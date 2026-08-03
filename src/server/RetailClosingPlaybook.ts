import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { CommandExecutorService, type CommandHandler, type ExecutedResult } from "./CommandExecutorService.js";
import { RetailFloorReconciliationService } from "./RetailFloorReconciliationService.js";
import { FinancialLedgerService } from "./FinancialLedgerService.js";
import { OutcomeMeasurementService } from "./OutcomeMeasurementService.js";
import { DecisionActionService } from "./DecisionActionService.js";
import { ProcessRuntimeService } from "./ProcessRuntimeService.js";
import type { PlaybookDefinition } from "./PlaybookEngine.js";

/**
 * Piloto 1 do Execution Runtime — RETAIL DAILY CLOSING (ADR-152 Fatia 4a).
 *
 * Playbook `retail_daily_closing_v1` que conclui o fechamento diário de uma
 * loja atrás de política + confirmação humana quando necessária. Fatia
 * escolhida como primeiro piloto porque:
 *   - 75% da fundação já existe (ADR-150 F6 — reconciliação Alterdata × PDV);
 *   - política de aprovação é clara (tolerância de valor, docs completos);
 *   - escopo por loja + dia limita blast radius;
 *   - baixo risco financeiro (lança em cash_events, aditivo);
 *   - alto valor pro cliente-piloto (TOULON) que já usa o ADR-150.
 *
 * Decisões de escopo (registradas em DECISOES-E-PENDENCIAS.md §F):
 *   D1: Sicredi como fonte de conciliação — NÃO nesta fatia. Alterdata+PDV
 *       são a fonte principal (já conciliadas na F6 do ADR-150). Sicredi
 *       fica pra fatia futura F4a.1 quando as credenciais estiverem
 *       disponíveis.
 *   D2: Write-back Alterdata — NÃO. F4a lança no FinancialLedgerService
 *       LOCAL (fonte da verdade do ZappFlow). Alterdata segue como leitura.
 *   D8: Org piloto — TOULON (continuidade natural do ADR-150).
 *   D9: Régua shadow → assisted — ≥95% concordância com decisão humana por
 *       2 semanas. Operacional (não codificada aqui; monitorada por
 *       comparação Runtime × decisão manual no painel Operações da F3.2).
 *   D10: Kill-switch (execution_runtime_enabled=0) — só Master Admin.
 *
 * O playbook (retail_daily_closing_v1, seed pela rota /api/runtime/
 * retail-closing/seed):
 *
 *   [1] reconcile   — RetailFloorReconciliationService.runDay(orgId,
 *                     storeId, date). Idempotente (só-promove — ADR-150 F6).
 *                     Sucesso: temos totals com gap, confirmed, unmatched.
 *   [2] decide      — roteia por CONDIÇÃO no playbook (PlaybookEngine):
 *                     if within_tolerance AND documentation_complete AND
 *                        no_unmatched:
 *                        → auto_post (efeito automático se a org permitir);
 *                     else:
 *                        → escalate (cria DecisionAction awaiting_approval).
 *   [3a] auto_post  — FinancialLedgerService.recordEvent(direction='in',
 *                     amount=erpTotal, sourceType='retail_closing',
 *                     sourceId=`${storeId}:${date}`). UNIQUE(org, source_type,
 *                     source_id) da cash_events dedupe idempotentemente:
 *                     rodar 2× no mesmo dia NÃO duplica caixa.
 *                     Registra outcome com categorias explícitas
 *                     (F3.1): time_saved_minutes=15 (planilha manual),
 *                     revenue_recovered=0 (não é receita, é registro),
 *                     evidence do fechamento pra auditoria.
 *   [3b] escalate   — DecisionActionService.propose(status='awaiting_approval')
 *                     pro gerente da loja. NÃO lança no financeiro; o humano
 *                     resolve pela aba Plano de Ação.
 *   [$end]          — process_instance vira 'completed' + result_json.
 *
 * Guardas RN (F4a):
 *   G-4a-1: reconcile é IDEMPOTENTE (só-promove — herdado do ADR-150 F6).
 *   G-4a-2: auto_post é IDEMPOTENTE (UNIQUE em cash_events.source_id).
 *   G-4a-3: escalate NUNCA lança no financeiro (só cria DecisionAction).
 *   G-4a-4: tolerância é CONFIGURÁVEL por org (agent_policies.config_json.
 *           tolerance_pct, default 5%). O playbook lê essa config no decide.
 *   G-4a-5: dias sem atendimento (nenhum declared) NÃO geram cash_event —
 *           process_instance vai direto pra completed com skipped_reason.
 *   G-4a-6: Comissão (§15.7 do PRD) fica pra F4a.1. F4a foca no "concluir o
 *           dia = ter caixa lançado ou exceção pro gerente". Comissão exige
 *           regras por loja/vendedor que já tem service próprio
 *           (PerformanceFeeService, ADR fora do escopo do Runtime).
 */

// ── Handlers ──────────────────────────────────────────────────────────────

const payloadOf = (action: any) => { try { return action.command_payload_json ? JSON.parse(action.command_payload_json) : {}; } catch { return {}; } };

/**
 * retail_reconcile_day — chama RetailFloorReconciliationService.runDay. É o
 * PRIMEIRO passo do playbook; sucesso quando o summary vem (mesmo com 0
 * declarados no dia). Sem confirmação externa (síncrona, determinística).
 */
const RetailReconcileDayCommandHandler: CommandHandler = {
  key: "RetailReconcileDayCommandHandler",
  commandTypes: ["retail_reconcile_day"],
  prepare(_orgId, action) {
    const p = payloadOf(action);
    return { summary: `Conciliação preparada (loja ${p.storeId || "?"}, ${p.date || "?"})`, artifact: { kind: "retail_reconcile_draft", storeId: p.storeId || null, date: p.date || null } };
  },
  execute(orgId, action): ExecutedResult {
    const p = payloadOf(action);
    if (!p.storeId) throwHandler("non_retryable", "retail_reconcile_day exige storeId no payload.");
    if (!p.date || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.date))) throwHandler("non_retryable", "retail_reconcile_day exige date=YYYY-MM-DD no payload.");
    let summary: any;
    try {
      summary = RetailFloorReconciliationService.runDay(orgId, String(p.storeId), String(p.date), action.assigned_to || "runtime");
    } catch (e: any) { throwHandler("retryable", `RetailFloor.runDay falhou: ${e?.message || e}`); }
    return {
      summary: `Conciliação ${p.date} (loja ${p.storeId}): ${summary.totals?.confirmed || 0}✓ / ${summary.totals?.unmatched || 0}✗ · gap ${summary.totals?.gap ?? 0}`,
      artifact: { kind: "retail_reconcile_done", storeId: p.storeId, date: p.date, ...summary },
      effect: "retail_reconcile_done",
      externalRef: null,
    };
  },
};

/**
 * retail_post_closing — chamado SÓ quando a decisão do playbook foi
 * auto_post (tolerância OK + docs completos + zero unmatched). Lança o
 * total ERP como entrada de caixa (`cash_events` com UNIQUE por source_id
 * ⇒ idempotente) e registra outcome com categorias F3.1.
 */
const RetailPostClosingCommandHandler: CommandHandler = {
  key: "RetailPostClosingCommandHandler",
  commandTypes: ["retail_post_closing"],
  prepare(_orgId, action) {
    const p = payloadOf(action);
    return { summary: `Lançamento de caixa preparado (loja ${p.storeId}, ${p.date})`, artifact: { kind: "retail_post_closing_draft", storeId: p.storeId, date: p.date, amount: p.amount } };
  },
  execute(orgId, action): ExecutedResult {
    const p = payloadOf(action);
    if (!p.storeId || !p.date || p.amount == null) {
      throwHandler("non_retryable", "retail_post_closing exige storeId, date e amount no payload.");
    }
    const amount = Number(p.amount);
    if (!(amount >= 0)) throwHandler("non_retryable", "retail_post_closing.amount deve ser >= 0.");

    let result: any;
    try {
      result = FinancialLedgerService.recordEvent(orgId, {
        direction: "in",
        amount,
        eventDate: String(p.date),
        sourceType: "retail_closing",
        sourceId: `${p.storeId}:${p.date}`,
        confidence: "confirmed",
        note: `Fechamento da loja ${p.storeId} em ${p.date} (Runtime F4a)`,
        createdBy: action.assigned_to || "runtime",
      });
    } catch (e: any) { throwHandler("retryable", `FinancialLedger.recordEvent falhou: ${e?.message || e}`); }

    // Registra outcome com categorias explícitas (F3.1). time_saved_minutes
    // reflete o trabalho manual que a operação evita (comparar planilhas
    // Alterdata × PDV + lançar caixa manualmente — ~15min/loja/dia).
    try {
      OutcomeMeasurementService.record(orgId, action.id, {
        expectedValue: amount, realizedValue: amount, basis: "fact", measurementMethod: "derived",
        timeSavedMinutes: 15, revenueRecovered: 0, costAvoided: 0, lossPrevented: 0,
        evidence: { storeId: p.storeId, date: p.date, amount, cashEventId: result?.id || null, source: "retail_closing_v1" },
      });
    } catch { /* aditivo — nunca bloqueia o efeito */ }

    return {
      summary: `Fechamento lançado no caixa (loja ${p.storeId} · ${p.date} · R$ ${amount.toFixed(2)})`,
      artifact: { kind: "retail_closing_posted", storeId: p.storeId, date: p.date, amount, cashEventId: result?.id || null },
      effect: "cash_event_created",
      externalRef: result?.id || null,
    };
  },
};

CommandExecutorService.registerHandler(RetailReconcileDayCommandHandler);
CommandExecutorService.registerHandler(RetailPostClosingCommandHandler);

// ── Definição do playbook (JSON tipado — ADR-152 D3) ──────────────────────

/**
 * `retail_daily_closing_v1` — playbook seedado por
 * `RetailClosingPlaybook.seed(orgId)`. Contexto esperado ao criar a
 * process_instance:
 *   { storeId, date, tolerancePct? }
 *
 * O `decide` roteia por CONDIÇÃO sobre `results.reconcile.totals` (o step
 * anterior colocou lá):
 *   - `results.reconcile.totals.unmatched == 0` + gap dentro da tolerância
 *     absoluta → auto_post
 *   - senão → escalate
 *
 * A tolerância vira `context.absTolerance` (calculado ANTES do decide) pra
 * o PlaybookEngine.evaluateCondition conseguir comparar contra o gap com
 * `lte`. O escalate cria a DecisionAction; auto_post lança caixa. Ambos
 * seguem pra $end.
 */
export const RETAIL_DAILY_CLOSING_V1: PlaybookDefinition = {
  startStep: "reconcile",
  steps: [
    {
      id: "reconcile",
      commandType: "retail_reconcile_day",
      successCondition: { op: "truthy", path: "results.reconcile.totals" },
      timeoutSeconds: 300,
      maxAttempts: 3,
      onFailure: "escalate",
      // Sempre vai pro dispatch — que decide auto vs escalate no HANDLER
      // (a regra `absGap <= tolerancePct * erpTotal` exige aritmética que
      // o subset JSON-Logic da F1 do PlaybookEngine ainda não faz). Fatia
      // futura do Runtime pode enriquecer o engine com `mul`/`abs` e
      // trazer a decisão de volta pro JSON.
      next: "post_dispatch",
    },
    {
      id: "post_dispatch",
      commandType: "retail_closing_dispatch",
      next: "$end",
    },
  ],
};

/**
 * Handler do "dispatch" — decide auto_post × escalate a partir do resultado
 * do reconcile. Idempotente: um process_instance só entra aqui uma vez.
 *
 * Regra da tolerância: `absGap <= tolerancePct * erpTotal + 0.01` (folga
 * de arredondamento de centavos). Se erpTotal=0 e gap=0, considera ok
 * (loja sem venda no dia — não gera cash_event; skipped_reason no result).
 */
const RetailClosingDispatchHandler: CommandHandler = {
  key: "RetailClosingDispatchHandler",
  commandTypes: ["retail_closing_dispatch"],
  prepare(_orgId, action) {
    return { summary: `Dispatch de fechamento preparado`, artifact: { kind: "retail_dispatch_draft", instanceId: (payloadOf(action) as any).instanceId || null } };
  },
  async execute(orgId, action): Promise<ExecutedResult> {
    const p = payloadOf(action);
    // O dispatch é chamado NO CONTEXTO de uma process_instance — mas o
    // action isolado não conhece a instância (F4a limitação: instance →
    // action é 1-way). Usamos o `subject_id` da action (que a fatia 4a seta
    // como storeId:date) pra localizar a instance viva mais recente do
    // processo `retail_daily_closing_v1` da mesma org.
    const instanceId = String(p.instanceId || "");
    if (!instanceId) throwHandler("non_retryable", "retail_closing_dispatch exige instanceId no payload.");
    const inst = ProcessRuntimeService.getInstance(orgId, instanceId);
    if (!inst) throwHandler("non_retryable", `process_instance ${instanceId} não encontrada.`);
    const ctx = inst.context || {};
    const reconcile = ctx.results?.reconcile;
    if (!reconcile) throwHandler("retryable", `contexto sem results.reconcile; reconcile ainda não rodou?`);
    const totals = reconcile.totals || {};
    const tolerancePct = Number(ctx.tolerancePct ?? 0.05);
    const erpTotal = Number(totals.erpValue || 0);
    const gap = Number(totals.gap || 0);
    const unmatched = Number(totals.unmatched || 0);
    const absGap = Math.abs(gap);
    const absTolerance = Math.max(tolerancePct * erpTotal + 0.01, 0.01);
    const skipped = erpTotal === 0 && totals.declaredCount === 0;

    if (skipped) {
      return {
        summary: `Dia sem venda (loja ${ctx.storeId} · ${ctx.date}) — nada a lançar.`,
        artifact: { kind: "retail_closing_skipped", storeId: ctx.storeId, date: ctx.date, reason: "no_sales" },
        effect: "skipped_no_sales", externalRef: null,
      };
    }

    const autoOk = unmatched === 0 && absGap <= absTolerance;
    if (autoOk) {
      // Criar uma ação nova aprovada de retail_post_closing e executá-la.
      // Vai pro mesmo executor governado (3 guardas + auditoria em
      // action_execution_log). Reusa a policy de retail / retail
      // (dono cadastra no seed).
      const posted = await createAndExecute(orgId, {
        domain: "retail", actionType: "retail_post_closing", title: `Lançar fechamento ${ctx.storeId} · ${ctx.date}`,
        commandType: "retail_post_closing",
        payload: { storeId: ctx.storeId, date: ctx.date, amount: erpTotal },
        expectedImpact: erpTotal, basis: "fact",
      }, "runtime");
      const externalRef = (posted.result?.result as ExecutedResult | undefined)?.externalRef || null;
      return {
        summary: `Auto-post: caixa lançado (loja ${ctx.storeId} · R$ ${erpTotal.toFixed(2)})`,
        artifact: { kind: "retail_closing_auto_posted", storeId: ctx.storeId, date: ctx.date, amount: erpTotal, postActionId: posted.actionId, cashEventId: externalRef, decision: { autoOk: true, absGap, absTolerance, unmatched } },
        effect: "cash_event_created", externalRef,
      };
    }

    // Escalate — cria DecisionAction awaiting_approval pro gerente. NÃO
    // lança caixa. O gerente resolve via aba Plano de Ação (aprovar +
    // completar) ou dispara post_closing manualmente depois.
    const escalated = DecisionActionService.propose(orgId, {
      domain: "retail", actionType: "retail_closing_review", title: `Revisar fechamento ${ctx.storeId} · ${ctx.date}`,
      description: `Fechamento requer decisão humana: gap R$ ${absGap.toFixed(2)} (tolerância R$ ${absTolerance.toFixed(2)}) · ${unmatched} atendimento(s) não conciliado(s).`,
      priorityScore: unmatched * 10 + Math.round(absGap),
      expectedImpact: erpTotal, basis: "fact",
      commandPayload: { storeId: ctx.storeId, date: ctx.date, erpTotal, gap, absGap, absTolerance, unmatched, declaredTotal: totals.declaredValue },
    });
    try { logAuthEvent(orgId, "runtime", null, "RUNTIME_RETAIL_CLOSING_ESCALATED", { instanceId, storeId: ctx.storeId, date: ctx.date, escalatedActionId: escalated.id, gap: absGap, unmatched }); } catch { /* noop */ }
    return {
      summary: `Fechamento escalado ao gerente (gap R$ ${absGap.toFixed(2)}, ${unmatched} não conciliado)`,
      artifact: { kind: "retail_closing_escalated", storeId: ctx.storeId, date: ctx.date, escalatedActionId: escalated.id, decision: { autoOk: false, absGap, absTolerance, unmatched, gap } },
      effect: "escalated_to_manager", externalRef: escalated.id,
    };
  },
};

CommandExecutorService.registerHandler(RetailClosingDispatchHandler);

// ── Seed helper (rota master admin) + kickoff pro Runtime ────────────────

export class RetailClosingPlaybookService {
  /**
   * Cria a definição `retail_daily_closing_v1` na org (idempotente por
   * process_type — se já existir versão ativa igual, devolve a existente).
   * Rota `POST /api/runtime/retail-closing/seed` chama isto.
   */
  static seed(orgId: string, actorId?: string): any {
    const existing = ProcessRuntimeService.latestActiveDefinition(orgId, "retail_daily_closing_v1");
    if (existing) return existing;
    return ProcessRuntimeService.defineProcess(orgId, {
      processType: "retail_daily_closing_v1",
      name: "Fechamento diário de loja",
      description: "Concilia declarado × PDV, decide auto-post por tolerância ou escala pro gerente. Lança em cash_events (idempotente). Comissão fica pra F4a.1.",
      triggerType: "manual",
      objective: "Entregar o dia da loja fechado (lançado) ou escalado ao humano.",
      autonomyLevelDefault: "execute",
      slaDefinition: { deadline: "T+09h", timezone: "America/Sao_Paulo" },
      steps: RETAIL_DAILY_CLOSING_V1,
    }, actorId);
  }

  /**
   * Inicia uma instância pro par (storeId, date). Reusa o dedupe conservador
   * do ProcessRuntimeService (se já existe uma viva pro mesmo subject, devolve
   * ela). O `tolerancePct` vem do policy config; default 0.05.
   */
  static start(orgId: string, opts: { storeId: string; date: string; tolerancePct?: number }, createdBy?: string): any {
    if (!opts?.storeId) throw new Error("storeId obrigatório.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(opts?.date || ""))) throw new Error("date deve ser YYYY-MM-DD.");
    return ProcessRuntimeService.startForSubject(orgId, {
      processType: "retail_daily_closing_v1",
      subjectType: "retail_store_day",
      subjectId: `${opts.storeId}:${opts.date}`,
      context: { storeId: opts.storeId, date: opts.date, tolerancePct: Number(opts.tolerancePct ?? 0.05) },
      priority: 5,
      riskLevel: "low",
      createdBy: createdBy || null,
    }, createdBy || undefined);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function throwHandler(cls: "retryable" | "external_unavailable" | "permission" | "non_retryable", message: string): never {
  const err = new Error(message) as any;
  err.errorClass = cls;
  throw err;
}

/**
 * Cria uma ação, aprova (só o executor precisa passar pelas 3 guardas — a
 * política define autonomy) e executa pelo modo `execute` do
 * CommandExecutorService. Usado pelo dispatch pra materializar o
 * post_closing dentro do próprio playbook. Idempotência do post_closing
 * fica no cash_events UNIQUE(org, source_type, source_id).
 */
async function createAndExecute(orgId: string, input: {
  domain: string; actionType: string; title: string; commandType: string;
  payload: any; expectedImpact?: number | null; basis?: string;
}, actorId: string): Promise<{ actionId: string; result: any }> {
  const proposed = DecisionActionService.propose(orgId, {
    domain: input.domain, actionType: input.actionType, title: input.title,
    commandType: input.commandType, commandPayload: input.payload,
    expectedImpact: input.expectedImpact ?? null, basis: input.basis || "fact",
  });
  // Se a política não é 'none', é preciso approve. O `dispatch` roda como
  // runtime — aprovamos internamente (auditado como 'runtime').
  if (proposed.status !== "approved") {
    DecisionActionService.approve(orgId, proposed.id, actorId);
    const still = DecisionActionService.get(orgId, proposed.id);
    if (still.status !== "approved") {
      throwHandler("permission", `Política de ${input.actionType} exige aprovação manual (${still.approval_policy}) — dispatch não roda auto-post.`);
    }
  }
  const result = await CommandExecutorService.execute(orgId, proposed.id);
  return { actionId: proposed.id, result };
}
