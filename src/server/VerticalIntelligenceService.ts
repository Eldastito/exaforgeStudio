import db from "./db.js";
import { randomUUID, createHash } from "crypto";
import { getResearchProvider, ExternalResearchProvider } from "./ExternalResearchProvider.js";
import { sanitizeForShared } from "./researchAnonymize.js";

/**
 * VerticalIntelligenceService (ADR-156, DI-4.1) — a ESCRITA da camada
 * COMPARTILHADA `vertical_intelligence`. Quem roda a pesquisa é o **admin master
 * / scheduler** (D5), NUNCA a conta do tenant — por isso este serviço não recebe
 * `orgId` e não toca em nenhuma tabela por-org.
 *
 * A query externa é montada SÓ de (vertical, topic, region, timeframe)
 * (RN-156-2); o resultado passa pelo filtro de anonimização (RN-156-3) antes de
 * gravar; dedup por `fingerprint` (1 pesquisa por nicho — PRD §29); `valid_until`
 * dá o TTL/freshness (cadência semanal por vertical via Scheduler, ADR-074).
 */

const DEFAULT_TTL_DAYS = 7;

/** fingerprint(vertical|topic|region|timeframe) — normalizado, determinístico. */
export function researchFingerprint(vertical: string, topic: string, region?: string, timeframe?: string): string {
  const norm = (s?: string) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const key = [norm(vertical), norm(topic), norm(region), norm(timeframe)].join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export class VerticalIntelligenceService {
  /**
   * Roda (ou atualiza) a pesquisa de um nicho e grava no compartilhado. SÓ admin
   * master/scheduler. `opts.provider` permite injetar um provider (teste/DI);
   * senão resolve por nome/env. Async (provider pode ser assíncrono).
   */
  static async runResearch(
    actor: { userId?: string | null; organizationId?: string | null } | null,
    input: { vertical: string; topic: string; region?: string; timeframe?: string; ttlDays?: number },
    opts: { provider?: ExternalResearchProvider; providerName?: string } = {},
  ): Promise<any> {
    const vertical = String(input?.vertical || "").trim();
    const topic = String(input?.topic || "").trim();
    if (!vertical || !topic) throw new Error("vertical e topic são obrigatórios.");
    const region = input.region ? String(input.region).trim() : null;
    const timeframe = input.timeframe ? String(input.timeframe).trim() : null;

    // Query derivada SÓ da taxonomia do nicho (RN-156-2) — nunca de dado de tenant.
    const query = [vertical, topic, region, timeframe].filter(Boolean).join(" ");
    const provider = opts.provider || getResearchProvider(opts.providerName);
    const result = await provider.research({ vertical, topic, region: region || undefined, timeframe: timeframe || undefined, query });

    // Anonimização ANTES de persistir no compartilhado (RN-156-3).
    const safeContent = sanitizeForShared(result?.content ?? {}, []);
    const sources = Array.isArray(result?.sources) ? result.sources : [];
    const confidence = Math.max(0, Math.min(1, Number(result?.confidence) || 0));

    const fingerprint = researchFingerprint(vertical, topic, region || undefined, timeframe || undefined);
    const ttlDays = Math.max(1, Math.min(365, Number(input.ttlDays) || DEFAULT_TTL_DAYS));

    const existing = db.prepare("SELECT id FROM vertical_intelligence WHERE fingerprint = ?").get(fingerprint) as any;
    const id = existing?.id || randomUUID();
    db.prepare(`
      INSERT INTO vertical_intelligence (id, fingerprint, vertical, topic, region, timeframe, content_json, sources_json, confidence, provider, created_by, generated_at, valid_until, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, datetime('now', ?), CURRENT_TIMESTAMP)
      ON CONFLICT(fingerprint) DO UPDATE SET
        content_json=excluded.content_json, sources_json=excluded.sources_json, confidence=excluded.confidence,
        provider=excluded.provider, created_by=excluded.created_by, generated_at=CURRENT_TIMESTAMP,
        valid_until=excluded.valid_until, updated_at=CURRENT_TIMESTAMP
    `).run(id, fingerprint, vertical, topic, region, timeframe, JSON.stringify(safeContent), JSON.stringify(sources), confidence, provider.name, actor?.userId || "admin", `+${ttlDays} days`);

    try {
      const { logAuthEvent } = await import("./auditLog.js");
      logAuthEvent(actor?.organizationId || null, actor?.userId || null, null, "VERTICAL_INTELLIGENCE_RUN", { vertical, topic, region, timeframe, fingerprint, provider: provider.name });
    } catch { /* auditoria best-effort */ }

    return this.getByFingerprint(fingerprint);
  }

  /** Entrada compartilhada por fingerprint (ou null). `fresh` calculado. */
  static getByFingerprint(fingerprint: string): any | null {
    const row = db.prepare("SELECT * FROM vertical_intelligence WHERE fingerprint = ?").get(fingerprint) as any;
    return row ? hydrate(row) : null;
  }

  /** Entrada FRESCA para o nicho (valid_until > agora), ou null. */
  static getFresh(vertical: string, topic: string, region?: string, timeframe?: string): any | null {
    const fp = researchFingerprint(vertical, topic, region, timeframe);
    const row = db.prepare("SELECT * FROM vertical_intelligence WHERE fingerprint = ? AND valid_until > CURRENT_TIMESTAMP").get(fp) as any;
    return row ? hydrate(row) : null;
  }

  /** Lista entradas compartilhadas (opcional por vertical). Não tem org. */
  static list(opts: { vertical?: string } = {}): any[] {
    let sql = "SELECT * FROM vertical_intelligence";
    const params: any[] = [];
    if (opts.vertical) { sql += " WHERE vertical = ?"; params.push(opts.vertical); }
    sql += " ORDER BY generated_at DESC LIMIT 200";
    return (db.prepare(sql).all(...params) as any[]).map(hydrate);
  }
}

function hydrate(row: any): any {
  return {
    ...row,
    content: safeParse(row.content_json),
    sources: row.sources_json ? safeParse(row.sources_json) : [],
    fresh: new Date(row.valid_until).getTime() > Date.now(),
  };
}
function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }

export default VerticalIntelligenceService;
