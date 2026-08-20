/**
 * TEST — Hardening / production-readiness do Tutor de Ajuda (ADR-179 F6).
 * Doc-of-record executável de dupla função:
 *   (A) CODIFICA os guardrails RN-HELP-1..8 como REGRESSÃO tocando os serviços
 *       REAIS (F1–F4);
 *   (B) verifica a FIAÇÃO de produção (serviços importáveis, rotas montadas,
 *       testes wired no package.json, runbook presente).
 *
 * FECHA o ADR-179. Uso: npm run test:help-hardening
 */
import os from "os"; import path from "path"; import fs from "fs"; import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-help-hard-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-help-hard-123456";
// Garante caminho DETERMINÍSTICO (sem chave de IA) — RN-HELP-8.
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
  const { HelpKnowledgeService: KB } = await import("../src/server/HelpKnowledgeService.js");
  const { ZeroTrainingHelpService: HELP } = await import("../src/server/ZeroTrainingHelpService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status) VALUES (?, ?, 'A', 'active', 'varejo', 'autonomo', 'active')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status) VALUES (?, ?, 'B', 'active', 'saude', 'autonomo', 'active')`).run(randomUUID(), B);

  // ═══════════ (B) fiação: serviços importáveis + rotas montadas ═══════════
  check("B1 HelpKnowledgeService importável", typeof KB?.answer === "function" && typeof KB?.retrieve === "function");
  const uxRouter = (await import("../src/server/routes/ux.js")).default as any;
  const uxPaths = routePaths(uxRouter);
  check("B2 rota POST /help montada", uxPaths.includes("/help"));
  check("B3 rotas F3 montadas (/help/suggestions, /help/feedback)", uxPaths.includes("/help/suggestions") && uxPaths.includes("/help/feedback"));
  check("B4 rotas F4 montadas (/help/gaps, /help/metrics)", uxPaths.includes("/help/gaps") && uxPaths.includes("/help/metrics"));
  check("B4b rotas F5 montadas (/help/tour, /help/learn-one)", uxPaths.includes("/help/tour") && uxPaths.includes("/help/learn-one"));
  check("B4c digest de treinamento é passe do Scheduler", typeof (KB as any).passLearningDigest === "function");
  check("B4d camada LLM (F7) exposta: answerAsync + aiAvailable", typeof (HELP as any).answerAsync === "function" && typeof (KB as any).aiAvailable === "function");
  // RN-HELP-8: SEM IA, answerAsync mantém o determinístico — sem cobertura ainda registra a lacuna.
  const gapsBefore = Number((db.prepare(`SELECT COUNT(*) c FROM help_gap_log WHERE organization_id=?`).get(A) as any).c);
  const noAi = await (HELP as any).answerAsync(A, { userId: "u", role: "owner", organizationId: A }, { text: "pergunta sem cobertura zzz obscura qqq" });
  const gapsAfter = Number((db.prepare(`SELECT COUNT(*) c FROM help_gap_log WHERE organization_id=?`).get(A) as any).c);
  check("RN-HELP-8 sem IA: answerAsync = determinístico (lacuna registrada, sem inventar)", noAi.llmUsed === false && noAi.article === null && gapsAfter === gapsBefore + 1);
  const adminRouter = (await import("../src/server/routes/admin.js")).default as any;
  const adminPaths = routePaths(adminRouter);
  check("B5 rotas de curadoria montadas (/help-articles + bootstrap + publish + archive)",
    adminPaths.includes("/help-articles") && adminPaths.includes("/help-articles/bootstrap") && adminPaths.includes("/help-articles/:id/publish") && adminPaths.includes("/help-articles/:id/archive"));
  check("B6 rotas globais master montadas (/help-gaps, /help-metrics)", adminPaths.includes("/help-gaps") && adminPaths.includes("/help-metrics"));

  // ═══════════ RN-HELP-3: curadoria humana obrigatória ═══════════
  const d = KB.upsert({ moduleKey: "agenda", title: "Rascunho X", what: "abc", keywords: "quiron nebula agenda" }, "m1");
  check("RN-HELP-3a rascunho NÃO é recuperável", KB.retrieve(A, "quiron nebula agenda") === null);
  let pubThrew = false; try { KB.publish(d.id, "  ", "m1"); } catch { pubThrew = true; }
  check("RN-HELP-3b publish exige reviewedBy", pubThrew);
  KB.publish(d.id, "Curador", "m1");
  check("RN-HELP-3c publicado passa a ser recuperável", KB.retrieve(A, "quiron nebula agenda")?.id === d.id);

  // ═══════════ RN-HELP-8 + RN-HELP-5: determinístico; bootstrap = rascunho ═══════════
  const boot = await KB.bootstrap({ moduleKey: "vendas" }, "m1");
  check("RN-HELP-8 bootstrap determinístico sem IA", boot.via === "deterministic");
  check("RN-HELP-5 bootstrap gera RASCUNHO (não publica)", KB.getById(boot.id)?.status === "draft");

  // ═══════════ RN-HELP-1 + RN-HELP-2: grounded/citação; sem cobertura→lacuna ═══════════
  const cov = KB.answer(A, "como uso a agenda quiron?");
  check("RN-HELP-2 resposta coberta cita a fonte", cov.found === true && /fonte:/i.test(cov.message || ""));
  const miss = KB.answer(A, "como configuro integracao xpto zzz obscura?");
  check("RN-HELP-1a sem cobertura → não inventa (found=false)", miss.found === false && miss.message === null);
  const gapRow = db.prepare(`SELECT COUNT(*) c FROM help_gap_log WHERE organization_id=?`).get(A) as any;
  check("RN-HELP-1b lacuna registrada", gapRow.c >= 1);

  // ═══════════ RN-HELP-6: minimização/LGPD — sem PII na fila ═══════════
  KB.logGap(A, "meu telefone é 11999998888 e email joao@teste.com qual o passo", null);
  const leaked = db.prepare(`SELECT COUNT(*) c FROM help_gap_log WHERE organization_id=? AND (query_norm LIKE '%11999998888%' OR query_norm LIKE '%@%')`).get(A) as any;
  check("RN-HELP-6a telefone/email não persistem na lacuna", leaked.c === 0);
  const askCols = db.prepare(`PRAGMA table_info(help_ask_stats)`).all() as any[];
  check("RN-HELP-6b help_ask_stats não guarda texto de pergunta", !askCols.some((c) => /query|text|pergunta/i.test(c.name)));
  const fbCols = db.prepare(`PRAGMA table_info(help_feedback)`).all() as any[];
  check("RN-HELP-6c help_feedback não guarda texto", !fbCols.some((c) => /query|text|pergunta/i.test(c.name)));

  // ═══════════ RN-HELP-7: recorte por vertical ═══════════
  check("RN-HELP-7a artigo de saúde não vaza p/ varejo", KB.retrieve(A, "alta paciente pin clinica") === null);
  check("RN-HELP-7b artigo de saúde recuperável na saúde", KB.retrieve(B, "alta paciente pin clinica")?.id === "help_seed_clinica");

  // ═══════════ null≠0 (RN-004) ═══════════
  const mEmpty = KB.metrics(B);
  check("null≠0: answerRatePct null sem asks", mEmpty.answerRatePct === null);
  check("null≠0: helpfulRatePct null sem votos", mEmpty.helpfulRatePct === null);

  // ═══════════ isolamento multi-tenant ═══════════
  HELP.answer(A, { userId: "u", role: "owner", organizationId: A } as any, { text: "asdf qwer zxcv nada" });
  const mA = KB.metrics(A); const mB2 = KB.metrics(B);
  check("isolamento: métricas de A não vazam p/ B", mB2.totalAsks === 0 && mA.totalAsks >= 1);

  // ═══════════ (B) testes wired + runbook presente ═══════════
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const scripts = pkg.scripts || {};
  for (const t of ["test:help-knowledge", "test:help-curation", "test:help-gaps", "test:help-context", "test:help-training", "test:help-llm", "test:help-hardening"]) {
    check(`wired: ${t} no package.json`, typeof scripts[t] === "string");
  }
  check("runbook presente (docs/runbook/ajuda-operacao.md)", fs.existsSync(path.join(repoRoot, "docs/runbook/ajuda-operacao.md")));

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} help-hardening: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
