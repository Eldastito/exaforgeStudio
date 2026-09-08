/**
 * TEST — Fala Tu "Conversar com o negócio" (FalaTuAskService).
 * Prova o roteador determinístico + as respostas aterradas + o gate de dinheiro:
 *   - classify() puro: cash_on_day / sales_on_day / who_is_off / open_question + data.
 *   - dinheiro no dia: soma SÓ 'dinheiro' (não pix/credito), por data, isolado por org.
 *   - faturamento no dia: soma informed_total dos fechamentos da data.
 *   - quem está de folga: reusa RetailScheduleTemplateService.whoIsOff.
 *   - lacuna honesta: dia sem fechamento → admite ("não encontrei"), nunca inventa.
 *   - RBAC de dinheiro (§73): vendedor barrado; owner e gerente liberados.
 *   - datas relativas (amanhã/ontem/hoje) derivadas corretamente.
 *
 * Uso: npm run test:falatu-ask
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-ask-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-falatu-ask-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FalaTuAskService, extractDate } = await import("../src/server/FalaTuAskService.js");

  const mkOrg = () => {
    const o = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status, vertical) VALUES (?, 'Toulon', 'active', 'moda')`).run(o);
    return o;
  };
  const store = (org: string, name: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO retail_stores (id, organization_id, name) VALUES (?, ?, ?)`).run(id, org, name);
    return id;
  };
  const closing = (org: string, storeId: string, date: string, total: number, items: Record<string, number>) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, informed_total, status) VALUES (?, ?, ?, ?, ?, 'reconciled')`).run(id, org, storeId, date, total);
    for (const [pm, amt] of Object.entries(items)) {
      db.prepare(`INSERT INTO retail_daily_closing_items (id, organization_id, closing_id, payment_method, informed_amount) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, id, pm, amt);
    }
    return id;
  };
  const offEntry = (org: string, storeId: string, sellerKey: string, sellerName: string, date: string) => {
    db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, seller_key, seller_name, work_date, status) VALUES (?, ?, ?, ?, ?, ?, 'off')`).run(randomUUID(), org, storeId, sellerKey, sellerName, date);
  };

  const owner = (org: string) => ({ userId: randomUUID(), email: "dono@toulon.com", role: "owner", organizationId: org });

  const A = mkOrg();
  const s1 = store(A, "Loja Centro");
  const s2 = store(A, "Loja Shopping");
  const DATE = "2025-08-31";
  // Loja Centro: R$ 1.000 dinheiro + 500 pix. Loja Shopping: R$ 250 dinheiro.
  closing(A, s1, DATE, 1500, { dinheiro: 1000, pix: 500 });
  closing(A, s2, DATE, 250, { dinheiro: 250 });

  // ── 1. classify puro ──
  const c1 = FalaTuAskService.classify("quanto a loja fez de vendas em dinheiro no dia 31 de agosto de 2025?", "2026-09-08");
  check("1.1 classify: 'em dinheiro no dia X' → cash_on_day", c1.kind === "cash_on_day");
  check("1.2 classify: extrai a data 2025-08-31", c1.date === "2025-08-31");
  check("1.3 classify: cash needsMoney=true", c1.needsMoney === true);

  const c2 = FalaTuAskService.classify("qual foi o faturamento total do dia 31/08/2025?", "2026-09-08");
  check("1.4 classify: faturamento → sales_on_day", c2.kind === "sales_on_day");
  check("1.5 classify: dd/mm/aaaa vira 2025-08-31", c2.date === "2025-08-31");

  const c3 = FalaTuAskService.classify("quem são os colaboradores que estão de folga amanhã?", "2025-08-31");
  check("1.6 classify: folga → who_is_off", c3.kind === "who_is_off");
  check("1.7 classify: 'amanhã' vira 2025-09-01", c3.date === "2025-09-01");
  check("1.8 classify: who_is_off needsMoney=false", c3.needsMoney === false);

  const c4 = FalaTuAskService.classify("por que minhas vendas caíram esse mês?", "2026-09-08");
  check("1.9 classify: pergunta aberta → open_question", c4.kind === "open_question");
  check("1.10 classify: open_question needsMoney=false (não vaza p/ LLM gate)", c4.needsMoney === false);

  // ── 2. extractDate relativo ──
  check("2.1 extractDate hoje", extractDate("e hoje?", "2025-08-31") === "2025-08-31");
  check("2.2 extractDate ontem", extractDate("e ontem?", "2025-08-31") === "2025-08-30");
  check("2.3 extractDate amanhã", extractDate("amanhã", "2025-08-31") === "2025-09-01");
  check("2.4 extractDate anteontem", extractDate("anteontem", "2025-08-31") === "2025-08-29");
  check("2.5 extractDate sem data → null", extractDate("por que caiu?", "2025-08-31") === null);

  // ── 3. dinheiro no dia (owner) ──
  const r1 = await FalaTuAskService.answer(A, owner(A), "quanto vendi em dinheiro no dia 31 de agosto de 2025?");
  check("3.1 cash: soma SÓ dinheiro (1000+250=1250), não pix", r1.data?.total === 1250);
  check("3.2 cash: 2 fechamentos", r1.data?.closings === 2);
  check("3.3 cash: grounded (query direta)", r1.grounded === true);
  check("3.4 cash: não restrito p/ owner", r1.moneyRestricted === false);
  check("3.5 cash: resposta cita o valor formatado", /1\.250,00/.test(r1.answer));

  // ── 4. faturamento total no dia ──
  const r2 = await FalaTuAskService.answer(A, owner(A), "faturamento total do dia 31/08/2025?");
  check("4.1 sales: soma informed_total (1500+250=1750)", r2.data?.total === 1750);
  check("4.2 sales: grounded", r2.grounded === true && r2.kind === "sales_on_day");

  // ── 5. lacuna honesta: dia sem fechamento ──
  const r3 = await FalaTuAskService.answer(A, owner(A), "quanto vendi em dinheiro no dia 01/01/2020?");
  check("5.1 gap: total null (não inventa)", r3.data?.total === null);
  check("5.2 gap: admite não ter o número", /não encontrei|não tenho/i.test(r3.answer));

  // ── 6. quem está de folga ──
  offEntry(A, s1, "ana", "Ana", "2025-09-01");
  offEntry(A, s2, "bruno", "Bruno", "2025-09-01");
  const r4 = await FalaTuAskService.answer(A, owner(A), "quem está de folga em 01/09/2025?");
  check("6.1 folga: who_is_off", r4.kind === "who_is_off");
  check("6.2 folga: 2 pessoas", (r4.data?.off || []).length === 2);
  check("6.3 folga: cita Ana e Bruno", /Ana/.test(r4.answer) && /Bruno/.test(r4.answer));

  const r5 = await FalaTuAskService.answer(A, owner(A), "quem está de folga em 05/09/2025?");
  check("6.4 folga vazia: admite ninguém marcado", /ninguém|nao ha|não há/i.test(r5.answer));

  // ── 7. RBAC de dinheiro (§73) ──
  // 7a. vendedor (role agent, sem gerente) → barrado.
  const vend = { userId: randomUUID(), email: "vend@toulon.com", role: "agent", organizationId: A };
  const rv = await FalaTuAskService.answer(A, vend, "quanto vendi em dinheiro no dia 31 de agosto de 2025?");
  check("7.1 vendedor: dinheiro RESTRITO", rv.moneyRestricted === true);
  check("7.2 vendedor: não vaza o número", !/1\.250/.test(rv.answer));
  // 7b. vendedor PODE perguntar folga (não é dinheiro).
  const rvOff = await FalaTuAskService.answer(A, vend, "quem está de folga em 01/09/2025?");
  check("7.3 vendedor: folga liberada", rvOff.moneyRestricted === false && rvOff.kind === "who_is_off");
  // 7c. gerente (role_profile system_key='gerente') → liberado.
  const gProf = "prof_ger_" + randomUUID().slice(0, 6);
  db.prepare(`INSERT INTO role_profiles (id, organization_id, name, system_key, is_system) VALUES (?, ?, 'Gerente', 'gerente', 1)`).run(gProf, A);
  const ger = { userId: randomUUID(), email: "ger@toulon.com", role: "agent", role_profile_id: gProf, organizationId: A };
  const rg = await FalaTuAskService.answer(A, ger, "quanto vendi em dinheiro no dia 31 de agosto de 2025?");
  check("7.4 gerente: dinheiro LIBERADO", rg.moneyRestricted === false && rg.data?.total === 1250);

  // ── 8. isolamento multi-tenant ──
  const B = mkOrg();
  const rBiso = await FalaTuAskService.answer(B, owner(B), "quanto vendi em dinheiro no dia 31 de agosto de 2025?");
  check("8.1 org B não vê o caixa de A", rBiso.data?.total === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-ask: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
