import db from "./db.js";
import { randomUUID, createHash } from "crypto";
import { getResearchProvider, ExternalResearchProvider } from "./ExternalResearchProvider.js";
import { sanitizeForShared } from "./researchAnonymize.js";
import { ResearchBudgetService } from "./ResearchBudgetService.js";
import { ResearchCuratorService } from "./ResearchCuratorService.js";
import { logAuthEvent } from "./auditLog.js";

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

    // Guardrail de orçamento de plataforma (DI-4.2): recusa ANTES de chamar o
    // provider se o teto mensal já estourou (o stub custa 0 e nunca bloqueia).
    if (!ResearchBudgetService.canSpend()) {
      const st = ResearchBudgetService.status();
      const err: any = new Error(`budget_exceeded: orçamento de pesquisa do mês esgotado (gasto ${st.spentCents}c / teto ${st.budgetCents}c).`);
      err.code = "budget_exceeded";
      throw err;
    }

    // Query derivada SÓ da taxonomia do nicho (RN-156-2) — nunca de dado de tenant.
    const query = [vertical, topic, region, timeframe].filter(Boolean).join(" ");
    const provider = opts.provider || getResearchProvider(opts.providerName);
    const result = await provider.research({ vertical, topic, region: region || undefined, timeframe: timeframe || undefined, query });

    // Registra o custo da chamada no ledger de plataforma (derivação do gasto).
    ResearchBudgetService.record({ fingerprint: researchFingerprint(vertical, topic, region || undefined, timeframe || undefined), vertical, topic, provider: provider.name, costCents: Number(result?.costCents) || 0 });

    // Persiste no compartilhado (anonimiza + dedup + audita).
    return this.publish(actor, {
      vertical, topic, region, timeframe,
      content: result?.content ?? {},
      sources: Array.isArray(result?.sources) ? result.sources : [],
      confidence: Number(result?.confidence) || 0,
      provider: provider.name, ttlDays: input.ttlDays,
    });
  }

  /**
   * Provider MANUAL (DI-4.4) — o admin master COLA a pesquisa do nicho, SEM rede
   * externa. Passa pelo MESMO filtro de anonimização (RN-156-3) antes de gravar;
   * custo zero (não chama provider), logo não toca no orçamento. É a opção mais
   * segura: nenhuma chamada live, o admin cura o texto.
   */
  static runManual(
    actor: { userId?: string | null; organizationId?: string | null } | null,
    input: { vertical: string; topic: string; region?: string; timeframe?: string; summary: string; drivers?: string[]; sources?: string[]; confidence?: number; ttlDays?: number },
  ): any {
    const vertical = String(input?.vertical || "").trim();
    const topic = String(input?.topic || "").trim();
    const summary = String(input?.summary || "").trim();
    if (!vertical || !topic) throw new Error("vertical e topic são obrigatórios.");
    if (!summary) throw new Error("summary (o texto da pesquisa) é obrigatório.");
    const content = { summary, drivers: Array.isArray(input.drivers) ? input.drivers.map((d) => String(d)) : [], generatedBy: "manual" };
    return this.publish(actor, {
      vertical, topic,
      region: input.region ? String(input.region).trim() : null,
      timeframe: input.timeframe ? String(input.timeframe).trim() : null,
      content,
      sources: Array.isArray(input.sources) ? input.sources.map((s) => String(s)) : [],
      confidence: input.confidence != null ? Number(input.confidence) : 0.6,
      provider: "manual", ttlDays: input.ttlDays,
    });
  }

  /**
   * Publica (upsert) uma entrada CURADA no compartilhado: anonimiza (RN-157-1,
   * sempre DEPOIS da curadoria) + dedup + versiona no histórico (DI-5.2) + audita.
   * Público desde a DI-5.3 para o `ResearchCuratorService.curate` publicar um
   * pacote já aprovado sem reimplementar anonimização/versionamento.
   */
  static publish(
    actor: { userId?: string | null; organizationId?: string | null } | null,
    p: { vertical: string; topic: string; region?: string | null; timeframe?: string | null; content: any; sources: string[]; confidence: number; provider: string; ttlDays?: number },
  ): any {
    const region = p.region ?? null;
    const timeframe = p.timeframe ?? null;
    // Anonimização ANTES de persistir no compartilhado (RN-156-3) — vale também
    // para o texto colado pelo admin no provider manual.
    const safeContent = sanitizeForShared(p.content ?? {}, []);
    const confidence = Math.max(0, Math.min(1, Number(p.confidence) || 0));
    const fingerprint = researchFingerprint(p.vertical, p.topic, region || undefined, timeframe || undefined);
    const ttlDays = Math.max(1, Math.min(365, Number(p.ttlDays) || DEFAULT_TTL_DAYS));

    const existing = db.prepare("SELECT id, content_json, confidence FROM vertical_intelligence WHERE fingerprint = ?").get(fingerprint) as any;
    const id = existing?.id || randomUUID();

    // DI-5.2 — versiona no histórico ANTES de sobrescrever o head: o conteúdo que
    // estava no head é a "versão anterior" para o delta. safeContent (já
    // anonimizado) é o que vai tanto pro head quanto pro histórico (RN-157-1: o
    // histórico compartilhado nunca guarda PII). A confiança do head mora na
    // coluna `confidence` (não no content), então é injetada no content pro delta.
    // Best-effort: um erro aqui nunca pode travar a publicação (convenção nº 7).
    try {
      const prevContent = existing?.content_json
        ? { ...safeParse(existing.content_json), confidence: Number(existing.confidence) || 0 }
        : null;
      const delta = ResearchCuratorService.computeDelta(
        prevContent,
        { ...safeContent, confidence },
      );
      const nextVersion = (db.prepare("SELECT COALESCE(MAX(version),0) v FROM vertical_intelligence_history WHERE fingerprint = ?").get(fingerprint) as any).v + 1;
      db.prepare(`
        INSERT INTO vertical_intelligence_history (id, fingerprint, vertical, topic, version, content_json, sources_json, confidence, delta_json, provider, generated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(randomUUID(), fingerprint, p.vertical, p.topic, nextVersion, JSON.stringify(safeContent), JSON.stringify(p.sources), confidence, JSON.stringify(delta), p.provider);
    } catch (e) { /* histórico best-effort; não trava o publish */ }

    db.prepare(`
      INSERT INTO vertical_intelligence (id, fingerprint, vertical, topic, region, timeframe, content_json, sources_json, confidence, provider, created_by, generated_at, valid_until, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, datetime('now', ?), CURRENT_TIMESTAMP)
      ON CONFLICT(fingerprint) DO UPDATE SET
        content_json=excluded.content_json, sources_json=excluded.sources_json, confidence=excluded.confidence,
        provider=excluded.provider, created_by=excluded.created_by, generated_at=CURRENT_TIMESTAMP,
        valid_until=excluded.valid_until, updated_at=CURRENT_TIMESTAMP
    `).run(id, fingerprint, p.vertical, p.topic, region, timeframe, JSON.stringify(safeContent), JSON.stringify(p.sources), confidence, p.provider, actor?.userId || "admin", `+${ttlDays} days`);

    try { logAuthEvent(actor?.organizationId || null, actor?.userId || null, null, "VERTICAL_INTELLIGENCE_RUN", { vertical: p.vertical, topic: p.topic, region, timeframe, fingerprint, provider: p.provider }); } catch { /* auditoria best-effort */ }

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

  /**
   * DI-5.2 — histórico versionado de um nicho (mais recente 1º). Cada linha traz
   * o `delta` já parseado (o que mudou vs a versão anterior). Compartilhado, sem
   * org. `limit` limita a leitura (default 50).
   */
  static history(fingerprint: string, limit = 50): any[] {
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    const rows = db.prepare("SELECT * FROM vertical_intelligence_history WHERE fingerprint = ? ORDER BY version DESC LIMIT ?").all(fingerprint, n) as any[];
    return rows.map(hydrateHistory);
  }

  /** DI-5.2 — o delta da versão mais recente do nicho (ou null se só há a 1ª/nenhuma). */
  static latestDelta(fingerprint: string): any | null {
    const row = db.prepare("SELECT delta_json FROM vertical_intelligence_history WHERE fingerprint = ? ORDER BY version DESC LIMIT 1").get(fingerprint) as any;
    return row?.delta_json ? safeParse(row.delta_json) : null;
  }
}

function hydrateHistory(row: any): any {
  return {
    ...row,
    content: safeParse(row.content_json),
    sources: row.sources_json ? safeParse(row.sources_json) : [],
    delta: row.delta_json ? safeParse(row.delta_json) : null,
  };
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
