/**
 * TESTE — F6 do Diretor IA com ferramentas: HARDENING (fecha o plano
 * docs/prd/PLANO-DIRETOR-IA-FERRAMENTAS.md).
 * -----------------------------------------------------------------------------
 * Doc-of-record executável de dupla função:
 *  (A) codifica os guardrails RN-DIR como REGRESSÃO sobre os serviços reais:
 *      RN-DIR-1 modelo nunca gera SQL (só escolhe do cardápio; args validados);
 *      RN-DIR-2 org da sessão / cross-tenant isolado;
 *      RN-DIR-3 dinheiro §73 gated no cardápio E na execução;
 *      RN-DIR-4 sem dado → admite (pending/futuro nunca vira venda);
 *      RN-DIR-5 determinístico antes de LLM;
 *      RN-DIR-6 resposta cita só o resultado da ferramenta (prompt sob teto);
 *      RN-DIR-7 sem ferramenta → null (panorama), 0-regressão.
 *  (B) verifica a FIAÇÃO de produção: serviços importáveis, os 4 pontos de
 *      entrada usam o roteador, rota /diretor-tools/gaps montada, testes wired.
 *
 * Uso: npm run test:diretor-tools-hardening
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-dirhard-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-dirhard-1234567890";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ExecutiveQueryToolsService: T } = await import("../src/server/ExecutiveQueryToolsService.js");
  const { ExecutiveQueryRouterService: R } = await import("../src/server/ExecutiveQueryRouterService.js");

  const root = process.cwd();
  const tz = process.env.TZ_DISPLAY || "America/Sao_Paulo";
  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const ontem = new Date(Date.parse(hoje + "T12:00:00Z") - 86400000).toISOString().slice(0, 10);
  const futuro = new Date(Date.parse(hoje + "T12:00:00Z") + 5 * 86400000).toISOString().slice(0, 10);

  const mkOrg = (tag: string) => {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), orgId, `Rede ${tag}`);
    return orgId;
  };
  const A = mkOrg("A");
  const st = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active) VALUES (?, ?, 'Av. brasil', 1)`).run(st, A);
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, quota_amount) VALUES (?, ?, ?, ?, 'received', 5000, 4000)`).run(randomUUID(), A, st, ontem);
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, quota_amount) VALUES (?, ?, ?, ?, 'pending', 0, 4000)`).run(randomUUID(), A, st, futuro);

  // ── RN-DIR-1: o modelo só escolhe do cardápio; args não viram SQL. ──
  // llmSelect que devolve tool fora do cardápio ou payload malicioso → descartado.
  R.llmFn = async () => JSON.stringify({ tool: "'; DROP TABLE channels; --", args: { x: 1 } });
  check("RN-DIR-1 tool fora do cardápio (mesmo com cara de SQL) é descartada", (await R.answer(A, "xpto qualquer coisa aleatoria", { canSeeMoney: true })) === null);
  const chExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='channels'`).get();
  check("RN-DIR-1 nenhuma tabela foi tocada (channels segue existindo)", !!chExists);
  const src = fs.readFileSync(path.join(root, "src/server/ExecutiveQueryToolsService.ts"), "utf8");
  check("RN-DIR-1 ferramentas usam db.prepare (código), não montam SQL do texto", src.includes("db.prepare(") && !/db\.prepare\([^)]*\$\{/.test(src));

  // ── RN-DIR-5: determinístico antes de LLM DE SELEÇÃO. ──
  // (o fraseio final pode chamar o LLM — o que não pode é a SELEÇÃO json:true.)
  let selectCalled = false;
  R.llmFn = async (_p: string, opts: any = {}) => { if (opts.json) selectCalled = true; throw new Error("fraseio off"); };
  const det = await R.answer(A, "vendas de ontem da av brasil", { canSeeMoney: true });
  check("RN-DIR-5 pergunta clara resolve SEM chamar o LLM de seleção", !selectCalled && !!det?.includes("R$ 5000.00"), det?.slice(0, 60) || "");

  // ── RN-DIR-4: pending/futuro nunca vira venda; sem dado → admite. ──
  check("RN-DIR-4 futuro/pending fora do total (só ontem conta)", !!T.run(A, "vendas_por_loja", { period: "hoje" }, { canSeeMoney: true }).summary?.includes("Nenhum fechamento") );
  check("RN-DIR-4 dia com fechamento real traz o número", !!T.run(A, "vendas_por_loja", { period: "ontem" }, { canSeeMoney: true }).summary?.includes("R$ 5000.00"));

  // ── RN-DIR-3: §73 no cardápio E no run. ──
  const restrito = T.list({ canSeeMoney: false }).map((t: any) => t.name);
  check("RN-DIR-3 nenhuma ferramenta money no cardápio restrito", !T.list({ canSeeMoney: false }).some((t: any) => t.money), restrito.join(","));
  check("RN-DIR-3 run barra ferramenta money sem permissão", T.run(A, "caixa_resumo", {}, { canSeeMoney: false }).error === "forbidden_money");

  // ── RN-DIR-2: cross-tenant. ──
  const B = mkOrg("B");
  check("RN-DIR-2 org B não vê venda de A", !T.run(B, "vendas_por_loja", { period: "ontem" }, { canSeeMoney: true }).summary?.includes("5000"));

  // ── RN-DIR-6: prompt de seleção sob teto (pergunta truncada em 300). ──
  R.llmFn = async (prompt: string) => { (globalThis as any).__lastPrompt = prompt; return JSON.stringify({ tool: null, args: {} }); };
  await R.answer(A, "z".repeat(5000), { canSeeMoney: true });
  const lp = String((globalThis as any).__lastPrompt || "");
  check("RN-DIR-6 pergunta é truncada no prompt de seleção (<= ~600 chars da parte da pergunta)", lp.length > 0 && !lp.includes("z".repeat(400)), `len=${lp.length}`);

  // ── RN-DIR-7 + fiação: 4 pontos de entrada usam o roteador. ──
  const ask = fs.readFileSync(path.join(root, "src/server/ExecutiveAdvisorService.ts"), "utf8");
  const orc = fs.readFileSync(path.join(root, "src/server/AIOrchestratorService.ts"), "utf8");
  const rota = fs.readFileSync(path.join(root, "src/server/routes/decisionIntelligence.ts"), "utf8");
  check("fiação: ask() usa ExecutiveQueryRouterService (F2)", ask.includes("ExecutiveQueryRouterService"));
  check("fiação: orquestrador Zapp usa o roteador (F3)", orc.includes("ExecutiveQueryRouterService"));
  check("fiação: rota /diretor-tools/gaps montada (F5)", rota.includes("/diretor-tools/gaps") && rota.includes("requireRole"));

  // ── Fiação: serviços importáveis + testes wired no package.json. ──
  check("fiação: ExecutiveQueryToolsService importável", typeof T.run === "function" && typeof T.list === "function");
  check("fiação: ExecutiveQueryRouterService importável", typeof R.answer === "function" && typeof R.gaps === "function");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  for (const s of ["test:diretor-tools", "test:diretor-router", "test:diretor-entrypoints", "test:diretor-tools-finance", "test:diretor-tools-gaps", "test:diretor-tools-hardening"]) {
    check(`fiação: ${s} wired no package.json`, !!pkg.scripts?.[s]);
  }

  console.log("\n=== TEST: F6 — hardening RN-DIR + fiação de produção ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
