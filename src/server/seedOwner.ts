import db from "./db.js";
import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";

/**
 * Seed opcional de uma conta de DONO DE NEGÓCIO (role 'owner') para testes.
 *
 * Controlado 100% por variáveis de ambiente — a senha NUNCA fica no repositório.
 * Só roda se SEED_OWNER_EMAIL e SEED_OWNER_PASSWORD estiverem definidos.
 *
 * Idempotente:
 *  - Se o usuário não existe: cria a organização + o owner (onboarding concluído).
 *  - Se já existe: apenas REDEFINE a senha (útil para rotacionar o acesso de teste).
 *
 * Envs:
 *  - SEED_OWNER_EMAIL     (obrigatória)
 *  - SEED_OWNER_PASSWORD  (obrigatória; mín. 8 caracteres, com letras e números)
 *  - SEED_OWNER_NAME      (opcional; padrão "Conta de Teste")
 *  - SEED_OWNER_ORG       (opcional; padrão "Empresa de Teste")
 */
export async function seedOwnerFromEnv() {
  const email = (process.env.SEED_OWNER_EMAIL || "").trim().toLowerCase();
  const password = process.env.SEED_OWNER_PASSWORD || "";
  if (!email || !password) return; // opt-in: sem envs, não faz nada.

  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    console.warn("[SeedOwner] SEED_OWNER_PASSWORD fraca (mín. 8 caracteres, com letras e números). Seed ignorado.");
    return;
  }

  const name = (process.env.SEED_OWNER_NAME || "Conta de Teste").trim();
  const orgName = (process.env.SEED_OWNER_ORG || "Empresa de Teste").trim();

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const existing = db.prepare("SELECT id, organization_id FROM users WHERE email = ?").get(email) as any;

    if (existing) {
      db.prepare("UPDATE users SET password_hash = ?, role = 'owner', global_status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(passwordHash, existing.id);
      console.log(`[SeedOwner] Senha redefinida para a conta de teste existente: ${email}`);
      return;
    }

    const orgId = "org_test_" + uuidv4().substring(0, 8);
    const userId = uuidv4();
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO organization_settings (id, organization_id, business_name, status, onboarding_status)
        VALUES (?, ?, ?, 'active', 'completed')
      `).run(uuidv4(), orgId, orgName);
      db.prepare(`
        INSERT INTO users (id, organization_id, name, email, password_hash, role, global_status)
        VALUES (?, ?, ?, ?, ?, 'owner', 'active')
      `).run(userId, orgId, name, email, passwordHash);
    });
    tx();
    console.log(`[SeedOwner] Conta de teste (dono de negócio) criada: ${email} — org "${orgName}".`);
  } catch (e) {
    console.error("[SeedOwner] Falha ao criar/atualizar a conta de teste:", e);
  }
}
