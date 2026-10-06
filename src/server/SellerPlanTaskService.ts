import db from "./db.js";
import { SellerRecommendationService } from "./SellerRecommendationService.js";
import { TaskService } from "./TaskService.js";
import { RetailSellerIdentityService } from "./RetailSellerIdentityService.js";
import { ApprovalPolicyService } from "./ApprovalPolicyService.js";
import { logAuthEvent } from "./auditLog.js";

/**
 * SellerPlanTaskService — transforma itens do plano de 14 dias em TAREFAS do gerente (ADR-204 F3.5), mas SÓ por decisão de uma
 * PESSOA: o plano é recomendação (read-only, `SellerRecommendationService`); criar a tarefa é o "aprovar" do gestor.
 *
 *  - O plano é RECALCULADO aqui no servidor — o cliente só escolhe CHAVES de itens; nunca se confia no texto vindo de fora.
 *  - Quem aprova precisa ser uma pessoa identificada; rótulo de sistema (runtime/ai/rule…) é recusado (RN-F3-3).
 *  - Idempotente: `occurrence_dedupe_key` = `seller_plan14:<vendedor>:<data-ref>:<item>` (índice único parcial de `tasks`) — pedir
 *    de novo não duplica; o item repetido volta em `skipped`.
 *  - Responsável: o gerente da loja da pessoa; sem gerente cadastrado, quem aprovou. Responsável fora da empresa é recusado.
 *  - Nada aqui mexe em comissão, salário, meta oficial ou cobrança; a tarefa é trabalho do gerente (conversa/observação).
 *  - Cada criação fica na auditoria (quem aprovou, qual plano, quais itens). Isolado por organização.
 */
export class SellerPlanTaskService {
  static create(orgId: string, input: { sellerId: string; refDate: string; itemKeys: string[]; assignedTo?: string | null }, approvedBy: string | null | undefined): { ok: boolean; error?: string; created: any[]; skipped: any[] } {
    const by = String(approvedBy || "").trim();
    if (!by) return { ok: false, error: "A aprovação exige uma pessoa identificada.", created: [], skipped: [] };
    if (ApprovalPolicyService.isSystemActor(by)) return { ok: false, error: "Só uma pessoa aprova tarefas do plano — a IA só recomenda.", created: [], skipped: [] };
    const keys = [...new Set((Array.isArray(input.itemKeys) ? input.itemKeys : []).map((k) => String(k)))];
    if (!keys.length) return { ok: false, error: "Escolha pelo menos um item do plano.", created: [], skipped: [] };

    const rec = SellerRecommendationService.recommend(orgId, input.sellerId, input.refDate);
    if (!rec.found) return { ok: false, error: "Vendedor não encontrado.", created: [], skipped: [] };
    if (!rec.plan14) return { ok: false, error: rec.reason || "Não há plano a partir destes números.", created: [], skipped: [] };
    const byKey = new Map<string, any>(rec.plan14.items.map((i: any) => [i.key, i]));
    const unknown = keys.filter((k) => !byKey.has(k));
    if (unknown.length) return { ok: false, error: `Item(ns) fora do plano atual: ${unknown.join(", ")}.`, created: [], skipped: [] };

    // responsável: gerente da loja da pessoa → senão quem aprovou
    let assignee: string | null = input.assignedTo ? String(input.assignedTo) : null;
    if (!assignee) {
      const place = RetailSellerIdentityService.storeOn(orgId, rec.seller.id, input.refDate);
      const m = place ? (db.prepare(`SELECT manager_user_id FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, place.storeId) as any)?.manager_user_id : null;
      assignee = m || by;
    }
    if (!db.prepare(`SELECT 1 FROM users WHERE organization_id = ? AND id = ?`).get(orgId, assignee)) return { ok: false, error: "O responsável não pertence a esta empresa.", created: [], skipped: [] };

    const approver = (db.prepare(`SELECT name FROM users WHERE organization_id = ? AND id = ?`).get(orgId, by) as any)?.name || "gestor";
    const created: any[] = [], skipped: any[] = [];
    for (const k of keys) {
      const it = byKey.get(k);
      const dedupe = `seller_plan14:${rec.seller.id}:${input.refDate}:${k}`;
      try {
        const t = TaskService.create(orgId, {
          title: `Plano 14 dias — ${rec.seller.name}: ${it.title}`,
          description: `${it.detail}\n\nPor quê: ${it.why}${it.watch ? `\nO que acompanhar: ${it.watch}.` : ""}\n\nPlano aprovado por ${approver}. ${rec.disclaimer}`,
          assignedTo: assignee, priority: it.kind === "checkpoint" ? "media" : "media", dueAt: `${it.dueDate}T12:00:00.000Z`, source: "ia",
          occurrenceDedupeKey: dedupe,
        }, by);
        created.push({ key: k, taskId: t?.id || null, dueDate: it.dueDate });
      } catch (e: any) {
        if (e?.code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE/i.test(String(e?.message))) skipped.push({ key: k, reason: "já existe tarefa deste item para este plano" });
        else throw e;
      }
    }
    try { logAuthEvent(orgId, by, rec.seller.id, "SELLER_PLAN14_TASKS_CREATED", { refDate: input.refDate, driver: rec.driver, items: created.map((c) => c.key), skipped: skipped.length, assignedTo: assignee }); } catch { /* best-effort */ }
    return { ok: true, created, skipped };
  }
}

export default SellerPlanTaskService;
