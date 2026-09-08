/**
 * TEST — Fala Tu agenda COMPROMISSO com cliente por comando GOVERNADO (F11).
 * "marca reunião com <cliente> <data> <hora>" NÃO agenda direto: resolve o cliente
 * nos contatos, propõe governado (awaiting_approval) e só cria o appointment na
 * aprovação (AppointmentService.create).
 *   - classify detecta agendamento; pergunta ("qual minha agenda?") não vira.
 *   - parseAppointment: nome/data/hora/título.
 *   - cliente não cadastrado → não propõe (honesto); ambíguo → pede nome completo;
 *     sem data/hora → pede.
 *   - com cliente resolvido → propõe; approve→execute cria o appointment.
 *   - isolamento.
 *
 * Uso: npm run test:falatu-record-appointment
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-appt-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-falatu-appt-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FalaTuAskService } = await import("../src/server/FalaTuAskService.js");
  const { FalatuRecordService } = await import("../src/server/FalatuRecordService.js");
  const { FalaTuService } = await import("../src/server/FalaTuService.js");
  const { DecisionActionService } = await import("../src/server/DecisionActionService.js");
  const { CommandExecutorService } = await import("../src/server/CommandExecutorService.js");

  const mkOrg = () => {
    const o = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status, vertical) VALUES (?, 'Toulon', 'active', 'moda')`).run(o);
    FalaTuService.setOrgEnabled(o, true);
    return o;
  };
  const mkContact = (org: string, name: string) => {
    let ch = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND provider = 'falatu'`).get(org) as any;
    if (!ch) { const cid = randomUUID(); db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'falatu', 'Fala Tu', 'falatu', 'connected')`).run(cid, org); ch = { id: cid }; }
    const id = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`).run(id, org, ch.id, name, `${name}-${id.slice(0, 4)}`);
    return id;
  };
  const apptCount = (org: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM appointments WHERE organization_id = ?`).get(org) as any)?.n || 0);

  const A = mkOrg();
  const owner = { userId: randomUUID(), role: "owner", organizationId: A };

  // ── 1. classify ──
  check("1.1 'marca reunião com João amanhã às 10h' → record_appointment", FalaTuAskService.classify("marca reunião com João amanhã às 10h", "2026-09-08").kind === "record_appointment");
  check("1.2 'agenda consulta com Maria dia 05/09 14h' → record_appointment", FalaTuAskService.classify("agenda consulta com Maria dia 05/09 14h", "2026-09-08").kind === "record_appointment");
  check("1.3 pergunta 'qual a minha agenda amanhã?' → NÃO record_appointment", FalaTuAskService.classify("qual a minha agenda amanhã?", "2026-09-08").kind !== "record_appointment");

  // ── 2. parseAppointment ──
  const p = FalatuRecordService.parseAppointment("marca reunião com João Silva dia 05/09/2025 às 14h30", "2026-09-08");
  check("2.1 nome", p.contactName === "João Silva");
  check("2.2 data", p.date === "2025-09-05");
  check("2.3 hora 14:30", p.time === "14:30");
  check("2.4 título Reunião", p.title === "Reunião");

  // ── 3. cliente não cadastrado → não propõe (honesto) ──
  const r0 = await FalaTuAskService.converse(A, owner, "marca reunião com Fulano dia 05/09/2025 às 14h");
  check("3.1 contact_not_found → não propõe", r0.kind === "record_appointment" && !r0.data?.actionId && /não achei o cliente/i.test(r0.answer));

  // ── 4. com cliente resolvido → propõe ──
  const maria = mkContact(A, "Maria Souza");
  const r1 = await FalaTuAskService.converse(A, owner, "marca reunião com Maria dia 05/09/2025 às 14h");
  check("4.1 kind record_appointment + actionId", r1.kind === "record_appointment" && !!r1.data?.actionId);
  const action = DecisionActionService.get(A, r1.data!.actionId);
  check("4.2 awaiting_approval, agenda/falatu_record_appointment", action?.status === "awaiting_approval" && action?.domain === "agenda" && action?.action_type === "falatu_record_appointment");
  check("4.3 payload com contactId resolvido + scheduledStart", action?.command_payload?.contactId === maria && /2025-09-05T14:00/.test(String(action?.command_payload?.scheduledStart)));
  check("4.4 NADA na agenda ainda", apptCount(A) === 0);

  // ── 5. approve → execute → appointment criado ──
  DecisionActionService.approve(A, r1.data!.actionId, owner.userId, { reason: "ok" });
  await CommandExecutorService.execute(A, r1.data!.actionId);
  const appt = db.prepare(`SELECT * FROM appointments WHERE organization_id = ?`).get(A) as any;
  check("5.1 appointment criado", apptCount(A) === 1);
  check("5.2 contato certo + início certo", appt?.contact_id === maria && /2025-09-05T14:00/.test(String(appt?.scheduled_start)));

  // ── 6. sem data/hora → pede ──
  const r2 = await FalaTuAskService.converse(A, owner, "marca reunião com Maria");
  check("6.1 no_datetime → pede data/hora", r2.kind === "record_appointment" && !r2.data?.actionId && /faltou a data ou a hora/i.test(r2.answer));

  // ── 7. ambíguo (2 clientes 'Maria') → pede nome completo ──
  mkContact(A, "Maria Lima");
  const r3 = await FalaTuAskService.converse(A, owner, "marca reunião com Maria dia 06/09/2025 às 09h");
  check("7.1 contact_ambiguous → pede nome completo", !r3.data?.actionId && /mais de um cliente/i.test(r3.answer));

  // ── 8. isolamento ──
  const B = mkOrg();
  check("8.1 org B sem appointments de A", apptCount(B) === 0 && apptCount(A) === 1);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-record-appointment: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
