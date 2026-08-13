import db from "./db.js";
import { randomUUID } from "crypto";
import { VerticalIntelligenceService, researchFingerprint } from "./VerticalIntelligenceService.js";

/**
 * ResearchBrokerService (ADR-156, DI-4.1) — a LEITURA do tenant. É READ-ONLY:
 * **nunca chama o provider** (D5 — só o admin master dispara pesquisa). Resolve
 * na ordem `L2 organization_contextualization (fresca?) → L3 vertical_intelligence
 * (fresca, por fingerprint)`; em hit L3, monta/atualiza a contextualização
 * por-org (isolada por organization_id) combinando o pacote do nicho com o
 * enquadramento da org. Sem pesquisa fresca do nicho → `{ available:false }`.
 *
 * Requer opt-in da org (`external_intelligence_enabled`). A contextualização
 * rica com evidência PRIVADA da org entra na DI-4.3; aqui o `context_json`
 * carrega só a referência + um enquadramento mínimo, e NUNCA volta ao
 * compartilhado (RN-156-1).
 *
 * DI-5.6 (ADR-157) — a leitura do tenant também devolve a TENDÊNCIA de mercado
 * (`trend`): o delta da última versão publicada do nicho vs a anterior
 * (novo/saiu/cresceu/retraiu + variação de confiança). É o mesmo delta que o
 * admin master já vê, agora surfaça no Diretor IA do lojista. Seguro por
 * construção: o delta deriva de `vertical_intelligence_history`, que é
 * COMPARTILHADO e por RN-157-1 nunca guarda PII/id de tenant — logo é só
 * inteligência de nicho anonimizada, nunca dado por-org. Read-only (nunca dispara
 * pesquisa). Ausente (`null`) na 1ª versão do nicho (não há "anterior").
 */

export class ResearchBrokerService {
  static isEnabled(orgId: string): boolean {
    const row = db.prepare("SELECT external_intelligence_enabled FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    return !!(row && row.external_intelligence_enabled);
  }

  /**
   * Resolve evidência externa para a org (read-only). Retorna
   * `{ available, source?, fingerprint, contextualization?, vertical?, reason? }`.
   */
  static resolve(orgId: string, input: { vertical: string; topic: string; region?: string; timeframe?: string }): any {
    const vertical = String(input?.vertical || "").trim();
    const topic = String(input?.topic || "").trim();
    if (!vertical || !topic) return { available: false, reason: "invalid_input" };
    if (!this.isEnabled(orgId)) return { available: false, reason: "opt_out" };

    const fingerprint = researchFingerprint(vertical, topic, input.region, input.timeframe);

    // L2 — contextualização por-org já existente e ainda fresca (o frescor segue
    // o valid_until da entrada compartilhada referenciada).
    const ctx = db.prepare(`
      SELECT c.*, v.valid_until AS vi_valid_until
      FROM organization_contextualization c
      JOIN vertical_intelligence v ON v.id = c.vertical_intelligence_id
      WHERE c.organization_id = ? AND c.fingerprint = ?
    `).get(orgId, fingerprint) as any;
    if (ctx && new Date(ctx.vi_valid_until).getTime() > Date.now()) {
      return { available: true, source: "organization_contextualization", cacheLevel: "L2", fingerprint, vertical, contextualization: hydrateCtx(ctx), trend: VerticalIntelligenceService.latestDelta(fingerprint) };
    }

    // L3 — entrada compartilhada fresca do nicho. NUNCA chama o provider.
    const vi = VerticalIntelligenceService.getFresh(vertical, topic, input.region, input.timeframe);
    if (!vi) return { available: false, reason: "no_fresh_vertical_intelligence", fingerprint, vertical };

    const contextualization = this.contextualize(orgId, vi, fingerprint);
    return { available: true, source: "vertical_intelligence", cacheLevel: "L3", fingerprint, vertical, contextualization, trend: VerticalIntelligenceService.latestDelta(fingerprint) };
  }

  /** Cria/atualiza a contextualização por-org (upsert por org+fingerprint). */
  private static contextualize(orgId: string, vi: any, fingerprint: string): any {
    const context = {
      note: `Inteligência do nicho ${vi.vertical} aplicada à sua operação.`,
      verticalIntelligenceId: vi.id,
      summary: vi.content?.summary ?? null,
      confidence: vi.confidence,
      validUntil: vi.valid_until,
    };
    const existing = db.prepare("SELECT id FROM organization_contextualization WHERE organization_id = ? AND fingerprint = ?").get(orgId, fingerprint) as any;
    const id = existing?.id || randomUUID();
    db.prepare(`
      INSERT INTO organization_contextualization (id, organization_id, vertical_intelligence_id, fingerprint, vertical, topic, context_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(organization_id, fingerprint) DO UPDATE SET
        vertical_intelligence_id=excluded.vertical_intelligence_id, vertical=excluded.vertical,
        topic=excluded.topic, context_json=excluded.context_json, updated_at=CURRENT_TIMESTAMP
    `).run(id, orgId, vi.id, fingerprint, vi.vertical, vi.topic, JSON.stringify(context));
    return { id, organization_id: orgId, vertical_intelligence_id: vi.id, fingerprint, vertical: vi.vertical, topic: vi.topic, context };
  }

  /** Lista as contextualizações de uma org (isolado). */
  static list(orgId: string): any[] {
    return (db.prepare("SELECT * FROM organization_contextualization WHERE organization_id = ? ORDER BY updated_at DESC LIMIT 200").all(orgId) as any[]).map(hydrateCtx);
  }
}

function hydrateCtx(row: any): any {
  return { ...row, context: safeParse(row.context_json) };
}
function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }

export default ResearchBrokerService;
