/**
 * ReputationClosureService (ADR-162 / PRD 5 §31, §11.10, F10) — RÉPLICA + FECHAMENTO,
 * a ponta que fecha o ciclo aberto na F8 (resposta pública). Reusa dedupe/correlação/
 * confirmação — sem entidade nova (D1/§5):
 *
 *   - RÉPLICA (§31): `syncReplies` lê `provider.getReplies/getStatus` do MESMO item e
 *     grava as respostas do CONSUMIDOR no próprio caso (evidência do sinal, cercada como
 *     `untrusted_external_data` §11 — não é instrução). Uma réplica NOVA do consumidor num
 *     caso já fechado REABRE o caso (`status='open'` → volta ao attention feed) — a
 *     réplica pertence ao MESMO caso, nunca abre outro.
 *   - FECHAMENTO (§11.10): `close` marca o sinal resolvido/reconhecido e CONFIRMA a
 *     `reputation_reply` que a F8 armou (`ConfirmationEngine.confirm` → a `decision_action`
 *     da resposta fecha em `done` com outcome — o loop "respondeu → resolveu de fato"). A
 *     operação não estava concluída só porque respondeu; agora está.
 *
 * Determinístico (roda em CI com o stub). Isolado por org (RN-CRR-9). Conteúdo externo
 * SEMPRE cercado (RN-CRR-1).
 */
import db from "./db.js";
import { ReputationConnectorService } from "./ReputationConnectorService.js";
import { ConfirmationEngine } from "./ConfirmationEngine.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { ContextGuardService } from "./ContextGuardService.js";

interface CaseRow { id: string; correlationId: string; source: string | null; itemExternalId: string | null; status: string; evidence: any; }

export interface ReplySyncResult {
  signalId: string;
  itemStatus: string;
  totalReplies: number;
  newConsumerReplies: Array<{ externalId: string; content: string; suspicious: boolean; publishedAt: string | null }>;
  resolvedByProvider: boolean;
  reopened: boolean;
  degraded?: boolean;
}

export interface CloseResult { signalId: string; resolution: "resolved" | "not_resolved"; signalStatus: string; confirmed: string[]; dismissed: string[]; }

export class ReputationClosureService {
  private static load(orgId: string, signalId: string): CaseRow | null {
    const r = db.prepare(
      `SELECT id, correlation_id, source_entity_type, source_entity_id, status, evidence_json FROM business_signals
       WHERE organization_id = ? AND id = ? AND domain = 'reputation'`
    ).get(orgId, signalId) as any;
    if (!r) return null;
    let evidence: any = {}; try { evidence = JSON.parse(r.evidence_json || "{}"); } catch { evidence = {}; }
    return { id: r.id, correlationId: r.correlation_id || r.id, source: r.source_entity_type || null, itemExternalId: r.source_entity_id || null, status: r.status, evidence };
  }

  /**
   * RÉPLICA (§31): lê respostas/status do provider e grava as réplicas do consumidor no
   * caso (deduped por externalId da réplica, cercadas §11). Réplica nova de consumidor
   * num caso fechado REABRE o caso. Provider indisponível → degrada (nunca perde o caso).
   */
  static async syncReplies(orgId: string, signalId: string, opts: { provider?: string } = {}): Promise<ReplySyncResult | null> {
    const c = this.load(orgId, signalId);
    if (!c) return null;
    const itemExternalId = c.itemExternalId || signalId;
    const provider = opts.provider || c.source || "reclame_aqui";
    const prov = ReputationConnectorService.providerFor(orgId, provider);

    let replies: any[] = []; let itemStatus = "unknown"; let degraded = false;
    try {
      replies = (await prov.getReplies(itemExternalId)) || [];
      itemStatus = (await prov.getStatus(itemExternalId)) || "unknown";
    } catch { degraded = true; }

    const ev = c.evidence || {};
    const existing: any[] = Array.isArray(ev.replies) ? ev.replies : [];
    const seen = new Set(existing.map((r) => r.externalId));
    const newConsumerReplies: ReplySyncResult["newConsumerReplies"] = [];
    for (const r of replies) {
      if (!r?.externalId || seen.has(r.externalId)) continue;
      // Conteúdo externo do consumidor SEMPRE cercado (RN-CRR-1/§11).
      const f = ContextGuardService.fence(String(r.content || ""), { source: String(provider) });
      const rec = { externalId: r.externalId, authorType: r.authorType || "unknown", content: f.fenced, suspicious: f.suspicious, publishedAt: r.publishedAt || null };
      existing.push(rec);
      if (rec.authorType === "consumer") newConsumerReplies.push({ externalId: rec.externalId, content: rec.content, suspicious: rec.suspicious, publishedAt: rec.publishedAt });
    }
    ev.replies = existing;

    // Réplica NOVA do consumidor num caso fechado → REABRE (§31 — mesmo caso).
    let reopened = false;
    if (newConsumerReplies.length && ["resolved", "acknowledged"].includes(c.status)) {
      db.prepare(`UPDATE business_signals SET status = 'open' WHERE organization_id = ? AND id = ?`).run(orgId, signalId);
      reopened = true;
    }
    db.prepare(`UPDATE business_signals SET evidence_json = ? WHERE organization_id = ? AND id = ?`).run(JSON.stringify(ev), orgId, signalId);

    return { signalId, itemStatus, totalReplies: existing.length, newConsumerReplies, resolvedByProvider: ["resolved", "closed"].includes(itemStatus), reopened, degraded };
  }

  /**
   * FECHAMENTO (§11.10): marca o sinal e fecha o loop da resposta. `resolved` →
   * confirma a `reputation_reply` (F8) de cada ação de resposta do caso (a ação fecha em
   * `done` com outcome); `not_resolved` → reconhece o sinal e dispensa a confirmação
   * pendente (a resposta não resolveu — sem inventar desfecho).
   */
  static close(orgId: string, signalId: string, input: { resolution: "resolved" | "not_resolved"; actorId?: string | null; note?: string }): CloseResult | null {
    const c = this.load(orgId, signalId);
    if (!c) return null;
    const replyActions = db.prepare(
      `SELECT id FROM decision_actions WHERE organization_id = ? AND correlation_id = ? AND command_type = 'reputation_publish_reply'`
    ).all(orgId, c.correlationId) as any[];

    const confirmed: string[] = []; const dismissed: string[] = [];
    if (input.resolution === "resolved") {
      BusinessSignalService.resolve(orgId, signalId);
      for (const a of replyActions) {
        const conf = ConfirmationEngine.getForAction(orgId, a.id);
        if (conf && conf.status === "pending") {
          ConfirmationEngine.confirm(orgId, a.id, { evidence: { closedBy: input.actorId || null, resolution: "resolved", note: input.note || null }, actorId: input.actorId || undefined });
          confirmed.push(a.id);
        }
      }
      return { signalId, resolution: "resolved", signalStatus: "resolved", confirmed, dismissed };
    }
    // not_resolved — reconhece (visto/tratado, não resolvido) e dispensa a pendência.
    BusinessSignalService.acknowledge(orgId, signalId);
    for (const a of replyActions) {
      const conf = ConfirmationEngine.getForAction(orgId, a.id);
      if (conf && conf.status === "pending") { ConfirmationEngine.dismiss(orgId, a.id, { reason: "case_not_resolved", actorId: input.actorId || undefined }); dismissed.push(a.id); }
    }
    return { signalId, resolution: "not_resolved", signalStatus: "acknowledged", confirmed, dismissed };
  }
}

export default ReputationClosureService;
