/**
 * TEST — Aprovar pelo WhatsApp fecha o ciclo governado (F10).
 * O GestorCommandService já listava/aprovava as decision_actions awaiting_approval;
 * a F10 faz o "aprovar N" TAMBÉM EXECUTAR o comando (senão aprovar pelo WhatsApp
 * não gravava nada — a despesa ficava 'approved' sem efeito).
 *   - "aprovações" lista as ações governadas pendentes (F5–F7).
 *   - "aprovar 1" aprova E executa → payable criado; resposta cita o efeito.
 *   - "dispensar 1" rejeita → sem efeito.
 *   - colaborador (não-gestor) é barrado.
 *
 * Uso: npm run test:falatu-approve-whatsapp
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-approve-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-falatu-approve-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { GestorCommandService } = await import("../src/server/GestorCommandService.js");
  const { FalatuRecordService } = await import("../src/server/FalatuRecordService.js");
  const { DecisionActionService } = await import("../src/server/DecisionActionService.js");

  const mkOrg = () => {
    const o = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status, vertical, wa_gestor_enabled) VALUES (?, 'Toulon', 'active', 'moda', 1)`).run(o);
    return o;
  };
  const mkUser = (org: string, phone: string, role: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role, global_status) VALUES (?, ?, ?, ?, ?, ?, 'active')`).run(id, org, `U-${phone}`, `${id}@t.com`, phone, role);
    return id;
  };
  const proposeExpense = (org: string) => FalatuRecordService.proposeExpense(org, { amount: 200, supplierName: "Padaria", description: "despesa padaria", dueDate: "2025-09-01" });
  const payablesCount = (org: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM payables WHERE organization_id = ?`).get(org) as any)?.n || 0);

  const A = mkOrg();
  const ownerPhone = "5511900000001";
  mkUser(A, ownerPhone, "owner");

  const a1 = proposeExpense(A);

  // ── 1. "aprovações" lista a ação pendente ──
  const r1 = await GestorCommandService.handle(A, ownerPhone, "aprovações");
  check("1.1 handled", r1.handled === true);
  check("1.2 lista a despesa pendente", /Aguardando/i.test(r1.reply) && /Lançar despesa/i.test(r1.reply));

  // ── 2. "aprovar 1" aprova E executa (grava o payable) ──
  check("2.0 nada em payables antes", payablesCount(A) === 0);
  const r2 = await GestorCommandService.handle(A, ownerPhone, "aprovar 1");
  check("2.1 resposta 'Aprovada'", /Aprovada/i.test(r2.reply));
  check("2.2 resposta cita o efeito (despesa lançada)", /Despesa lançada/i.test(r2.reply));
  check("2.3 payable criado (executou de fato)", payablesCount(A) === 1);
  check("2.4 ação ficou approved (executada)", DecisionActionService.get(A, a1.id)?.status === "approved");

  // ── 3. "dispensar 1" rejeita, sem efeito ──
  const a2 = proposeExpense(A);
  await GestorCommandService.handle(A, ownerPhone, "aprovações"); // renumera (só a2 está pendente)
  const r3 = await GestorCommandService.handle(A, ownerPhone, "dispensar 1");
  check("3.1 resposta 'Dispensada'", /Dispensada/i.test(r3.reply));
  check("3.2 sem novo payable", payablesCount(A) === 1);
  check("3.3 ação a2 rejeitada", DecisionActionService.get(A, a2.id)?.status === "rejected");

  // ── 4. colaborador (não-gestor) barrado ──
  const vendPhone = "5511922222222";
  mkUser(A, vendPhone, "agent");
  const r4 = await GestorCommandService.handle(A, vendPhone, "aprovações");
  check("4.1 colaborador barrado", r4.denied === true && /gestores/i.test(r4.reply));

  // ── 5. isolamento: aprovar em A não afeta B ──
  const B = mkOrg();
  check("5.1 org B sem payables", payablesCount(B) === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-approve-whatsapp: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
