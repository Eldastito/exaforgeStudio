/**
 * TEST — FalaTu F8.6 (ADR-154 Fase 8): briefing por E-MAIL.
 *
 * Cobre: opt-in por usuário (default off, toggle audita, desligar é UPDATE
 * com trilha); status expõe destino + channelReady; digest pass: janela da
 * manhã (SP), só quem optou, dedupe próprio por (org, user, dia) SEPARADO
 * das portas WA/push, destino é SEMPRE o e-mail de login (nunca arbitrário),
 * assunto datado + corpo sem asteriscos; falha de envio NÃO marca entrega
 * (retenta no tick seguinte); org sem conexão Google pula com
 * no_email_channel sem lançar; sendNow ignora janela/dedupe mas exige
 * opt-in + canal + briefing; isolamento multi-tenant.
 *
 * Transporte de e-mail INJETADO (sem rede); sweep de briefing real; mock só
 * do interpret (sem chave OpenAI). Uso: npm run test:falatu-email
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-email-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-email-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// 09:00 SP = 12:00Z (janela da manhã); 20:00 SP = 23:00Z (fora).
const MORNING = new Date("2026-08-05T12:00:00Z");
const NIGHT = new Date("2026-08-05T23:00:00Z");
const DATE_SP = "2026-08-05";

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuService } = await import("../src/server/FalaTuService.js");
  const { FalaTuBriefingTaskService } = await import("../src/server/FalaTuBriefingTaskService.js");
  const { FalaTuEmailService } = await import("../src/server/FalaTuEmailService.js");

  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const userA = randomUUID();
  const userNoEmail = randomUUID();
  const userNoBriefing = randomUUID();
  const userB = randomUUID();
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org B', 'active')`).run(randomUUID(), orgB);
  FalaTuService.setOrgEnabled(orgA, true);
  FalaTuService.setOrgEnabled(orgB, true);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'Dona A', 'a@a.test', 'owner', 'active')`).run(userA, orgA);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'Sem Email', '', 'owner', 'active')`).run(userNoEmail, orgA);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'Sem Briefing', 'sb@a.test', 'owner', 'active')`).run(userNoBriefing, orgA);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'Dono B', 'b@b.test', 'owner', 'active')`).run(userB, orgB);

  (FalaTuService as any).interpret = async (input: any) => ({
    transcription: String(input.text || ""), summary: String(input.text || "").slice(0, 40), intent: "TASK",
    entities: { people: [], projects: [], actions: [], listItems: [], eventDate: null, eventTime: null },
    confidence: 0.9, suggestedAction: "s",
  });

  const auditCount = (org: string, type: string) =>
    (db.prepare(`SELECT COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? AND event_type = ?`).get(org, type) as any).c;

  // ===== 1. Opt-in: default off, toggle com auditoria, trilha em UPDATE =====
  check("default: porta desligada", !FalaTuEmailService.enabled(orgA, userA));
  FalaTuEmailService.setEnabled(orgA, userA, true);
  check("ligar liga", FalaTuEmailService.enabled(orgA, userA));
  check("auditoria ENABLE", auditCount(orgA, "FALATU_EMAIL_ENABLE") === 1);
  FalaTuEmailService.setEnabled(orgA, userA, false);
  check("desligar desliga", !FalaTuEmailService.enabled(orgA, userA));
  check("auditoria DISABLE", auditCount(orgA, "FALATU_EMAIL_DISABLE") === 1);
  const optRows = db.prepare(`SELECT COUNT(*) c FROM falatu_email_optins WHERE organization_id = ? AND user_id = ?`).get(orgA, userA) as any;
  check("desligar é UPDATE (1 linha, trilha preservada)", optRows.c === 1);
  FalaTuEmailService.setEnabled(orgA, userA, true);

  // ===== 2. Status pra UI =====
  const st = await FalaTuEmailService.status(orgA, userA);
  check("status: enabled + destino do login", st.enabled && st.email === "a@a.test");
  check("status: sem conexão Google → channelReady false", st.channelReady === false);

  // ===== 3. Dia acionável + sinais publicados =====
  await FalaTuService.capture(orgA, userA, { text: "ligar pro contador" });
  await FalaTuService.capture(orgA, userNoEmail, { text: "comprar etiquetas" });
  await FalaTuService.capture(orgB, userB, { text: "revisar contrato" });
  FalaTuBriefingTaskService.run(orgA, { date: DATE_SP });
  FalaTuBriefingTaskService.run(orgB, { date: DATE_SP });

  const delivered: Array<{ to: string; subject: string; body: string }> = [];
  const okSend = async (to: string, subject: string, body: string) => { delivered.push({ to, subject, body }); };

  // ===== 4. Fora da janela: nada =====
  const night = await FalaTuEmailService.runDigestPass(orgA, { now: NIGHT, send: okSend });
  check("fora da janela da manhã não envia", night.sent === 0 && delivered.length === 0);

  // ===== 5. Na janela: só quem optou; destino é o login; texto limpo =====
  const morning = await FalaTuEmailService.runDigestPass(orgA, { now: MORNING, send: okSend });
  check("na janela entrega só userA (optou)", morning.sent === 1 && delivered.length === 1);
  check("destino é o e-mail de login", delivered[0].to === "a@a.test");
  check("assunto datado com FalaTu", delivered[0].subject.includes("FalaTu") && delivered[0].subject.includes("05/08/2026"));
  check("corpo sem asteriscos do WA", !delivered[0].body.includes("*"));
  check("sem opt-in pulou com not_opted_in", morning.results.some((r) => r.userId === userNoEmail && r.reason === "not_opted_in"));
  const del = db.prepare(`SELECT COUNT(*) c FROM falatu_email_deliveries WHERE organization_id = ? AND user_id = ? AND briefing_date = ?`).get(orgA, userA, DATE_SP) as any;
  check("entrega marcada no dedupe PRÓPRIO do e-mail", del.c === 1);
  const waDel = db.prepare(`SELECT COUNT(*) c FROM falatu_briefing_deliveries WHERE organization_id = ?`).get(orgA) as any;
  const pushDel = db.prepare(`SELECT COUNT(*) c FROM falatu_push_deliveries WHERE organization_id = ?`).get(orgA) as any;
  check("dedupes das portas WA e push intocados", waDel.c === 0 && pushDel.c === 0);

  // ===== 6. Dedupe por dia + isolamento multi-tenant =====
  const again = await FalaTuEmailService.runDigestPass(orgA, { now: MORNING, send: okSend });
  check("mesmo dia não reenvia (dedupe)", again.sent === 0 && delivered.length === 1);
  check("org B não recebeu nada no pass da org A", delivered.every((d) => !d.to.includes("b@b.test")));

  // ===== 7. Usuário sem e-mail cadastrado: pula com no_email =====
  FalaTuEmailService.setEnabled(orgA, userNoEmail, true);
  const withNoEmail = await FalaTuEmailService.runDigestPass(orgA, { now: MORNING, send: okSend });
  check("sem e-mail cadastrado pula com no_email", withNoEmail.results.some((r) => r.userId === userNoEmail && r.reason === "no_email"));

  // ===== 8. Falha de envio NÃO marca entrega (retenta no próximo tick) =====
  FalaTuEmailService.setEnabled(orgB, userB, true);
  const boom = async () => { throw new Error("smtp down"); };
  const failed = await FalaTuEmailService.runDigestPass(orgB, { now: MORNING, send: boom });
  check("falha de envio conta como send_failed sem lançar", failed.sent === 0 && failed.results.some((r) => r.reason === "send_failed"));
  const delB0 = db.prepare(`SELECT COUNT(*) c FROM falatu_email_deliveries WHERE organization_id = ?`).get(orgB) as any;
  check("falha NÃO marcou entrega", delB0.c === 0);
  const retry = await FalaTuEmailService.runDigestPass(orgB, { now: MORNING, send: okSend });
  check("tick seguinte retenta e entrega", retry.sent === 1 && delivered.some((d) => d.to === "b@b.test"));

  // ===== 9. Sem transporte injetado e sem Google: no_email_channel, sem throw =====
  const noChannel = await FalaTuEmailService.runDigestPass(orgA, { now: MORNING });
  check("org sem conexão Google pula tudo com no_email_channel", noChannel.sent === 0 && noChannel.results.every((r) => r.reason === "no_email_channel"));

  // ===== 10. sendNow: exige opt-in + briefing; ignora janela/dedupe =====
  FalaTuEmailService.setEnabled(orgA, userNoBriefing, false);
  const offNow = await FalaTuEmailService.sendNow(orgA, userNoBriefing, { now: NIGHT, send: okSend });
  check("sendNow com porta desligada → email_disabled", offNow.sent === 0 && offNow.reason === "email_disabled");
  FalaTuEmailService.setEnabled(orgA, userNoBriefing, true);
  const noBrief = await FalaTuEmailService.sendNow(orgA, userNoBriefing, { now: NIGHT, send: okSend });
  check("sendNow sem briefing do dia → no_briefing", noBrief.sent === 0 && noBrief.reason === "no_briefing");
  const before = delivered.length;
  const nowOk = await FalaTuEmailService.sendNow(orgA, userA, { now: NIGHT, send: okSend });
  check("sendNow envia fora da janela e apesar do dedupe do dia", nowOk.sent === 1 && delivered.length === before + 1);

  // ===== resumo =====
  console.log("");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
