import db from "./db.js";
import { randomUUID } from "crypto";
import { AutonomyKillSwitchService } from "./AutonomyKillSwitchService.js";

/**
 * ApprovalPolicyService (ADR-136, Epic 2 — C2).
 *
 * Decide se uma ação pode ser preparada, aprovada por 1, por perfil, ou por 2
 * pessoas (two_step). Determinístico: usa a política da organização
 * (`agent_policies`) quando existe; senão a MATRIZ PADRÃO do PRD §10.2. Nunca
 * "execute" automático nesta fatia — o mais alto é preparar/aprovar.
 *
 * ADR-159 F3 (D4) — Autonomy Contract de 1ª classe: `resolveContract` devolve um
 * dos 4 ESTADOS (permitido/requer aprovação/escalonar/bloqueado) a partir de
 * BANDAS valor→papel (`agent_policies.config_json.bands`), com ponte pro modelo
 * legado (max_auto_amount/approval_role) e opinião de default-deny p/ ações
 * financeiras/destrutivas sem política (RN-159-1). Estende o service — sem engine
 * de governança paralelo (RN-159-4).
 */

export type ApprovalPolicy = "none" | "single" | "role" | "two_step";

// ADR-159 F3 — os 4 estados do Autonomy Contract (Estado Final §16).
export type AutonomyState = "allow" | "require_approval" | "escalate" | "deny";
const AUTONOMY_STATES = new Set<AutonomyState>(["allow", "require_approval", "escalate", "deny"]);

/** Uma banda valor→papel: até `upTo` (null = teto/sem limite) → `state` (+ `role`). */
export interface AutonomyBand { upTo: number | null; state: AutonomyState; role?: string | null; }

// Ações financeiras/destrutivas: default-deny quando NÃO há política/banda
// resolvida (RN-159-1). Conservador — dinheiro que sai + destrutivo irreversível.
const FINANCIAL_OR_DESTRUCTIVE = new Set([
  "refund", "issue_payment", "change_price", "choose_supplier", "create_purchase_order",
  "delete_record", "cancel_subscription", "asaas_pix_charge",
]);

// ADR-204 F3.1a (RN-F3-2) — PISO DE AUTONOMIA: tipos de ação que SEMPRE exigem
// aprovação de uma PESSOA (PRD Fase 3 §4): compras, pagamentos/transferência de
// dinheiro, contratação/demissão, salário, comissão consolidada, desconto relevante,
// preço, crédito, compromisso contratual e comunicação jurídica. É por TIPO (não por
// domínio): `domain==='finance'` também carrega cobrança/mensagem (ex.: `collection`),
// que NÃO é comprometer dinheiro da empresa e segue como está. O piso vale acima de
// qualquer banda `allow`, política semeada ou `max_auto_amount` — o Autonomy Contract
// continua podendo ENDURECER (deny/escalar), nunca afrouxar abaixo daqui.
// D8 (dono, 2026-10): reembolso/estorno é dinheiro que SAI — entra no piso (a banda `allow` não o auto-aprova).
// Fora de propósito: `prepare_purchase`/`send_quote_request` (rascunho/cotação,
// nível 2 — preparar é permitido) e `asaas_pix_charge` (cobrar cliente é receber).
// Tipos novos que comprometam dinheiro/pessoas/contrato DEVEM entrar aqui.
const HUMAN_ONLY_CATEGORIES: Record<string, { label: string; types: string[] }> = {
  compras: { label: "Compras", types: ["create_purchase_order", "choose_supplier", "confirm_purchase", "send_purchase_order"] },
  pagamentos: { label: "Pagamentos e transferência de dinheiro", types: ["issue_payment", "pay_bill", "pay_supplier", "pay_invoice", "transfer_funds", "bank_transfer", "pix_transfer", "send_pix"] },
  reembolso: { label: "Reembolso e estorno ao cliente", types: ["refund", "issue_refund", "customer_refund", "chargeback_refund"] },
  pessoas: { label: "Contratação, demissão e salário", types: ["hire", "dismiss", "terminate_employee", "change_salary", "adjust_salary", "payroll_change"] },
  comissao: { label: "Comissão consolidada", types: ["confirm_commission", "consolidate_commission", "pay_commission", "commission_payout"] },
  preco: { label: "Preço e descontos relevantes", types: ["change_price", "bulk_price_change", "bulk_discount", "grant_large_discount"] },
  credito_contrato: { label: "Empréstimo, contratos e comunicação jurídica", types: ["take_loan", "request_credit", "sign_contract", "contract_commitment", "sign_agreement", "send_legal_notice", "legal_communication"] },
};
const HUMAN_ONLY_ACTION_TYPES = new Set<string>(Object.values(HUMAN_ONLY_CATEGORIES).flatMap((c) => c.types));

// Nome em linguagem de dono dos tipos de ação mais comuns (a tela Empresa → Autonomia da IA). Desconhecido → "Ação interna".
const ACTION_LABELS: Record<string, string> = {
  create_task: "Tarefas internas", internal_reminder: "Lembretes internos", register_financial_plan: "Plano financeiro",
  prepare_campaign: "Preparar campanha", send_campaign: "Enviar campanha", prepare_purchase: "Preparar compra", send_quote_request: "Pedir cotação",
  collection: "Cobrança", collection_followup: "Cobrança — acompanhamento", collection_resend_pix: "Cobrança — reenvio do PIX", collection_promise_followup: "Cobrança — promessa de pagamento",
  sales_recovery_send: "Recuperação de venda", prospect_outreach_whatsapp: "Prospecção por WhatsApp", prospect_outreach_email: "Prospecção por e-mail",
  social_publish: "Publicação em redes sociais", growth_optimization: "Otimização de conteúdo", auto_booking: "Agendamento automático",
  refund: "Reembolso", retail_transfer: "Transferência de estoque entre lojas", retail_post_closing: "Lançamento do fechamento da loja", retail_closing_review: "Revisão do fechamento da loja",
  order_reship: "Reenvio de pedido", ticket_assign: "Atribuir atendimento", internal_handoff: "Repasse para a equipe", customer_private_message: "Mensagem privada ao cliente",
};

// Quem aprova NÃO pode ser um rótulo de sistema ("rule", "runtime", "ai"…): o piso exige
// uma pessoa. Os callers legítimos passam o `user.id` real.
const SYSTEM_ACTOR = /^(rule|ai|runtime|system|scheduler|agent|autopilot|mission|playbook|process|cron|bot)([:_\-\s]|$)/i;

// Matriz padrão por tipo de ação (PRD §10.2). Chave = action_type.
const DEFAULTS: Record<string, { policy: ApprovalPolicy; role?: string }> = {
  create_task: { policy: "none" },
  internal_reminder: { policy: "none" },
  register_financial_plan: { policy: "none" },
  prepare_campaign: { policy: "single" },
  send_campaign: { policy: "role", role: "admin" },
  prepare_purchase: { policy: "single" },
  send_quote_request: { policy: "single" },
  collection: { policy: "single" },
  choose_supplier: { policy: "two_step" },
  create_purchase_order: { policy: "two_step" },
  change_price: { policy: "role", role: "owner" },
  // ADR-167 F11 — publicação social exige aprovação humana por padrão (governança
  // on por default; o Autonomy Contract pode liberar/bloquear por banda).
  social_publish: { policy: "single" },
};

const DEFAULT_FALLBACK: { policy: ApprovalPolicy; role?: string } = { policy: "single" };

export class ApprovalPolicyService {
  /**
   * Resolve a política para (domínio, tipo, valor). Considera a config da org e,
   * quando `autonomy_level` restringe, endurece a política (observe/suggest não
   * podem ser 'none'). `max_auto_amount` eleva para aprovação quando excedido.
   */
  static resolve(orgId: string, input: { domain: string; actionType: string; expectedImpact?: number | null }): { policy: ApprovalPolicy; requiredRole: string | null; autonomy: string } {
    const base = DEFAULTS[input.actionType] || DEFAULT_FALLBACK;
    let policy: ApprovalPolicy = base.policy;
    let requiredRole: string | null = base.role || null;
    let autonomy = "suggest";

    const cfg = db.prepare("SELECT autonomy_level, approval_role, max_auto_amount, active FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ?")
      .get(orgId, input.domain, input.actionType) as any;
    if (cfg && Number(cfg.active)) {
      autonomy = String(cfg.autonomy_level || "suggest");
      if (cfg.approval_role) requiredRole = String(cfg.approval_role);
      // Autonomia mais baixa nunca reduz a exigência de aprovação abaixo de 'single'.
      if ((autonomy === "observe" || autonomy === "suggest") && policy === "none") policy = "single";
      // Valor acima do teto de automação → exige aprovação.
      const amount = Math.abs(Number(input.expectedImpact) || 0);
      if (cfg.max_auto_amount != null && amount > Number(cfg.max_auto_amount) && policy === "none") policy = "single";
      if (requiredRole && policy === "single") policy = "role";
    }
    return { policy, requiredRole, autonomy };
  }

  /** Quantas aprovações distintas a política exige (two_step = 2, none = 0). */
  static requiredApprovals(policy: ApprovalPolicy): number {
    return policy === "two_step" ? 2 : policy === "none" ? 0 : 1;
  }

  /**
   * A ação é financeira/destrutiva? Fonte ÚNICA da definição de "crítico"
   * (reusada pelo default-deny do resolveContract e pelo step-up MFA da F6).
   */
  static isFinancialOrDestructive(domain: string, actionType: string): boolean {
    return FINANCIAL_OR_DESTRUCTIVE.has(actionType) || domain === "finance";
  }

  /** ADR-204 F3.1a — o tipo cai no PISO "sempre exige pessoa" (PRD Fase 3 §4)? Lista pública p/ a UI/Empresa→IA. */
  static isHumanOnly(actionType: string | null | undefined): boolean {
    return !!actionType && HUMAN_ONLY_ACTION_TYPES.has(String(actionType));
  }
  static humanOnlyTypes(): string[] { return Array.from(HUMAN_ONLY_ACTION_TYPES).sort(); }

  /** O ator é um rótulo de SISTEMA (não uma pessoa)? Vazio também conta — sem identidade não há pessoa. */
  static isSystemActor(actorId: string | null | undefined): boolean {
    const a = String(actorId ?? "").trim();
    return !a || SYSTEM_ACTOR.test(a);
  }

  /**
   * ADR-204 F3.1a (D1) — nível de autonomia 0–4 do PRD, DERIVADO de
   * `autonomy_level × execution_mode × (aprovação automática?)` — NÃO é enum novo
   * (RN-F3-1). 0 observar · 1 recomendar · 2 preparar (aguarda autorização) ·
   * 3 executar dentro de limites pré-autorizados · 4 autonomia avançada (NÃO habilitado
   * nesta fase: `autonomous` aparece como 3 com `level4Blocked`). Tipos do piso
   * (`humanOnly`) ficam travados em ≤ 2 acima de qualquer configuração.
   */
  static autonomyLevel(orgId: string, input: { domain: string; actionType: string }): {
    level: 0 | 1 | 2 | 3; label: string; humanOnly: boolean; capped: boolean; level4Blocked: boolean; paused: boolean; reason: string;
  } {
    const humanOnly = this.isHumanOnly(input.actionType);
    const cfg = db.prepare("SELECT autonomy_level, execution_mode, active, max_auto_amount, config_json FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ?")
      .get(orgId, input.domain, input.actionType) as any;
    let level: 0 | 1 | 2 | 3 = 1;
    let level4Blocked = false;
    let reason = "sem política: a IA só recomenda";
    if (cfg && Number(cfg.active)) {
      const auto = String(cfg.autonomy_level || "suggest");
      const mode = String(cfg.execution_mode || "assisted");
      if (auto === "observe") { level = 0; reason = "política 'observe': a IA só observa e relata"; }
      else if (auto === "suggest") { level = 1; reason = "política 'suggest': a IA recomenda e a pessoa decide"; }
      else if (auto === "prepare") { level = 2; reason = "política 'prepare': a IA prepara e aguarda autorização"; }
      else if (auto === "execute") {
        const canEffect = mode === "approved_execution" || mode === "autonomous";
        let autoApprove = (DEFAULTS[input.actionType] || DEFAULT_FALLBACK).policy === "none" || cfg.max_auto_amount != null;
        try { const c = JSON.parse(cfg.config_json || "{}"); if (Array.isArray(c?.bands) && c.bands.some((b: any) => b?.state === "allow")) autoApprove = true; } catch { /* config torto */ }
        if (!canEffect) { level = 2; reason = `execution_mode='${mode}' bloqueia efeito externo: a IA prepara e aguarda autorização`; }
        else if (!autoApprove) { level = 2; reason = "executa só depois da aprovação de uma pessoa (sem limite pré-autorizado)"; }
        else { level = 3; reason = "executa dentro de limite pré-autorizado pelo dono"; }
        if (mode === "autonomous") { level4Blocked = true; reason += " — nível 4 (autonomia avançada) não habilitado nesta fase"; }
      }
    }
    let capped = false;
    if (humanOnly && level > 2) { level = 2; capped = true; reason = "tipo do piso (PRD §4): sempre exige aprovação de uma pessoa — a IA só analisa e prepara"; }
    // ADR-204 F3.1c: pausa do dono (kill switch) bloqueia efeito — a IA no máximo prepara, seja qual for a política.
    const pause = AutonomyKillSwitchService.isPaused(orgId, input.domain, input.actionType);
    if (pause) { if (level > 2) level = 2; reason = `autonomia pausada pelo dono (${pause.reason}): nenhum efeito sai, a IA só analisa e prepara`; }
    const label = ["observar", "recomendar", "preparar", "executar dentro de limites"][level];
    return { level, label, humanOnly, capped, level4Blocked, paused: !!pause, reason };
  }

  /**
   * ADR-204 F3.1c (PRD §37) — TRAVAS opt-in no `execute`, configuradas POR TIPO de ação em `agent_policies.config_json.gates`:
   *   - `minConfidence` (0–1): confiança da ação abaixo disso → não executa;
   *   - `maxExecuteAmount` (≥0): impacto financeiro acima disso → não executa; valor DESCONHECIDO também não (não se prova que cabe no limite);
   *   - `maxDataAgeMinutes` (>0): o dado em que a ação se baseia (`dataAsOf` no comando ou na evidência) mais velho que isso → não executa;
   *     sem `dataAsOf` não dá pra afirmar que está fresco → não executa.
   * Sem trava configurada = comportamento de sempre (0-regressão). Retorna `{}` quando não há nenhuma.
   */
  static gatesFor(orgId: string, domain: string, actionType: string): { minConfidence?: number; maxExecuteAmount?: number; maxDataAgeMinutes?: number } {
    try {
      const cur = db.prepare("SELECT config_json FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ? AND active = 1").get(orgId, domain, actionType) as any;
      const g = cur?.config_json ? (JSON.parse(cur.config_json)?.gates || {}) : {};
      const out: any = {};
      if (Number.isFinite(Number(g.minConfidence)) && g.minConfidence != null) out.minConfidence = Number(g.minConfidence);
      if (Number.isFinite(Number(g.maxExecuteAmount)) && g.maxExecuteAmount != null) out.maxExecuteAmount = Number(g.maxExecuteAmount);
      if (Number.isFinite(Number(g.maxDataAgeMinutes)) && g.maxDataAgeMinutes != null) out.maxDataAgeMinutes = Number(g.maxDataAgeMinutes);
      return out;
    } catch { return {}; }
  }

  /**
   * Liga/ajusta/desliga travas de um tipo de ação. `undefined` mantém, `null` limpa. EXIGE política ativa já existente:
   * criar uma só para guardar a trava mudaria o que o `dispatchGoverned` faz (ele só semeia política quando não há nenhuma).
   */
  static setGates(orgId: string, domain: string, actionType: string, patch: { minConfidence?: number | null; maxExecuteAmount?: number | null; maxDataAgeMinutes?: number | null }): { minConfidence?: number; maxExecuteAmount?: number; maxDataAgeMinutes?: number } {
    const cur = db.prepare("SELECT id, config_json FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ? AND active = 1").get(orgId, domain, actionType) as any;
    if (!cur) throw new Error("Defina a política deste tipo de ação antes de configurar as travas de segurança.");
    let config: any = {};
    if (cur.config_json) { try { config = JSON.parse(cur.config_json) || {}; } catch { config = {}; } }
    const gates: any = { ...(config.gates || {}) };
    const num = (v: any, name: string, ok: (n: number) => boolean, msg: string) => {
      if (v === undefined) return;
      if (v === null) { delete gates[name]; return; }
      const n = Number(v);
      if (!Number.isFinite(n) || !ok(n)) throw new Error(msg);
      gates[name] = n;
    };
    num(patch.minConfidence, "minConfidence", (n) => n >= 0 && n <= 1, "Confiança mínima deve estar entre 0 e 1.");
    num(patch.maxExecuteAmount, "maxExecuteAmount", (n) => n >= 0, "O teto de execução não pode ser negativo.");
    num(patch.maxDataAgeMinutes, "maxDataAgeMinutes", (n) => n > 0, "A idade máxima do dado deve ser maior que zero (minutos).");
    if (Object.keys(gates).length) config.gates = gates; else delete config.gates;
    db.prepare("UPDATE agent_policies SET config_json = ? WHERE id = ?").run(JSON.stringify(config), cur.id);
    return this.gatesFor(orgId, domain, actionType);
  }

  /**
   * Avalia as travas contra uma ação (linha de `decision_actions`). `null` = pode seguir. Determinístico, sem efeito.
   * O código devolvido vira o "Não executei porque…" (ExecutionTraceService.REFUSAL_TEXT).
   */
  static evaluateGates(orgId: string, action: any, now: Date = new Date()): { code: string; message: string } | null {
    const g = this.gatesFor(orgId, action.domain, action.action_type);
    if (g.minConfidence != null) {
      const c = action.confidence == null ? null : Number(action.confidence);
      if (c == null || !Number.isFinite(c) || c < g.minConfidence) return { code: "confidence_below_min", message: `Confiança ${c == null ? "desconhecida" : c.toFixed(2)} abaixo do mínimo exigido (${g.minConfidence}).` };
    }
    if (g.maxExecuteAmount != null) {
      if (action.expected_impact == null || !Number.isFinite(Number(action.expected_impact))) return { code: "amount_unknown", message: `Há teto de execução (${g.maxExecuteAmount}) e o valor da ação é desconhecido — não dá pra provar que cabe no limite.` };
      if (Math.abs(Number(action.expected_impact)) > g.maxExecuteAmount) return { code: "amount_above_limit", message: `Valor ${Math.abs(Number(action.expected_impact))} acima do teto de execução (${g.maxExecuteAmount}).` };
    }
    if (g.maxDataAgeMinutes != null) {
      let asOf: any = null;
      for (const raw of [action.command_payload_json, action.evidence_json]) {
        if (asOf || !raw) continue;
        try { const o = JSON.parse(raw); asOf = o?.dataAsOf ?? o?.data_as_of ?? null; } catch { /* json torto → sem data */ }
      }
      const t = asOf ? new Date(asOf).getTime() : NaN;
      if (!Number.isFinite(t)) return { code: "data_freshness_unknown", message: `Há limite de idade do dado (${g.maxDataAgeMinutes} min) e a ação não informa de quando é o dado — não dá pra afirmar que está atualizado.` };
      const ageMin = (now.getTime() - t) / 60000;
      if (ageMin > g.maxDataAgeMinutes) return { code: "data_stale", message: `Dado de ${Math.round(ageMin)} min atrás, acima do limite de ${g.maxDataAgeMinutes} min.` };
    }
    return null;
  }

  /**
   * ADR-204 F3.1d (PRD §34) — visão para a tela Empresa → Autonomia da IA, em linguagem de dono: o que SEMPRE exige uma
   * pessoa (por categoria), cada política ativa da empresa com seu nível 0–3 (derivado) e a pausa/travas daquele tipo, e a
   * pausa da empresa inteira. Read-only; o nível mostrado é DERIVADO da política — a tela não cria uma forma nova de elevar
   * a autonomia (RN-F3-3). Isolado por organização.
   */
  static overview(orgId: string): any {
    const rows = db.prepare("SELECT domain, action_type FROM agent_policies WHERE organization_id = ? AND active = 1 ORDER BY domain, action_type").all(orgId) as any[];
    const policies = rows.map((r) => {
      const lv = this.autonomyLevel(orgId, { domain: r.domain, actionType: r.action_type });
      const pause = AutonomyKillSwitchService.isPaused(orgId, r.domain, r.action_type);
      return {
        domain: r.domain, actionType: r.action_type, label: ACTION_LABELS[r.action_type] || "Ação interna",
        level: lv.level, levelLabel: lv.label, humanOnly: lv.humanOnly, paused: lv.paused,
        pausedScope: pause ? pause.scope : null, reason: lv.reason, gates: this.gatesFor(orgId, r.domain, r.action_type),
      };
    });
    return {
      pause: AutonomyKillSwitchService.status(orgId),
      humanOnly: Object.entries(HUMAN_ONLY_CATEGORIES).map(([key, c]) => ({ key, label: c.label, types: [...c.types] })),
      policies,
    };
  }

  /**
   * ADR-204 F3.1b (RN-F3-8) — FOTO da política que governa uma ação no momento da proposta: de onde veio a regra
   * (banda do dono / política da org / matriz padrão), o estado do contrato, quantas pessoas precisam aprovar, se o
   * PISO (F3.1a) apertou a regra e o nível 0–3 derivado. É o que permite responder "por que o ZapFlow fez isso?"
   * depois, mesmo que o dono mude a política. Determinístico, sem I/O além de ler a política; nunca lança.
   */
  static snapshot(orgId: string, input: { domain: string; actionType: string; amount?: number | null; policy: ApprovalPolicy; requiredRole: string | null; floorApplied?: boolean }): any {
    try {
      const contract = this.resolveContract(orgId, { domain: input.domain, actionType: input.actionType, amount: input.amount });
      const level = this.autonomyLevel(orgId, { domain: input.domain, actionType: input.actionType });
      const cfg = db.prepare("SELECT 1 AS x FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ? AND active = 1").get(orgId, input.domain, input.actionType);
      const source = contract.enforced ? "bands" : cfg ? "agent_policy" : "default_matrix";
      return {
        version: 1,
        capturedAt: new Date().toISOString(),
        source,
        approvalPolicy: input.policy,
        requiredRole: input.requiredRole || null,
        requiredApprovals: this.requiredApprovals(input.policy),
        humanOnly: this.isHumanOnly(input.actionType),
        floorApplied: !!input.floorApplied,
        contract: { state: contract.state, reason: contract.reason, enforced: contract.enforced, requiredRole: contract.requiredRole },
        autonomy: { level: level.level, label: level.label, level4Blocked: level.level4Blocked, reason: level.reason },
        gates: this.gatesFor(orgId, input.domain, input.actionType),
        amount: input.amount != null && Number.isFinite(Number(input.amount)) ? Math.abs(Number(input.amount)) : null,
      };
    } catch { return null; }
  }

  /**
   * ADR-159 F3 (D4) — resolve o ESTADO do Autonomy Contract para (domínio, tipo,
   * valor). Ordem de precedência:
   *   1) BANDAS valor→papel (`config_json.bands`) — o modelo D4 de 1ª classe.
   *      A 1ª banda cujo teto (`upTo`) cobre o valor decide (null = teto final).
   *      `enforced=true`: o `propose` PASSA A IMPOR este estado (opt-in — só
   *      quando o dono configurou bandas).
   *   2) Ponte LEGADA: `max_auto_amount` + `approval_role`. Acima do teto →
   *      escalonar (se há papel) / requer aprovação; dentro → permitido.
   *      `enforced=false` (advisória — não muda o fluxo pré-F3).
   *   3) Sem política: default-deny p/ financeiro/destrutivo (RN-159-1), senão
   *      "requer aprovação" por padrão. `enforced=false` (opinião; o enforcement
   *      geral do default-deny é o D3/F4 sob flag).
   */
  static resolveContract(orgId: string, input: { domain: string; actionType: string; amount?: number | null }): {
    state: AutonomyState; requiredRole: string | null; band: AutonomyBand | null; reason: string; enforced: boolean;
  } {
    const cfg = db.prepare("SELECT approval_role, max_auto_amount, active, config_json FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ?")
      .get(orgId, input.domain, input.actionType) as any;
    const amount = Math.abs(Number(input.amount) || 0);

    // 1) Bandas explícitas.
    let bands: AutonomyBand[] | null = null;
    if (cfg?.config_json) { try { const c = JSON.parse(cfg.config_json); if (Array.isArray(c?.bands) && c.bands.length) bands = c.bands; } catch { /* config torto → ignora bandas */ } }
    if (bands) {
      const sorted = [...bands].sort((a, b) => (a.upTo == null ? Infinity : Number(a.upTo)) - (b.upTo == null ? Infinity : Number(b.upTo)));
      const match = sorted.find((b) => b.upTo == null || amount <= Number(b.upTo)) || sorted[sorted.length - 1];
      const state: AutonomyState = AUTONOMY_STATES.has(match.state) ? match.state : "require_approval";
      return { state, requiredRole: match.role ?? cfg.approval_role ?? null, band: match, reason: `banda valor→papel (valor=${amount})`, enforced: true };
    }

    // 2) Ponte legada (max_auto_amount / approval_role).
    if (cfg && Number(cfg.active)) {
      if (cfg.max_auto_amount != null && amount > Number(cfg.max_auto_amount)) {
        return { state: cfg.approval_role ? "escalate" : "require_approval", requiredRole: cfg.approval_role ?? null, band: null, reason: `acima do teto de automação (${cfg.max_auto_amount})`, enforced: false };
      }
      return { state: "allow", requiredRole: null, band: null, reason: "dentro do teto de automação", enforced: false };
    }

    // 3) Sem política resolvida.
    const risky = FINANCIAL_OR_DESTRUCTIVE.has(input.actionType) || input.domain === "finance";
    return risky
      ? { state: "deny", requiredRole: null, band: null, reason: "ação financeira/destrutiva sem política resolvida (default-deny, RN-159-1)", enforced: false }
      : { state: "require_approval", requiredRole: null, band: null, reason: "sem política — requer aprovação por padrão", enforced: false };
  }

  /**
   * ADR-159 F3 — grava/atualiza as bandas valor→papel de uma (domínio, tipo) em
   * `config_json.bands` (upsert idempotente da linha de `agent_policies`, sem
   * tocar autonomy_level/execution_mode). Ligar bandas é o opt-in do enforcement.
   */
  static setBands(orgId: string, domain: string, actionType: string, bands: AutonomyBand[]): void {
    const cur = db.prepare("SELECT id, config_json FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ?").get(orgId, domain, actionType) as any;
    let config: any = {};
    if (cur?.config_json) { try { config = JSON.parse(cur.config_json) || {}; } catch { config = {}; } }
    config.bands = bands;
    if (cur) db.prepare("UPDATE agent_policies SET config_json = ? WHERE id = ?").run(JSON.stringify(config), cur.id);
    else db.prepare("INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, active, config_json) VALUES (?, ?, ?, ?, 'suggest', 1, ?)").run(randomUUID(), orgId, domain, actionType, JSON.stringify(config));
  }
}

export default ApprovalPolicyService;
