/**
 * TEST — Hardening / production-readiness do Sales Coach (ADR-202 F7).
 * Doc-of-record executável de dupla função:
 *   (A) CODIFICA os guardrails RN-SC-1..9 como REGRESSÃO tocando o serviço REAL
 *       (SalesCoachService F1–F6);
 *   (B) verifica a FIAÇÃO de produção (serviço importável, rotas montadas,
 *       testes wired no package.json, runbook presente).
 *
 * FECHA o ADR-202. Uso: npm run test:sales-coach-hardening
 */
import os from "os"; import path from "path"; import fs from "fs"; import { fileURLToPath } from "url";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sc-hard-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-sc-hard-123456";
// Garante caminho DETERMINÍSTICO (sem chave de IA) — RN-SC-4.
delete process.env.OPENAI_API_KEY;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

function routePaths(router: any): string[] {
  const out: string[] = [];
  try { for (const l of router?.stack || []) if (l?.route?.path) out.push(String(l.route.path)); } catch { /* noop */ }
  return out;
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { SalesCoachService: SC } = await import("../src/server/SalesCoachService.js");
  const A = "org-A", B = "org-B", ASOF = "2026-09-12";

  // ═══════════ (B) fiação: serviço importável + rotas montadas ═══════════
  for (const m of ["performanceSnapshot", "gaps", "feedback", "feedbackAsync", "solutionsForSeller", "roleplay", "isEnabled", "listSellers", "sellerForUser", "canView", "bundle"]) {
    check(`B1 SalesCoachService.${m} importável`, typeof (SC as any)[m] === "function");
  }
  const scRouter = (await import("../src/server/routes/salesCoach.js")).default as any;
  const scPaths = routePaths(scRouter);
  check("B2 rotas montadas (/sellers, /me, /seller/:sellerId)", scPaths.includes("/sellers") && scPaths.includes("/me") && scPaths.includes("/seller/:sellerId"));

  // ── setup de dados ──
  db.prepare("INSERT INTO organization_settings (organization_id, sales_coach_enabled) VALUES (?, 1)").run(A);
  db.prepare("INSERT INTO organization_settings (organization_id, sales_coach_enabled) VALUES ('org-off', 0)").run();
  const seller = db.prepare("INSERT INTO retail_sellers (id, organization_id, matricula, name, user_id, active) VALUES (?, ?, ?, ?, ?, ?)");
  const sale = db.prepare("INSERT INTO retail_seller_sales (id, organization_id, sale_date, seller_name, matricula, valor, pecas, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')");
  seller.run("sQueda", A, "M1", "Ana", "uA", 1);   // 4 meses, 3 quedas → declining_trend (regra PeoplePatternMemory)
  seller.run("sEstavel", A, "M2", "Bruno", "uB", 1); // 4 meses, 2 quedas → SEM declining_trend
  seller.run("sSemDado", A, "M3", "Célia", "uC", 1); // sem venda → insufficient_data
  let i = 0;
  for (const [ym, v] of [["2026-05", 1000], ["2026-06", 900], ["2026-07", 800], ["2026-08", 700]] as [string, number][])
    sale.run(`q${i++}`, A, `${ym}-05`, "Ana", "M1", v, 10);
  for (const [ym, v] of [["2026-05", 1000], ["2026-06", 900], ["2026-07", 950], ["2026-08", 800]] as [string, number][])
    sale.run(`e${i++}`, A, `${ym}-05`, "Bruno", "M2", v, 10);

  // ═══════════ RN-SC-1: VENDEDOR ≠ CLIENTE — sem superfície externa ═══════════
  for (const forbidden of ["send", "notify", "publish", "dispatch", "sendToCustomer", "message", "reply"])
    check(`RN-SC-1 sem método de envio externo (${forbidden})`, typeof (SC as any)[forbidden] !== "function");
  const rp = SC.roleplay(A, "sQueda", { asOf: ASOF });
  check("RN-SC-1 roleplay declara que nada é enviado ao cliente", /nada aqui é enviado ao cliente/i.test(rp.disclaimer));

  // ═══════════ RN-SC-2: advisório — severidade qualitativa, nunca nota que pune ═══════════
  const gQ = SC.gaps(A, "sQueda", { asOf: ASOF });
  check("RN-SC-2 gaps carregam severidade qualitativa (high/medium/low)", gQ.gaps.every((g: any) => ["high", "medium", "low"].includes(g.severity)));
  check("RN-SC-2 gap não expõe nota/score numérico punitivo", gQ.gaps.every((g: any) => !("score" in g) && !("nota" in g) && !("grade" in g)));

  // ═══════════ RN-SC-3: grounded / null≠0 — sem dado → honesto ═══════════
  const snapEmpty = SC.performanceSnapshot(A, "sSemDado", { asOf: ASOF });
  check("RN-SC-3 sem venda → hasData=false", snapEmpty.hasData === false);
  check("RN-SC-3 sem venda → avgTicket null (não 0)", snapEmpty.totals.avgTicket === null && snapEmpty.source === null);
  const gEmpty = SC.gaps(A, "sSemDado", { asOf: ASOF });
  check("RN-SC-3 sem base → insufficient_data honesto", gEmpty.hasData === false && gEmpty.gaps.some((g: any) => g.key === "insufficient_data"));

  // ═══════════ RN-SC-4: determinístico antes de LLM ═══════════
  const fb = SC.feedback(A, "sQueda", { asOf: ASOF });
  check("RN-SC-4 feedback() determinístico sem chave de IA", fb.hasData === true && fb.points.length >= 1);
  const fbA = await SC.feedbackAsync(A, "sQueda", { asOf: ASOF });
  check("RN-SC-4 feedbackAsync cai no determinístico sem IA (aiUsed=false)", fbA.aiUsed === false && !!fbA.narrative);

  // ═══════════ RN-SC-8: sem motor paralelo — MESMA regra do PeoplePatternMemory (≥3 quedas) ═══════════
  check("RN-SC-8 queda recorrente detectada (≥3 quedas/4 meses)", gQ.gaps.some((g: any) => g.key === "declining_trend"));
  const gE = SC.gaps(A, "sEstavel", { asOf: ASOF });
  check("RN-SC-8 <3 quedas NÃO vira queda recorrente (não inventa gatilho)", !gE.gaps.some((g: any) => g.key === "declining_trend"));

  // ═══════════ RN-SC-5: conhecimento humano — reusa ManagerSolution, não inventa ═══════════
  const sol = SC.solutionsForSeller(A, "sQueda", { asOf: ASOF });
  check("RN-SC-5 soluções são arrays (reusa ManagerSolutionRetrieval)", Array.isArray(sol.targeted) && Array.isArray(sol.general));
  check("RN-SC-5 sem solução validada → vazio (não inventa 'verdade da IA')", sol.targeted.length === 0 && sol.general.length === 0);

  // ═══════════ RN-SC-6: isolamento multi-tenant ═══════════
  check("RN-SC-6 vendedor de A não existe em B (bundle null)", SC.bundle(B, "sQueda", { asOf: ASOF }) === null);
  check("RN-SC-6 listSellers de B vazio", SC.listSellers(B).length === 0);

  // ═══════════ RN-SC-7: opt-in por flag (default 0) ═══════════
  check("RN-SC-7 flag ON → habilitado", SC.isEnabled(A) === true);
  check("RN-SC-7 flag OFF → desabilitado", SC.isEnabled("org-off") === false);
  check("RN-SC-7 sem settings → desabilitado (0-regressão)", SC.isEnabled("org-sem") === false);

  // ═══════════ RN-SC-9: RBAC/LGPD — gestor vê time; vendedor só a si ═══════════
  check("RN-SC-9 gestor (owner) vê qualquer vendedor", SC.canView(A, { role: "owner" } as any, "sEstavel") === true);
  check("RN-SC-9 vendedor vê a SI", SC.canView(A, { role: "agent", userId: "uA" } as any, "sQueda") === true);
  check("RN-SC-9 vendedor NÃO vê outro vendedor", SC.canView(A, { role: "agent", userId: "uA" } as any, "sEstavel") === false);
  check("RN-SC-9 sem usuário → sem acesso", SC.canView(A, undefined, "sQueda") === false);

  // ═══════════ (B) testes wired + runbook presente ═══════════
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const scripts = pkg.scripts || {};
  for (const t of ["test:sales-coach-snapshot", "test:sales-coach-gaps", "test:sales-coach-feedback", "test:sales-coach-solutions", "test:sales-coach-roleplay", "test:sales-coach-surface", "test:sales-coach-hardening"])
    check(`wired: ${t} no package.json`, typeof scripts[t] === "string");
  check("runbook presente (docs/runbook/sales-coach-operacao.md)", fs.existsSync(path.join(repoRoot, "docs/runbook/sales-coach-operacao.md")));

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} sales-coach-hardening: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
