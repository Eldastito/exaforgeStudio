/**
 * TEST — FalaTu Fatia 6 (ADR-151): entrega do briefing diário por WhatsApp.
 *
 * O digest é CONSUMIDOR dos sinais falatu_daily_briefing (Fatia 5): lê o sinal
 * aberto do dia e manda o resumo pro WhatsApp — não recomputa nem cria nada.
 * Cobre: porta de canal (flag falatu_briefing_wa_enabled, separada da flag do
 * módulo); texto determinístico a partir da evidência do sinal; janela da
 * manhã (SP); dedupe por (org, usuário, dia); só entrega a quem tem sinal
 * aberto + telefone; envio manual (ignora janela/dedupe, respeita a porta);
 * NUNCA materializa nada; isolamento multi-tenant.
 *
 * Envio INJETADO (sem rede), sweep de briefing real. Uso: npm run test:falatu-briefing-digest
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-digest-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-digest-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// Janela da manhã / fora da janela em SP (UTC-3). 09:00 SP = 12:00Z; 20:00 SP = 23:00Z.
const MORNING = new Date("2026-08-03T12:00:00Z");
const NIGHT = new Date("2026-08-03T23:00:00Z");
const DATE_SP = "2026-08-03";

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuService } = await import("../src/server/FalaTuService.js");
  const { FalaTuBriefingTaskService } = await import("../src/server/FalaTuBriefingTaskService.js");
  const { FalaTuBriefingDigestService } = await import("../src/server/FalaTuBriefingDigestService.js");

  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const userA = randomUUID();
  const userNoPhone = randomUUID();
  const userB = randomUUID();
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org B', 'active')`).run(randomUUID(), orgB);
  FalaTuService.setOrgEnabled(orgA, true);
  FalaTuService.setOrgEnabled(orgB, true);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role, global_status) VALUES (?, ?, 'Dona A', 'a@a.test', '5511999998888', 'owner', 'active')`).run(userA, orgA);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role, global_status) VALUES (?, ?, 'Sem Fone', 'nf@a.test', NULL, 'owner', 'active')`).run(userNoPhone, orgA);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role, global_status) VALUES (?, ?, 'Dono B', 'b@b.test', '5521955554444', 'owner', 'active')`).run(userB, orgB);

  (FalaTuService as any).interpret = async (input: any) => ({
    transcription: String(input.text || ""), summary: String(input.text || "").slice(0, 40), intent: "TASK",
    entities: { people: [], projects: [], actions: [], listItems: [], eventDate: null, eventTime: null },
    confidence: 0.9, suggestedAction: "s",
  });

  // Cada usuário com um dia acionável: userA e userNoPhone com inbox pendente;
  // userA ainda ganha um compromisso de hoje (pro texto ter a seção de agenda).
  await FalaTuService.capture(orgA, userA, { text: "ligar pro contador" });
  await FalaTuService.capture(orgA, userNoPhone, { text: "revisar contrato" });
  db.prepare(`INSERT INTO falatu_events (id, organization_id, user_id, title, event_date, event_time) VALUES (?, ?, ?, 'Dentista', ?, '10:00')`).run(randomUUID(), orgA, userA, DATE_SP);
  db.prepare(`INSERT INTO falatu_events (id, organization_id, user_id, title, event_date, event_time) VALUES (?, ?, ?, 'Ligar cliente', NULL, NULL)`).run(randomUUID(), orgA, userA);

  // Publica os sinais do dia (Fatia 5) — o digest CONSOME isto.
  FalaTuBriefingTaskService.run(orgA, { date: DATE_SP });

  const sent: Array<{ phone: string; text: string }> = [];
  const send = (phone: string, text: string) => { sent.push({ phone, text }); };
  const deliveries = (org: string) => (db.prepare(`SELECT COUNT(*) c FROM falatu_briefing_deliveries WHERE organization_id = ?`).get(org) as any).c;

  // ===== 1. Porta de canal desligada (default) → não entrega =====
  const r1 = await FalaTuBriefingDigestService.runPass(orgA, { now: MORNING, send });
  check("sem opt-in de canal, nada é entregue (porta separada da flag do módulo)", r1.sent === 0 && sent.length === 0);

  FalaTuBriefingDigestService.setWaEnabled(orgA, true);

  // ===== 2. Fora da janela da manhã → não entrega =====
  const r2 = await FalaTuBriefingDigestService.runPass(orgA, { now: NIGHT, send });
  check("fora da janela da manhã (SP) não entrega", r2.sent === 0 && sent.length === 0);

  // ===== 3. Na janela → entrega só a quem tem sinal + telefone =====
  const r3 = await FalaTuBriefingDigestService.runPass(orgA, { now: MORNING, send });
  check("entrega 1 (userA com telefone); pula userNoPhone", r3.sent === 1 && r3.results.some((x) => x.reason === "no_phone"));
  check("mensagem foi pro telefone certo", sent.length === 1 && sent[0].phone === "5511999998888");

  // ===== 4. Texto determinístico a partir da evidência do sinal =====
  const txt = sent[0].text;
  check("texto tem inbox pendente", /1 anotação aguardando/.test(txt));
  check("texto lista compromisso de hoje com hora", /Compromissos de hoje/.test(txt) && /10:00 — Dentista/.test(txt));
  check("texto separa compromisso SEM data", /Sem data definida/.test(txt) && /Ligar cliente/.test(txt));

  // ===== 5. Dedupe por (org, usuário, dia): 2º passe não reenvia =====
  const r5 = await FalaTuBriefingDigestService.runPass(orgA, { now: MORNING, send });
  check("mesmo dia não reenvia (dedupe por dia)", r5.sent === 0 && r5.results.some((x) => x.reason === "already_sent") && sent.length === 1 && deliveries(orgA) === 1);

  // ===== 6. Digest NUNCA materializa nada (só lê o sinal e envia) =====
  const tasksA = (db.prepare(`SELECT COUNT(*) c FROM falatu_tasks WHERE organization_id = ?`).get(orgA) as any).c;
  check("nenhuma tarefa/evento materializado pelo digest", tasksA === 0);

  // ===== 7. Envio manual: ignora janela/dedupe, respeita a porta =====
  const sent7: Array<{ phone: string; text: string }> = [];
  const send7 = (phone: string, text: string) => { sent7.push({ phone, text }); };
  const rNow = await FalaTuBriefingDigestService.sendNow(orgA, userA, { now: MORNING, send: send7 });
  check("send-now envia mesmo já tendo entregue hoje (ignora dedupe)", rNow.sent === 1 && sent7.length === 1);
  // Desliga a porta → send-now recusa.
  FalaTuBriefingDigestService.setWaEnabled(orgA, false);
  const rNow2 = await FalaTuBriefingDigestService.sendNow(orgA, userA, { now: MORNING, send: send7 });
  check("send-now respeita a porta (wa_disabled)", rNow2.sent === 0 && rNow2.reason === "wa_disabled");
  FalaTuBriefingDigestService.setWaEnabled(orgA, true);

  // ===== 8. Usuário sem nada acionável → send-now não envia =====
  const orgC = `org_${randomUUID().slice(0, 8)}`;
  const userC = randomUUID();
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org C', 'active')`).run(randomUUID(), orgC);
  FalaTuService.setOrgEnabled(orgC, true);
  FalaTuBriefingDigestService.setWaEnabled(orgC, true);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role, global_status) VALUES (?, ?, 'User C', 'c@c.test', '5511911112222', 'owner', 'active')`).run(userC, orgC);
  const rNow3 = await FalaTuBriefingDigestService.sendNow(orgC, userC, { now: MORNING, send: () => {} });
  check("dia sem nada acionável não gera envio (no_briefing)", rNow3.sent === 0 && rNow3.reason === "no_briefing");

  // ===== 9. Isolamento multi-tenant: sinal de B não é entregue pela org A =====
  await FalaTuService.capture(orgB, userB, { text: "pagar aluguel" });
  FalaTuBriefingTaskService.run(orgB, { date: DATE_SP });
  FalaTuBriefingDigestService.setWaEnabled(orgB, true);
  const sentB: Array<{ phone: string; text: string }> = [];
  const rB = await FalaTuBriefingDigestService.runPass(orgB, { now: MORNING, send: (p, t) => sentB.push({ phone: p, text: t }) });
  check("org B entrega só o próprio usuário", rB.sent === 1 && sentB.length === 1 && sentB[0].phone === "5521955554444");
  check("entrega de A e de B não se misturam (dedupe por org)", deliveries(orgA) === 1 && deliveries(orgB) === 1);

  // ===== Resultado =====
  console.log("\n=== FalaTu Fatia 6 (entrega do briefing por WhatsApp) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
