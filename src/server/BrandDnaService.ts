import db from "./db.js";
import { randomUUID } from "node:crypto";

/**
 * BrandDnaService — Brand DNA 2.0 (PRD 11 / ADR-168 F1).
 *
 * O PRD 10 deixou a identidade de marca RASA e em DOIS stores desconectados:
 *  - `brand_profiles` (palette/tone/style/summary) — a identidade VISUAL do Estúdio;
 *  - `organization_settings.brand_voice_context` (ADR-155) — a VOZ de copy do grimoire.
 * O Estúdio não lê a voz; o grimoire não lê o visual. Este serviço UNIFICA os dois numa
 * leitura estruturada única e ADICIONA os campos que faltavam (persona / público-alvo /
 * posicionamento / proibições / exemplos do-don't), com VERSIONAMENTO (histórico + rollback).
 *
 * Decisões (ADR-168):
 *  - D5 — ESTENDE `brand_profiles`; NÃO cria 2º store de marca (§37). A voz continua sendo
 *    `brand_voice_context` (fonte ÚNICA) — aqui só a expomos unificada e a escrevemos por um
 *    caminho único (`GrimoireService.setBrandVoice`), nunca duplicada.
 *  - Read-only por default; escrita só via `save`/`restore` (owner/admin na rota).
 *
 * Guardrails:
 *  - RN-CG-09 — Brand DNA NUNCA inventa: `save` só grava o que foi passado; `get` devolve
 *    null/[] pro que está vazio (nunca preenche com placeholder). `completeness` é derivado
 *    (RN-004), honesto sobre o que falta.
 *  - convenção nº 1 — isolamento por `organization_id` em toda query.
 *  - convenção nº 3 — cada `save` congela um SNAPSHOT canônico da versão (rollback/auditoria).
 */

export interface BrandDna {
  // Identidade visual (já existia em brand_profiles).
  palette: string[];
  tone: string | null;
  style: string | null;
  summary: string | null;
  // Voz de copy — UNIFICADA de organization_settings.brand_voice_context (ADR-155).
  voice: string | null;
  voiceEnabled: boolean;
  // Identidade estruturada (novo na F1).
  persona: string | null;
  audience: string | null;
  positioning: string | null;
  forbidden: string[];      // palavras/temas que a marca NÃO usa
  doExamples: string[];     // exemplos do que fazer
  dontExamples: string[];   // exemplos do que evitar
  // Metadados.
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  completeness: number;     // 0..1 — fração de campos de identidade preenchidos (derivado)
}

/** Campos textuais/estruturados que o usuário pode setar (voz tratada à parte). */
export interface BrandDnaPatch {
  palette?: string[];
  tone?: string | null;
  style?: string | null;
  summary?: string | null;
  voice?: string | null;        // escrita → brand_voice_context (fonte única)
  voiceEnabled?: boolean;
  persona?: string | null;
  audience?: string | null;
  positioning?: string | null;
  forbidden?: string[];
  doExamples?: string[];
  dontExamples?: string[];
}

function parseArr(json: any): string[] {
  if (!json) return [];
  try {
    const v = typeof json === "string" ? JSON.parse(json) : json;
    return Array.isArray(v) ? v.map((x) => String(x)).filter((s) => s.trim().length > 0) : [];
  } catch { return []; }
}
function cleanArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter((s) => s.length > 0);
}
function nz(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

// Campos de identidade contados no `completeness` (visual+voz+estruturado). Palette conta
// como preenchido quando tem ≥1 cor; arrays quando têm ≥1 item.
const IDENTITY_KEYS = [
  "palette", "tone", "style", "summary", "voice",
  "persona", "audience", "positioning", "forbidden", "doExamples", "dontExamples",
] as const;

export class BrandDnaService {
  /** Leitura estruturada e UNIFICADA da identidade da marca. Honesta (null/[] sem dado). */
  static async get(orgId: string): Promise<BrandDna> {
    const r = db.prepare(
      `SELECT palette, tone, style, summary, persona, audience, positioning,
              forbidden_json, do_examples_json, dont_examples_json,
              dna_version, dna_updated_at, dna_updated_by
       FROM brand_profiles WHERE organization_id = ?`
    ).get(orgId) as any;

    // Voz vem do store canônico da ADR-155 (fonte ÚNICA — não duplicada aqui).
    let voice: string | null = null; let voiceEnabled = false;
    try {
      const { GrimoireService } = await import("./GrimoireService.js");
      const bv = await GrimoireService.getBrandVoice(orgId);
      voice = nz(bv.context); voiceEnabled = !!bv.enabled;
    } catch { /* grimoire ausente → voz honesta null */ }

    const dna: BrandDna = {
      palette: parseArr(r?.palette),
      tone: nz(r?.tone),
      style: nz(r?.style),
      summary: nz(r?.summary),
      voice,
      voiceEnabled,
      persona: nz(r?.persona),
      audience: nz(r?.audience),
      positioning: nz(r?.positioning),
      forbidden: parseArr(r?.forbidden_json),
      doExamples: parseArr(r?.do_examples_json),
      dontExamples: parseArr(r?.dont_examples_json),
      version: Number(r?.dna_version || 0),
      updatedAt: r?.dna_updated_at || null,
      updatedBy: r?.dna_updated_by || null,
      completeness: 0,
    };
    dna.completeness = this.completenessOf(dna);
    return dna;
  }

  /** Fração de campos de identidade preenchidos (derivado — honesto sobre o que falta). */
  static completenessOf(dna: BrandDna): number {
    let filled = 0;
    for (const k of IDENTITY_KEYS) {
      const v = (dna as any)[k];
      if (Array.isArray(v)) { if (v.length > 0) filled++; }
      else if (v !== null && v !== undefined && String(v).trim().length > 0) filled++;
    }
    return Math.round((filled / IDENTITY_KEYS.length) * 100) / 100;
  }

  /**
   * Grava um patch PARCIAL (RN-CG-09 — só toca os campos passados, nunca inventa). Sobe a
   * versão, congela um snapshot canônico e devolve o DNA resultante. A voz, quando passada,
   * vai pro `brand_voice_context` (fonte única) — mantendo os stores unificados.
   */
  static async save(orgId: string, actorId: string | null, patch: BrandDnaPatch): Promise<BrandDna> {
    if (!orgId) throw new Error("orgId obrigatório");
    // 1. Voz → store canônico da ADR-155 (não duplica).
    if (patch.voice !== undefined || patch.voiceEnabled !== undefined) {
      try {
        const { GrimoireService } = await import("./GrimoireService.js");
        await GrimoireService.setBrandVoice(orgId, {
          ...(patch.voice !== undefined ? { context: patch.voice } : {}),
          ...(patch.voiceEnabled !== undefined ? { enabled: patch.voiceEnabled } : {}),
        });
      } catch { /* grimoire ausente → ignora voz (visual/estruturado seguem) */ }
    }

    // 2. Campos de brand_profiles (visual + estruturado). Upsert garante a linha.
    db.prepare(
      `INSERT INTO brand_profiles (organization_id, dna_version) VALUES (?, 0)
       ON CONFLICT(organization_id) DO NOTHING`
    ).run(orgId);

    const sets: string[] = []; const vals: unknown[] = [];
    const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
    if (patch.palette !== undefined) put("palette", JSON.stringify(cleanArr(patch.palette)));
    if (patch.tone !== undefined) put("tone", nz(patch.tone) ?? "");
    if (patch.style !== undefined) put("style", nz(patch.style) ?? "");
    if (patch.summary !== undefined) put("summary", nz(patch.summary) ?? "");
    if (patch.persona !== undefined) put("persona", nz(patch.persona));
    if (patch.audience !== undefined) put("audience", nz(patch.audience));
    if (patch.positioning !== undefined) put("positioning", nz(patch.positioning));
    if (patch.forbidden !== undefined) put("forbidden_json", JSON.stringify(cleanArr(patch.forbidden)));
    if (patch.doExamples !== undefined) put("do_examples_json", JSON.stringify(cleanArr(patch.doExamples)));
    if (patch.dontExamples !== undefined) put("dont_examples_json", JSON.stringify(cleanArr(patch.dontExamples)));

    const current = Number((db.prepare(`SELECT dna_version FROM brand_profiles WHERE organization_id = ?`).get(orgId) as any)?.dna_version || 0);
    const nextVersion = current + 1;
    put("dna_version", nextVersion);
    put("dna_updated_at", new Date().toISOString());
    put("dna_updated_by", actorId || null);
    // `updated_at` do visual também, pra manter a semântica antiga.
    sets.push("updated_at = CURRENT_TIMESTAMP");

    db.prepare(`UPDATE brand_profiles SET ${sets.join(", ")} WHERE organization_id = ?`).run(...(vals as any[]), orgId);

    // 3. Snapshot canônico da nova versão (rollback/auditoria).
    const dna = await this.get(orgId);
    try {
      db.prepare(
        `INSERT INTO brand_dna_versions (id, organization_id, version, snapshot_json, created_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(organization_id, version) DO NOTHING`
      ).run(randomUUID(), orgId, nextVersion, JSON.stringify(dna), actorId || null);
    } catch { /* best-effort: o snapshot é histórico, não bloqueia o save */ }
    return dna;
  }

  /** Histórico de versões (mais recente primeiro) — metadados, sem o snapshot inteiro. */
  static versions(orgId: string): Array<{ version: number; createdAt: string; createdBy: string | null }> {
    return (db.prepare(
      `SELECT version, created_at, created_by FROM brand_dna_versions
       WHERE organization_id = ? ORDER BY version DESC`
    ).all(orgId) as any[]).map((r) => ({ version: Number(r.version), createdAt: r.created_at, createdBy: r.created_by || null }));
  }

  /** Snapshot congelado de uma versão específica (para inspeção/diff). */
  static snapshot(orgId: string, version: number): BrandDna | null {
    const r = db.prepare(
      `SELECT snapshot_json FROM brand_dna_versions WHERE organization_id = ? AND version = ?`
    ).get(orgId, version) as any;
    if (!r) return null;
    try { return JSON.parse(r.snapshot_json) as BrandDna; } catch { return null; }
  }

  /**
   * Restaura uma versão anterior — NÃO rebobina o contador: aplica o conteúdo do snapshot
   * como um NOVO save (nova versão), preservando todo o histórico (convenção nº 9).
   */
  static async restore(orgId: string, actorId: string | null, version: number): Promise<BrandDna> {
    const snap = this.snapshot(orgId, version);
    if (!snap) throw new Error("Versão não encontrada.");
    return this.save(orgId, actorId, {
      palette: snap.palette, tone: snap.tone, style: snap.style, summary: snap.summary,
      voice: snap.voice, voiceEnabled: snap.voiceEnabled,
      persona: snap.persona, audience: snap.audience, positioning: snap.positioning,
      forbidden: snap.forbidden, doExamples: snap.doExamples, dontExamples: snap.dontExamples,
    });
  }
}
