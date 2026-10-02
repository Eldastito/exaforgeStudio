/**
 * TESTE — S6: (a) sinais do publicador de varejo REABREM quando o problema volta (antes: ficavam resolvidos pra sempre e o gestor
 * não era avisado de novo); só o que o PRÓPRIO detector fechou reabre — o que uma pessoa resolveu/dispensou fica fechado;
 * (b) parcial das 16h mostra a meta do MÊS × fechamentos já enviados (antes só tinha a meta do dia) sem inventar: sem meta mensal
 * a linha não aparece; sem fechamento enviado não diz "vendeu 0"; loja sem meta não ganha linha.
 * Uso:  npm run test:retail-signal-reopen
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-reopen-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-reopen-1234567890";

let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailOnlineReserveService } = await import("../src/server/RetailOnlineReserveService.js");
  const { OrdersService } = await import("../src/server/OrdersService.js");
  const { RetailOpsSignalPublisher: Pub } = await import("../src/server/RetailOpsSignalPublisher.js");
  const { BusinessSignalService: S } = await import("../src/server/BusinessSignalService.js");
  const { RetailAfternoonBriefService: Aft } = await import("../src/server/RetailAfternoonBriefService.js");
  const { RetailMonthlyGoalService: G } = await import("../src/server/RetailMonthlyGoalService.js");

  const today = new Date().toISOString().slice(0, 10);
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const A = mkOrg(), O = mkOrg();

  // ── (a) reabertura ──
  const store = RetailStoreService.create(A, { name: "Loja 1", code: "1" });
  const prod = (name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', ?, 100, 1, 0)`).run(id, A, name); return id; };
  const PA = prod("Camisa"), PB = prod("Calça");
  RetailOnlineReserveService.setEnabled(A, true);
  RetailOnlineReserveService.setReserve(A, store.id, PA, null, 3);
  const sell = (p: string, q: number) => OrdersService.createOrder(A, { items: [{ productId: p, name: "x", unitPrice: 0, quantity: q }], storeId: store.id, autoClose: true });
  sell(PA, 3);                                                      // esgota
  const run = () => Pub.run(A, { asOf: today, windowDays: 3650 });
  const stat = (type: string) => (db.prepare(`SELECT status, auto_resolved FROM business_signals WHERE organization_id = ? AND signal_type = ?`).get(A, type) as any);
  run();
  check("esgotou → sinal aberto", stat("retail_online_reserve_out")?.status === "open");
  RetailOnlineReserveService.setReserve(A, store.id, PA, null, 10);   // reabastece
  run();
  const s1 = stat("retail_online_reserve_out");
  check("reabasteceu → o detector fecha (resolved, marcado como automático)", s1?.status === "resolved" && s1?.auto_resolved === 1, JSON.stringify(s1));
  sell(PA, 7);                                                      // esgota de novo
  run();
  const s2 = stat("retail_online_reserve_out");
  check("o problema VOLTOU → o sinal reabre (antes ficava resolvido pra sempre)", s2?.status === "open" && s2?.auto_resolved === 0, JSON.stringify(s2));
  check("reabrir não duplica o sinal", (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id = ? AND signal_type = 'retail_online_reserve_out'`).get(A) as any).c === 1);

  // resolvido por PESSOA: fica resolvido mesmo com o problema ainda valendo
  const row = db.prepare(`SELECT id FROM business_signals WHERE organization_id = ? AND signal_type = 'retail_online_reserve_out'`).get(A) as any;
  S.resolve(A, row.id);
  run();
  const s3 = stat("retail_online_reserve_out");
  check("resolvido por uma pessoa NÃO é reaberto pelo detector", s3?.status === "resolved" && s3?.auto_resolved === 0, JSON.stringify(s3));
  // dispensado: idem
  db.prepare(`UPDATE business_signals SET status = 'open' WHERE id = ?`).run(row.id);
  S.dismiss(A, row.id, null);
  run();
  check("dispensado por uma pessoa NÃO é reaberto", stat("retail_online_reserve_out")?.status === "dismissed");
  // legado (resolvido antes da coluna existir = auto_resolved 0): conservador, não reabre
  check("o resolveByDedupe marca auto_resolved; resolve humano zera (sem estado ambíguo)", (() => {
    const k = `t:${randomUUID()}`; const sg = S.publish(A, { domain: "retail_ops", signalType: "x_test", severity: "info", basis: "fact", confidence: 1, sourceService: "t", evidence: {}, dedupeKey: k });
    S.resolveByDedupe(A, k); const a = (db.prepare(`SELECT auto_resolved a FROM business_signals WHERE id = ?`).get(sg.id) as any).a;
    S.reopenByDedupe(A, k, { onlyAutoResolved: true }); S.resolveByDedupe(A, k); S.resolve(A, sg.id);
    return a === 1 && (db.prepare(`SELECT auto_resolved a FROM business_signals WHERE id = ?`).get(sg.id) as any).a === 0;
  })());
  check("isolamento: reabertura em A não toca outra org", (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id = ?`).get(O) as any).c === 0);

  // ── (b) parcial das 16h com a meta do mês ──
  const D = "2026-09-24";
  const mk = (org: string, name: string, code: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, ?, ?)`).run(id, org, name, code); return id; };
  const closing = (org: string, st: string, date: string, v: number) => db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total) VALUES (?, ?, ?, ?, 'received', ?, 0)`).run(randomUUID(), org, st, date, v);
  const bangu = mk(O, "Bangu", "3001"), carioca = mk(O, "Carioca", "3002"), grande = mk(O, "Grande Rio", "3003");
  G.set(O, { storeId: bangu, month: "2026-09", goalAmount: 80000 });
  G.set(O, { storeId: carioca, month: "2026-09", goalAmount: 60000 });
  closing(O, bangu, "2026-09-01", 3000); closing(O, bangu, "2026-09-02", 2500); closing(O, bangu, D, 9999);   // o dia de hoje NÃO entra
  closing(O, grande, "2026-09-03", 1000);                                                                    // sem meta mensal
  const snap = Aft.snapshot(O, D, { now: new Date(`${D}T19:30:00Z`) });
  const st = (n: string) => snap.stores.find((x: any) => x.storeName === n)!;
  check("Bangu: meta do mês 80.000 × fechado até ontem 5.500 → faltam 74.500 (hoje não entra)", st("Bangu").mes?.goal === 80000 && st("Bangu").mes?.sold === 5500 && st("Bangu").mes?.falta === 74500 && st("Bangu").mes?.closedDays === 2, JSON.stringify(st("Bangu").mes));
  check("Carioca: meta cadastrada, SEM fechamento enviado → só a meta (não afirma vendeu 0)", st("Carioca").mes?.goal === 60000 && st("Carioca").mes?.sold === null && st("Carioca").mes?.falta === null, JSON.stringify(st("Carioca").mes));
  check("Grande Rio: sem meta mensal → sem linha do mês (não inventa)", st("Grande Rio").mes === null);
  const txt = Aft.text(snap);
  check("texto: 'Mês: meta R$ 80.000 · fechado até ontem R$ 5.500 · faltam R$ 74.500 (só fechamentos já enviados)'", /Mês: meta R\$ 80\.000 · fechado até ontem R\$ 5\.500 · faltam R\$ 74\.500 \(só fechamentos já enviados\)/.test(txt), txt);
  check("texto: Carioca 'sem fechamento enviado ainda' e nada de 'R$ 0,00' de mês", /Mês: meta R\$ 60\.000 · sem fechamento enviado ainda/.test(txt));
  check("texto: Grande Rio não ganha linha 'Mês'", !/Grande Rio — 16h[\s\S]*?Dinheiro: [^\n]*\nMês:/.test(txt));
  const snap1 = Aft.snapshot(O, "2026-09-01", { now: new Date("2026-09-01T19:30:00Z") });
  check("dia 1: ainda não há mês fechado → nenhuma linha de mês", snap1.stores.every((x: any) => x.mes === null));
  check("isolamento: org A (sem lojas deste teste) não vê as metas da O", Aft.snapshot(A, D).stores.every((x: any) => x.mes === null));

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures) { console.log(`\n${failures} FALHA(S)`); process.exit(1); }
  console.log("\nTODOS OS CHECKS PASSARAM");
}
main().catch((e) => { console.error(e); process.exit(1); });
