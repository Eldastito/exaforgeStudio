/**
 * RetailCommissionPolicyService — ciclo de vida das POLÍTICAS de comissão (PRD Fase 1, F1.4a).
 *
 * Regra dura: "regra pendente nunca vira pagamento". A comissão consolidada e o run de pagamento
 * só leem política `active`/`confirmed` (`RetailCommissionRaceService.getPlan` em modo pagamento,
 * que é o DEFAULT). Uma interpretação de planilha por IA (F1.4b) ou qualquer rascunho entra aqui
 * como PROPOSTA — tabela própria, para NUNCA sobrescrever o plano vigente (a chave loja+mês é única
 * na tabela viva). Só um humano (owner/admin, na rota) confirma; ao confirmar, a proposta é PROMOVIDA
 * ao plano vivo (`savePlan`) com `confirmed_by`/`confirmed_at`. Pendente serve para PRÉVIA/simulação
 * (`raceMonth({ preview: true })`), nunca grava e vem rotulada.
 *
 * Estados da proposta: draft → pending_confirmation → confirmed (promovida) | archived.
 * Política viva: active | confirmed (pagam) | archived (não paga; cai na próxima precedência).
 * Nada é apagado (retenção): arquivar é UPDATE. Tudo isolado por organization_id.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { RetailCommissionRaceService } from "./RetailCommissionRaceService.js";

export type ProposalStatus = "draft" | "pending_confirmation" | "confirmed" | "archived";
const SOURCES = ["manual", "ai_import"];
const parse = (s: any) => { try { return JSON.parse(s ?? "null"); } catch { return null; } };
const shape = (r: any) => r && ({
  id: r.id, storeId: r.store_id === "*" ? null : r.store_id, month: r.year_month || null, status: r.status as ProposalStatus,
  source: r.source, sourceRef: r.source_ref || null, note: r.note || null, config: parse(r.config_json),
  createdBy: r.created_by || null, createdAt: r.created_at, submittedAt: r.submitted_at || null,
  confirmedBy: r.confirmed_by || null, confirmedAt: r.confirmed_at || null, archiveReason: r.archive_reason || null,
});

export class RetailCommissionPolicyService {
  private static row(orgId: string, id: string): any {
    return db.prepare(`SELECT * FROM retail_commission_policy_proposals WHERE organization_id = ? AND id = ?`).get(orgId, id);
  }
  private static must(orgId: string, id: string): any {
    const r = this.row(orgId, id);
    if (!r) throw new Error("Proposta não encontrada.");
    return r;
  }

  /** Cria a proposta (draft, ou já pending_confirmation com `submit`). NÃO toca no plano vigente. */
  static propose(orgId: string, input: { storeId?: string | null; month?: string | null; config: any; source?: string; sourceRef?: string | null; note?: string | null; submit?: boolean }, actorId?: string | null): any {
    RetailCommissionRaceService.assertPlanShape(input.config);
    const month = input.month ? String(input.month) : null;
    if (month && !/^\d{4}-\d{2}$/.test(month)) throw new Error("month deve ser YYYY-MM");
    const storeId = input.storeId ? String(input.storeId) : "*";
    if (storeId !== "*" && !db.prepare(`SELECT 1 FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId)) throw new Error("Loja não encontrada.");
    const source = input.source || "manual";
    if (!SOURCES.includes(source)) throw new Error(`source inválido (${SOURCES.join("|")}).`);
    const id = randomUUID();
    const status: ProposalStatus = input.submit ? "pending_confirmation" : "draft";
    db.prepare(
      `INSERT INTO retail_commission_policy_proposals (id, organization_id, store_id, year_month, config_json, status, source, source_ref, note, created_by, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${input.submit ? "CURRENT_TIMESTAMP" : "NULL"})`
    ).run(id, orgId, storeId, month, JSON.stringify(input.config), status, source, input.sourceRef ?? null, input.note ?? null, actorId || null);
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_COMMISSION_POLICY_PROPOSED", { storeId, month, source, status }); } catch { /* noop */ }
    return shape(this.row(orgId, id));
  }

  /** draft → pending_confirmation (pronta pra o dono revisar). */
  static submit(orgId: string, id: string, actorId?: string | null): any {
    const r = this.must(orgId, id);
    if (r.status !== "draft") throw new Error(`invalid_transition: só rascunho pode ser enviado (está ${r.status}).`);
    db.prepare(`UPDATE retail_commission_policy_proposals SET status = 'pending_confirmation', submitted_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(orgId, id);
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_COMMISSION_POLICY_SUBMITTED", {}); } catch { /* noop */ }
    return shape(this.row(orgId, id));
  }

  /**
   * pending_confirmation → confirmed: gesto HUMANO. Promove a proposta ao plano vivo (loja+mês ou
   * vigente) com `active` + `confirmed_by`. Transação única: ou promove e marca, ou nada muda.
   */
  static confirm(orgId: string, id: string, actorId: string | null): any {
    if (!actorId) throw new Error("confirm exige um usuário identificado.");
    const r = this.must(orgId, id);
    if (r.status !== "pending_confirmation") throw new Error(`invalid_transition: só política pendente de confirmação pode ser confirmada (está ${r.status}).`);
    const cfg = parse(r.config_json);
    RetailCommissionRaceService.assertPlanShape(cfg);
    db.transaction(() => {
      RetailCommissionRaceService.savePlan(orgId, r.store_id === "*" ? null : r.store_id, cfg, actorId, r.year_month || null, { status: "active", confirmedBy: actorId });
      db.prepare(`UPDATE retail_commission_policy_proposals SET status = 'confirmed', confirmed_by = ?, confirmed_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(actorId, orgId, id);
    })();
    try { logAuthEvent(orgId, actorId, id, "RETAIL_COMMISSION_POLICY_CONFIRMED", { storeId: r.store_id, month: r.year_month, source: r.source }); } catch { /* noop */ }
    return shape(this.row(orgId, id));
  }

  /** draft/pending → archived (recusada/descartada). Nunca apaga. */
  static archiveProposal(orgId: string, id: string, actorId?: string | null, reason?: string | null): any {
    const r = this.must(orgId, id);
    if (r.status === "confirmed" || r.status === "archived") throw new Error(`invalid_transition: proposta ${r.status} não pode ser arquivada.`);
    db.prepare(`UPDATE retail_commission_policy_proposals SET status = 'archived', archived_by = ?, archived_at = CURRENT_TIMESTAMP, archive_reason = ? WHERE organization_id = ? AND id = ?`).run(actorId || null, reason ? String(reason).slice(0, 300) : null, orgId, id);
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_COMMISSION_POLICY_ARCHIVED", { reason: reason || null }); } catch { /* noop */ }
    return shape(this.row(orgId, id));
  }

  /** Arquiva a política VIVA (loja+mês ou vigente): deixa de pagar; a precedência cai na seguinte. Reversível por savePlan. */
  static archiveLive(orgId: string, target: { storeId?: string | null; month?: string | null }, actorId?: string | null): { archived: boolean } {
    const sid = target.storeId ? String(target.storeId) : "*";
    const month = target.month ? String(target.month) : null;
    const r = month
      ? db.prepare(`UPDATE retail_commission_plan_months SET policy_status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND store_id = ? AND year_month = ? AND COALESCE(policy_status, 'active') <> 'archived'`).run(orgId, sid, month)
      : db.prepare(`UPDATE retail_commission_plans SET policy_status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND store_id = ? AND COALESCE(policy_status, 'active') <> 'archived'`).run(orgId, sid);
    if (r.changes > 0) { try { logAuthEvent(orgId, actorId || "system", sid, "RETAIL_COMMISSION_POLICY_LIVE_ARCHIVED", { storeId: sid, month }); } catch { /* noop */ } }
    return { archived: r.changes > 0 };
  }

  static list(orgId: string, opts: { month?: string | null; status?: string | null } = {}): { proposals: any[]; live: any[] } {
    const w: string[] = ["organization_id = ?"]; const a: any[] = [orgId];
    if (opts.month) { w.push("year_month = ?"); a.push(opts.month); }
    if (opts.status) { w.push("status = ?"); a.push(opts.status); }
    const proposals = (db.prepare(`SELECT * FROM retail_commission_policy_proposals WHERE ${w.join(" AND ")} ORDER BY created_at DESC, rowid DESC`).all(...a) as any[]).map(shape);
    const live = [
      ...(db.prepare(`SELECT store_id, year_month, policy_status, confirmed_by, confirmed_at FROM retail_commission_plan_months WHERE organization_id = ?${opts.month ? " AND year_month = ?" : ""}`).all(...(opts.month ? [orgId, opts.month] : [orgId])) as any[])
        .map((x) => ({ storeId: x.store_id === "*" ? null : x.store_id, month: x.year_month, status: x.policy_status || "active", confirmedBy: x.confirmed_by || null, confirmedAt: x.confirmed_at || null })),
      ...(opts.month ? [] : (db.prepare(`SELECT store_id, policy_status, confirmed_by, confirmed_at FROM retail_commission_plans WHERE organization_id = ?`).all(orgId) as any[])
        .map((x) => ({ storeId: x.store_id === "*" ? null : x.store_id, month: null, status: x.policy_status || "active", confirmedBy: x.confirmed_by || null, confirmedAt: x.confirmed_at || null }))),
    ];
    return { proposals, live };
  }
}

export default RetailCommissionPolicyService;
