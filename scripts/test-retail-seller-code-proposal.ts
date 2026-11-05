/**
 * TESTE — P3 + LV- do Atendimento de Loja (análise dos códigos de vendedor sem nome).
 * ----------------------------------------------------------------------------
 * Quem foi cadastrado SEM o código do caixa (placeholder "LV-" do Atendimento de Loja, ou matrícula
 * chutada que nunca vendeu) recebe a PROPOSTA do código novo da loja cujo dia bate com o dele — pelo
 * lançamento manual do gerente OU pela venda declarada no Atendimento. Nunca liga sozinho.
 * Prova:
 *   - "sem código" = nenhum código da pessoa vendeu no PDV/ERP (LV- e matrícula fantasma entram; quem vende sai);
 *   - LV- + venda declarada no Atendimento → propõe o código (fonte "atendimento");
 *   - matrícula fantasma + lançamento manual → propõe (fonte "manual");
 *   - sem evidência, empate entre duas pessoas e código de OUTRA loja → não propõe;
 *   - somente leitura (nada gravado); o aviso de código novo cita a proposta;
 *   - Atendimento de Loja: gerente DA LOJA vê os códigos sem nome e confirma (outra loja: 403;
 *     código de outra loja: recusado); confirmar liga como apelido e a pessoa sai de "sem código";
 *   - conciliação do Atendimento enxerga o código ligado: venda declarada do LV- passa a ser confirmada;
 *   - cadastro do Atendimento recusa código que já é apelido de outra pessoa; sem código → LV-;
 *   - isolamento entre orgs; rótulos; fiação das telas.
 *
 * Uso:  npm run test:retail-seller-code-proposal
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-code-proposal-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-code-proposal-1234567890abc";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));
  const { RetailSellerCodeProposalService: P } = await import("../src/server/RetailSellerCodeProposalService.js");
  const { RetailFloorService } = await import("../src/server/RetailFloorService.js");
  const { RetailFloorReconciliationService: Recon } = await import("../src/server/RetailFloorReconciliationService.js");
  const { RetailSellerDirectoryService: Dir } = await import("../src/server/RetailSellerDirectoryService.js");
  const { RetailOpsSignalPublisher } = await import("../src/server/RetailOpsSignalPublisher.js");
  const labels = await import("../src/features/retailops/sellerCodeLabels.js");
  const express = (await import("express")).default;
  const { default: floorRoutes } = await import("../src/server/routes/retailFloor.js");
  const { default: retailRoutes } = await import("../src/server/routes/retailops.js");

  const ASOF = new Date().toISOString().slice(0, 10);
  const dayAgo = (n: number) => new Date(Date.parse(ASOF + "T12:00:00Z") - n * 86400000).toISOString().slice(0, 10);
  const A = `org_A_${randomUUID().slice(0, 6)}`, O = `org_O_${randomUUID().slice(0, 6)}`;
  for (const o of [A, O]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const store = (org: string, name: string, code: string, mgr: string | null) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active, manager_user_id) VALUES (?, ?, ?, ?, 1, ?)`).run(id, org, name, code, mgr); return id; };
  const bangu = store(A, "BANGU", "1083", "mgrB"), carioca = store(A, "Carioca", "1065", "mgrC");
  store(O, "Outra", "1083", null);
  let b = 0;
  const sale = (org: string, filial: string, code: string, date: string, v: number) => db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor_codigo, valor) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), org, filial, `b${b++}`, date, code, v);
  const man = (org: string, storeId: string, name: string, date: string, v: number) => db.prepare(`INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, valor) VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), org, storeId, date, name, v);
  const attend = (org: string, storeId: string, sellerId: string, date: string, v: number) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_floor_attendances (id, organization_id, store_id, shift_id, seller_id, started_at, ended_at, outcome, reconciliation_state, declared_value) VALUES (?, ?, ?, 'shift-x', ?, ?, ?, 'converted', 'pending', ?)`).run(id, org, storeId, sellerId, `${date} 15:00:00`, `${date} 15:20:00`, v); return id; };
  const seller = (org: string, name: string, matricula: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, ?, ?, 1)`).run(id, org, matricula, name); return id; };

  // Paula: cadastrada pelo Atendimento de Loja SEM código (LV-) e lotada na BANGU; o caixa vende em 10830007.
  const paula = RetailFloorService.createSeller(A, { name: "Paula Lima" }, "t").id;
  // Marcus: matrícula chutada 10830002 (nunca vendeu); o caixa vende em 10830005; o gerente lança por nome.
  const marcus = seller(A, "Marcus Vinicius", "10830002");
  const carlos = seller(A, "Carlos Real", "10830009");             // tem código que vende → não é "sem código"
  const ana = RetailFloorService.createSeller(A, { name: "Ana Sem Dado" }, "t").id; // LV- sem nenhuma evidência
  const g1 = seller(A, "Gemeo Um", "LV-G1"), g2 = seller(A, "Gemeo Dois", "LV-G2"); // empate
  const rita = seller(A, "Rita Carioca", "LV-RITA");               // só na Carioca; o código bate mas é da BANGU
  Dir.setStoreSellers(A, bangu, [paula, marcus, carlos, ana, g1, g2], "t");
  Dir.setStoreSellers(A, carioca, [rita], "t");

  // Cada código com um padrão diário próprio (como na loja real); valores parecidos entre códigos levariam ao
  // empate e, corretamente, a NENHUMA proposta.
  const days = [20, 18, 15, 12, 9, 6, 3].map(dayAgo);
  const vals = [900, 1200, 800, 1500, 700, 1000, 1100];     // Paula / 10830007
  const mVals = [300, 2500, 1900, 400, 2200, 350, 600];     // Marcus / 10830005
  const tVals = [5000, 150, 3000, 250, 4000, 180, 90];      // gêmeos / 10830008
  const rVals = [60, 70, 6000, 80, 5500, 75, 7000];         // Rita / 10830010
  days.forEach((d, i) => {
    sale(A, "1083", "10830007", d, vals[i]); attend(A, bangu, paula, d, vals[i] * 0.97);     // Paula: venda declarada bate
    sale(A, "1083", "10830005", d, mVals[i] + 7); man(A, bangu, "Marcus Vinicius", d, mVals[i]); // Marcus: manual bate
    sale(A, "1083", "10830008", d, tVals[i]); man(A, bangu, "Gemeo Um", d, tVals[i]); man(A, bangu, "Gemeo Dois", d, tVals[i] * 1.02); // empate
    sale(A, "1083", "10830010", d, rVals[i]); man(A, carioca, "Rita Carioca", d, rVals[i]); // sem loja em comum
    sale(A, "1083", "10830009", d, 50);                                                     // Carlos vende
  });
  sale(O, "1083", "10839999", dayAgo(2), 100);

  const sellersBefore = (db.prepare(`SELECT COUNT(*) n FROM retail_sellers WHERE organization_id = ?`).get(A) as any).n;
  const aliasesBefore = (db.prepare(`SELECT COUNT(*) n FROM retail_seller_aliases WHERE organization_id = ?`).get(A) as any).n;

  // ── 1. Quem está sem código ──
  const people = P.codelessPeople(A);
  const pid = new Set(people.map((p) => p.sellerId));
  check("1.1 'sem código': LV- (Paula, Ana, gêmeos, Rita) e matrícula fantasma (Marcus) entram", [paula, ana, g1, g2, rita, marcus].every((id) => pid.has(id)));
  check("1.2 quem tem código que vende (Carlos) não entra", !pid.has(carlos));
  check("1.3 Paula marcada como placeholder; Marcus não", people.find((p) => p.sellerId === paula)!.placeholder && !people.find((p) => p.sellerId === marcus)!.placeholder);

  // ── 2. Propostas ──
  const rep = P.report(A, { asOf: ASOF });
  const prop = (id: string) => rep.people.find((p) => p.sellerId === id)?.proposal || null;
  check("2.1 Paula (LV-) ← 10830007 pela venda declarada no Atendimento", prop(paula)?.code === "10830007" && prop(paula)?.sources.join() === "atendimento" && prop(paula)?.matchDays === 7, JSON.stringify(prop(paula)));
  check("2.2 Marcus (fantasma 10830002) ← 10830005 pelo lançamento manual", prop(marcus)?.code === "10830005" && prop(marcus)?.sources.join() === "manual", JSON.stringify(prop(marcus)));
  check("2.3 sem evidência (Ana): sem proposta", prop(ana) === null);
  check("2.4 empate entre duas pessoas (gêmeos): ninguém recebe o código", prop(g1) === null && prop(g2) === null);
  check("2.5 código de OUTRA loja (Rita só na Carioca): sem proposta", prop(rita) === null);
  check("2.6 a proposta diz por quê (dias batendo e fonte)", /Em 7 de 7 dias/.test(prop(paula)?.why || "") && /Atendimento de Loja/.test(prop(paula)?.why || ""));
  check("2.7 somente leitura: nenhum vendedor/apelido criado", (db.prepare(`SELECT COUNT(*) n FROM retail_sellers WHERE organization_id = ?`).get(A) as any).n === sellersBefore && (db.prepare(`SELECT COUNT(*) n FROM retail_seller_aliases WHERE organization_id = ?`).get(A) as any).n === aliasesBefore);
  check("2.8 isolamento: outra org sem pessoas/propostas da A", P.codelessPeople(O).length === 0 && P.proposals(O).length === 0);

  // ── 3. Aviso de código novo cita a proposta ──
  RetailOpsSignalPublisher.run(A, { asOf: ASOF });
  const sig = db.prepare(`SELECT evidence_json FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`).get(A, `retail_ops:seller_code_new:${bangu}:10830007`) as any;
  const ev = sig ? JSON.parse(sig.evidence_json) : {};
  check("3.1 aviso do 10830007: 'Parece ser Paula Lima (cadastrado sem código do caixa)'", /Parece ser Paula Lima \(cadastrado sem código do caixa\)/.test(ev.summary || "") && ev.proposalSellerId === paula, ev.summary);

  // ── 4. Conciliação do Atendimento ANTES de ligar: venda declarada da Paula não casa ──
  const D = days[6];
  db.prepare(`INSERT INTO retail_erp_seller_sales (id, organization_id, store_id, filial, sale_date, matricula, seller_name, valor) VALUES (?, ?, ?, '1083', ?, '10830007', NULL, ?)`).run(randomUUID(), A, bangu, D, vals[6] * 1.01);
  Recon.runDay(A, bangu, D, "t");
  const stOf = () => (db.prepare(`SELECT reconciliation_state s FROM retail_floor_attendances WHERE organization_id = ? AND seller_id = ? AND date(started_at) = ?`).get(A, paula, D) as any)?.s;
  check("4.1 antes de ligar: venda declarada da Paula (LV-) fica 'não confirmada'", stOf() === "unmatched", String(stOf()));

  // ── 5. Rotas do Atendimento de Loja (gerente DA loja) ──
  const app = express();
  app.use(express.json());
  const fake = (req: any, _res: any, next: any) => { req.organizationId = req.headers["x-test-org"] || null; req.user = { userId: req.headers["x-test-user"] || "u1", role: req.headers["x-test-role"] || "owner", organizationId: req.organizationId }; next(); };
  app.use("/api/retail-floor", fake, floorRoutes);
  app.use("/api/retailops", fake, retailRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, p: string, org: string, role: string, user: string, body?: any) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-test-org": org, "x-test-role": role, "x-test-user": user }, body: body ? JSON.stringify(body) : undefined });
    let j: any = null; try { j = await r.json(); } catch { /* sem corpo */ }
    return { status: r.status, body: j };
  };
  try {
    const sc = await call("GET", `/api/retail-floor/stores/${bangu}/seller-codes`, A, "agent", "mgrB");
    check("5.1 gerente da BANGU vê os códigos sem nome da loja e a proposta da Paula", sc.status === 200 && sc.body.candidates.some((c: any) => c.matricula === "10830007") && sc.body.proposals.some((p: any) => p.sellerId === paula && p.code === "10830007"), JSON.stringify(sc.body).slice(0, 300));
    check("5.2 'código ligado' só mostra código que vende (Carlos 10830009 sim; fantasma 10830002 não)", sc.body.linked?.[carlos]?.includes("10830009") && !sc.body.linked?.[marcus]);
    const scC = await call("GET", `/api/retail-floor/stores/${bangu}/seller-codes`, A, "agent", "mgrC");
    check("5.3 gerente de OUTRA loja: 403", scC.status === 403);
    const bad = await call("POST", `/api/retail-floor/stores/${bangu}/sellers/${paula}/link-code`, A, "agent", "mgrB", { code: "10650001" });
    check("5.4 código que não vendeu nesta loja: recusado", bad.status === 400);
    const ok = await call("POST", `/api/retail-floor/stores/${bangu}/sellers/${paula}/link-code`, A, "agent", "mgrB", { code: "10830007" });
    check("5.5 gerente confirma: 10830007 vira código da Paula (apelido)", ok.status === 200 && !!db.prepare(`SELECT 1 FROM retail_seller_aliases WHERE organization_id = ? AND seller_id = ? AND alias = '10830007' AND kind = 'matricula'`).get(A, paula), JSON.stringify(ok.body));
    check("5.6 a matrícula principal da Paula não muda (LV- fica; histórico preservado)", /^LV-/.test((db.prepare(`SELECT matricula m FROM retail_sellers WHERE id = ?`).get(paula) as any).m));
    check("5.7 Paula sai de 'sem código'", !P.codelessPeople(A).some((p) => p.sellerId === paula));
    const sc2 = await call("GET", `/api/retail-floor/stores/${bangu}/seller-codes`, A, "agent", "mgrB");
    check("5.8 a tela passa a mostrar 'Código do caixa 10830007' para a Paula", labels.floorCodeLabel("LV-X", sc2.body.linked?.[paula]) === "Código do caixa 10830007");
    const rede = await call("GET", `/api/retailops/sellers/identity/codeless`, A, "owner", "own");
    check("5.9 rede: lista quem segue sem código, com a proposta do Marcus", rede.status === 200 && rede.body.people.some((p: any) => p.sellerId === marcus && p.proposal?.code === "10830005") && !rede.body.people.some((p: any) => p.sellerId === paula));
    const redeAgent = await call("GET", `/api/retailops/sellers/identity/codeless`, A, "agent", "mgrB");
    check("5.10 rede: sem papel de dono/admin → 403", redeAgent.status === 403);
  } finally { server.close(); }

  // ── 6. Conciliação DEPOIS de ligar: a venda declarada da Paula casa com o ERP do código real ──
  Recon.runDay(A, bangu, D, "t");
  check("6.1 depois de ligar: venda declarada da Paula confirmada pelo ERP do 10830007", stOf() === "confirmed", String(stOf()));

  // ── 7. Cadastro do Atendimento de Loja ──
  let err = ""; try { RetailFloorService.createSeller(A, { name: "Outra Pessoa", matricula: "10830007" }, "t"); } catch (e: any) { err = e.message; }
  check("7.1 código que já é apelido de outra pessoa: recusado ('já é de Paula Lima')", /já é de Paula Lima/.test(err), err);
  check("7.2 sem código informado: fica 'LV-' (sem código do caixa)", /^LV-/.test(RetailFloorService.createSeller(A, { name: "Nova Sem Codigo" }, "t").matricula));

  // ── 8. Rótulos ──
  check("8.1 rótulo da proposta", labels.proposalLabel({ code: "10830005", matchDays: 7, pdvDays: 7 }) === "Parece ser o código 10830005 (bateu em 7 de 7 dias)");
  check("8.2 rótulo do código: ligado > LV- > matrícula", labels.floorCodeLabel("LV-1", []) === "Sem código do caixa" && labels.floorCodeLabel("1234", undefined) === "Matrícula 1234" && labels.floorCodeLabel("LV-1", ["9", "8"]) === "Código do caixa 9, 8");

  // ── 9. Fiação das telas ──
  const floorView = fs.readFileSync(path.join(process.cwd(), "src/features/RetailFloorView.tsx"), "utf8");
  const opsView = fs.readFileSync(path.join(process.cwd(), "src/features/RetailOpsView.tsx"), "utf8");
  check("9.1 Atendimento de Loja lista os códigos da loja e confirma pela rota da loja", floorView.includes("/seller-codes") && floorView.includes("/link-code") && !floorView.includes("Matrícula no PDV (opcional)"));
  check("9.2 rede: cartão mostra 'Cadastrados sem código do caixa'", opsView.includes("/api/retailops/sellers/identity/codeless") && opsView.includes("Cadastrados sem código do caixa"));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} retail-seller-code-proposal: ${passed}/${results.length} checks`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });
