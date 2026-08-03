/**
 * TEST — FalaTu Fatia 2 (ADR-151): rollout multi-tenant.
 *
 * Cobre: flag opt-in `falatu_enabled` (default desligada, por org); gate da
 * rota (Master Admin sempre entra; org sem flag recebe 403; org com flag
 * passa); RBAC granular ADR-095 (módulo "falatu" registrado, perfis com
 * default none sem acesso, dono/gerente com acesso, parque legado sem perfil
 * não é gateado); limite de uso por plano (captura respeita o teto mensal de
 * ações de IA e conta no ai_interactions_log; billing bloqueado trava; org
 * sem plano não tem teto); isolamento multi-tenant do consumo.
 *
 * Mocka FalaTuService.interpret (sem chave OpenAI) — o resto do fluxo é real.
 *
 * Uso: npm run test:falatu-rollout
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-f2-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-rollout-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuService } = await import("../src/server/FalaTuService.js");
  const { PermissionService, RBAC_MODULES, ROUTE_MODULE } = await import("../src/server/PermissionService.js");
  const { falatuGate } = await import("../src/server/routes/falatu.js");
  const { MASTER_ADMIN_EMAIL } = await import("../src/server/config/secret.js");

  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const userA = randomUUID();
  const userB = randomUUID();
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org B', 'active')`).run(randomUUID(), orgB);

  // Mock da extração (o gate de plano e o log de consumo rodam ANTES/DEPOIS dela no capture real).
  (FalaTuService as any).interpret = async (input: any) => ({
    transcription: input.text || "",
    summary: "Ligar pro contador",
    intent: "TASK",
    entities: { people: [], projects: [], actions: ["ligar"], listItems: [], eventDate: null, eventTime: null },
    confidence: 0.9,
    suggestedAction: "Criar tarefa",
  });

  // ===== 1. Flag opt-in por org (default DESLIGADA) =====
  check("flag nasce desligada (opt-in, convenção nº 10)", FalaTuService.orgEnabled(orgA) === false);
  FalaTuService.setOrgEnabled(orgA, true);
  check("setOrgEnabled liga a flag da org", FalaTuService.orgEnabled(orgA) === true);
  check("flag NÃO vaza pra outra org (isolamento)", FalaTuService.orgEnabled(orgB) === false);
  FalaTuService.setOrgEnabled(orgA, false);
  check("setOrgEnabled desliga de volta", FalaTuService.orgEnabled(orgA) === false);

  // ===== 2. Gate da rota (middleware, sem subir Express) =====
  const runGate = (user: any, orgId: string) => {
    let nexted = false; let code: number | null = null;
    const req: any = { user, organizationId: orgId };
    const res: any = { status: (c: number) => { code = c; return { json: () => undefined }; } };
    (falatuGate as any)(req, res, () => { nexted = true; });
    return { nexted, code };
  };
  const master = runGate({ email: MASTER_ADMIN_EMAIL, userId: userA }, orgA);
  check("Master Admin entra mesmo com a flag desligada", master.nexted && master.code === null);
  const blocked = runGate({ email: "cliente@org-a.com", userId: userA }, orgA);
  check("org sem flag → 403 (não vaza o módulo)", !blocked.nexted && blocked.code === 403);
  FalaTuService.setOrgEnabled(orgA, true);
  const allowed = runGate({ email: "cliente@org-a.com", userId: userA }, orgA);
  check("org com flag ligada → passa", allowed.nexted && allowed.code === null);

  // ===== 3. RBAC granular (ADR-095) =====
  check("módulo 'falatu' registrado no RBAC", (RBAC_MODULES as readonly string[]).includes("falatu"));
  check("segmento /falatu mapeado pro módulo (enforcement global)", ROUTE_MODULE["falatu"] === "falatu");
  PermissionService.seedSystemProfiles(orgA);
  const profId = (key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(orgA, key) as any)?.id;
  check("dono tem full em falatu", PermissionService.levelFor(orgA, { role_profile_id: profId("owner") }, "falatu") === "full");
  check("gerente tem acesso (default full do template)", PermissionService.can(orgA, { role_profile_id: profId("gerente") }, "falatu", "write"));
  check("atendente NÃO tem acesso (default none)", PermissionService.levelFor(orgA, { role_profile_id: profId("atendente") }, "falatu") === "none");
  // Enforcement global por rota: legado sem perfil passa; com perfil, gateia.
  const legacy = PermissionService.checkRouteAccess(orgA, { userId: userA, role: "agent" }, "falatu", "GET");
  check("parque legado (sem perfil) não é gateado pelo RBAC", legacy.gated === false && legacy.allow === true);
  const gatedNo = PermissionService.checkRouteAccess(orgA, { role_profile_id: profId("atendente") }, "falatu", "GET");
  check("perfil sem nível é barrado no enforcement global", gatedNo.gated === true && gatedNo.allow === false);
  const gatedYes = PermissionService.checkRouteAccess(orgA, { role_profile_id: profId("gerente") }, "falatu", "POST");
  check("perfil com nível passa no enforcement global", gatedYes.gated === true && gatedYes.allow === true);
  check("permissionMap expõe o nível de falatu pro menu", PermissionService.permissionMap(orgA, { role_profile_id: profId("gerente") }).falatu === "full");

  // ===== 4. Limite de uso por plano (captura = ação de IA) =====
  db.prepare(`INSERT INTO plans (id, name, price, features) VALUES ('test_nano', 'Nano (teste)', 1, ?)`).run(JSON.stringify({ ai_monthly_limit: 2 }));
  db.prepare(`UPDATE organization_settings SET plan_id = 'test_nano' WHERE organization_id = ?`).run(orgA);
  const aiCount = (org: string) => (db.prepare(`SELECT COUNT(*) c FROM ai_interactions_log WHERE organization_id = ? AND agent_used = 'falatu'`).get(org) as any).c;

  const cap1 = await FalaTuService.capture(orgA, userA, { text: "ligar pro contador" });
  check("captura 1 dentro do teto funciona", cap1?.status === "pending");
  check("captura conta no ai_interactions_log (agent 'falatu')", aiCount(orgA) === 1);
  await FalaTuService.capture(orgA, userA, { text: "pagar o fornecedor" });
  check("captura 2 esgota o teto do plano (limite=2)", aiCount(orgA) === 2);

  let threw = "";
  try { await FalaTuService.capture(orgA, userA, { text: "mais uma" }); } catch (e: any) { threw = e.message; }
  check("captura 3 é travada pelo teto mensal do plano", /Limite mensal/.test(threw));
  check("captura travada NÃO grava item no inbox", (db.prepare(`SELECT COUNT(*) c FROM falatu_inbox_items WHERE organization_id = ?`).get(orgA) as any).c === 2);

  // Org sem plano → sem teto (aiAllowed não trava sem plan_id).
  FalaTuService.setOrgEnabled(orgB, true);
  const capB = await FalaTuService.capture(orgB, userB, { text: "org B segue capturando" });
  check("org sem plano não tem teto (e não herda o consumo da outra)", capB?.status === "pending" && aiCount(orgB) === 1);

  // Billing bloqueado trava a captura (mesmo enforcement do atendimento).
  db.prepare(`UPDATE organization_settings SET billing_status = 'blocked' WHERE organization_id = ?`).run(orgB);
  threw = "";
  try { await FalaTuService.capture(orgB, userB, { text: "não deveria passar" }); } catch (e: any) { threw = e.message; }
  check("billing bloqueado trava a captura", /bloqueada|pendente/.test(threw));

  // ===== 5. Auditoria segue viva na captura multi-tenant =====
  const audits = (db.prepare(`SELECT COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'FALATU_CAPTURE'`).get(orgA) as any).c;
  check("FALATU_CAPTURE auditado por captura aceita", audits === 2);

  // ===== Resultado =====
  console.log("\n=== FalaTu Fatia 2 (rollout multi-tenant) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
