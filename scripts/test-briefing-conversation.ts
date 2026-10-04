/**
 * TESTE — o BRIEFING vira conversa (ADR-203 §13): responder "Por quê?" / "E a Carioca?" à mensagem das 16h, da noite ou da manhã
 * ----------------------------------------------------------------------------
 * Antes: o briefing saía por WhatsApp mas não deixava contexto; a resposta do dono ("Por quê?") caía no vazio ("de qual loja?").
 * Prova, com o envio INJETADO (sem rede) e o FalaTu real (`FalaTuAskService.answer`):
 *   - 16h: depois do envio, "Por quê?" explica a loja DESTACADA (a abaixo do ritmo) e "E a Carioca?" troca a loja na mesma ferramenta;
 *   - o contexto sobrevive horas (briefing é lido tarde — não os 20 min da conversa normal) e expira (não é eterno);
 *   - só quem RECEBEU o briefing ganha contexto (outro usuário não);
 *   - noite sem fechamento (nenhuma loja comprovadamente abaixo): NÃO inventa loja — o "Por quê?" PERGUNTA de qual loja;
 *   - manhã (Tutor): "E a Carioca?" devolve a meta do dia da Carioca;
 *   - isolamento: o contexto de uma empresa não vaza pra outra.
 *
 * Uso:  npm run test:briefing-conversation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-brief-conv-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-brief-conv-1234567890abcd";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const tick = () => new Promise((r) => setTimeout(r, 80));

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailAfternoonBriefService: Aft } = await import("../src/server/RetailAfternoonBriefService.js");
  const { RetailDayBriefService: Night } = await import("../src/server/RetailDayBriefService.js");
  const { BusinessTutorService: Tutor } = await import("../src/server/BusinessTutorService.js");
  const { FalaTuAskService: Ask } = await import("../src/server/FalaTuAskService.js");
  const { FalaTuConversationService: Conv, BRIEFING_TTL_MS } = await import("../src/server/FalaTuConversationService.js");

  const ORG = `org_${randomUUID().slice(0, 8)}`, OTHER = `org_${randomUUID().slice(0, 8)}`;
  for (const o of [ORG, OTHER]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'TOULON', 'active')`).run(randomUUID(), o);
  const mkUser = (org: string, name: string, role: string, phone: string | null) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status, phone) VALUES (?, ?, ?, ?, ?, 'active', ?)`).run(id, org, name, `${name}@t.com`, role, phone); return id; };
  const bruno = mkUser(ORG, "Bruno", "owner", "21999990001"), semFone = mkUser(ORG, "SemFone", "admin", null);
  const store = (name: string, code: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, ?, ?, 1)`).run(id, ORG, name, code); return id; };
  const grande = store("Grande Rio", "2001"), carioca = store("Carioca", "2002");
  const D = "2026-09-24";
  const quota = (st: string, v: number) => db.prepare(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), ORG, st, D, v);
  let n = 0;
  const sale = (filial: string, date: string, time: string, valor: number) => db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, sale_time, valor, pecas, status, payments_json) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'N', NULL)`).run(randomUUID(), ORG, filial, `b${++n}`, date, time, valor);
  quota(grande, 2500); quota(carioca, 1100);
  // a ferramenta da manhã ("meta do dia") lê o dia REAL de hoje — a meta da Carioca precisa existir nele também
  const hoje = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  if (hoje !== D) db.prepare(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), ORG, carioca, hoje, 1100);
  sale("2001", D, "10:30", 500); sale("2001", D, "14:15", 550);
  for (const d of ["2026-09-17", "2026-09-10", "2026-09-03", "2026-08-27"]) { sale("2001", d, "11:00", 1500); sale("2001", d, "18:30", 700); }
  sale("2002", D, "09:00", 700); sale("2002", D, "13:00", 720);
  db.prepare(`UPDATE organization_settings SET retail_afternoon_brief_enabled = 1, retail_night_brief_enabled = 1, tutor_wa_enabled = 1 WHERE organization_id = ?`).run(ORG);

  const owner = { userId: bruno, role: "owner" }, stranger = { userId: semFone, role: "admin" };
  const at = (iso: string) => new Date(iso);
  const sent: string[] = [];
  const send = (_p: string, t: string) => { sent.push(t); };
  const ask = (u: any, q: string, now: Date) => Ask.answer(ORG, u, q, { now });

  // ── 16h ──
  const t16 = at(`${D}T19:30:00Z`);                         // 16:30 SP
  Conv.reset();
  const r16 = await Aft.runPass(ORG, { now: t16, send, force: true }); await tick();
  check("16h: o briefing foi enviado ao dono", r16.sent === 1 && sent.length === 1);
  let a = await ask(owner, "Por quê?", new Date(t16.getTime() + 30 * 60_000));
  check("16h: 'Por quê?' explica a loja DESTACADA (Grande Rio, abaixo do ritmo) em vez de perguntar a loja", /Grande Rio/.test(a.answer) && !/De qual loja/.test(a.answer), a.answer.slice(0, 160));
  await Aft.runPass(ORG, { now: t16, send, force: true }); await tick();
  a = await ask(owner, "E a Carioca?", new Date(t16.getTime() + 30 * 60_000));
  check("16h: 'E a Carioca?' troca a loja na mesma ferramenta (vendas por loja, hoje)", /Carioca/.test(a.answer), a.answer.slice(0, 160));

  await Aft.runPass(ORG, { now: t16, send, force: true }); await tick();
  const late = await ask(owner, "Por quê?", new Date(t16.getTime() + 3 * 3600_000));
  check("o contexto SOBREVIVE horas (3h depois ainda continua a conversa) — não os 20 min da conversa normal", /Grande Rio/.test(late.answer), late.answer.slice(0, 120));
  Conv.reset(); await Aft.runPass(ORG, { now: t16, send, force: true }); await tick();
  const expired = await ask(owner, "Por quê?", new Date(t16.getTime() + BRIEFING_TTL_MS + 60_000));
  check("…e EXPIRA (passado o prazo, 'Por quê?' não puxa a loja de ontem)", !/Grande Rio — dia/.test(expired.answer), expired.answer.slice(0, 120));

  // ── só quem recebeu ──
  Conv.reset(); await Aft.runPass(ORG, { now: t16, send, force: true }); await tick();
  const other = await ask(stranger, "Por quê?", new Date(t16.getTime() + 60_000));
  check("só quem RECEBEU o briefing ganha contexto (outro usuário não: 'Por quê?' não puxa a Grande Rio)", !/Grande Rio — dia/.test(other.answer), other.answer.slice(0, 120));
  const iso = Conv.last(OTHER, owner, t16.getTime() + 60_000);
  check("isolamento: o contexto não vaza pra outra empresa", iso === null);

  // ── noite (sem fechamento: nenhuma loja comprovadamente abaixo) ──
  Conv.reset();
  const rn = await Night.runPass(ORG, { now: at(`${D}T23:00:00Z`), send, force: true }); await tick();
  check("noite: o fechamento foi enviado", rn.sent >= 1);
  const nn = await ask(owner, "Por quê?", at(`${D}T23:05:00Z`));
  check("noite sem fechamento: NÃO inventa loja — o 'Por quê?' PERGUNTA de qual loja", /De qual loja/.test(nn.answer), nn.answer.slice(0, 120));
  const ne = await ask(owner, "E a Carioca?", at(`${D}T23:06:00Z`));
  check("noite: 'E a Carioca?' funciona (vendas por loja, hoje)", /Carioca/.test(ne.answer), ne.answer.slice(0, 120));

  // ── manhã (Tutor) ──
  Conv.reset();
  const rm = await Tutor.runMorningPass(ORG, { now: at(`${D}T12:00:00Z`), send }); await tick();   // 09:00 SP
  check("manhã: o resumo foi enviado ao dono", rm.sent === true);
  const mm = await ask(owner, "E a Carioca?", at(`${D}T12:05:00Z`));
  check("manhã: 'E a Carioca?' devolve a META DO DIA da Carioca", /Carioca/.test(mm.answer) && /1\.100|1100/.test(mm.answer), mm.answer.slice(0, 140));

  console.log("\n=== Briefing vira conversa ===");
  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok || !x.detail ? "" : ` — ${x.detail}`}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} briefing-conversation: ${results.length - failures}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } process.exit(1); });
