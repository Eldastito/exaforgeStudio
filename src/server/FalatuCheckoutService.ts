import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { VerticalBlueprintService } from "./VerticalBlueprintService.js";
import { AsaasService } from "./AsaasService.js";
import { PlanService } from "./PlanService.js";
import { isFalatuPlanId } from "./falatuPlans.js";

/**
 * ADR-154 F2.2 (Fatia B) — checkout self-serve do FalaTu.
 *
 * Fecha o caminho crítico "escolhe plano → PAGA → conta ativa". Um visitante
 * NÃO logado escolhe um plano B2C (Solo/Pro/Família), a gente cria a org+dono
 * já com o `plan_id` e a assinatura recorrente no Asaas, e devolve o link de
 * pagamento (Pix/cartão/boleto — página hospedada do Asaas, a gente NUNCA toca
 * dado de cartão). A org nasce `trialing` e o WEBHOOK EXISTENTE do Asaas
 * (AsaasService.handleWebhook → PlanService.setBillingStatus 'active') a promove
 * quando o primeiro pagamento confirma — zero código novo de ativação.
 *
 * Garantia de 7 dias (não é trial grátis): cobra na hora, com direito a
 * reembolso em 7 dias (CDC Art.49) — o mecanismo de reembolso é a Fatia D.
 *
 * Guardrails money-critical:
 * - só planos `falatu_*` (isFalatuPlanId) — nunca cobra um tier B2B por aqui;
 * - exige Asaas configurado (sem gateway, 503 `billing_not_configured` — não
 *   cria conta órfã "grátis" que era o vazamento que a gente está fechando);
 * - 1 email = 1 conta (dedup → `email_in_use`);
 * - se a assinatura no Asaas falhar DEPOIS de criar a org, faz rollback
 *   (a org acabou de nascer, sem dado nenhum) — não deixa conta pendurada.
 */

/**
 * Versão dos documentos legais aceitos no checkout (Termos + Privacidade +
 * Cancelamento). Bumpe a data quando o texto mudar — o aceito gravado guarda
 * QUAL versão o cliente aceitou (prova de consentimento, LGPD/CDC).
 */
export const FALATU_TERMS_VERSION = "2026-08-08";

export type FalatuCheckoutInput = {
  name: string; email: string; phone?: string; cpf: string; password: string; planId: string;
  acceptedTerms?: boolean;
};
export type FalatuCheckoutResult = {
  organizationId: string; planId: string; planName: string; price: number; checkoutUrl: string;
};
export class FalatuCheckoutError extends Error {
  constructor(public code: string, public httpStatus: number, message?: string) { super(message || code); }
}

const SOLO_BLUEPRINT_KEY = "falatu_solo"; // todos os tiers B2C usam o blueprint solo (esconde tudo fora do FalaTu)

function passwordPolicyError(pw: string): string | null {
  if (typeof pw !== "string" || pw.length < 8) return "A senha deve ter pelo menos 8 caracteres.";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "A senha deve conter letras e números.";
  return null;
}

export class FalatuCheckoutService {
  /** Injetável pra teste (evita rede real). Produção usa o AsaasService. */
  static async start(input: FalatuCheckoutInput, deps?: {
    subscribe?: typeof AsaasService.subscribe;
    listInvoices?: typeof AsaasService.listInvoices;
    asaasConfigured?: () => boolean;
  }): Promise<FalatuCheckoutResult> {
    const name = String(input?.name || "").trim();
    const email = String(input?.email || "").trim().toLowerCase();
    const cpf = String(input?.cpf || "").replace(/\D/g, "");
    const phone = input?.phone ? String(input.phone).trim() : null;
    const planId = String(input?.planId || "").trim();

    // ---- validação de forma ----
    if (!name || !email || !input?.password) throw new FalatuCheckoutError("missing_fields", 400, "Informe nome, e-mail e senha.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new FalatuCheckoutError("invalid_email", 400, "E-mail inválido.");
    if (cpf.length !== 11) throw new FalatuCheckoutError("invalid_cpf", 400, "CPF inválido (11 dígitos).");
    const pwErr = passwordPolicyError(input.password);
    if (pwErr) throw new FalatuCheckoutError("weak_password", 400, pwErr);

    // Aceite obrigatório dos Termos + Privacidade (prova de consentimento — CDC/LGPD).
    if (input?.acceptedTerms !== true) throw new FalatuCheckoutError("terms_not_accepted", 400, "É preciso aceitar os Termos de Uso e a Política de Privacidade.");

    // ---- plano precisa ser um plano B2C do FalaTu ----
    if (!isFalatuPlanId(planId)) throw new FalatuCheckoutError("invalid_plan", 400, "Plano inválido.");
    const plan = PlanService.listFalatuPlans().find((p) => p.id === planId);
    if (!plan) throw new FalatuCheckoutError("invalid_plan", 400, "Plano inválido.");

    // ---- gateway obrigatório (não cria conta grátis órfã) ----
    const configured = deps?.asaasConfigured ? deps.asaasConfigured() : AsaasService.isConfigured();
    if (!configured) throw new FalatuCheckoutError("billing_not_configured", 503, "Cobrança indisponível no momento.");

    // ---- blueprint solo publicado ----
    const bp = VerticalBlueprintService.getLatestPublished(SOLO_BLUEPRINT_KEY);
    if (!bp || bp.mode !== "solo") throw new FalatuCheckoutError("blueprint_missing", 500, "Configuração do FalaTu indisponível.");

    // ---- 1 email = 1 conta ----
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as any;
    if (existing) throw new FalatuCheckoutError("email_in_use", 409, "Este e-mail já tem conta. Faça login.");

    // ---- cria a org (nasce trialing + plan_id) + dono ----
    const passwordHash = await bcrypt.hash(input.password, 10);
    const orgId = "org_" + uuidv4().substring(0, 8);
    const bizName = `Assistente de ${name}`;
    db.prepare(`
      INSERT INTO organization_settings (id, organization_id, business_name, phone, vertical, status, onboarding_status, plan_id, billing_status, default_landing_view, falatu_terms_version, falatu_terms_accepted_at)
      VALUES (?, ?, ?, ?, ?, 'active', 'completed', ?, 'trialing', 'falatu', ?, CURRENT_TIMESTAMP)
    `).run(uuidv4(), orgId, bizName, phone, bp.baseVertical, planId, FALATU_TERMS_VERSION);
    try { db.prepare(`UPDATE organization_settings SET falatu_enabled = 1 WHERE organization_id = ?`).run(orgId); } catch { /* noop */ }
    VerticalBlueprintService.assignToOrganization(orgId, bp.id, "system-falatu-checkout");
    const userId = uuidv4();
    db.prepare(`
      INSERT INTO users (id, organization_id, name, email, phone, password_hash, role, global_status)
      VALUES (?, ?, ?, ?, ?, ?, 'owner', 'active')
    `).run(userId, orgId, name, email, phone, passwordHash);

    // ---- assinatura no Asaas + link de pagamento. Se falhar, rollback da org. ----
    try {
      const subscribe = deps?.subscribe || AsaasService.subscribe.bind(AsaasService);
      const listInvoices = deps?.listInvoices || AsaasService.listInvoices.bind(AsaasService);
      const today = new Date().toISOString().slice(0, 10);
      const sub = await subscribe(orgId, {
        customer: { name, email, cpfCnpj: cpf, mobilePhone: phone || undefined },
        value: plan.price, // Asaas trabalha em reais
        description: `FalaTu ${plan.name} — assinatura mensal`,
        nextDueDate: today,
        cycle: "MONTHLY",
      });
      if (!sub?.subscriptionId) throw new Error("assinatura não criada no gateway");
      const invoices = await listInvoices(orgId);
      const checkoutUrl = invoices.find((i) => i.invoiceUrl)?.invoiceUrl || "";

      logAuthEvent(orgId, userId, userId, "FALATU_TERMS_ACCEPTED", { email, termsVersion: FALATU_TERMS_VERSION });
      logAuthEvent(orgId, userId, userId, "FALATU_CHECKOUT_STARTED", { email, planId, price: plan.price, subscriptionId: sub.subscriptionId });
      return { organizationId: orgId, planId, planName: plan.name, price: plan.price, checkoutUrl };
    } catch (e: any) {
      // Rollback: a org acabou de nascer sem dado nenhum — remove pra permitir
      // nova tentativa com o mesmo e-mail (senão o dedup barraria o retry).
      try { db.prepare(`DELETE FROM users WHERE organization_id = ?`).run(orgId); } catch { /* noop */ }
      try { db.prepare(`DELETE FROM organization_settings WHERE organization_id = ?`).run(orgId); } catch { /* noop */ }
      throw new FalatuCheckoutError("gateway_error", 502, `Falha ao iniciar a cobrança: ${e?.message || e}`);
    }
  }
}

export default FalatuCheckoutService;
