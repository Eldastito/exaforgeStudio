/**
 * TESTE — PRD Fase 1 §9/§11/§12 (S3, estrutura): META MENSAL por loja/competência como dado + resumo da manhã/noite lendo-a.
 * Prova: cadastro validado (valor > 0, mês YYYY-MM, loja da org, upsert, remover) e null≠0; o fechamento da noite mostra
 * "Mês: R$ X de R$ <meta mensal>" (denominador = meta mensal, NÃO a soma das cotas diárias) por loja; a REDE só usa a meta mensal
 * quando TODA loja aberta tem a sua (senão fica como antes — sem denominador misturado); mês parcial rotula a meta; "lojas que
 * bateram × abaixo" só conta com venda E cota conhecidas; manhã: "Meta de hoje por loja" + exceções "sem escala" (só em org que usa
 * escala) e "N vendedores ainda precisam ser identificados"; org sem meta mensal = comportamento anterior; isolamento por org.
 * Uso:  npm run test:retail-monthly-goal
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mgoal-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-mgoal-1234567890";

let failures = 0;
function check(name: string, ok: boolean) { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const G = (await import("../src/server/RetailMonthlyGoalService.js")).RetailMonthlyGoalService;
  const B = (await import("../src/server/RetailDayBriefService.js")).RetailDayBriefService;

  const A = `org_A_${randomUUID().slice(0, 6)}`, O = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, O]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  db.prepare(`UPDATE organization_settings SET retail_official_sale_source = 'folha' WHERE organization_id = ?`).run(A);
  const store = (org: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, ?, ?)`).run(id, org, name, name.slice(0, 4)); return id; };
  const quota = (org: string, st: string, date: string, v: number) => db.prepare(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, st, date, v);
  const closing = (org: string, st: string, date: string, v: number) => db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total) VALUES (?, ?, ?, ?, 'received', ?, 0)`).run(randomUUID(), org, st, date, v);
  const D = "2026-09-24", MONTH = "2026-09";

  const carioca = store(A, "Carioca"), bangu = store(A, "Bangu"), grande = store(A, "Grande Rio");
  const lojaB = store(O, "Loja B");

  // ── cadastro ──
  check("sem meta cadastrada → null (nunca 0) e lista vazia", G.get(A, carioca, MONTH) === null && G.list(A, MONTH).length === 0);
  const r = G.set(A, { storeId: carioca, month: MONTH, goalAmount: 60000 }, "u1");
  check("cadastra a meta mensal da loja", r.goalAmount === 60000 && G.get(A, carioca, MONTH) === 60000);
  G.set(A, { storeId: carioca, month: MONTH, goalAmount: "65000,50" }, "u1");
  check("regrava (upsert, aceita vírgula) sem duplicar", G.get(A, carioca, MONTH) === 65000.5 && G.list(A, MONTH).length === 1);
  G.set(A, { storeId: carioca, month: MONTH, goalAmount: 60000 }, "u1");
  let e1 = false, e2 = false, e3 = false, e4 = false;
  try { G.set(A, { storeId: carioca, month: MONTH, goalAmount: 0 }); } catch { e1 = true; }
  try { G.set(A, { storeId: carioca, month: "2026-13", goalAmount: 10 }); } catch { e2 = true; }
  try { G.set(A, { storeId: lojaB, month: MONTH, goalAmount: 10 }); } catch { e3 = true; }
  try { G.set(A, { storeId: carioca, month: MONTH, goalAmount: -5 }); } catch { e4 = true; }
  check("recusa meta 0/negativa, mês inválido e loja de OUTRA org", e1 && e2 && e3 && e4 && G.get(O, lojaB, MONTH) === null);
  check("isolamento: a meta da A não aparece na org B", G.list(O, MONTH).length === 0);

  // ── noite: denominador = meta mensal ──
  for (const d of ["2026-09-10", "2026-09-21", "2026-09-22", "2026-09-23", D]) { quota(A, carioca, d, 1000); closing(A, carioca, d, 1200); }   // Carioca: 5 dias × 1.200 = 6.000
  quota(A, bangu, D, 1000); closing(A, bangu, D, 800);                                                                                       // Bangu: abaixo da meta do dia
  quota(A, grande, D, 1000); closing(A, grande, D, 1500);                                                                                    // Grande Rio: bateu
  const sn = B.nightSnapshot(A, D);
  const c = sn.stores.find((x) => x.storeName === "Carioca")!, b = sn.stores.find((x) => x.storeName === "Bangu")!;
  check("Carioca mês: venda 6.000 de META MENSAL 60.000 (não soma das cotas = 5.000) e atingimento 10%", c.month.venda.value === 6000 && c.month.cota.value === 60000 && c.month.cotaBasis === "meta_mensal" && c.month.atingimento.value === 10);
  check("Bangu (sem meta mensal) mantém a soma das cotas diárias como denominador", b.month.cotaBasis === "cotas_diarias" && b.month.cota.value === 1000);
  check("REDE: nem toda loja tem meta mensal → mês da rede NÃO mistura (segue soma das cotas)", sn.network.month.cotaBasis !== "meta_mensal");
  const txt = B.nightText(sn);
  check("texto: 'Mês: R$ 6.000 de R$ 60.000 (10%)' no bloco da Carioca", /Carioca[\s\S]*?Mês: R\$ 6\.000 de R\$ 60\.000 \(10%\)/.test(txt));
  check("lojas que bateram × abaixo: 2 bateram (Carioca, Grande Rio), 1 abaixo (Bangu)", sn.network.storesHit === 2 && sn.network.storesBelow === 1 && /Lojas que bateram a meta: 2 · abaixo da meta: 1/.test(txt));

  G.set(A, { storeId: bangu, month: MONTH, goalAmount: 80000 }, "u1"); G.set(A, { storeId: grande, month: MONTH, goalAmount: 100000 }, "u1");
  const sn2 = B.nightSnapshot(A, D);
  check("REDE: com TODAS as lojas com meta mensal, o mês da rede usa a soma das metas (240.000)", sn2.network.month.cotaBasis === "meta_mensal" && sn2.network.month.cota.value === 240000);

  // mês parcial rotula a meta
  const P = `org_P_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), P);
  db.prepare(`UPDATE organization_settings SET retail_official_sale_source = 'folha' WHERE organization_id = ?`).run(P);
  const lp = store(P, "Loja P"); quota(P, lp, "2026-09-23", 1000); quota(P, lp, D, 1000); closing(P, lp, D, 900);   // falta o fechamento do dia 23
  G.set(P, { storeId: lp, month: MONTH, goalAmount: 30000 });
  const tp = B.nightText(B.nightSnapshot(P, D));
  check("mês com fechamento faltando: parcial rotulado COM a meta do mês, sem atingimento", /Mês: R\$ 900 — parcial, faltam fechamentos de 1 dia\(s\) \(meta do mês R\$ 30\.000\)/.test(tp));

  // org sem meta mensal = como antes
  const snO = B.nightSnapshot(O, D);
  check("org sem nenhuma meta mensal: comportamento anterior (sem 'meta_mensal')", snO.stores.every((s) => s.month.cotaBasis !== "meta_mensal"));
  check("lojas bateram/abaixo: sem venda E cota conhecidas → null (nunca 0)", snO.network.storesHit === null && snO.network.storesBelow === null && !/Lojas que bateram/.test(B.nightText(snO)));

  // ── manhã: exceções ──
  const M = `org_M_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), M);
  const s1 = store(M, "Bangu"), s2 = store(M, "Carioca");
  quota(M, s1, D, 2000); quota(M, s2, D, 3000);
  let ml = B.morningLines(M, D).join("\n");
  check("manhã: 'Meta de hoje por loja' com as metas e a da rede (5.000)", /Meta de hoje por loja/.test(ml) && /• Bangu: R\$ 2\.000/.test(ml) && /• Rede: R\$ 5\.000/.test(ml));
  check("manhã: org que NÃO usa escala não recebe 'sem escala'", !/sem escala/.test(ml));
  db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status) VALUES (?, ?, ?, ?, 'mat:1', 'Ana', 'work')`).run(randomUUID(), M, s2, D);
  ml = B.morningLines(M, D).join("\n");
  check("manhã: org que usa escala → 'Bangu está sem escala.' (Carioca tem escala, não aparece)", /Bangu está sem escala\./.test(ml) && !/Carioca está sem escala/.test(ml));
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, '7777', NULL)`).run(randomUUID(), M);
  db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor, vendedor_codigo) VALUES (?, ?, '1', 'B1', ?, '7777', '7777')`).run(randomUUID(), M, D);
  ml = B.morningLines(M, D).join("\n");
  check("manhã: '1 vendedor ainda precisa ser identificado.'", /1 vendedor ainda precisa ser identificado\./.test(ml));
  check("manhã: a exceção de uma org não vaza pra outra (isolamento)", !/sem escala|identificado/.test(B.morningLines(A, D).join("\n")));

  console.log(failures ? `\n${failures} FALHA(S)` : "\nTodas as verificações OK");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
