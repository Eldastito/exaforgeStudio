/**
 * TESTE — S9: "sem giro" só é afirmado quando o sistema ENXERGA as saídas de estoque.
 * Achado (prints TOULON, 02/10): "R$ 13.428,60 parados em estoque sem giro (7 itens)" abria a mensagem da manhã, mas o estoque da TOULON
 * vem direto da Alterdata e não grava `stock_movements` — todo item parece "sem saída" sem que isso prove "sem venda".
 * Prova: `giroMeasured` (≥1 saída na janela); sem ele (a) a Central de Saúde NÃO cria o gatilho "parados em estoque sem giro" nem o
 * Tutor o repete, (b) o Índice de Sobrevivência fica neutro (não é puxado pra baixo), (c) o snapshot do Diretor IA diz "giro não medido"
 * em vez de um fato (null ≠ zero), (d) o simulador de compra não estima "quanto ficaria parado"; (e) com saída registrada nada muda
 * (0-regressão); saída fora da janela ou de outra org não vale; os números brutos de stockCapital seguem os mesmos (aditivo).
 * Uso:  npm run test:stock-giro-measured
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-giro-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-stock-giro-1234567890abcdef";

let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailImpactService } = await import("../src/server/RetailImpactService.js");
  const { BusinessHealthService: H } = await import("../src/server/BusinessHealthService.js");
  const { SurvivalIndexService: SI } = await import("../src/server/SurvivalIndexService.js");
  const { InventorySnapshotAdapter } = await import("../src/server/BusinessSnapshotAdapters.js");
  const { DecisionSimulatorService: Sim } = await import("../src/server/DecisionSimulatorService.js");
  const { BusinessTutorService: T } = await import("../src/server/BusinessTutorService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const inv = (org: string, pid: string, qty: number, cost: number) =>
    db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, pid, qty, cost);
  const saida = (org: string, pid: string, when = "-1 days") =>
    db.prepare(`INSERT INTO stock_movements (id, organization_id, product_service_id, type, quantity, created_at) VALUES (?, ?, ?, 'saida', 1, datetime('now', ?))`).run(randomUUID(), org, pid, when);

  const U = mkOrg();   // não medido (estoque do ERP, sem movimentos)
  const M = mkOrg();   // medido
  const X = mkOrg();   // só tem saída antiga
  const O = mkOrg();   // outra org com saída recente
  for (const o of [U, M, X]) { inv(o, "pDead1", 91, 29.85); inv(o, "pDead2", 50, 40); }
  saida(M, "pSells");                 // M registra saídas (de outro produto) → giro medido
  saida(X, "pSells", "-90 days");     // fora da janela de 60 dias
  saida(O, "pSells");                 // outra org

  // ── stockCapital ──
  const u: any = RetailImpactService.stockCapital(U), m: any = RetailImpactService.stockCapital(M), x: any = RetailImpactService.stockCapital(X);
  check("sem nenhuma saída: giroMeasured=false (saidasInWindow 0)", u.giroMeasured === false && u.saidasInWindow === 0);
  check("com saída registrada na janela: giroMeasured=true", m.giroMeasured === true && m.saidasInWindow === 1);
  check("saída fora da janela de 60 dias não conta", x.giroMeasured === false);
  check("isolamento: saída de OUTRA org não torna a org medida", u.giroMeasured === false);
  check("aditivo: os números brutos seguem iguais (capital sem giro 2.716,35 + 2.000)", Math.abs(u.slowMoverCapital - 4716.35) < 0.01 && u.slowMoverCount === 2 && u.slowMoverCapital === m.slowMoverCapital);

  // ── Central de Saúde / Tutor ──
  const hu: any = H.status(U), hm: any = H.status(M);
  check("NÃO medido: sem o gatilho 'parados em estoque sem giro' (o headline deixa de afirmar)", !hu.triggers.some((t: any) => t.code === "estoque_parado") && hu.estoque?.giroMeasured === false);
  check("medido: o gatilho continua (0-regressão)", hm.triggers.some((t: any) => t.code === "estoque_parado") && hm.estoque?.giroMeasured === true);
  check("a mensagem da manhã do NÃO medido não afirma 'parados em estoque sem giro'", !/parados em estoque sem giro/.test(T.morningBrief(U).text), T.morningBrief(U).text);
  check("a mensagem da manhã do medido afirma (0-regressão)", /parados em estoque sem giro/.test(T.morningBrief(M).text));

  // ── Índice de Sobrevivência ──
  const eu = SI.score(U).components.find((c: any) => c.key === "estoque");
  const em = SI.score(M).components.find((c: any) => c.key === "estoque");
  check("Índice: NÃO medido → componente de estoque neutro (50, hasData=false), não penaliza", eu.score === 50 && eu.hasData === false, JSON.stringify(eu));
  check("Índice: medido → tem dado (0-regressão)", em.hasData === true);

  // ── snapshot do Diretor IA ──
  const su: any = InventorySnapshotAdapter.build(U), sm: any = InventorySnapshotAdapter.build(M);
  check("snapshot NÃO medido: semGiro é null/n-a com o motivo (null ≠ zero, não é fato)", su.semGiro.value === null && su.semGiro.basis === "n/a" && /giro_nao_medido/.test(su.semGiro.motivo), JSON.stringify(su.semGiro));
  check("snapshot medido: semGiro segue fato com valor (0-regressão)", sm.semGiro.basis === "fact" && sm.semGiro.value > 0);

  // ── simulador de compra ──
  const simU: any = Sim.buyStock(U, { amount: 10000 }), simM: any = Sim.buyStock(M, { amount: 10000 });
  check("simulador NÃO medido: não estima quanto ficaria parado (estIdle/slowPct null) e diz por quê", simU.estIdle === null && simU.slowPct === null && /giro do estoque não é medido/.test(simU.veredito), simU.veredito);
  check("simulador medido: estima como antes (0-regressão)", typeof simM.estIdle === "number" && typeof simM.slowPct === "number" && /sem giro|parado|empatar/.test(simM.veredito), simM.veredito);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures) { console.log(`\n${failures} FALHA(S)`); process.exit(1); }
  console.log("\nTODOS OS CHECKS PASSARAM");
}
main().catch((e) => { console.error(e); process.exit(1); });
