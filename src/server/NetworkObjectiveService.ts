import db from "./db.js";
import { RetailForecastService } from "./RetailForecastService.js";
import { TaskService } from "./TaskService.js";
import { ApprovalPolicyService } from "./ApprovalPolicyService.js";
import { logAuthEvent } from "./auditLog.js";
import { todaySP } from "./spDate.js";

/**
 * NetworkObjectiveService — ADR-204 F3.6b: DECOMPOR um objetivo da REDE ("+10% de venda neste mês") em quanto CADA LOJA precisa a mais.
 *
 * Só RECOMENDA (IA só recomenda, RN-F3-3): `plan` é read-only; `createTasks` só corre por decisão de uma PESSOA e cria TAREFA do gerente (conversa/
 * acompanhamento) — nunca mexe em meta oficial, comissão, cota diária nem escreve venda. A meta oficial (`retail_store_monthly_goals`) é só LIDA (RN-F3-6).
 *
 * Base honesta: o "ponto de partida" de cada loja é a PROJEÇÃO do mês (F3.4: o que acontece se nada mudar), não a meta nem o ano passado. Loja que não dá
 * pra projetar (sem histórico/fechamento atrasado/mês fechado) fica FORA, com o motivo — a rede só soma as lojas projetáveis e diz quantas ficaram de fora.
 * Dividir é PROPORCIONAL à projeção (cada loja +X% do que ela mesma deve fazer); o que o serviço acrescenta é traduzir isso em R$/dia útil que falta e comparar com
 * o dia típico da loja (esforço). Os rótulos de esforço (≤10% leve · ≤25% moderado · acima alto) são PREMISSA não calibrada com dado real — declarada.
 * Hipótese ≠ fato: projeção é estimativa; nada aqui promete resultado.
 */
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const brl = (n: number) => `R$ ${round2(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ymd = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const monthEnd = (m: string) => { const t = new Date(`${m}-01T00:00:00Z`); t.setUTCMonth(t.getUTCMonth() + 1); t.setUTCDate(0); return t.toISOString().slice(0, 10); };

export interface StoreObjective {
  storeId: string; storeName: string; baseline: number; target: number; extra: number; sold: number;
  daysLeft: number; extraPerDay: number | null; typicalPerDay: number | null; extraVsTypicalPct: number | null;
  effort: "leve" | "moderado" | "alto" | null; confidence: string;
  goal: { amount: number | null; baselineVsGoalPct: number | null; targetVsGoalPct: number | null; alreadyAboveGoal: boolean };
  nextStep: string;
}

export class NetworkObjectiveService {
  static plan(orgId: string, input: { pct: unknown; month?: string; now?: number }, opts: { storeIds?: string[] | null } = {}): any {
    const pct = Number(input?.pct);
    if (!Number.isFinite(pct) || !(pct > 0) || pct > 100) return { ok: false, error: "Informe o aumento desejado em % (entre 0 e 100)." };
    const now = input.now || Date.now();
    const fc = RetailForecastService.forecast(orgId, { month: input.month, now });
    const scoped = (r: any) => !opts.storeIds || opts.storeIds.includes(r.storeId);
    const mine = (fc.stores || []).filter(scoped);
    const stores: StoreObjective[] = [], excluded: Array<{ storeId: string; storeName: string; status: string; reason: string | null }> = [];
    for (const r of mine) {
      if (r.status !== "ok") { excluded.push({ storeId: r.storeId, storeName: r.storeName, status: r.status, reason: r.reason || null }); continue; }
      const baseline = Number(r.projection.mid), extra = round2((baseline * pct) / 100), target = round2(baseline + extra);
      const daysLeft = (Number(r.remainingOpenDays) || 0) + ((r.pendingDays || []).length || 0);
      const extraPerDay = daysLeft > 0 ? round2(extra / daysLeft) : null;
      const typical = r.typicalPerOpenDay != null ? Number(r.typicalPerOpenDay) : null;
      const vsTyp = extraPerDay != null && typical && typical > 0 ? Math.round((extraPerDay / typical) * 100) : null;
      const effort = vsTyp == null ? null : vsTyp <= 10 ? "leve" : vsTyp <= 25 ? "moderado" : "alto";
      const goalAmt = r.goal?.amount != null ? Number(r.goal.amount) : null;
      stores.push({
        storeId: r.storeId, storeName: r.storeName, baseline: round2(baseline), target, extra, sold: Number(r.sold) || 0, daysLeft, extraPerDay, typicalPerDay: typical, extraVsTypicalPct: vsTyp, effort,
        confidence: r.confidence?.label || "baixa",
        goal: { amount: goalAmt, baselineVsGoalPct: goalAmt ? Math.round((baseline / goalAmt) * 100) : null, targetVsGoalPct: goalAmt ? Math.round((target / goalAmt) * 100) : null, alreadyAboveGoal: goalAmt != null && baseline >= goalAmt },
        nextStep: daysLeft > 0
          ? `Combinar com o gerente da ${r.storeName}: cerca de ${brl(extraPerDay!)} a mais por dia útil nos ${daysLeft} dias que faltam${vsTyp != null ? ` (${vsTyp}% acima de um dia típico)` : ""}. Veja o plano dos vendedores da loja.`
          : `A ${r.storeName} não tem mais dia útil neste mês pra puxar o objetivo.`,
      });
    }
    stores.sort((a, b) => b.extra - a.extra);
    const full = !opts.storeIds;     // rede inteira só quando o usuário vê todas as lojas
    const network = full && stores.length ? { storesPlanned: stores.length, storesExcluded: excluded.length, baseline: round2(stores.reduce((s, x) => s + x.baseline, 0)), target: round2(stores.reduce((s, x) => s + x.target, 0)), extra: round2(stores.reduce((s, x) => s + x.extra, 0)) } : null;
    return {
      ok: true, pct, month: fc.month, asOf: fc.asOf, basis: "projeção do mês (estimativa) — o que cada loja deve fazer se nada mudar", stores, excluded, network,
      notes: [
        "O objetivo é dividido proporcionalmente à projeção de cada loja; lojas sem projeção confiável ficam de fora e NÃO entram na soma da rede.",
        "Rótulos de esforço (leve ≤10%, moderado ≤25%, alto acima) são premissa não calibrada com dado real.",
        "É recomendação: nada altera meta oficial, cota ou comissão. Tarefas só são criadas por uma pessoa.",
        ...(full ? [] : ["Você vê só as suas lojas — a leitura da rede inteira é do gestor."]),
      ],
      executes: false, generatedAt: new Date(now).toISOString(),
    };
  }

  /** Cria TAREFAS do gerente (uma por loja escolhida) — só por PESSOA; o plano é recalculado aqui (o cliente só escolhe lojas). Idempotente por (mês, %, loja). */
  static createTasks(orgId: string, input: { pct: unknown; month?: string; storeIds: unknown; assignedTo?: string | null; now?: number }, approvedBy: string | null | undefined, opts: { allowedStoreIds?: string[] | null } = {}): { ok: boolean; error?: string; created: any[]; skipped: any[] } {
    const by = String(approvedBy || "").trim();
    if (!by) return { ok: false, error: "A aprovação exige uma pessoa identificada.", created: [], skipped: [] };
    if (ApprovalPolicyService.isSystemActor(by)) return { ok: false, error: "Só uma pessoa cria tarefas do objetivo — a IA só recomenda.", created: [], skipped: [] };
    const ids = [...new Set((Array.isArray(input.storeIds) ? input.storeIds : []).map(String))];
    if (!ids.length) return { ok: false, error: "Escolha pelo menos uma loja.", created: [], skipped: [] };
    if (opts.allowedStoreIds && ids.some((i) => !opts.allowedStoreIds!.includes(i))) return { ok: false, error: "Alguma loja escolhida não está entre as suas lojas.", created: [], skipped: [] };
    const p = this.plan(orgId, { pct: input.pct, month: input.month, now: input.now }, {});
    if (!p.ok) return { ok: false, error: p.error, created: [], skipped: [] };
    const byId = new Map<string, StoreObjective>(p.stores.map((s: StoreObjective) => [s.storeId, s]));
    const notPlannable = ids.filter((i) => !byId.has(i));
    if (notPlannable.length) return { ok: false, error: "Alguma loja não tem projeção confiável neste mês — não há o que decompor pra ela.", created: [], skipped: [] };
    if (input.assignedTo && !db.prepare("SELECT 1 FROM users WHERE organization_id = ? AND id = ?").get(orgId, input.assignedTo)) return { ok: false, error: "O responsável não pertence a esta empresa.", created: [], skipped: [] };

    const approver = (db.prepare("SELECT name FROM users WHERE organization_id = ? AND id = ?").get(orgId, by) as any)?.name || "gestor";
    const created: any[] = [], skipped: any[] = [];
    for (const id of ids) {
      const s = byId.get(id)!;
      const mgr = (db.prepare("SELECT manager_user_id FROM retail_stores WHERE organization_id = ? AND id = ?").get(orgId, id) as any)?.manager_user_id;
      const assignee = input.assignedTo || mgr || by;
      if (!db.prepare("SELECT 1 FROM users WHERE organization_id = ? AND id = ?").get(orgId, assignee)) { skipped.push({ storeId: id, reason: "responsável inválido" }); continue; }
      try {
        const t = TaskService.create(orgId, {
          title: `Objetivo +${p.pct}% — ${s.storeName}: ${s.extraPerDay != null ? `+${brl(s.extraPerDay)}/dia útil` : "sem dia útil restante"}`,
          description: `${s.nextStep}\n\nBase: projeção de ${brl(s.baseline)} no mês → alvo ${brl(s.target)} (+${brl(s.extra)}). ${s.goal.amount != null ? `Meta oficial da loja: ${brl(s.goal.amount)} (a projeção já está em ${s.goal.baselineVsGoalPct}% dela).` : "A loja não tem meta mensal cadastrada."}\nEsforço: ${s.effort || "n/d"} (premissa não calibrada). Confiança da projeção: ${s.confidence}.\n\nObjetivo definido por ${approver}. Projeção é estimativa, não promessa; nenhuma meta oficial foi alterada.`,
          assignedTo: assignee, priority: "media", dueAt: `${monthEnd(p.month)}T12:00:00.000Z`, source: "ia",
          occurrenceDedupeKey: `network_obj:${p.month}:${p.pct}:${id}`,
        }, by);
        created.push({ storeId: id, taskId: t?.id || null });
      } catch (e: any) {
        if (e?.code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE/i.test(String(e?.message))) skipped.push({ storeId: id, reason: "já existe tarefa deste objetivo para esta loja" });
        else throw e;
      }
    }
    try { logAuthEvent(orgId, by, null, "NETWORK_OBJECTIVE_TASKS_CREATED", { month: p.month, pct: p.pct, stores: created.length, skipped: skipped.length }); } catch { /* best-effort */ }
    return { ok: true, created, skipped };
  }
}

export default NetworkObjectiveService;
