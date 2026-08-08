/**
 * GrimoireService — carrega just-in-time a(s) rubrica(s) de copy roteada(s) por
 * (módulo, estágio) do grimoire (ADR-155 F1.2, padrão 4 grimoire /
 * progressive-disclosure de docs/patterns/agentic-pipeline-lessons.md).
 *
 * REGRA CENTRAL (progressive disclosure): NUNCA retorna o grimoire inteiro — só
 * a(s) rubrica(s) roteada(s) no INDEX pro par (module, stage), montada(s) como
 * bloco <rubrica> pro prompt do redator. É o análogo executável do "MUST read X
 * before Y" do img2threejs: o redator recebe a peça certa no momento certo, e
 * não o dump (economia de token = padrão 6).
 *
 * ISOLAMENTO: `orgId` é o 1º arg (convenção nº 1, tenant-first). A camada
 * por-org (`brand_voice_context`) entra na F1.3 — por ora a assinatura já é
 * tenant-first pra não quebrar contrato depois. Roteamento também isola por
 * MÓDULO: pedir (cobranca, compose) nunca traz a rubrica de outro módulo.
 *
 * FONTE: o conteúdo vem de ./grimoire/compiled.ts (gerado de docs/grimoire/
 * copy/** por scripts/build-grimoire.ts e embarcado no bundle — sem fs em
 * runtime). Rode `npm run grimoire:build` após editar o grimoire; o
 * test:grimoire-service confere que o compilado está em sync.
 */
import { GRIMOIRE_INDEX, GRIMOIRE_RUBRICS, type GrimoireRubric } from "./grimoire/compiled.js";

export type GrimoireStage = "intake" | "compose" | "guardrails" | "review" | "glossary";

export interface GrimoireLoad {
  found: boolean;
  module: string;
  stage: GrimoireStage;
  rubricPaths: string[];
  rubrics: GrimoireRubric[];
  /** Bloco(s) <rubrica> prontos pro prompt — SÓ o roteado (progressive disclosure). */
  prompt: string;
}

const MODULOS = GRIMOIRE_INDEX.modulos as unknown as Record<string, Record<string, readonly string[]>>;

export class GrimoireService {
  /** Estágios conhecidos (do INDEX). */
  static stages(): GrimoireStage[] {
    return [...(GRIMOIRE_INDEX.estagios as readonly string[])] as GrimoireStage[];
  }

  /** Módulos conhecidos (do INDEX). */
  static modules(): string[] {
    return Object.keys(MODULOS);
  }

  /** Rubricas roteadas pra (módulo, estágio) segundo o INDEX. Vazio se não houver. */
  static routes(module: string, stage: GrimoireStage): string[] {
    const byStage = MODULOS[module];
    return byStage && byStage[stage] ? [...byStage[stage]] : [];
  }

  /**
   * Carrega just-in-time SÓ a(s) rubrica(s) roteada(s) pro par (module, stage).
   * Módulo/estágio desconhecido → found=false, prompt vazio (graceful, sem throw).
   */
  static load(orgId: string, module: string, stage: GrimoireStage): GrimoireLoad {
    void orgId; // reservado p/ F1.3 (brand_voice_context por org)
    const rubricPaths = this.routes(module, stage);
    const rubrics = rubricPaths
      .map((p) => GRIMOIRE_RUBRICS[p])
      .filter((r): r is GrimoireRubric => Boolean(r));
    const prompt = rubrics.map((r) => this.render(r)).join("\n\n");
    return { found: rubrics.length > 0, module, stage, rubricPaths, rubrics, prompt };
  }

  /**
   * Carrega várias etapas de uma vez (ex.: [guardrails, intake, compose, review])
   * pra montar o prompt completo de composição — sempre só o roteado por etapa.
   */
  static loadStages(orgId: string, module: string, stages: GrimoireStage[]): GrimoireLoad[] {
    return stages.map((s) => this.load(orgId, module, s));
  }

  /** Concatena o prompt de várias etapas num bloco único pronto pra injetar. */
  static promptFor(orgId: string, module: string, stages: GrimoireStage[]): string {
    return this.loadStages(orgId, module, stages)
      .map((l) => l.prompt)
      .filter(Boolean)
      .join("\n\n");
  }

  private static render(r: GrimoireRubric): string {
    return this.renderWithLessons(r, []);
  }

  /** Renderiza a rubrica + (F1.4) bloco <licoes> quando há lições pós-mortem. Sem lições ⇒ byte-idêntico a render(). */
  private static renderWithLessons(r: GrimoireRubric, lessons: string[]): string {
    const licoes = lessons.length ? `\n<licoes>\n${lessons.map((l) => `- ${l}`).join("\n")}\n</licoes>` : "";
    return `<rubrica id="${r.id}" estagio="${r.estagio}">\n${r.corpo}${licoes}\n</rubrica>`;
  }

  // ===== F1.3 — camada por-org (brand voice) =====
  // db é importado dinamicamente (convenção nº 11) pra manter as partes puras
  // acima (F1.2: routes/load/promptFor) livres de DB e sem custo de init no load.

  /** Voz/marca por org: flag opt-in + texto de contexto. Isolamento por organization_id. */
  static async getBrandVoice(orgId: string): Promise<{ enabled: boolean; context: string | null }> {
    const db = (await import("./db.js")).default;
    const row = db
      .prepare(`SELECT brand_voice_enabled AS enabled, brand_voice_context AS context FROM organization_settings WHERE organization_id = ?`)
      .get(orgId) as { enabled?: number; context?: string | null } | undefined;
    return { enabled: !!(row && row.enabled), context: (row && row.context) ?? null };
  }

  /** Atualiza voz/marca da org (patch parcial). Só toca os campos passados. */
  static async setBrandVoice(orgId: string, patch: { enabled?: boolean; context?: string | null }): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.enabled !== undefined) { sets.push("brand_voice_enabled = ?"); vals.push(patch.enabled ? 1 : 0); }
    if (patch.context !== undefined) { sets.push("brand_voice_context = ?"); vals.push(patch.context); }
    if (!sets.length) return;
    vals.push(orgId);
    const db = (await import("./db.js")).default;
    db.prepare(`UPDATE organization_settings SET ${sets.join(", ")} WHERE organization_id = ?`).run(...(vals as any[]));
  }

  /**
   * Injeção COMBINADA por org (o que os redatores de F2/F3 chamam): rubrica(s)
   * global(is) roteada(s) + <contexto_marca> da org. GATED pela flag: se
   * brand_voice_enabled=0 (default), retorna "" — o redator não injeta NADA
   * (zero mudança em prod). Só quando a org opta é que o grimoire entra no prompt.
   */
  static async promptForOrg(orgId: string, module: string, stages: GrimoireStage[]): Promise<string> {
    const bv = await this.getBrandVoice(orgId);
    if (!bv.enabled) return "";
    // Rubricas roteadas (dedupe por id, preservando ordem) + F1.4 lições da org.
    const seen = new Set<string>();
    const rubrics: GrimoireRubric[] = [];
    for (const s of stages) for (const r of this.load(orgId, module, s).rubrics) {
      if (!seen.has(r.id)) { seen.add(r.id); rubrics.push(r); }
    }
    const lessons = await this.lessonsFor(orgId, rubrics.map((r) => r.id));
    const blocks = rubrics.map((r) => this.renderWithLessons(r, lessons.get(r.id) || []));
    const marca = bv.context && bv.context.trim() ? `<contexto_marca>\n${bv.context.trim()}\n</contexto_marca>` : "";
    return [...blocks, marca].filter(Boolean).join("\n\n");
  }

  // ===== F1.4 — lições pós-mortem (memória institucional do grimoire) =====
  // O erro medido (ex.: A/B da copy) vira uma regra datada na rubrica, injetada
  // dali pra frente. Dados dinâmicos por-org na tabela grimoire_lessons.

  /** Lições ATIVAS por rubrica (datadas). Isolado por org. Vazio se não houver. */
  static async lessonsFor(orgId: string, rubricIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!rubricIds.length) return out;
    const db = (await import("./db.js")).default;
    const ph = rubricIds.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT rubric_id AS rubricId, lesson, DATE(updated_at) AS d
         FROM grimoire_lessons
        WHERE organization_id = ? AND active = 1 AND rubric_id IN (${ph})
        ORDER BY updated_at ASC`
    ).all(orgId, ...rubricIds) as any[];
    for (const r of rows) {
      const arr = out.get(String(r.rubricId)) || [];
      arr.push(`${r.d}: ${r.lesson}`);
      out.set(String(r.rubricId), arr);
    }
    return out;
  }

  /** Grava (ou reativa) uma lição na rubrica. Idempotente por (org, rubric, dedupeKey). */
  static async recordLesson(orgId: string, rubricId: string, opts: { lesson: string; source?: string; dedupeKey: string; evidence?: unknown }): Promise<void> {
    const db = (await import("./db.js")).default;
    const ev = opts.evidence !== undefined ? JSON.stringify(opts.evidence) : null;
    const existing = db.prepare(`SELECT id FROM grimoire_lessons WHERE organization_id = ? AND rubric_id = ? AND dedupe_key = ?`).get(orgId, rubricId, opts.dedupeKey) as any;
    if (existing) {
      db.prepare(`UPDATE grimoire_lessons SET lesson = ?, source = ?, evidence_json = ?, active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(opts.lesson, opts.source || null, ev, existing.id);
      return;
    }
    const { randomUUID } = await import("crypto");
    db.prepare(`INSERT INTO grimoire_lessons (id, organization_id, rubric_id, lesson, source, evidence_json, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), orgId, rubricId, opts.lesson, opts.source || null, ev, opts.dedupeKey);
  }

  /** Aposenta uma lição (active=0) quando a condição que a gerou some. */
  static async retireLesson(orgId: string, rubricId: string, dedupeKey: string): Promise<void> {
    const db = (await import("./db.js")).default;
    db.prepare(`UPDATE grimoire_lessons SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND rubric_id = ? AND dedupe_key = ?`).run(orgId, rubricId, dedupeKey);
  }
}
