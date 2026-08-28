/**
 * StudioVisualRecipeService — ADR-194 F1 + F2.
 *
 * F1: contrato + resolver dos Visual Recipes do Studio.
 * F2: `generate()` — consome `buildPromptPlan()`, monta prompt final,
 *     chama `generateImageB64` do llm.ts (Gemini Imagen com fallback OpenAI),
 *     salva mídia local, registra em `studio_creations` marcando o recipe usado.
 *
 * Determinístico até o ponto de chamar o provider. Sem LLM no service — só o
 * provider externo (Imagen/OpenAI) faz inferência, e o prompt seed é literal.
 *
 * Regras (RN-VRE-01..06):
 *   1. recipe_key regex `^[A-Z][A-Z0-9_]{2,63}$`, imutável.
 *   2. version monótona; nova versão = INSERT nova linha.
 *   3. alias único global; resolve case-insensitive; slash é opcional.
 *   4. supported_formats_json obrigatório com ≥1 formato.
 *   5. provider_hints é dica; provider real vem do llm.ts (default gemini→openai).
 *   6. `generate()` NUNCA burla plan gate — usa mesma `PlanService.studioAllowed`
 *      do StudioService (F2).
 */
import { v4 as uuidv4 } from "uuid";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import db from "./db.js";
import { generateImageB64 as defaultGenerateImageB64, chat as llmChat, isAIConfigured } from "./llm.js";

export const RECIPE_KEY_REGEX = /^[A-Z][A-Z0-9_]{2,63}$/;

export const SUPPORTED_FORMATS = [
  "feed_1_1", "story_9_16", "landscape_16_9", "square_1_1", "portrait_4_5",
] as const;
export type SupportedFormat = typeof SUPPORTED_FORMATS[number];

// Sizes que o llm.ts::generateImageB64 suporta hoje.
export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024";

/**
 * Mapa formato lógico → size da API. story/portrait vão pra 1024x1536 (retrato),
 * landscape vai pra 1536x1024, resto pra 1024x1024 quadrado. Mantém proporção
 * aproximada; provider pode ajustar mas não distorcer.
 */
function mapFormatToSize(format: SupportedFormat): ImageSize {
  if (format === "story_9_16" || format === "portrait_4_5") return "1024x1536";
  if (format === "landscape_16_9") return "1536x1024";
  return "1024x1024";
}

// Diretório de mídia (mesmo padrão do StudioService).
const MEDIA_DIR = path.join(process.env.DATA_DIR || process.cwd(), "media");
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch { /* noop */ }

/** Salva base64 → arquivo em MEDIA_DIR e retorna URL relativa (/media/xxx.png). */
function saveMediaB64(b64: string, ext = "png"): string {
  const name = `${randomUUID()}.${ext}`;
  const buf = Buffer.from(b64, "base64");
  fs.writeFileSync(path.join(MEDIA_DIR, name), buf);
  return `/media/${name}`;
}

export interface RecipeRow {
  id: string;
  recipe_key: string;
  version: number;
  active: number;                     // 0/1
  name: string;
  description: string | null;
  intent: string | null;
  composition_json: string | null;
  provider_hints_json: string | null;
  constraints_json: string | null;
  supported_formats_json: string;     // JSON stringified
  vertical_hints_json: string | null;
  created_at: string;
}

export interface Recipe {
  id: string;
  key: string;
  version: number;
  active: boolean;
  name: string;
  description: string | null;
  intent: string | null;
  composition: any;
  provider_hints: any;
  constraints: any;
  supported_formats: SupportedFormat[];
  vertical_hints: string[];
  created_at: string;
}

export interface PromptPlan {
  recipe_key: string;
  recipe_version: number;
  intent: string | null;
  composition: any;
  constraints: any;
  provider_hints: any;
  supported_formats: SupportedFormat[];
  inputs: Record<string, any>;         // o que o caller passou
  requested_format: SupportedFormat;
  // Prompt textual básico — servirá de base pra F2 gerar o prompt final
  // que vai pro Imagen/OpenAI. Aqui é só concatenação estruturada.
  prompt_seed: string;
}

export class VisualRecipeError extends Error {
  code: string;
  constructor(code: string, msg: string) {
    super(msg); this.code = code; this.name = "VisualRecipeError";
  }
}

function rowToRecipe(r: RecipeRow): Recipe {
  const parse = <T>(s: string | null, fallback: T): T => {
    if (!s) return fallback;
    try { return JSON.parse(s); } catch { return fallback; }
  };
  return {
    id: r.id,
    key: r.recipe_key,
    version: r.version,
    active: r.active === 1,
    name: r.name,
    description: r.description,
    intent: r.intent,
    composition: parse(r.composition_json, {}),
    provider_hints: parse(r.provider_hints_json, {}),
    constraints: parse(r.constraints_json, {}),
    supported_formats: parse(r.supported_formats_json, []) as SupportedFormat[],
    vertical_hints: parse(r.vertical_hints_json, []) as string[],
    created_at: r.created_at,
  };
}

export class StudioVisualRecipeService {

  /** Lista as active versions de todos os recipes (ordem alfabética por key). */
  static list(): Recipe[] {
    const rows = db.prepare(`
      SELECT * FROM studio_visual_recipes WHERE active = 1 ORDER BY recipe_key
    `).all() as RecipeRow[];
    return rows.map(rowToRecipe);
  }

  /**
   * Get 1 recipe por key OU por alias. Retorna null se não achou.
   * `orgId` opcional (F5): quando informado, aliases da organização
   * têm prioridade sobre aliases globais.
   */
  static get(keyOrAlias: string, orgId?: string | null): Recipe | null {
    // Tenta como key direta
    const direct = db.prepare(
      "SELECT * FROM studio_visual_recipes WHERE recipe_key = ? AND active = 1"
    ).get(keyOrAlias) as RecipeRow | undefined;
    if (direct) return rowToRecipe(direct);

    // Tenta como alias (org > global)
    const resolved = this.resolveAlias(keyOrAlias, orgId);
    if (!resolved) return null;

    const byKey = db.prepare(
      "SELECT * FROM studio_visual_recipes WHERE recipe_key = ? AND active = 1"
    ).get(resolved) as RecipeRow | undefined;
    return byKey ? rowToRecipe(byKey) : null;
  }

  /**
   * Resolve alias (case-insensitive, slash opcional) para recipe_key.
   * `orgId` opcional (F5): quando informado, tenta primeiro em
   * studio_visual_recipe_org_aliases; se não achou, cai no global.
   * Retorna a key ou null.
   */
  static resolveAlias(input: string, orgId?: string | null): string | null {
    if (!input) return null;
    // Normalização: lowercase + strip do slash inicial. Aplicada nos dois
    // lados pra que "/3Dbillboard" (input) case com "/3Dbillboard" (armazenado)
    // e também com "3dbillboard" (input alternativo).
    const normalized = input.trim().replace(/^\//, "").toLowerCase();

    // 1) Org override tem prioridade
    if (orgId) {
      const orgRow = db.prepare(
        "SELECT recipe_key FROM studio_visual_recipe_org_aliases WHERE organization_id = ? AND LOWER(REPLACE(alias, '/', '')) = ?"
      ).get(orgId, normalized) as any;
      if (orgRow?.recipe_key) return orgRow.recipe_key;
    }

    // 2) Global fallback
    const row = db.prepare(
      "SELECT recipe_key FROM studio_visual_recipe_aliases WHERE LOWER(REPLACE(alias, '/', '')) = ?"
    ).get(normalized) as any;
    return row?.recipe_key || null;
  }

  // ═══════════════ Org-scoped aliases (F5) ═══════════════

  /**
   * Adiciona um alias per-org. `alias` obrigatório; `recipe_key` DEVE
   * existir e estar active. Rejeita duplicata na mesma org com
   * VisualRecipeError('duplicate_alias').
   */
  static addOrgAlias(orgId: string, alias: string, recipe_key: string): {
    id: string; organization_id: string; alias: string; recipe_key: string;
  } {
    if (!orgId) throw new VisualRecipeError("missing_org", "orgId é obrigatório");
    const trimmed = (alias || "").trim();
    if (!trimmed) throw new VisualRecipeError("missing_alias", "alias é obrigatório");
    if (!recipe_key) throw new VisualRecipeError("missing_key", "recipe_key é obrigatório");

    const exists = db.prepare(
      "SELECT 1 FROM studio_visual_recipes WHERE recipe_key = ? AND active = 1"
    ).get(recipe_key);
    if (!exists) {
      throw new VisualRecipeError("recipe_not_found", `recipe_key não encontrada: ${recipe_key}`);
    }

    // Duplicata na mesma org (case-insensitive, slash opcional)
    const normalized = trimmed.replace(/^\//, "").toLowerCase();
    const dup = db.prepare(
      "SELECT id FROM studio_visual_recipe_org_aliases WHERE organization_id = ? AND LOWER(REPLACE(alias, '/', '')) = ?"
    ).get(orgId, normalized);
    if (dup) {
      throw new VisualRecipeError("duplicate_alias", `alias já existe nesta organização: ${trimmed}`);
    }

    const id = uuidv4();
    db.prepare(
      "INSERT INTO studio_visual_recipe_org_aliases (id, organization_id, alias, recipe_key) VALUES (?, ?, ?, ?)"
    ).run(id, orgId, trimmed, recipe_key);
    return { id, organization_id: orgId, alias: trimmed, recipe_key };
  }

  /**
   * Remove um alias per-org. Só remove se a org for a dona.
   * Retorna true se removeu; false se não achou.
   */
  static removeOrgAlias(orgId: string, aliasId: string): boolean {
    if (!orgId || !aliasId) return false;
    const info = db.prepare(
      "DELETE FROM studio_visual_recipe_org_aliases WHERE id = ? AND organization_id = ?"
    ).run(aliasId, orgId);
    return info.changes > 0;
  }

  /**
   * Lista aliases visíveis pra org: globais (id null) + os próprios da org.
   * `own_only=true` filtra pra só os da org (útil pra UI de gerenciamento).
   */
  static listAliasesForOrg(orgId: string | null | undefined, ownOnly = false): Array<{
    id: string; alias: string; recipe_key: string; scope: "global" | "org"; created_at: string;
  }> {
    const own = orgId ? (db.prepare(
      "SELECT id, alias, recipe_key, created_at FROM studio_visual_recipe_org_aliases WHERE organization_id = ? ORDER BY alias"
    ).all(orgId) as any[]).map(r => ({ ...r, scope: "org" as const })) : [];

    if (ownOnly) return own;

    const global = (db.prepare(
      "SELECT id, alias, recipe_key, created_at FROM studio_visual_recipe_aliases ORDER BY alias"
    ).all() as any[]).map(r => ({ ...r, scope: "global" as const }));

    return [...own, ...global];
  }

  /**
   * Cria uma nova recipe. Se `key` já existe, incrementa `version` e marca
   * versões anteriores como active=0. Sempre INSERT — nunca UPDATE do body.
   */
  static create(input: {
    key: string;
    name: string;
    description?: string | null;
    intent?: string | null;
    composition?: any;
    provider_hints?: any;
    constraints?: any;
    supported_formats: SupportedFormat[];
    vertical_hints?: string[];
  }): Recipe {
    if (!RECIPE_KEY_REGEX.test(input.key)) {
      throw new VisualRecipeError("invalid_key",
        `recipe_key inválido: ${input.key}. Formato esperado: ${RECIPE_KEY_REGEX.source}`);
    }
    if (!input.name || input.name.trim().length === 0) {
      throw new VisualRecipeError("missing_name", "name é obrigatório");
    }
    if (!input.supported_formats || input.supported_formats.length === 0) {
      throw new VisualRecipeError("missing_formats",
        "supported_formats deve ter ≥1 formato (RN-VRE-4)");
    }
    for (const f of input.supported_formats) {
      if (!SUPPORTED_FORMATS.includes(f)) {
        throw new VisualRecipeError("invalid_format",
          `formato inválido: ${f}. Aceitos: ${SUPPORTED_FORMATS.join(", ")}`);
      }
    }

    // Descobre próxima versão
    const latest = db.prepare(
      "SELECT MAX(version) AS v FROM studio_visual_recipes WHERE recipe_key = ?"
    ).get(input.key) as any;
    const nextVersion = (latest?.v || 0) + 1;

    // Marca versões anteriores como inativas
    if (nextVersion > 1) {
      db.prepare(
        "UPDATE studio_visual_recipes SET active = 0 WHERE recipe_key = ?"
      ).run(input.key);
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO studio_visual_recipes
        (id, recipe_key, version, active, name, description, intent,
         composition_json, provider_hints_json, constraints_json,
         supported_formats_json, vertical_hints_json)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.key, nextVersion, input.name.trim(),
      input.description ?? null, input.intent ?? null,
      JSON.stringify(input.composition ?? {}),
      JSON.stringify(input.provider_hints ?? {}),
      JSON.stringify(input.constraints ?? {}),
      JSON.stringify(input.supported_formats),
      JSON.stringify(input.vertical_hints ?? []),
    );

    return this.get(input.key)!;
  }

  /**
   * Adiciona um alias apontando pra uma recipe_key. Idempotente por UNIQUE(alias).
   */
  static addAlias(alias: string, recipe_key: string): void {
    if (!alias || alias.trim().length === 0) {
      throw new VisualRecipeError("missing_alias", "alias é obrigatório");
    }
    if (!this.get(recipe_key)) {
      throw new VisualRecipeError("recipe_not_found",
        `recipe ${recipe_key} não existe`);
    }
    try {
      db.prepare(
        "INSERT INTO studio_visual_recipe_aliases (id, alias, recipe_key) VALUES (?, ?, ?)"
      ).run(uuidv4(), alias.trim(), recipe_key);
    } catch (e: any) {
      // UNIQUE constraint: alias já existe — silenciosamente idempotente
      if (String(e.code || e.message || "").includes("UNIQUE")) return;
      throw e;
    }
  }

  /**
   * Monta o "prompt plan" a partir da receita + inputs. Determinístico.
   * StudioService (F2+) consome esse plan pra chamar Imagen/OpenAI.
   */
  static buildPromptPlan(input: {
    recipe_key_or_alias: string;
    inputs: Record<string, any>;         // produto, marca, público, cta, etc.
    format: SupportedFormat;
    orgId?: string | null;               // F5: aliases da org têm prioridade
  }): PromptPlan {
    const recipe = this.get(input.recipe_key_or_alias, input.orgId);
    if (!recipe) {
      throw new VisualRecipeError("recipe_not_found",
        `recipe não encontrada: ${input.recipe_key_or_alias}`);
    }
    if (!recipe.supported_formats.includes(input.format)) {
      throw new VisualRecipeError("format_not_supported",
        `formato ${input.format} não suportado por ${recipe.key}. Suportados: ${recipe.supported_formats.join(", ")}`);
    }

    // prompt_seed: concatenação simples que F2 vai enriquecer com o motor.
    // Aqui é literal — o LLM não decide texto nesta fatia.
    const parts: string[] = [];
    parts.push(recipe.name);
    if (recipe.description) parts.push(recipe.description);
    if (recipe.intent) parts.push(`intenção: ${recipe.intent}`);
    if (recipe.composition && Object.keys(recipe.composition).length > 0) {
      parts.push(`composição: ${JSON.stringify(recipe.composition)}`);
    }
    parts.push(`formato: ${input.format}`);
    if (input.inputs && Object.keys(input.inputs).length > 0) {
      const inputPairs = Object.entries(input.inputs)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
      parts.push(`inputs: ${inputPairs.join(", ")}`);
    }
    const prompt_seed = parts.join(" | ");

    return {
      recipe_key: recipe.key,
      recipe_version: recipe.version,
      intent: recipe.intent,
      composition: recipe.composition,
      constraints: recipe.constraints,
      provider_hints: recipe.provider_hints,
      supported_formats: recipe.supported_formats,
      inputs: input.inputs,
      requested_format: input.format,
      prompt_seed,
    };
  }

  // ═══════════════ Generate (F2) ═══════════════

  /**
   * Injetável: default usa generateImageB64 do llm.ts (Gemini→OpenAI).
   * Testes substituem por adapter fake pra não bater na API.
   */
  private static imageGenerator: (prompt: string, size: ImageSize) => Promise<string> =
    (p, s) => defaultGenerateImageB64(p, s);

  static configureImageGenerator(fn: (prompt: string, size: ImageSize) => Promise<string>): void {
    this.imageGenerator = fn;
  }

  static resetImageGenerator(): void {
    this.imageGenerator = (p, s) => defaultGenerateImageB64(p, s);
  }

  /**
   * Executa geração de imagem a partir de recipe + inputs + formato.
   *
   * Pipeline:
   *   1. buildPromptPlan → plan estruturado
   *   2. compose prompt final (concat plan.prompt_seed + brand_hint opcional)
   *   3. mapeia formato → size Imagen ("1024x1024" | "1024x1536" | "1536x1024")
   *   4. chama imageGenerator (Gemini/OpenAI)
   *   5. salva base64 em MEDIA_DIR
   *   6. registra em `studio_creations` com o `prompt` marcado com recipe_key/version
   *
   * Não faz gate de plano aqui — o caller da rota é responsável, com
   * PlanService.studioAllowed. Isso evita duplicar a política em 2 lugares
   * (StudioService já enforça em /api/studio/generate).
   */
  static async generate(input: {
    orgId: string;
    recipe_key_or_alias: string;
    inputs?: Record<string, any>;
    format: SupportedFormat;
    brand_hint?: string;                 // texto opcional pra contextualizar marca
  }): Promise<{
    id: string; mediaUrl: string; prompt: string;
    recipe_key: string; recipe_version: number;
  }> {
    if (!input.orgId) throw new VisualRecipeError("missing_org", "orgId é obrigatório");

    const plan = this.buildPromptPlan({
      recipe_key_or_alias: input.recipe_key_or_alias,
      inputs: input.inputs || {},
      format: input.format,
      orgId: input.orgId,
    });

    // Compose prompt final. plan.prompt_seed já é a base; brand_hint entra na frente
    // se veio. Restrições da receita viram texto legível pro provider.
    const parts: string[] = [];
    if (input.brand_hint) parts.push(input.brand_hint);
    parts.push(plan.prompt_seed);
    if (plan.constraints && typeof plan.constraints === "object") {
      const c = plan.constraints as Record<string, any>;
      if (c.preserve_product_identity) parts.push("preservar identidade do produto");
      if (c.allow_text_on_image === false) parts.push("sem texto sobre a imagem");
      if (typeof c.max_people_in_scene === "number") parts.push(`no máximo ${c.max_people_in_scene} pessoa(s) na cena`);
    }
    const finalPrompt = parts.join(". ");

    // Mapeia formato → size do generateImageB64 (só 3 sizes suportados).
    const size = mapFormatToSize(input.format);

    const b64 = await this.imageGenerator(finalPrompt, size);
    if (!b64) throw new VisualRecipeError("provider_empty", "provider retornou vazio");

    const mediaUrl = saveMediaB64(b64, "png");
    const id = randomUUID();
    // Registra em studio_creations com marcador do recipe usado no prompt
    // (não altera schema; a marca fica no prompt como comentário estruturado).
    const markedPrompt = `[${plan.recipe_key}@v${plan.recipe_version}] ${finalPrompt}`;
    db.prepare(
      "INSERT INTO studio_creations (id, organization_id, kind, prompt, media_url) VALUES (?, ?, 'image', ?, ?)"
    ).run(id, input.orgId, markedPrompt, mediaUrl);

    return {
      id, mediaUrl, prompt: finalPrompt,
      recipe_key: plan.recipe_key,
      recipe_version: plan.recipe_version,
    };
  }

  // ═══════════════ Suggest (F3.5) ═══════════════
  //
  // Classifica um briefing livre no melhor recipe. Duas rotas:
  //   1. LLM classifier (via chat() do llm.ts), retorna JSON estruturado.
  //   2. Fallback determinístico por palavras-chave sobre name/description/
  //      intent/vertical_hints. Também usado quando a chave inválida vem do LLM.
  //
  // DI: `configureBriefingClassifier(fn)` substitui o classifier para testes
  // que não podem bater na API real.

  private static briefingClassifier: (
    input: { briefing: string; format?: SupportedFormat | null },
    catalog: Array<{ recipe_key: string; name: string; description: string | null; intent: string | null; vertical_hints: string[]; supported_formats: SupportedFormat[] }>,
  ) => Promise<{ recipe_key: string; reasoning: string; confidence: number; alternatives?: Array<{ recipe_key: string; reasoning: string }> } | null> =
    defaultBriefingClassifier;

  static configureBriefingClassifier(
    fn: typeof StudioVisualRecipeService.briefingClassifier,
  ): void {
    this.briefingClassifier = fn;
  }

  static resetBriefingClassifier(): void {
    this.briefingClassifier = defaultBriefingClassifier;
  }

  /**
   * Sugere um recipe a partir de um briefing livre.
   * @throws VisualRecipeError('missing_briefing') se briefing vazio.
   */
  static async suggestForBriefing(input: {
    briefing: string;
    format?: SupportedFormat | null;
  }): Promise<{
    suggestion: {
      recipe_key: string;
      name: string;
      reasoning: string;
      confidence: number;
    } | null;
    method: "llm" | "fallback_keyword";
    alternatives: Array<{ recipe_key: string; name: string; reasoning: string }>;
  }> {
    const briefing = (input.briefing || "").trim();
    if (!briefing) {
      throw new VisualRecipeError("missing_briefing", "briefing é obrigatório");
    }

    const format = input.format || null;

    // Catálogo filtrado pelo formato quando pedido — não vale sugerir
    // uma receita que não suporta o formato que o usuário quer.
    const all = this.list();
    const candidates = format
      ? all.filter(r => r.supported_formats.includes(format))
      : all;

    if (candidates.length === 0) {
      return { suggestion: null, method: "fallback_keyword", alternatives: [] };
    }

    // Shape leve pro classifier (não expor JSON interno).
    const catalog = candidates.map(r => ({
      recipe_key: r.key,
      name: r.name,
      description: r.description,
      intent: r.intent,
      vertical_hints: r.vertical_hints,
      supported_formats: r.supported_formats,
    }));

    // 1. Tenta LLM classifier.
    let llmResult: Awaited<ReturnType<typeof this.briefingClassifier>> = null;
    try {
      llmResult = await this.briefingClassifier({ briefing, format }, catalog);
    } catch {
      // erro silencioso — cai no fallback abaixo
      llmResult = null;
    }

    if (llmResult && candidates.find(r => r.key === llmResult!.recipe_key)) {
      const chosen = candidates.find(r => r.key === llmResult!.recipe_key)!;
      const alts = (llmResult.alternatives || [])
        .filter(a => candidates.find(r => r.key === a.recipe_key))
        .slice(0, 2)
        .map(a => ({
          recipe_key: a.recipe_key,
          name: candidates.find(r => r.key === a.recipe_key)!.name,
          reasoning: a.reasoning,
        }));
      return {
        suggestion: {
          recipe_key: chosen.key,
          name: chosen.name,
          reasoning: llmResult.reasoning,
          confidence: Math.max(0, Math.min(1, llmResult.confidence)),
        },
        method: "llm",
        alternatives: alts,
      };
    }

    // 2. Fallback keyword — pontuar cada recipe por hits de tokens.
    const tokens = briefing.toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")   // remove acentos
      .split(/[^a-z0-9]+/)
      .filter(t => t.length >= 3);

    const scored = candidates.map(r => {
      const haystack = [
        r.name, r.description || "", r.intent || "",
        ...r.vertical_hints,
      ].join(" ").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      let score = 0;
      for (const t of tokens) {
        if (haystack.includes(t)) score++;
      }
      return { recipe: r, score };
    }).sort((a, b) => b.score - a.score);

    const top = scored[0];
    if (!top || top.score === 0) {
      // Nada bateu — devolve a primeira do catálogo como default fraco.
      const first = candidates[0];
      return {
        suggestion: {
          recipe_key: first.key,
          name: first.name,
          reasoning: "Nenhuma palavra-chave do briefing bateu com o catálogo — devolvendo primeira receita disponível como ponto de partida.",
          confidence: 0.1,
        },
        method: "fallback_keyword",
        alternatives: [],
      };
    }

    const alts = scored.slice(1, 3).filter(s => s.score > 0).map(s => ({
      recipe_key: s.recipe.key,
      name: s.recipe.name,
      reasoning: `${s.score} palavra(s) do briefing bateu com o catálogo.`,
    }));

    return {
      suggestion: {
        recipe_key: top.recipe.key,
        name: top.recipe.name,
        reasoning: `${top.score} palavra(s) do briefing bateu com name/description/intent/verticais.`,
        confidence: Math.min(0.6, 0.2 + top.score * 0.1),
      },
      method: "fallback_keyword",
      alternatives: alts,
    };
  }

  // ═══════════════ Analytics (F4) ═══════════════

  /**
   * Agrega uso de receitas a partir do prompt marcado em `studio_creations`
   * (formato `[KEY@vN] ...` gravado por `generate()` na F2).
   *
   * Retorno inclui top por recipe (uses desc, tie-break por last_used desc),
   * rollup por vertical (uma receita com N verticais conta em cada uma), e
   * total_uses. Junção com `studio_visual_recipes` é best-effort — se a
   * receita foi removida/renomeada, `name` fica null e vertical_hints=[].
   *
   * @param opts.orgId  — quando informado, filtra por organização; senão global.
   * @param opts.since  — ISO opcional pra limitar janela (created_at ≥ since).
   */
  static usageStats(opts: {
    orgId?: string | null;
    since?: string | null;
  } = {}): {
    scope: "org" | "global";
    total_uses: number;
    by_recipe: Array<{
      recipe_key: string;
      name: string | null;
      vertical_hints: string[];
      uses: number;
      last_used: string;
    }>;
    by_vertical: Array<{ vertical: string; uses: number }>;
  } {
    const orgId = opts.orgId || null;
    const since = opts.since || null;

    const wheres: string[] = [
      "prompt LIKE '[%@v%]%'",
      "INSTR(prompt, '@') > 2",
      "kind = 'image'",
    ];
    const params: any[] = [];
    if (orgId) { wheres.push("organization_id = ?"); params.push(orgId); }
    if (since) { wheres.push("created_at >= ?"); params.push(since); }

    const rows = db.prepare(`
      SELECT
        SUBSTR(prompt, 2, INSTR(prompt, '@') - 2) AS recipe_key,
        COUNT(*) AS uses,
        MAX(created_at) AS last_used
      FROM studio_creations
      WHERE ${wheres.join(" AND ")}
      GROUP BY recipe_key
      ORDER BY uses DESC, last_used DESC
    `).all(...params) as Array<{ recipe_key: string; uses: number; last_used: string }>;

    // Junta com o catálogo pra puxar name/vertical_hints. Uma query só, mapa em JS.
    const recipeRows = db.prepare(
      `SELECT recipe_key, name, vertical_hints_json
         FROM studio_visual_recipes
        WHERE active = 1`
    ).all() as Array<{ recipe_key: string; name: string; vertical_hints_json: string }>;
    const catalog = new Map(recipeRows.map(r => {
      let verts: string[] = [];
      try { verts = JSON.parse(r.vertical_hints_json || "[]"); } catch { /* keep [] */ }
      return [r.recipe_key, { name: r.name, verticals: verts }];
    }));

    const by_recipe = rows.map(r => {
      const meta = catalog.get(r.recipe_key) || null;
      return {
        recipe_key: r.recipe_key,
        name: meta?.name ?? null,
        vertical_hints: meta?.verticals ?? [],
        uses: r.uses,
        last_used: r.last_used,
      };
    });

    // Rollup por vertical — uma receita com N verticais soma em cada uma.
    const vertMap = new Map<string, number>();
    for (const stat of by_recipe) {
      for (const v of stat.vertical_hints) {
        vertMap.set(v, (vertMap.get(v) || 0) + stat.uses);
      }
    }
    const by_vertical = Array.from(vertMap.entries())
      .map(([vertical, uses]) => ({ vertical, uses }))
      .sort((a, b) => b.uses - a.uses || a.vertical.localeCompare(b.vertical));

    const total_uses = by_recipe.reduce((acc, r) => acc + r.uses, 0);

    return {
      scope: orgId ? "org" : "global",
      total_uses,
      by_recipe,
      by_vertical,
    };
  }

  // ═══════════════ Seed (idempotente) ═══════════════

  /**
   * Cria os 6 recipes iniciais discutidos no PRD-PEL-01 §12.4 se ainda não
   * existirem. Idempotente: recipe já presente → skip. Aliases também.
   */
  static seedInitialRecipes(): { created: string[]; aliases_added: number } {
    const created: string[] = [];
    let aliases_added = 0;

    for (const seed of SEED_RECIPES) {
      if (!this.get(seed.key)) {
        this.create(seed);
        created.push(seed.key);
      }
    }

    for (const [alias, key] of SEED_ALIASES) {
      const already = db.prepare(
        "SELECT id FROM studio_visual_recipe_aliases WHERE LOWER(alias) = ?"
      ).get(alias.toLowerCase());
      if (!already) {
        this.addAlias(alias, key);
        aliases_added++;
      }
    }

    return { created, aliases_added };
  }
}

/**
 * Classifier default (F3.5) — chama chat() do llm.ts com response_format JSON
 * e devolve a chave escolhida. Retorna null se IA não estiver configurada
 * ou se a resposta não parsear — o caller cai no fallback keyword.
 */
async function defaultBriefingClassifier(
  input: { briefing: string; format?: SupportedFormat | null },
  catalog: Array<{ recipe_key: string; name: string; description: string | null; intent: string | null; vertical_hints: string[]; supported_formats: SupportedFormat[] }>,
): Promise<{ recipe_key: string; reasoning: string; confidence: number; alternatives?: Array<{ recipe_key: string; reasoning: string }> } | null> {
  if (!isAIConfigured() || catalog.length === 0) return null;

  const catalogLines = catalog.map(r => {
    const parts = [`- ${r.recipe_key}: ${r.name}`];
    if (r.description) parts.push(`descrição: ${r.description}`);
    if (r.intent) parts.push(`intenção: ${r.intent}`);
    if (r.vertical_hints.length > 0) parts.push(`verticais: ${r.vertical_hints.join(", ")}`);
    return parts.join(" | ");
  }).join("\n");

  const system = "Você é um classificador de receitas visuais para geração de imagem. Escolha a MELHOR receita para o briefing e até 2 alternativas. Responda APENAS JSON válido no formato {choice: string, reasoning: string, confidence: number, alternatives: [{recipe_key: string, reasoning: string}]}. `choice` e `recipe_key` DEVEM ser uma das keys exatas do catálogo.";
  const prompt = [
    `Catálogo (${catalog.length} receita(s) disponível(is)):`,
    catalogLines,
    "",
    `Briefing do usuário: "${input.briefing}"`,
    input.format ? `Formato solicitado: ${input.format}` : "",
    "",
    "Devolva JSON com: choice (recipe_key escolhido), reasoning (1-2 frases em pt-BR), confidence (0..1), alternatives (0-2 outras opções com recipe_key + reasoning curto).",
  ].filter(Boolean).join("\n");

  let raw = "";
  try {
    raw = await llmChat(prompt, { system, json: true, temperature: 0.3 });
  } catch { return null; }
  if (!raw) return null;

  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed.choice !== "string") return null;

  return {
    recipe_key: String(parsed.choice),
    reasoning: String(parsed.reasoning || ""),
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    alternatives: Array.isArray(parsed.alternatives)
      ? parsed.alternatives
          .filter((a: any) => a && typeof a.recipe_key === "string")
          .map((a: any) => ({ recipe_key: String(a.recipe_key), reasoning: String(a.reasoning || "") }))
      : [],
  };
}

// Dados curados do §12 do PRD-PEL-01.
const SEED_RECIPES: Array<Parameters<typeof StudioVisualRecipeService.create>[0]> = [
  {
    key: "PRODUCT_EXPLOSION",
    name: "Product Explosion",
    description: "Produto em explosão com cenário 3D dramatizado.",
    intent: "product_hero",
    composition: { camera: "wide_angle_low", lighting: "dramatic_rim", background: "solid_gradient", product_position: "center_hero", extras: ["debris", "smoke"] },
    provider_hints: { preferred: ["gemini_imagen", "openai_gpt_image"] },
    constraints: { preserve_product_identity: true, allow_text_on_image: false, max_people_in_scene: 0 },
    supported_formats: ["feed_1_1", "story_9_16"],
    vertical_hints: ["retail", "storefront"],
  },
  {
    key: "BILLBOARD_3D",
    name: "3D Billboard",
    description: "Outdoor 3D estilo Times Square, produto em relevo.",
    intent: "impact_hero",
    composition: { camera: "billboard_perspective", lighting: "urban_night", background: "city_skyline", product_position: "billboard_face" },
    provider_hints: { preferred: ["gemini_imagen"] },
    constraints: { preserve_product_identity: true, allow_text_on_image: true, max_people_in_scene: 0 },
    supported_formats: ["landscape_16_9", "feed_1_1", "story_9_16"],
    vertical_hints: ["retail", "beauty", "fashion"],
  },
  {
    key: "MAGAZINE_COVER",
    name: "Magazine Cover",
    description: "Capa de revista de estilo com produto como protagonista.",
    intent: "editorial_hero",
    composition: { camera: "portrait_studio", lighting: "editorial_softbox", background: "editorial_seamless", product_position: "portrait_hero" },
    provider_hints: { preferred: ["gemini_imagen", "openai_gpt_image"] },
    constraints: { preserve_product_identity: true, allow_text_on_image: true, max_people_in_scene: 1 },
    supported_formats: ["portrait_4_5", "feed_1_1"],
    vertical_hints: ["beauty", "fashion", "retail"],
  },
  {
    key: "ADD_CREATIVE",
    name: "Ad Creative",
    description: "Peça publicitária pronta pra ads (headline + produto + CTA).",
    intent: "ad_creative",
    composition: { camera: "product_studio", lighting: "clean_softbox", background: "brand_gradient", product_position: "left_third" },
    provider_hints: { preferred: ["gemini_imagen"] },
    constraints: { preserve_product_identity: true, allow_text_on_image: true, max_people_in_scene: 0 },
    supported_formats: ["feed_1_1", "story_9_16", "landscape_16_9"],
    vertical_hints: ["retail", "storefront", "beauty"],
  },
  {
    key: "SOFT_3D",
    name: "3D Soft",
    description: "Renderização 3D com paleta suave, pastéis, aesthetic soft.",
    intent: "aesthetic_soft",
    composition: { camera: "top_down_soft", lighting: "diffuse_soft", background: "pastel_gradient", product_position: "center_soft" },
    provider_hints: { preferred: ["gemini_imagen"] },
    constraints: { preserve_product_identity: true, allow_text_on_image: false, max_people_in_scene: 0 },
    supported_formats: ["feed_1_1", "square_1_1"],
    vertical_hints: ["beauty", "fashion", "retail"],
  },
  {
    key: "LIFESTYLE_SHORT",
    name: "Lifestyle Short",
    description: "Cena lifestyle curta em uso — produto no contexto humano.",
    intent: "lifestyle",
    composition: { camera: "hand_held_natural", lighting: "golden_hour", background: "in_context", product_position: "in_use" },
    provider_hints: { preferred: ["gemini_imagen"] },
    constraints: { preserve_product_identity: true, allow_text_on_image: false, max_people_in_scene: 2 },
    supported_formats: ["story_9_16", "portrait_4_5", "feed_1_1"],
    vertical_hints: ["fashion", "beauty", "retail"],
  },
];

const SEED_ALIASES: Array<[string, string]> = [
  // slash-commands citados no PRD §12
  ["/ProductExplosion", "PRODUCT_EXPLOSION"],
  ["/3Dbillboard", "BILLBOARD_3D"],
  ["/MagazineCover", "MAGAZINE_COVER"],
  ["/AddCreative", "ADD_CREATIVE"],
  ["/3DSoft", "SOFT_3D"],
  ["/LifestyleShort", "LIFESTYLE_SHORT"],
  // alternativas naturais em português/inglês (case-insensitive)
  ["outdoor 3d", "BILLBOARD_3D"],
  ["3d billboard", "BILLBOARD_3D"],
  ["capa de revista", "MAGAZINE_COVER"],
  ["magazine", "MAGAZINE_COVER"],
  ["explosão de produto", "PRODUCT_EXPLOSION"],
  ["product explosion", "PRODUCT_EXPLOSION"],
  ["ad creative", "ADD_CREATIVE"],
  ["criativo de anúncio", "ADD_CREATIVE"],
  ["3d soft", "SOFT_3D"],
  ["lifestyle", "LIFESTYLE_SHORT"],
];

export default StudioVisualRecipeService;
