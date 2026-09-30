/**
 * TESTE — PRD Fase 1, F1.6d: resumo de fechamento POR HORÁRIO DE CADA LOJA + fim da mensagem dupla.
 * Caso TOULON (lojas de shopping): Avenida Brasil fecha às 19h → resumo 19:30; as demais fecham às 22h → 22:30.
 * Prova: cada loja vai no resumo do SEU horário (19:30 só Avenida Brasil; 22:30 as demais + bloco "Rede" — o último horário
 * do dia fecha a rede); antes do horário não envia; dedupe por (usuário, dia, horário); tick perdido ainda envia dentro
 * de 3h e depois disso não; loja que não abre no dia (Av. Brasil aos domingos) sai do dia e não trava o total da rede;
 * sem horário cadastrado = padrão da rede 22:30; HH:MM validado; o "Fim do dia" genérico do Tutor NÃO sai quando o
 * fechamento por loja está ligado (acaba a mensagem dupla) e volta a sair quando desligado; roda no passe rápido (5 min).
 * Uso:  npm run test:retail-night-slots
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-nightslots-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-nightslots-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const B = (await import("../src/server/RetailDayBriefService.js")).RetailDayBriefService;
  const Stores = (await import("../src/server/RetailStoreService.js")).RetailStoreService;
  const Tutor = (await import("../src/server/BusinessTutorService.js")).BusinessTutorService;

  const T = `org_T_${randomUUID().slice(0, 6)}`, X = `org_X_${randomUUID().slice(0, 6)}`;
  for (const o of [T, X]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, retail_official_sale_source) VALUES (?, ?, 'X', 'active', 'folha')`).run(randomUUID(), o);
  const store = (org: string, name: string, time: string | null, closedWeekdays: number[] | null = null) => Stores.create(org, { name, code: name.slice(0, 4) + randomUUID().slice(0, 3), closingBriefTime: time, closedWeekdays } as any).id as string;
  const ab = store(T, "Avenida Brasil", "19:30", [0]), carioca = store(T, "Carioca", null), grande = store(T, "Grande Rio", null);
  const quota = (org: string, st: string, date: string, v: number) => db.prepare(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, st, date, v);
  const closing = (org: string, st: string, date: string, v: number) => db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, ?, 'received', ?)`).run(randomUUID(), org, st, date, v);
  const D = "2026-09-24", SUN = "2026-09-27";                                     // quinta · domingo
  for (const [st, q, v] of [[ab, 800, 850], [carioca, 1000, 1100], [grande, 2500, 2650]] as const) { quota(T, st, D, q); closing(T, st, D, v); }
  quota(T, carioca, SUN, 1000); quota(T, grande, SUN, 2000); closing(T, carioca, SUN, 1200); closing(T, grande, SUN, 2100);
  const user = (org: string, phone: string) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role, global_status) VALUES (?, ?, 'Dono', ?, ?, 'owner', 'active')`).run(id, org, `${id}@x.com`, phone); return id; };
  user(T, "5521999990001");
  const sent: string[] = [];
  const send = async (_p: string, t: string) => { sent.push(t); };
  const at = (date: string, hh: number, mm: number) => new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hh + 3, mm));   // SP = UTC-3

  // ── horários por loja ──
  const slots = B.slots(T, D);
  check("horários do dia: 19:30 (Avenida Brasil) e 22:30 (padrão da rede: Carioca e Grande Rio); o último fecha a rede", slots.length === 2 && slots[0].time === "19:30" && slots[0].storeIds.join() === ab && !slots[0].last && slots[1].time === "22:30" && slots[1].storeIds.length === 2 && slots[1].last, JSON.stringify(slots));
  B.setEnabled(T, true);

  check("19:00 (antes do horário da Avenida Brasil): não envia nada", (await B.runPass(T, { now: at(D, 19, 0), send })).sent === 0 && sent.length === 0);
  const r19 = await B.runPass(T, { now: at(D, 19, 30), send });
  check("19:30: envia UM resumo, só com a Avenida Brasil, SEM bloco 'Rede' e sem as outras lojas", r19.sent === 1 && sent.length === 1 && /Avenida Brasil/.test(sent[0]) && !/Carioca|Grande Rio|\nRede\n/.test(sent[0]), sent[0]);
  check("...com venda e cota da própria loja (850 de 800)", /Venda: R\$ 850/.test(sent[0]) && /Cota: R\$ 800/.test(sent[0]));
  check("19:40: dedupe — não reenvia o horário da Avenida Brasil", (await B.runPass(T, { now: at(D, 19, 40), send })).sent === 0 && sent.length === 1);
  check("22:00 (Avenida Brasil já saiu; demais ainda não): não envia", (await B.runPass(T, { now: at(D, 22, 0), send })).sent === 0 && sent.length === 1);
  const r22 = await B.runPass(T, { now: at(D, 22, 30), send });
  check("22:30: envia UM resumo com Carioca e Grande Rio + bloco 'Rede', sem repetir a Avenida Brasil", r22.sent === 1 && sent.length === 2 && /Carioca/.test(sent[1]) && /Grande Rio/.test(sent[1]) && /\nRede\n/.test(sent[1]) && !/Avenida Brasil/.test(sent[1]), sent[1]);
  check("a Rede das 22:30 soma as 3 lojas (todas fecharam): 4.600 de 4.300", /Rede\nVenda: R\$ 4\.600\nCota: R\$ 4\.300/.test(sent[1]), sent[1]);
  check("depois disso nada mais sai no dia (dedupe por horário)", (await B.runPass(T, { now: at(D, 23, 0), send })).sent === 0 && sent.length === 2);

  // ── tick perdido / janela de 3h ──
  const L1 = `org_L1_${randomUUID().slice(0, 6)}`, L2 = `org_L2_${randomUUID().slice(0, 6)}`;
  for (const o of [L1, L2]) { db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, retail_official_sale_source, retail_night_brief_enabled) VALUES (?, ?, 'X', 'active', 'folha', 1)`).run(randomUUID(), o); user(o, "5521988880001"); const s1 = store(o, "Loja L", "19:30"); quota(o, s1, D, 500); closing(o, s1, D, 520); }
  check("servidor fora do ar: às 21:55 ainda envia o horário das 19:30 (dentro de 3h)", (await B.runPass(L1, { now: at(D, 21, 55), send })).sent === 1);
  check("às 22:45 (mais de 3h depois) NÃO envia resumo velho", (await B.runPass(L2, { now: at(D, 22, 45), send })).sent === 0);

  // ── domingo: Avenida Brasil não abre ──
  const sunSlots = B.slots(T, SUN);
  check("domingo: a Avenida Brasil (não abre) sai do dia — só sobra o horário das 22:30", sunSlots.length === 1 && sunSlots[0].time === "22:30" && !sunSlots[0].storeIds.includes(ab));
  const before = sent.length;
  await B.runPass(T, { now: at(SUN, 22, 30), send });
  check("domingo 22:30: resumo sem Avenida Brasil e a Rede NÃO fica 'não calculada' por causa dela (3.300 de 3.000)", sent.length === before + 1 && !/Avenida Brasil/.test(sent[before]) && /Rede\nVenda: R\$ 3\.300\nCota: R\$ 3\.000/.test(sent[before]), sent[before]);
  check("domingo: a cota da manhã também não lista a loja fechada como 'sem cota'", !/Avenida Brasil/.test(B.morningLines(T, SUN).join("\n")));

  // ── cadastro do horário ──
  let bad = 0; for (const v of ["25:00", "19:75", "abc", "7"]) { try { Stores.update(T, carioca, { closingBriefTime: v } as any); } catch { bad++; } }
  check("horário inválido é recusado (HH:MM 00:00–23:59)", bad === 4);
  check("normaliza 7:05 → 07:05 e vazio volta ao padrão da rede", (Stores.update(T, carioca, { closingBriefTime: "7:05" } as any) as any).closing_brief_time === "07:05" && (Stores.update(T, carioca, { closingBriefTime: "" } as any) as any).closing_brief_time === null);
  check("loja sem horário = padrão da rede 22:30", B.slots(T, D).some((s) => s.time === "22:30" && s.storeIds.includes(carioca)));

  // ── fim da mensagem dupla (Tutor × fechamento por loja) ──
  db.prepare(`UPDATE organization_settings SET tutor_wa_enabled = 1, tutor_wa_phone = '5521999990001' WHERE organization_id = ?`).run(T);
  const evening = await Tutor.runEveningPass(T, { now: at("2026-09-25", 20, 0), send });
  check("fechamento por loja ligado: o 'Fim do dia' genérico do Tutor NÃO sai (não há 2ª mensagem)", evening.sent === false && (evening as any).reason === "replaced_by_retail_night_brief");
  B.setEnabled(T, false);
  const evening2 = await Tutor.runEveningPass(T, { now: at("2026-09-25", 20, 0), send });
  check("fechamento por loja desligado: o 'Fim do dia' do Tutor volta a sair (0-regressão)", evening2.sent === true);

  // ── fiação ──
  const sched = fs.readFileSync(path.join(process.cwd(), "src/server/Scheduler.ts"), "utf8");
  const fast = sched.slice(sched.indexOf("static async fastPass()"), sched.indexOf("static async", sched.indexOf("static async fastPass()") + 30));
  check("o passe do fechamento roda no passe RÁPIDO (5 min) e só ali — o tick horário atrasaria 19:30/22:30 em até 1h", /retailNightBriefPass\(\)/.test(fast) && (sched.match(/await this\.retailNightBriefPass\(\)/g) || []).length === 1);
  check("isolamento: a org X (sem nada) não tem horários", B.slots(X, D).length === 0);

  console.log("\n=== PRD Fase 1 · F1.6d: fechamento por horário de cada loja ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
