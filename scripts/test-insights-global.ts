/**
 * TESTE — Insights globais (ADR-136, kernel de inteligência empresarial).
 *
 * Prova o contrato HTTP da tela de Insights da plataforma (/api/insights):
 *   - GET /            → Pareto de TODOS os domínios (finanças + produção + varejo),
 *                        contagem por severidade e por domínio, resumo do ledger;
 *   - POST /refresh    → "Analisar agora" roda todos os publicadores (idempotente);
 *   - POST /act        → age a partir de um sinal de QUALQUER domínio → decision_action;
 *   - GET /actions     → painel lista a ação originada do sinal (qualquer domínio);
 *   - isolamento por organização.
 *
 * Monta o router real com um auth stub (org + perfil), sem tocar em rede externa.
 *
 * Uso:  npm run test:insights-global
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-insights-global-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-insights-global-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const express = (await import("express")).default;
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const insightsRoutes = (await import("../src/server/routes/insights.js")).default;
  const actionsRoutes = (await import("../src/server/routes/actions.js")).default;

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);

  // App com auth stub: o header x-org escolhe a org; o usuário é owner.
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.organizationId = req.headers["x-org"] || A;
    req.user = { userId: "u1", role: "owner" };
    next();
  });
  app.use("/api/insights", insightsRoutes);
  app.use("/api/actions", actionsRoutes);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, url: string, org = A, body?: any) => {
    const res = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json", "x-org": org }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  // Sinais abertos em TRÊS domínios distintos.
  BusinessSignalService.publish(A, {
    domain: "finance", signalType: "receivable_overdue", severity: "risk", basis: "fact", confidence: 1,
    impactAmount: 5000, impactUnit: "BRL", sourceService: "FinanceSignalPublisher", evidence: { count: 3 }, dedupeKey: "fin:recv:1",
  });
  BusinessSignalService.publish(A, {
    domain: "production", signalType: "production_order_late", severity: "risk", basis: "fact", confidence: 1,
    impactAmount: 20, impactUnit: "units", sourceService: "ProductionSignalPublisher", evidence: { orders: 4 }, dedupeKey: "prod:late:1",
  });
  const retailSig = BusinessSignalService.publish(A, {
    domain: "retail_ops", signalType: "retail_seller_concentration", severity: "attention", basis: "fact", confidence: 1,
    impactAmount: null, impactUnit: null, sourceService: "RetailOpsSignalPublisher", evidence: { seller: "Ana", pct: 90 }, dedupeKey: "retail:seller:1",
  });

  // ===== GET / — panorama consolidado, todos os domínios =====
  const overview = await call("GET", "/api/insights");
  check("GET / responde 200", overview.status === 200, String(overview.status));
  const domains = new Set((overview.json.priorities || []).map((p: any) => p.domain));
  check("Pareto abrange finance+production+retail_ops", domains.has("finance") && domains.has("production") && domains.has("retail_ops"), JSON.stringify([...domains]));
  check("byDomain conta os 3 domínios", (overview.json.byDomain?.finance || 0) === 1 && (overview.json.byDomain?.production || 0) === 1 && (overview.json.byDomain?.retail_ops || 0) === 1, JSON.stringify(overview.json.byDomain));
  check("bySeverity conta 2 risk + 1 attention", overview.json.bySeverity?.risk === 2 && overview.json.bySeverity?.attention === 1, JSON.stringify(overview.json.bySeverity));

  // ===== POST /act — age num sinal NÃO-financeiro (produção) e no de varejo =====
  // (antes do /refresh: o publicador de varejo auto-resolve sinais sem lastro na
  //  operação real — aqui os sinais são inseridos à mão só para o contrato.)
  const prodSig = db.prepare("SELECT id FROM business_signals WHERE organization_id=? AND domain='production' AND status='open'").get(A) as any;
  const acted = await call("POST", "/api/insights/act", A, { signalId: prodSig.id });
  check("POST /act cria ação (201)", acted.status === 201 && acted.json.ok === true, JSON.stringify(acted.json).slice(0, 160));
  check("ação herda o domínio do sinal (production)", acted.json.action?.domain === "production", acted.json.action?.domain);

  // Age também no sinal de varejo (prova que qualquer domínio é acionável).
  const actedRetail = await call("POST", "/api/insights/act", A, { signalId: retailSig.id });
  check("POST /act no varejo também cria ação", actedRetail.status === 201 && actedRetail.json.action?.domain === "retail_ops");

  // ===== GET /actions — painel lista ações de QUALQUER domínio =====
  const panel = await call("GET", "/api/insights/actions");
  const panelDomains = new Set((panel.json.actions || []).map((a: any) => a.domain));
  check("painel lista ações de produção E varejo", panelDomains.has("production") && panelDomains.has("retail_ops"), JSON.stringify([...panelDomains]));
  check("painel traz a severidade do sinal de origem", (panel.json.actions || []).every((a: any) => !!a.signal_severity), JSON.stringify(panel.json.actions?.map((a: any) => a.signal_severity)));

  // ===== POST /refresh — roda todos os publicadores, sem quebrar =====
  const refresh = await call("POST", "/api/insights/refresh", A, {});
  check("POST /refresh responde 200", refresh.status === 200, String(refresh.status));
  check("refresh reporta os 3 publicadores", !!refresh.json.ran?.finance && !!refresh.json.ran?.production && !!refresh.json.ran?.retail, JSON.stringify(refresh.json.ran));

  // ===== Ciclo de vida reusa /api/actions: aprovar → concluir → medir =====
  const actId = acted.json.action.id;
  const st0 = acted.json.action.status;
  if (st0 === "awaiting_approval") {
    const ap = await call("POST", `/api/actions/${actId}/approve`, A, {});
    check("aprovar via /api/actions", ap.status === 200 && ap.json.status === "approved", JSON.stringify(ap.json).slice(0, 120));
  } else check("ação já nasce aprovada (política none)", st0 === "approved");
  const done = await call("POST", `/api/actions/${actId}/complete`, A, { resultAmount: 15 });
  check("concluir mede o resultado", done.status === 200 && done.json.status === "done", JSON.stringify(done.json).slice(0, 120));

  // ===== Isolamento =====
  const bOverview = await call("GET", "/api/insights", B);
  check("isolamento: org B sem prioridades", (bOverview.json.priorities || []).length === 0);
  const bPanel = await call("GET", "/api/insights/actions", B);
  check("isolamento: org B sem ações no painel", (bPanel.json.actions || []).length === 0);
  const bAct = await call("POST", "/api/insights/act", B, { signalId: prodSig.id });
  check("isolamento: org B não age em sinal da org A (404)", bAct.status === 404, String(bAct.status));

  await new Promise<void>((r) => server.close(() => r()));
  console.log("\n=== Insights globais (kernel, todos os domínios) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
