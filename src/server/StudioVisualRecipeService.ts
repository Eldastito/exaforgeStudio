/**
 * StudioVisualRecipeService — ADR-194 F1.
 *
 * Contrato + resolver dos Visual Recipes do Studio. Nunca gera imagem nesta
 * fatia — a geração é responsabilidade do `StudioService` (F2+), que vai
 * consumir `buildPromptPlan()` e chamar `llm.ts::generateImageB64`.
 *
 * Determinístico. Sem LLM. Sem side-effect fora do SQLite.
 *
 * Regras (RN-VRE-01..05):
 *   1. recipe_key regex `^[A-Z][A-Z0-9_]{2,63}$`, imutável.
 *   2. version monótona; nova versão = INSERT nova linha.
 *   3. alias único global; resolve case-insensitive; slash é opcional.
 *   4. supported_formats_json obrigatório com ≥1 formato.
 *   5. provider_hints é dica; StudioService (F2+) escolhe o provider real.
 */
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";

export const RECIPE_KEY_REGEX = /^[A-Z][A-Z0-9_]{2,63}$/;

export const SUPPORTED_FORMATS = [
  "feed_1_1", "story_9_16", "landscape_16_9", "square_1_1", "portrait_4_5",
] as const;
export type SupportedFormat = typeof SUPPORTED_FORMATS[number];

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

  /** Get 1 recipe por key OU por alias. Retorna null se não achou. */
  static get(keyOrAlias: string): Recipe | null {
    // Tenta como key direta
    const direct = db.prepare(
      "SELECT * FROM studio_visual_recipes WHERE recipe_key = ? AND active = 1"
    ).get(keyOrAlias) as RecipeRow | undefined;
    if (direct) return rowToRecipe(direct);

    // Tenta como alias
    const resolved = this.resolveAlias(keyOrAlias);
    if (!resolved) return null;

    const byKey = db.prepare(
      "SELECT * FROM studio_visual_recipes WHERE recipe_key = ? AND active = 1"
    ).get(resolved) as RecipeRow | undefined;
    return byKey ? rowToRecipe(byKey) : null;
  }

  /**
   * Resolve alias (case-insensitive, slash opcional) para recipe_key.
   * Retorna a key ou null.
   */
  static resolveAlias(input: string): string | null {
    if (!input) return null;
    // Normalização: lowercase + strip do slash inicial. Aplicada nos dois
    // lados pra que "/3Dbillboard" (input) case com "/3Dbillboard" (armazenado)
    // e também com "3dbillboard" (input alternativo).
    const normalized = input.trim().replace(/^\//, "").toLowerCase();
    const row = db.prepare(
      "SELECT recipe_key FROM studio_visual_recipe_aliases WHERE LOWER(REPLACE(alias, '/', '')) = ?"
    ).get(normalized) as any;
    return row?.recipe_key || null;
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
  }): PromptPlan {
    const recipe = this.get(input.recipe_key_or_alias);
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
