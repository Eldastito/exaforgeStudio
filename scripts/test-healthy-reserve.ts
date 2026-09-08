/**
 * TEST — Reserva Saudável / método das 4 contas (ADR-201). DB-backed, determinístico.
 * Prova: rateio com base honesta por setor (varejo → margem bruta; serviço → faturamento);
 * metas × realizado × status (operação/pró-labore = teto, lucro = piso, impostos = reserva não
 * medida); base ≤ 0 → sem rateio (null≠0); config get/set com validação; sinal proativo OPT-IN
 * (flag), hipótese + impact null, self-healing; pass() só orgs opt-in com receita (online+física);
 * isolamento.
 *
 * Uso: npm run test:healthy-reserve
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-reserve-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-reserve-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { HealthyReserveService: HR } = await import("../src/server/HealthyReserveService.js");

  const mkOrg = (vertical: string) => {
    const o = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status, vertical) VALUES (?, 'O', 'active', ?)`).run(o, vertical);
    return o;
  };
  const mkSale = (org: string, revenue: number, cost: number, ym: string, day = "10") => {
    const oid = randomUUID();
    db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', ?, ?)`).run(oid, org, revenue, `${ym}-${day} 10:00:00`);
    db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', ?, 1, ?, ?)`).run(randomUUID(), oid, org, revenue, revenue, cost);
  };
  const mkPayable = (org: string, amount: number, ym: string) =>
    db.prepare(`INSERT INTO payables (id, organization_id, description, amount, due_date, recurrence, status) VALUES (?, ?, 'D', ?, ?, 'monthly', 'open')`).run(randomUUID(), org, amount, `${ym}-05`);
  const mkProLabore = (org: string, amount: number, ym: string) =>
    db.prepare(`INSERT INTO owner_draws (id, organization_id, kind, amount, draw_date) VALUES (?, ?, 'pro_labore', ?, ?)`).run(randomUUID(), org, amount, `${ym}-08`);
  const acct = (plan: any, key: string) => plan.accounts.find((a: any) => a.key === key);
  const sig = (org: string) => db.prepare(`SELECT status, basis, impact_amount, severity FROM business_signals WHERE organization_id=? AND dedupe_key='healthy_reserve:allocation_off'`).get(org) as any;

  const P = "2026-06";

  // ── A: VAREJO (moda) → base = margem bruta. Receita 1000, CMV 400 → MB 600.
  //     Operação 300 (50% > teto 22%) → excesso; pró-labore 100 (ok); lucro sobra 200 ≥ 60 (ok).
  const A = mkOrg("moda");
  mkSale(A, 1000, 400, P);
  mkPayable(A, 300, P);
  mkProLabore(A, 100, P);
  const pa = HR.plan(A, P);
  check("1.1 varejo usa base margem bruta", pa.baseMode === "gross_margin" && pa.base === 600);
  check("1.2 disponível com 4 contas", pa.available === true && pa.accounts.length === 4);
  check("1.3 operação meta 22% = R$132, realizado R$300, excesso", acct(pa, "operacao").targetAmount === 132 && acct(pa, "operacao").actualAmount === 300 && acct(pa, "operacao").status === "excesso");
  check("1.4 pró-labore meta 50% = R$300, realizado R$100, ok", acct(pa, "prolabore").targetAmount === 300 && acct(pa, "prolabore").actualAmount === 100 && acct(pa, "prolabore").status === "ok");
  check("1.5 lucro meta 10% = R$60, sobra R$200, ok", acct(pa, "lucro").targetAmount === 60 && acct(pa, "lucro").actualAmount === 200 && acct(pa, "lucro").status === "ok");
  check("1.6 impostos = reserva, realizado NÃO medido (null)", acct(pa, "impostos").targetAmount === 108 && acct(pa, "impostos").actualAmount === null && acct(pa, "impostos").status === "reserva");
  check("1.7 status geral = pior mensurável (excesso)", pa.overallStatus === "excesso");
  check("1.8 caveat de varejo (base margem bruta) presente", pa.caveats.some((c: string) => /margem bruta/i.test(c)));

  // ── B: SERVIÇO → base = faturamento (receita), NÃO a margem bruta. Receita 1000, CMV 300.
  const B = mkOrg("servicos");
  mkSale(B, 1000, 300, P);
  const pb = HR.plan(B, P);
  check("2.1 serviço usa base faturamento (receita 1000, não MB 700)", pb.baseMode === "revenue" && pb.base === 1000);
  check("2.2 operação meta 22% de 1000 = R$220", acct(pb, "operacao").targetAmount === 220);

  // ── 3: base ≤ 0 → sem rateio (não inventa dinheiro; null≠0) ──
  const D = mkOrg("moda"); // sem venda alguma
  const pd = HR.plan(D, P);
  check("3.1 sem base → indisponível, sem contas, base null", pd.available === false && pd.accounts.length === 0 && pd.base === null && pd.overallStatus === "no_data");

  // ── 4: config get/set com validação ──
  const C = mkOrg("moda");
  const c0 = HR.getConfig(C);
  check("4.1 defaults: 10/50/18/22, flag off, baseMode auto(null)", c0.targets.profit === 10 && c0.targets.prolabore === 50 && c0.targets.taxes === 18 && c0.targets.ops === 22 && c0.enabled === false && c0.baseMode === null);
  const c1 = HR.setConfig(C, { enabled: true, profit: 15, ops: 30, baseMode: "revenue" });
  check("4.2 set aplica flag/alvos/base", c1.enabled === true && c1.targets.profit === 15 && c1.targets.ops === 30 && c1.baseMode === "revenue");
  const c2 = HR.setConfig(C, { ops: 150 }); // fora de 0..100 → ignorado
  check("4.3 % inválido ignorado (mantém 30)", c2.targets.ops === 30);
  const c3 = HR.setConfig(C, { baseMode: null });
  check("4.4 baseMode volta pra auto", c3.baseMode === null);

  // ── 5: sinal OPT-IN — flag OFF não publica ──
  const r5 = HR.publishReserveSignal(A, { period: P }); // A está fora (excesso) mas flag off
  check("5.1 flag off → não publica (opt-in)", r5.published === false && !sig(A));

  // ── 6: flag ON + alocação fora → publica hipótese, impact null ──
  HR.setConfig(A, { enabled: true });
  const r6 = HR.publishReserveSignal(A, { period: P });
  check("6.1 publica quando fora do saudável", r6.published === true);
  const row = sig(A);
  check("6.2 hypothesis + impact null + attention", row.basis === "hypothesis" && row.impact_amount == null && row.severity === "attention");
  HR.publishReserveSignal(A, { period: P });
  check("6.3 dedupe (1 linha)", (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id=? AND dedupe_key='healthy_reserve:allocation_off'`).get(A) as any).n === 1);
  check("6.4 nunca cria decision_action", (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=?`).get(A) as any).n === 0);

  // ── 7: self-healing — alocação volta ao saudável → resolve ──
  db.prepare(`DELETE FROM payables WHERE organization_id=?`).run(A); // operação some → dentro do teto
  const pa2 = HR.plan(A, P);
  check("7.1 sem operação → geral ok", pa2.overallStatus === "ok");
  const r7 = HR.publishReserveSignal(A, { period: P });
  check("7.2 voltou ao saudável → resolved", r7.published === false && sig(A)?.status === "resolved");

  // ── 8: org saudável + flag on → nunca sinaliza ──
  const E = mkOrg("moda");
  mkSale(E, 1000, 400, P); mkPayable(E, 60, P); mkProLabore(E, 100, P); // op 60/600=10% ok
  HR.setConfig(E, { enabled: true });
  const r8 = HR.publishReserveSignal(E, { period: P });
  check("8.1 saudável → não publica", r8.published === false && !sig(E));

  // ── 9: pass() (mês corrente) — só opt-in com receita; rede física entra; isolamento ──
  const nowYm = new Date().toISOString().slice(0, 7);
  const F = mkOrg("moda"); // opt-in, receita FÍSICA (PDV), alocação fora
  db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, valor, pecas, status) VALUES (?, ?, '1', 'B1', ?, 1000, 5, 'N')`).run(randomUUID(), F, `${nowYm}-05`);
  mkPayable(F, 500, nowYm); // operação 500/1000 = 50% > teto → excesso
  HR.setConfig(F, { enabled: true });
  const G = mkOrg("moda"); // receita mas NÃO opt-in
  mkSale(G, 1000, 400, nowYm); mkPayable(G, 500, nowYm);
  HR.pass();
  check("9.1 pass sinaliza rede física opt-in fora do saudável", !!sig(F));
  check("9.2 pass NÃO sinaliza org sem opt-in", !sig(G));
  check("9.3 isolamento (F tem, G/E não fora)", !!sig(F) && !sig(G) === true);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} healthy-reserve: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
