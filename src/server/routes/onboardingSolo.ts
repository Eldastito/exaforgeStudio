import { Router, Request, Response } from "express";
import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";
import db from "../db.js";
import { logAuthEvent } from "../auditLog.js";
import { VerticalBlueprintService } from "../VerticalBlueprintService.js";
import { FalaTuSoloWhatsAppService } from "../FalaTuSoloWhatsAppService.js";
import { EntitlementService } from "../EntitlementService.js";

// Inline pra não criar módulo separado: mesma política do POST /register.
function passwordPolicyError(pw: string): string | null {
  if (typeof pw !== "string" || pw.length < 8) return "A senha deve ter pelo menos 8 caracteres.";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "A senha deve conter letras e números.";
  return null;
}

/**
 * ADR-154 Fatia 2.1 — Onboarding Standalone (Solo).
 *
 * Fluxo dedicado pra criar uma org de 1 usuário com um blueprint **solo** já
 * aplicado — assistente pessoal single-purpose. Diferente do POST /register:
 *
 * - NÃO exige `organizationName` (usa "Assistente de {name}" como default).
 * - NÃO pergunta segment/vertical (blueprint solo tem base_vertical fixo).
 * - EXIGE `blueprintKey` de um blueprint publicado em mode='solo' — se apontar
 *   pra suite ou não publicado, 400 (impede cadastro solo em blueprint errado).
 * - Aplica o blueprint atomicamente no mesmo request — a org já nasce Solo,
 *   sem janela onde poderia enxergar módulos hidden.
 * - Retorna 201 (mesmo padrão do /register — login separado).
 *
 * Body: `{ name, email, password, phone?, businessName?, blueprintKey }`
 *
 * Auditoria: `USER_REGISTERED_SOLO` com `{email, blueprintKey, blueprintVersion}`.
 */

const router = Router();

router.post("/", async (req: Request, res: Response): Promise<any> => {
  const { name, email, phone, password, businessName, blueprintKey } = req.body || {};

  if (!name || !email || !password) {
    return res.status(400).json({ error: "Missing required fields: name, email, password" });
  }
  if (!blueprintKey || typeof blueprintKey !== "string") {
    return res.status(400).json({ error: "blueprintKey é obrigatório" });
  }

  const pwErr = passwordPolicyError(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const bp = VerticalBlueprintService.getLatestPublished(blueprintKey);
  if (!bp) {
    return res.status(400).json({ error: `Blueprint solo '${blueprintKey}' não encontrado ou não publicado.` });
  }
  if (bp.mode !== "solo") {
    return res.status(400).json({ error: `Blueprint '${blueprintKey}' é '${bp.mode}', não 'solo'. Use POST /api/auth/register pra onboarding suíte.` });
  }

  try {
    // F2.1c: email duplicado vira 409 estruturado (B.1 — 1 email = 1 conta).
    // Contexto pro frontend decidir a próxima ação:
    //   - `falatuInPlan=true`  → usuário JÁ pode usar FalaTu, faz login normal.
    //   - `falatuInPlan=false` → sugere upgrade do plano da conta existente.
    // Nunca vazamos existência de conta pra terceiros (o próprio usuário
    // recebe essa resposta autenticando pelo campo `email` que ele digitou —
    // não é enumeração cruzada).
    const existingUser = db.prepare(
      "SELECT id, organization_id FROM users WHERE email = ?",
    ).get(email) as { id: string; organization_id: string } | undefined;
    if (existingUser) {
      let falatuInPlan = false;
      try {
        const decision = EntitlementService.check(existingUser.organization_id, { userId: existingUser.id, email } as any, "falatu", "view");
        falatuInPlan = !!decision && decision.state === "active";
      } catch { /* best-effort — na dúvida assume false */ }
      return res.status(409).json({
        error: "email_in_use",
        falatuInPlan,
        message: falatuInPlan
          ? "Este email já tem conta. Faça login normal — o FalaTu está no seu plano."
          : "Este email já tem conta ZappFlow. Adicione o FalaTu ao seu plano atual em vez de criar uma conta separada.",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const orgId = "org_" + uuidv4().substring(0, 8);
    const bizName = (businessName && String(businessName).trim()) || `Assistente de ${name}`;

    // Cria a org com o vertical do blueprint (herda o base_vertical) e status
    // active — solo não passa por onboarding wizard (nada pra configurar).
    // F2.1c: default_landing_view='falatu' pra que /entitlements/me devolva
    // isso e o useStore aterrissar em FalaTu por padrão (não em 'saude', que é
    // o fallback pra suíte). Sem isso, cada refresh joga o usuário Solo pra
    // Central de Saúde que ele nem tem acesso (blueprint solo esconde tudo).
    db.prepare(`
      INSERT INTO organization_settings (id, organization_id, business_name, phone, vertical, status, onboarding_status, plan_id, billing_status, default_landing_view)
      VALUES (?, ?, ?, ?, ?, 'active', 'completed', ?, 'active', 'falatu')
    `).run(uuidv4(), orgId, bizName, phone || null, bp.baseVertical, bp.defaultPlanId || null);

    // Solo do FalaTu: liga a flag opt-in do módulo já no cadastro pra que o
    // frontend receba `falatuEnabled=true` no /permissions/me sem passo extra.
    // Aditivo — se a coluna não existir na org, o UPDATE é no-op.
    try {
      db.prepare(`UPDATE organization_settings SET falatu_enabled = 1 WHERE organization_id = ?`).run(orgId);
    } catch { /* noop — org sem a coluna (rollback) segue funcionando */ }

    // Aplica o blueprint atomicamente. Se falhar, o cadastro inteiro rola
    // back (throw pra fora do try). Passa o próprio userId como actor depois.
    VerticalBlueprintService.assignToOrganization(orgId, bp.id, "system-solo-onboard");

    const userId = uuidv4();
    db.prepare(`
      INSERT INTO users (id, organization_id, name, email, phone, password_hash, role, global_status)
      VALUES (?, ?, ?, ?, ?, ?, 'owner', 'active')
    `).run(userId, orgId, name, email, phone || null, passwordHash);

    logAuthEvent(orgId, userId, userId, "USER_REGISTERED_SOLO", {
      email, blueprintKey: bp.key, blueprintVersion: bp.version, businessName: bizName,
    });

    // ADR-154 Fatia 4.1 — provision Evolution DEDICADA best-effort. Se
    // EVOLUTION_BASE_URL/API_KEY não estiver configurado (dev local, CI) ou a
    // Evolution estiver fora do ar, NÃO derruba o cadastro — usuário pode
    // chamar POST /api/falatu-solo/whatsapp/provision depois pra tentar QR.
    // O flag `whatsapp_instance_kind='dedicated'` é setado pelo service mesmo
    // se a chamada de rede falhar (é intenção declarada, não estado da rede).
    let whatsapp: { instanceName?: string; qrBase64?: string; channelId?: string; provisionError?: string } | undefined;
    try {
      const prov = await FalaTuSoloWhatsAppService.provision(orgId, userId);
      whatsapp = {
        instanceName: prov.instanceName,
        qrBase64: prov.qrBase64,
        channelId: prov.channelId,
        provisionError: prov.ok ? undefined : prov.error,
      };
    } catch (e: any) {
      console.warn("[Onboarding Solo] provision Evolution falhou (best-effort):", e?.message || e);
      whatsapp = { provisionError: e?.message || "provision indisponível" };
    }

    res.status(201).json({
      message: "Registration successful",
      organizationId: orgId,
      blueprint: { key: bp.key, version: bp.version, mode: bp.mode, name: bp.name },
      whatsapp,
    });
  } catch (error: any) {
    console.error("[Onboarding Solo] error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
