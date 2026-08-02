/**
 * TESTE — ADR-150 (operação): CLI/serviço de ativação do piloto
 * -------------------------------------------------------------
 * Prova, offline:
 *   - findOrgs acha por trecho do nome (case-insensitive) e ignora removidas;
 *   - plan é SÓ-LEITURA e lista as pendências reais (módulo desligado, sem
 *     calibração, loja sem gerente, vendedor sem vínculo, sem canal, sem sync);
 *   - apply liga o módulo + calibração (default 30d), define gerente por
 *     e-mail (só usuário ATIVO da MESMA org), liga o resumo opt-in, audita;
 *   - idempotência: rodar apply 2x não duplica nem muda nada além do esperado;
 *   - guards: storeCode sem managerEmail; e-mail de outra org; calibrationDays
 *     fora de 0..365; calibrationDays=0 remove a calibração;
 *   - o checklist vira PRONTO quando tudo está preenchido;
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-floor-pilot
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-floor-pilot-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-floor-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { RetailFloorPilotService } = await import("../src/server/RetailFloorPilotService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'TOULON Modas', 'active')`).run(randomUUID(), A);
  ModuleService.applyVertical(A, "moda");
  const DEL = `org_DEL_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, deleted_at) VALUES (?, ?, 'Toulon Antiga', 'active', CURRENT_TIMESTAMP)`).run(randomUUID(), DEL);

  // ---- 1. findOrgs ----
  const found = RetailFloorPilotService.findOrgs("toulon");
  check("findOrgs: acha por trecho (case-insensitive) e ignora removida", found.length === 1 && found[0].orgId === A && found[0].name === "TOULON Modas");

  // ---- 2. plan (só leitura) com pendências ----
  const store1 = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, 'Loja 1005', '1005')`).run(store1, A);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'M-01', 'Ana')`).run(randomUUID(), A);
  const p0 = RetailFloorPilotService.plan(A);
  check("plan: módulo desligado detectado", !p0.moduleEnabled && p0.checklist.some((c: string) => /DESLIGADO/.test(c)));
  check("plan: sem calibração + loja sem gerente + vendedor sem vínculo + sem canal + sem sync",
    p0.checklist.some((c: string) => /calibração/i.test(c)) && p0.checklist.some((c: string) => /manager_user_id/.test(c)) &&
    p0.checklist.some((c: string) => /user_id vinculado/.test(c)) && p0.checklist.some((c: string) => /canal WhatsApp/.test(c)) &&
    p0.checklist.some((c: string) => /Alterdata/.test(c)));
  check("plan: readiness PENDÊNCIAS e nada foi escrito", p0.readiness === "PENDÊNCIAS" && !ModuleService.isEnabled(A, "retail_floor"));

  // ---- 3. apply ----
  const uManager = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email, role) VALUES (?, ?, 'Gerente', 'gerente@toulon.com.br', 'agent')`).run(uManager, A);
  const p1 = RetailFloorPilotService.apply(A, { calibrationDays: 30, storeCode: "1005", managerEmail: "gerente@toulon.com.br" });
  check("apply: módulo ligado", p1.moduleEnabled && ModuleService.isEnabled(A, "retail_floor"));
  const expectCal = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 30); return d.toISOString().slice(0, 10); })();
  check("apply: calibração de 30 dias gravada", p1.settings.calibrationUntil === expectCal);
  check("apply: gerente da loja definido por e-mail", p1.stores[0].hasManager && p1.stores[0].managerEmail === "gerente@toulon.com.br");
  const audit = db.prepare(`SELECT COUNT(*) AS n FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'RETAIL_FLOOR_PILOT_APPLY'`).get(A) as any;
  check("apply: auditado (actor pilot-cli)", Number(audit.n) === 1);

  // Idempotência.
  const p2 = RetailFloorPilotService.apply(A, { calibrationDays: 30 });
  check("apply 2x: idempotente (módulo/gerente/calibração inalterados)",
    p2.moduleEnabled && p2.stores[0].managerEmail === "gerente@toulon.com.br" && p2.settings.calibrationUntil === expectCal);

  // Digest opt-in via apply.
  const p3 = RetailFloorPilotService.apply(A, { calibrationDays: 30, digest: true, digestHour: 19 });
  check("apply: resumo diário ligado com hora", p3.settings.dailyDigestEnabled === true && p3.settings.digestHour === 19);
  check("plan: resumo ligado sem destinatário vira pendência", p3.checklist.some((c: string) => /destinatário/.test(c)));

  // ---- 4. guards ----
  let halfManager = false;
  try { RetailFloorPilotService.apply(A, { managerEmail: "gerente@toulon.com.br" }); } catch (e: any) { halfManager = /--store/.test(e.message); }
  check("guard: manager-email sem store rejeitado", halfManager);
  let badDays = false;
  try { RetailFloorPilotService.apply(A, { calibrationDays: 999 }); } catch (e: any) { badDays = /0 e 365/.test(e.message); }
  check("guard: calibrationDays fora de 0..365 rejeitado", badDays);
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Outra Loja', 'active')`).run(randomUUID(), B);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, role) VALUES (?, ?, 'Intruso', 'intruso@outra.com', 'agent')`).run(randomUUID(), B);
  let crossEmail = false;
  try { RetailFloorPilotService.apply(A, { storeCode: "1005", managerEmail: "intruso@outra.com" }); } catch (e: any) { crossEmail = /NESTA organização/.test(e.message); }
  check("guard: e-mail de OUTRA org rejeitado (isolamento)", crossEmail);
  const p4 = RetailFloorPilotService.apply(A, { calibrationDays: 0 });
  check("calibrationDays=0 remove a calibração", p4.settings.calibrationUntil === null);

  // ---- 4b. corretores das pendências (novos) ----
  const pLink = RetailFloorPilotService.apply(A, { calibrationDays: 30, linkSellers: [{ matricula: "M-01", email: "gerente@toulon.com.br" }] });
  check("link-sellers: matrícula vinculada ao login por e-mail", pLink.sellers.linkedToUser === 1);
  let badMatricula = false;
  try { RetailFloorPilotService.apply(A, { linkSellers: [{ matricula: "M-99", email: "gerente@toulon.com.br" }] }); } catch (e: any) { badMatricula = /matrícula M-99/.test(e.message); }
  check("link-sellers: matrícula inexistente rejeitada", badMatricula);
  let crossLink = false;
  try { RetailFloorPilotService.apply(A, { linkSellers: [{ matricula: "M-01", email: "intruso@outra.com" }] }); } catch (e: any) { crossLink = /NESTA organização/.test(e.message); }
  check("link-sellers: e-mail de outra org rejeitado", crossLink);

  const pResp = RetailFloorPilotService.apply(A, { calibrationDays: 30, storeCode: "1005", responsiblePhone: "+55 (11) 88888-0001", responsibleName: "Gerente" });
  check("responsible: cadastrado normalizado (só dígitos) na loja", pResp.stores[0].responsibles === 1);
  const pResp2 = RetailFloorPilotService.apply(A, { calibrationDays: 30, storeCode: "1005", responsiblePhone: "5511888880001" });
  check("responsible: mesmo número não duplica (dedupe)", pResp2.stores[0].responsibles === 1);
  let badPhone = false;
  try { RetailFloorPilotService.apply(A, { storeCode: "1005", responsiblePhone: "123" }); } catch (e: any) { badPhone = /número WhatsApp válido/.test(e.message); }
  check("responsible: número curto rejeitado", badPhone);
  const pWa = RetailFloorPilotService.apply(A, { calibrationDays: 30, storeCode: "1005", storeWhatsapp: "5511999990001" });
  check("store-whatsapp: número da loja gravado", pWa.stores[0].whatsapp === "5511999990001");

  // ---- 5. checklist PRONTO ----
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'evolution', 'WA', '5511', 'connected')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO alterdata_sync_cursors (id, organization_id, module, resource, filial, version, last_synced_at) VALUES (?, ?, 'supply', 'Saldo', '1005', '1', CURRENT_TIMESTAMP)`).run(randomUUID(), A);
  const pReady = RetailFloorPilotService.plan(A);
  check("checklist: tudo preenchido (via corretores) → PRONTO", pReady.readiness === "PRONTO" && pReady.checklist.length === 0, JSON.stringify(pReady.checklist));
  check("checklist: pendências trazem o comando de correção", p0.checklist.some((c: string) => /--apply/.test(c)));

  // ---- 6. isolamento ----
  const pB = RetailFloorPilotService.plan(B);
  check("Isolamento: plan de B não vê lojas/vendedores de A", pB.stores.length === 0 && pB.sellers.total === 0);

  console.log("\n=== ADR-150 (operação): ativação do piloto ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
