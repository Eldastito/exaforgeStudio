/**
 * TEST — FalaTu F8.3 (ADR-154 Fase 8): briefing por Web Push.
 *
 * Cobre: VAPID gerado UMA vez e estável; subscribe valida shape e faz upsert
 * por endpoint (troca de dono no mesmo browser, nunca duplica); disable é
 * UPDATE de revoked_at (nunca DELETE); sendToUser entrega pra todas as
 * subscriptions ativas, marca last_success_at e REVOGA endpoint morto
 * (404/410) sem lançar; digest pass: janela da manhã (SP), dedupe por
 * (org, user, dia) SEPARADO do canal WA, só acionável, só quem tem
 * subscription; independência das portas (push entrega com WA desligado);
 * sendNow ignora janela/dedupe mas exige subscription + briefing; isolamento
 * multi-tenant; auditoria SUBSCRIBE/DISABLE.
 *
 * Transporte de push INJETADO (sem rede); sweep de briefing real; mock só do
 * interpret (sem chave OpenAI). Uso: npm run test:falatu-push
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-push-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-push-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// 09:00 SP = 12:00Z (janela da manhã); 20:00 SP = 23:00Z (fora).
const MORNING = new Date("2026-08-05T12:00:00Z");
const NIGHT = new Date("2026-08-05T23:00:00Z");
const DATE_SP = "2026-08-05";

const fakeSub = (tag: string) => ({
  endpoint: `https://push.example.com/ep/${tag}`,
  keys: { p256dh: `p256dh-${tag}`, auth: `auth-${tag}` },
});

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuService } = await import("../src/server/FalaTuService.js");
  const { FalaTuBriefingTaskService } = await import("../src/server/FalaTuBriefingTaskService.js");
  const { FalaTuPushService } = await import("../src/server/FalaTuPushService.js");

  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const userA = randomUUID();
  const userNoSub = randomUUID();
  const userB = randomUUID();
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org B', 'active')`).run(randomUUID(), orgB);
  FalaTuService.setOrgEnabled(orgA, true);
  FalaTuService.setOrgEnabled(orgB, true);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'Dona A', 'a@a.test', 'owner', 'active')`).run(userA, orgA);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'Sem Sub', 'ns@a.test', 'owner', 'active')`).run(userNoSub, orgA);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'Dono B', 'b@b.test', 'owner', 'active')`).run(userB, orgB);

  (FalaTuService as any).interpret = async (input: any) => ({
    transcription: String(input.text || ""), summary: String(input.text || "").slice(0, 40), intent: "TASK",
    entities: { people: [], projects: [], actions: [], listItems: [], eventDate: null, eventTime: null },
    confidence: 0.9, suggestedAction: "s",
  });

  const auditCount = (org: string, type: string) =>
    (db.prepare(`SELECT COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? AND event_type = ?`).get(org, type) as any).c;

  // ===== 1. VAPID: gerado uma vez, estável =====
  const v1 = await FalaTuPushService.ensureVapid();
  const v2 = await FalaTuPushService.ensureVapid();
  check("VAPID gerado com chaves não-vazias", !!v1.publicKey && !!v1.privateKey);
  check("VAPID estável entre chamadas", v1.publicKey === v2.publicKey && v1.privateKey === v2.privateKey);

  // ===== 2. Subscribe: shape + upsert por endpoint =====
  let threw = false;
  try { FalaTuPushService.subscribe(orgA, userA, { endpoint: "http://inseguro", keys: { p256dh: "x", auth: "y" } }); } catch { threw = true; }
  check("endpoint não-https recusado", threw);
  threw = false;
  try { FalaTuPushService.subscribe(orgA, userA, { endpoint: "https://ok.example.com/e", keys: { p256dh: "", auth: "y" } }); } catch { threw = true; }
  check("keys vazias recusadas", threw);
  FalaTuPushService.subscribe(orgA, userA, fakeSub("a1"));
  FalaTuPushService.subscribe(orgA, userA, fakeSub("a2")); // 2º aparelho
  const stA = await FalaTuPushService.status(orgA, userA);
  check("status subscribed com publicKey", stA.subscribed && stA.publicKey === v1.publicKey);
  check("auditoria SUBSCRIBE", auditCount(orgA, "FALATU_PUSH_SUBSCRIBE") === 2);
  // Mesmo endpoint assinado por OUTRO usuário → linha muda de dono, não duplica.
  FalaTuPushService.subscribe(orgB, userB, fakeSub("a2"));
  const rows = db.prepare(`SELECT * FROM falatu_push_subscriptions WHERE endpoint = ?`).all(fakeSub("a2").endpoint) as any[];
  check("endpoint re-assinado troca de dono sem duplicar", rows.length === 1 && rows[0].user_id === userB && rows[0].organization_id === orgB);

  // ===== 3. Dia acionável + sinais publicados =====
  await FalaTuService.capture(orgA, userA, { text: "ligar pro contador" });
  await FalaTuService.capture(orgB, userB, { text: "revisar contrato" });
  FalaTuBriefingTaskService.run(orgA, { date: DATE_SP });
  FalaTuBriefingTaskService.run(orgB, { date: DATE_SP });

  const delivered: Array<{ endpoint: string; payload: any }> = [];
  const okPush = async (sub: any, json: string) => { delivered.push({ endpoint: sub.endpoint, payload: JSON.parse(json) }); };

  // ===== 4. Fora da janela: nada =====
  const night = await FalaTuPushService.runDigestPass(orgA, { now: NIGHT, push: okPush });
  check("fora da janela da manhã não envia", night.sent === 0 && delivered.length === 0);

  // ===== 5. Na janela: entrega só pra quem tem subscription; WA desligado não importa =====
  const waFlag = (db.prepare(`SELECT falatu_briefing_wa_enabled w FROM organization_settings WHERE organization_id = ?`).get(orgA) as any)?.w;
  check("porta WA desligada (independência comprovada no envio abaixo)", !Number(waFlag));
  const morning = await FalaTuPushService.runDigestPass(orgA, { now: MORNING, push: okPush });
  check("na janela entrega 1 usuário (userA, 1 sub ativa restante)", morning.sent === 1 && delivered.length === 1);
  check("payload tem título e corpo sem asteriscos", delivered[0].payload.title.includes("FalaTu") && !String(delivered[0].payload.body).includes("*"));
  const del = db.prepare(`SELECT COUNT(*) c FROM falatu_push_deliveries WHERE organization_id = ? AND user_id = ? AND briefing_date = ?`).get(orgA, userA, DATE_SP) as any;
  check("entrega marcada no dedupe PRÓPRIO do push", del.c === 1);
  const waDel = db.prepare(`SELECT COUNT(*) c FROM falatu_briefing_deliveries WHERE organization_id = ? AND user_id = ?`).get(orgA, userA) as any;
  check("dedupe do canal WA intocado", waDel.c === 0);

  // ===== 6. Dedupe por dia: segundo pass não reenvia =====
  const again = await FalaTuPushService.runDigestPass(orgA, { now: MORNING, push: okPush });
  check("mesmo dia não reenvia (dedupe)", again.sent === 0 && delivered.length === 1);

  // ===== 7. Isolamento multi-tenant: pass da org A nunca toca org B =====
  check("org B não recebeu nada no pass da org A", delivered.every((d) => !d.endpoint.includes("a2")));

  // ===== 8. Endpoint morto (410) é revogado sem lançar =====
  FalaTuPushService.subscribe(orgB, userB, fakeSub("b-dead"));
  const deadPush = async (sub: any, _json: string) => {
    if (sub.endpoint.includes("b-dead")) { const e: any = new Error("gone"); e.statusCode = 410; throw e; }
    delivered.push({ endpoint: sub.endpoint, payload: JSON.parse(_json) });
  };
  const rB = await FalaTuPushService.sendToUser(orgB, userB, { title: "t", body: "b" }, { push: deadPush });
  check("envia nas vivas e conta a morta", rB.sent === 1 && rB.dead === 1);
  const deadRow = db.prepare(`SELECT revoked_at FROM falatu_push_subscriptions WHERE endpoint = ?`).get(fakeSub("b-dead").endpoint) as any;
  check("endpoint 410 revogado (UPDATE, linha permanece)", !!deadRow?.revoked_at);

  // ===== 9. Disable: revoga tudo do usuário; auditoria =====
  FalaTuPushService.disable(orgA, userA);
  const stAfter = await FalaTuPushService.status(orgA, userA);
  const remain = db.prepare(`SELECT COUNT(*) c FROM falatu_push_subscriptions WHERE organization_id = ? AND user_id = ?`).get(orgA, userA) as any;
  check("disable revoga (status false) sem apagar linhas", !stAfter.subscribed && remain.c >= 1);
  check("auditoria DISABLE", auditCount(orgA, "FALATU_PUSH_DISABLE") === 1);

  // ===== 10. sendNow: exige subscription; com ela, ignora janela/dedupe =====
  const nowNoSub = await FalaTuPushService.sendNow(orgA, userNoSub, { now: NIGHT, push: okPush });
  check("sendNow sem subscription → no_subscription", nowNoSub.sent === 0 && nowNoSub.reason === "no_subscription");
  FalaTuPushService.subscribe(orgA, userA, fakeSub("a3"));
  const before = delivered.length;
  const nowOk = await FalaTuPushService.sendNow(orgA, userA, { now: NIGHT, push: okPush });
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
