/**
 * TESTE — S8: acabamento de Insights / Central de Saúde / Relatórios (achados dos prints reais da TOULON, 02/10/2026).
 * Prova: (1) alertas TÉCNICOS (automações/plataforma: 143 de "162 risco") não entram nas contagens do dono — vêm à parte em
 * `technicalOpen`; (2) item de estoque parado SEM custo cadastrado deixa de valer "R$ 0,00" (capitalKnown:false + contagem) e o total
 * soma só o que tem custo; (3) dinheiro com milhar ("R$ 275.093,09", não "R$ 275093,09") e ausente = "—".
 * A parte de tela (chips em português, "itens", nota "Mostrando os N…") é verificada por tsc + build.
 * Uso:  npm run test:insights-polish
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import express from "express";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-insights-polish-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-insights-polish-1234567890";

let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService: S } = await import("../src/server/BusinessSignalService.js");
  const { BusinessHealthService: H } = await import("../src/server/BusinessHealthService.js");
  const { formatBRL } = await import("../src/lib/metric.js");
  const { default: insightsRoutes } = await import("../src/server/routes/insights.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const A = mkOrg(), O = mkOrg();

  // ── (1) contagens do dono sem os técnicos ──
  const pub = (org: string, domain: string, type: string, severity: string, key: string) =>
    S.publish(org, { domain, signalType: type, severity, basis: "fact", confidence: 1, sourceService: "t", evidence: {}, dedupeKey: key });
  for (let i = 0; i < 3; i++) pub(A, "runtime", "job_dead_letter", "risk", `rt${i}`);
  pub(A, "platform", "platform_x", "risk", "pl1");
  pub(A, "retail_ops", "retail_store_below_quota", "attention", "r1");
  pub(A, "inventory", "stockout_risk", "risk", "i1");
  pub(O, "runtime", "job_dead_letter", "risk", "o1");

  const app = express();
  app.use((req, _res, next) => { (req as any).organizationId = A; (req as any).user = { userId: "u1", role: "owner" }; next(); });
  app.use("/api/insights", insightsRoutes);
  const server = http.createServer(app);
  const port: number = await new Promise((r) => server.listen(0, () => r((server.address() as any).port)));
  const get = async () => (await fetch(`http://127.0.0.1:${port}/api/insights`)).json() as Promise<any>;
  const j = await get();
  check("alertas técnicos (runtime/platform) ficam FORA de severidade e domínio", j.bySeverity.risk === 1 && j.bySeverity.attention === 1 && !("runtime" in j.byDomain) && !("platform" in j.byDomain), JSON.stringify(j.bySeverity) + JSON.stringify(j.byDomain));
  check("…e aparecem à parte: technicalOpen = 4; openCount só com o que é do dono (2)", j.technicalOpen === 4 && j.openCount === 2, JSON.stringify({ t: j.technicalOpen, o: j.openCount }));
  check("isolamento: o runtime de outra org não conta", j.technicalOpen === 4);
  server.close();

  // ── (2) estoque parado sem custo ──
  const inv = (qty: number, cost: number | null, name: string) => {
    const pid = randomUUID();
    db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', ?, 100, 1, 1)`).run(pid, A, name);
    db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), A, pid, qty, cost);
  };
  inv(10, 20, "Camisa");        // capital 200, custo conhecido
  inv(4, 0, "Cinto");            // custo 0 = desconhecido
  inv(3, null, "Bermuda");       // sem custo
  const est: any = (H.status(A) as any).estoque;
  const byLabel = (n: string) => est.slowMovers.find((s: any) => String(s.label).includes(n));
  check("custo conhecido: capitalKnown true e valor 200", byLabel("Camisa")?.capitalKnown === true && byLabel("Camisa")?.capital === 200, JSON.stringify(byLabel("Camisa")));
  check("custo 0/ausente: capitalKnown false (a tela mostra '—', não 'R$ 0,00')", byLabel("Cinto")?.capitalKnown === false && byLabel("Bermuda")?.capitalKnown === false, JSON.stringify(est.slowMovers));
  check("unknownCostCount = 2 e o total soma só o que tem custo (200)", est.unknownCostCount === 2 && est.slowMoverCapital === 200, JSON.stringify({ u: est.unknownCostCount, c: est.slowMoverCapital }));
  const label = (H.status(A) as any).triggers.find((t: any) => t.code === "estoque_parado")?.label || "";
  check("o gatilho fala em 'itens' (português)", /3 itens/.test(label) && !/items/.test(label), label);

  // ── (3) dinheiro ──
  check("formatBRL: milhar com ponto e centavos", formatBRL(275093.09) === "R$ 275.093,09" && formatBRL(5765.02) === "R$ 5.765,02" && formatBRL(1720.32) === "R$ 1.720,32");
  check("formatBRL: ausente = '—' (nunca R$ 0,00); zero real continua R$ 0,00", formatBRL(null) === "—" && formatBRL(undefined) === "—" && formatBRL(0) === "R$ 0,00");

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures) { console.log(`\n${failures} FALHA(S)`); process.exit(1); }
  console.log("\nTODOS OS CHECKS PASSARAM");
}
main().catch((e) => { console.error(e); process.exit(1); });
