// ADR-154 F10.2 — UI master admin da prontidão de produção.
//
// A view (ProductionReadinessView) é PURA LEITURA sobre o endpoint da F10.1.
// Este teste guarda duas coisas:
//   1. O contrato que a view consome (report do ProductionReadinessService):
//      shape estável, rollup coerente, e a HONESTIDADE embutida (email off,
//      push on) — porque a tela renderiza literalmente isso.
//   2. O wiring estático da view no shell master-admin (store/App/Sidebar) e
//      que a tela fica atrás do gate isMasterAdmin (não vaza pro operador comum).
//
// Sem DB, sem rede, sem jsdom — manipula process.env e lê arquivos do repo.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProductionReadinessService } from "../src/server/ProductionReadinessService.js";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}`);
  if (!ok) failures++;
}

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

// ---------------------------------------------------------------------------
// 1. Contrato que a view renderiza (report do serviço da F10.1).
// ---------------------------------------------------------------------------
const tmpBackups = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-ui-"));
const ENV_KEYS = [
  "OPENAI_API_KEY", "JWT_SECRET", "APP_URL", "ASAAS_API_KEY",
  "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER",
  "EVOLUTION_API_KEY", "EVOLUTION_BASE_URL", "BACKUPS_DIR",
];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
function reset() { for (const k of ENV_KEYS) delete process.env[k]; process.env.BACKUPS_DIR = tmpBackups; }

// Cenário "degraded" (blocker ok, faltam recomendados) — é o mais rico pra UI:
// tem os três níveis com estados mistos que a tela precisa saber pintar.
reset();
process.env.OPENAI_API_KEY = "sk-test";
const r = ProductionReadinessService.report();

// Shape que os componentes desestruturam.
check("report tem status string", typeof r.status === "string");
check("report.status é degraded no cenário", r.status === "degraded");
check("report tem generatedAt parseável (Date válida)", !Number.isNaN(new Date(r.generatedAt).getTime()));
check("report.summary tem os 4 contadores numéricos",
  typeof r.summary.blockersFailing === "number" &&
  typeof r.summary.recommendedFailing === "number" &&
  typeof r.summary.optionalConfigured === "number" &&
  typeof r.summary.optionalTotal === "number");
check("todo check tem key/label/level/ok/detail",
  r.checks.every((c: any) => c.key && c.label && c.level && typeof c.ok === "boolean" && typeof c.detail === "string"));

// A view agrupa por estes 3 níveis — nenhum check pode escapar deles (senão some da tela).
const LEVELS = new Set(["blocker", "recommended", "optional"]);
check("todo check cai num dos 3 níveis da UI", r.checks.every((c: any) => LEVELS.has(c.level)));
check("há pelo menos 1 check de cada nível", ["blocker", "recommended", "optional"].every(
  (lvl) => r.checks.some((c: any) => c.level === lvl)));

// Honestidade que a tela expõe literalmente (não maquiar).
const email = r.checks.find((c: any) => c.key === "email");
const push = r.checks.find((c: any) => c.key === "push");
check("email aparece como NÃO configurado (transporte é TODO)", email && email.ok === false && !!email.hint);
check("push aparece como configurado (VAPID auto, sem env)", push && push.ok === true);

// Sem segredo no payload — a tela mostra env NAME, nunca valor.
check("nenhum segredo vaza no payload da view", !JSON.stringify(r).includes("sk-test"));
check("checks com hint expõem só nomes de env (sem '=')",
  r.checks.filter((c: any) => c.hint).every((c: any) => !/=\s*\S/.test(c.hint)));

// Rollup blocked coerente (a UI pinta o banner vermelho e some com o botão "subir").
reset();
const rBlocked = ProductionReadinessService.report();
check("sem OpenAI → status blocked (banner vermelho)", rBlocked.status === "blocked");
check("blocked expõe blockersFailing >= 1 pro tile", rBlocked.summary.blockersFailing >= 1);

for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
try { fs.rmSync(tmpBackups, { recursive: true, force: true }); } catch { /* noop */ }

// ---------------------------------------------------------------------------
// 2. Wiring estático da view no shell.
// ---------------------------------------------------------------------------
const view = read("src/features/ProductionReadinessView.tsx");
check("view consome GET /api/admin/production-readiness",
  view.includes("/api/admin/production-readiness"));
check("view exporta ProductionReadinessView", /export function ProductionReadinessView/.test(view));
check("view cobre os 3 rollups (ready/degraded/blocked)",
  view.includes("ready") && view.includes("degraded") && view.includes("blocked"));
check("view renderiza os 3 níveis (blocker/recommended/optional)",
  view.includes("blocker") && view.includes("recommended") && view.includes("optional"));
check("view mostra a dica de env (hint) sem inventar valor", view.includes(".hint") || view.includes("check.hint"));

const store = read("src/store/useStore.ts");
check("ViewMode inclui 'production_readiness'", store.includes("'production_readiness'"));

const app = read("src/App.tsx");
check("App importa ProductionReadinessView", app.includes("ProductionReadinessView"));
check("App renderiza a view no viewMode certo",
  /viewMode === 'production_readiness'[\s\S]{0,80}ProductionReadinessView/.test(app));
check("App tem título de navbar pra production_readiness",
  /viewMode === 'production_readiness'[\s\S]{0,80}Prontidão de Produção/.test(app));

const sidebar = read("src/features/Sidebar.tsx");
// O NavItem tem que estar DENTRO de um bloco isMasterAdmin — a tela é master-only
// (o backend reforça via requireMasterAdmin, mas o menu não pode nem aparecer).
check("Sidebar tem NavItem pra production_readiness",
  sidebar.includes("production_readiness") && sidebar.includes("Prontidão de Produção"));
const navIdx = sidebar.indexOf("production_readiness");
const gateIdx = sidebar.lastIndexOf("isMasterAdmin", navIdx);
const between = gateIdx >= 0 ? sidebar.slice(gateIdx, navIdx) : "";
check("NavItem de prontidão está atrás do gate isMasterAdmin",
  gateIdx >= 0 && !between.includes("</nav>") && between.includes("&&"));

// A rota que a view consome está sob o gate master-admin no server.
const admin = read("src/server/routes/admin.ts");
check("rota /production-readiness existe (consumida pela view)",
  admin.includes("/production-readiness") && admin.includes("ProductionReadinessService.report"));

console.log(failures === 0 ? "\nOK — 100% PASS" : `\nFALHOU — ${failures} checagem(ns)`);
process.exit(failures === 0 ? 0 : 1);
