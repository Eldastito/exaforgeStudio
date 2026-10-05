/**
 * TESTE — os briefings de 16h e do fechamento da noite por NOTIFICAÇÃO (web push) — ADR-203 §12
 * ----------------------------------------------------------------------------
 * Antes: as duas rotinas só saíam por WhatsApp (e dependiam de canal conectado). Agora também chegam como notificação no aparelho de quem
 * assinou o push. Com o transporte INJETADO (sem rede):
 *   - 16h: owner/admin sem loja COM subscription recebe 1 notificação (título + corpo CURTO, sem asteriscos); não exige telefone nem WhatsApp;
 *   - janela (16h–18h SP), opt-in da rotina (flag), dedupe por dia (e `force` reenvia), tudo igual ao WhatsApp;
 *   - quem NÃO assinou não recebe; gerente preso a loja NÃO recebe o resumo da rede (a trava vale na notificação também);
 *   - entrega que falha NÃO marca (retenta no próximo passe); endpoint morto (410) é revogado;
 *   - noite: 1 notificação por horário de fechamento, dedupe por horário;
 *   - depois da notificação o FalaTu continua a conversa ("Por quê?" explica a loja destacada);
 *   - isolamento: a subscription de outra empresa não recebe; o Scheduler chama os dois passes.
 *
 * Uso:  npm run test:retail-brief-push
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-brief-push-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-brief-push-1234567890abcd";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const tick = () => new Promise((r) => setTimeout(r, 80));

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailAfternoonBriefService: Aft } = await import("../src/server/RetailAfternoonBriefService.js");
  const { RetailDayBriefService: Night } = await import("../src/server/RetailDayBriefService.js");
  const { FalaTuPushService: Push } = await import("../src/server/FalaTuPushService.js");
  const { FalaTuAskService: Ask } = await import("../src/server/FalaTuAskService.js");
  const { FalaTuConversationService: Conv } = await import("../src/server/FalaTuConversationService.js");

  const ORG = `org_${randomUUID().slice(0, 8)}`, OTHER = `org_${randomUUID().slice(0, 8)}`;
  for (const o of [ORG, OTHER]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'TOULON', 'active')`).run(randomUUID(), o);
  const mkUser = (org: string, name: string, role: string) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, ?, ?, ?, 'active')`).run(id, org, name, `${name}@t.com`, role); return id; };
  const bruno = mkUser(ORG, "Bruno", "owner"), semPush = mkUser(ORG, "SemPush", "admin"), gerente = mkUser(ORG, "Gabriel", "admin"), forasteiro = mkUser(OTHER, "Fora", "owner");
  const store = (name: string, code: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, ?, ?, 1)`).run(id, ORG, name, code); return id; };
  const grande = store("Grande Rio", "2001"), carioca = store("Carioca", "2002");
  db.prepare(`INSERT INTO user_stores (organization_id, user_id, store_id) VALUES (?, ?, ?)`).run(ORG, gerente, carioca);
  const D = "2026-09-24";
  const quota = (st: string, v: number) => db.prepare(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), ORG, st, D, v);
  let n = 0;
  const sale = (filial: string, date: string, time: string, valor: number) => db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, sale_time, valor, pecas, status, payments_json) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'N', NULL)`).run(randomUUID(), ORG, filial, `b${++n}`, date, time, valor);
  quota(grande, 2500); quota(carioca, 1100);
  sale("2001", D, "10:30", 500); sale("2001", D, "14:15", 550);
  for (const d of ["2026-09-17", "2026-09-10", "2026-09-03", "2026-08-27"]) { sale("2001", d, "11:00", 1500); sale("2001", d, "18:30", 700); }
  sale("2002", D, "09:00", 700); sale("2002", D, "13:00", 720);
  db.prepare(`UPDATE organization_settings SET retail_afternoon_brief_enabled = 1, retail_night_brief_enabled = 1 WHERE organization_id = ?`).run(ORG);
  const sub = (org: string, uid: string) => Push.subscribe(org, uid, { endpoint: `https://push.test/${uid}`, keys: { p256dh: "p", auth: "a" } });
  sub(ORG, bruno); sub(ORG, gerente); sub(OTHER, forasteiro);     // semPush NÃO assina

  const sent: Array<{ to: string; payload: any }> = [];
  const transport = (_sub: any, json: string) => { sent.push({ to: _sub.endpoint.split("/").pop(), payload: JSON.parse(json) }); return Promise.resolve(); };
  const t16 = new Date(`${D}T19:30:00Z`);                         // 16:30 SP
  Conv.reset();

  // ── 16h ──
  let r = await Aft.runPushPass(ORG, { now: t16, push: transport });
  check("16h: o dono (owner, SEM telefone e sem WhatsApp) recebe 1 notificação", r.sent === 1 && sent.length === 1 && sent[0].to === bruno, JSON.stringify(r));
  const p = sent[0].payload;
  check("título 'Parcial das 16h' e corpo CURTO (≤ 280 + reticências), sem asteriscos, sem repetir o título", p.title === "Parcial das 16h" && p.body.length <= 281 && !/\*/.test(p.body) && !/^Parcial das 16h/.test(p.body) && /Grande Rio/.test(p.body), p.body.slice(0, 120));
  check("quem NÃO assinou o push não recebe", !sent.some((s) => s.to === semPush));
  check("gerente preso a loja NÃO recebe o resumo da REDE (mesmo assinando)", !sent.some((s) => s.to === gerente));
  check("isolamento: a subscription de OUTRA empresa não recebe", !sent.some((s) => s.to === forasteiro));
  r = await Aft.runPushPass(ORG, { now: t16, push: transport });
  check("dedupe: o 2º passe do dia não reenvia", r.sent === 0 && sent.length === 1 && r.reasons.includes("already_sent"));
  r = await Aft.runPushPass(ORG, { now: t16, push: transport, force: true });
  check("force reenvia (ignora dedupe)", r.sent === 1 && sent.length === 2);
  const before = sent.length;
  await Aft.runPushPass(ORG, { now: new Date(`${D}T15:00:00Z`), push: transport });           // 12:00 SP
  check("fora da janela (16h–18h SP) não envia", sent.length === before);
  db.prepare(`UPDATE organization_settings SET retail_afternoon_brief_enabled = 0 WHERE organization_id = ?`).run(ORG);
  await Aft.runPushPass(ORG, { now: t16, push: transport, force: true });
  check("rotina desligada (flag) não envia", sent.length === before);
  db.prepare(`UPDATE organization_settings SET retail_afternoon_brief_enabled = 1 WHERE organization_id = ?`).run(ORG);

  // ── falha de entrega ──
  db.prepare(`DELETE FROM falatu_push_deliveries WHERE organization_id = ?`).run(ORG);
  let calls = 0;
  const flaky = () => { calls++; return Promise.reject(Object.assign(new Error("boom"), { statusCode: 500 })); };
  r = await Aft.runPushPass(ORG, { now: t16, push: flaky as any });
  check("entrega que FALHA (500) não marca como enviada", r.sent === 0 && calls >= 1);
  r = await Aft.runPushPass(ORG, { now: t16, push: transport });
  check("…e retenta no próximo passe", r.sent === 1);
  db.prepare(`DELETE FROM falatu_push_deliveries WHERE organization_id = ?`).run(ORG);
  const dead = () => Promise.reject(Object.assign(new Error("gone"), { statusCode: 410 }));
  await Aft.runPushPass(ORG, { now: t16, push: dead as any });
  check("endpoint morto (410) é REVOGADO (não insiste)", !Push.hasActiveSubscription(ORG, bruno));
  sub(ORG, bruno);

  // ── conversa depois da notificação ──
  db.prepare(`DELETE FROM falatu_push_deliveries WHERE organization_id = ?`).run(ORG);
  Conv.reset();
  await Aft.runPushPass(ORG, { now: t16, push: transport }); await tick();
  const a = await Ask.answer(ORG, { userId: bruno, role: "owner" }, "Por quê?", { now: new Date(t16.getTime() + 20 * 60_000) });
  check("depois da notificação, 'Por quê?' no FalaTu explica a loja destacada (Grande Rio)", /Grande Rio/.test(a.answer), a.answer.slice(0, 120));

  // ── noite ──
  const night = new Date(`${D}T23:00:00Z`);
  const n0 = sent.length;
  r = await Night.runPushPass(ORG, { now: night, push: transport, force: true });
  const nightPushes = sent.slice(n0);
  check("noite: o dono recebe a notificação do fechamento (1 por horário de fechamento)", r.sent >= 1 && nightPushes.every((x) => x.to === bruno && x.payload.title === "Fechamento da noite") && nightPushes.length === r.sent, JSON.stringify(r));
  const n1 = sent.length;
  r = await Night.runPushPass(ORG, { now: night, push: transport });
  check("noite: dedupe por horário (2º passe não reenvia)", sent.length === n1);
  check("noite: gerente preso a loja não recebe", !nightPushes.some((x) => x.to === gerente));

  // ── fiação ──
  const sch = fs.readFileSync(path.join(process.cwd(), "src/server/Scheduler.ts"), "utf8");
  check("Scheduler chama os dois passes (16h no tick horário, noite no passe rápido)", /retailBriefPushPass\('afternoon'\)/.test(sch) && /retailBriefPushPass\('night'\)/.test(sch));

  console.log("\n=== Briefings de varejo por notificação ===");
  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok || !x.detail ? "" : ` — ${x.detail}`}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} retail-brief-push: ${results.length - failures}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } process.exit(1); });
