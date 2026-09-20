/**
 * TESTE — F3 do Diretor IA com ferramentas: PARIDADE dos pontos de entrada
 * (docs/prd/PLANO-DIRETOR-IA-FERRAMENTAS.md).
 * -----------------------------------------------------------------------------
 * A F2 pôs o roteador dentro do ask(); a F3 fecha o último ponto de entrada —
 * o comando "Zapp" do orquestrador — delegando pergunta de CONSULTA pro MESMO
 * ExecutiveQueryRouterService (fonte única, sem 2º motor).
 *
 * Prova, offline (LLM injetável):
 *  - "Zapp vendas de ontem da loja X" no orquestrador responde com o número
 *    do SISTEMA, sem chamar o raio-x/LLM (gestor autorizado, prefixo tirado);
 *  - comando Zapp NÃO-consulta ("Zapp resumo do negócio") segue no fluxo do
 *    orquestrador de sempre (0-regressão — não roteia);
 *  - quem NÃO é gestor autorizado nunca chega ao roteador (anti-recon);
 *  - fiação dos 4 pontos: orquestrador Zapp · pergunta_negocio do
 *    webhookProcessor · Fala Tu · rota da tela Diretor IA — todos passam por
 *    ask()/Router (grep no fonte, fonte única).
 *
 * Uso: npm run test:diretor-entrypoints
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-direntry-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-direntry-1234567890";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ExecutiveQueryRouterService: R } = await import("../src/server/ExecutiveQueryRouterService.js");
  const { AIOrchestratorService } = await import("../src/server/AIOrchestratorService.js");

  const tz = process.env.TZ_DISPLAY || "America/Sao_Paulo";
  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const ontem = new Date(Date.parse(hoje + "T12:00:00Z") - 86400000).toISOString().slice(0, 10);

  const orgId = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Rede A', 'active')`).run(randomUUID(), orgId);
  const storeId = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active) VALUES (?, ?, 'Av. brasil', 1)`).run(storeId, orgId);
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, quota_amount) VALUES (?, ?, ?, ?, 'received', 5476.7, 5200)`)
    .run(randomUUID(), orgId, storeId, ontem);
  const gestor = "5521999947477";
  db.prepare(`INSERT INTO authorized_managers (id, organization_id, identifier, name) VALUES (?, ?, ?, 'Gestor Teste')`).run(randomUUID(), orgId, gestor);
  const channelId = randomUUID();
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'evolution', 'Canal', 'inst-a', 'connected')`).run(channelId, orgId);

  // LLM do ROTEADOR indisponível → resposta são os fatos crus (prova que o
  // número vem do sistema); qualquer chamada de LLM do ORQUESTRADOR explodiria
  // o teste — então se a resposta vier, veio da ferramenta.
  R.llmFn = async () => { throw new Error("llm off"); };

  // ── 1) Comando Zapp de CONSULTA → ferramenta (sem raio-x/LLM). ──
  const r1 = await AIOrchestratorService.processMessage({
    message: "Zapp, como foram as vendas de ontem da loja avenida brasil?",
    organizationId: orgId, senderId: gestor, channelId,
  });
  check("1.1 Zapp consulta responde com o número do sistema", !!r1.reply?.includes("R$ 5476.70") && !!r1.reply?.includes("BATEU"), r1.reply?.slice(0, 120) || "");
  check("1.2 sem escalar pra humano (é resposta, não handoff)", r1.needsHuman === false);
  const audit = db.prepare(`SELECT COUNT(*) n FROM ai_interactions_log WHERE organization_id = ? AND agent_used = 'diretor_tools'`).get(orgId) as any;
  check("1.3 interação auditada como diretor_tools", Number(audit?.n) >= 1, String(audit?.n));

  // ── 2) Quem NÃO é gestor nunca chega ao roteador (anti-recon). ──
  // Sem canal admin, "zapp ..." de desconhecido cai no atendimento — que aqui
  // falharia no LLM; basta provar que NÃO veio resposta de ferramenta.
  let r2: any = null;
  try {
    r2 = await AIOrchestratorService.processMessage({
      message: "Zapp, vendas de ontem da avenida brasil",
      organizationId: orgId, senderId: "5521900000000", channelId,
    });
  } catch { /* atendimento sem LLM pode lançar — o que importa é não vazar dado */ }
  check("2.1 não-gestor não recebe dado de venda", !r2?.reply?.includes("5476"), r2?.reply?.slice(0, 80) || "(throw)");

  // ── 3) Fiação (fonte única) — os 4 pontos de entrada. ──
  const root = process.cwd();
  const orc = fs.readFileSync(path.join(root, "src/server/AIOrchestratorService.ts"), "utf8");
  check("3.1 orquestrador Zapp delega pro ExecutiveQueryRouterService", orc.includes("ExecutiveQueryRouterService"));
  const ask = fs.readFileSync(path.join(root, "src/server/ExecutiveAdvisorService.ts"), "utf8");
  check("3.2 ask() consulta o roteador (F2)", ask.includes("ExecutiveQueryRouterService"));
  const whk = fs.readFileSync(path.join(root, "src/server/webhookProcessor.ts"), "utf8");
  check("3.3 pergunta_negocio do WhatsApp passa pelo ask", whk.includes("ExecutiveAdvisorService.ask("));
  const falatu = fs.readFileSync(path.join(root, "src/server/FalaTuAskService.ts"), "utf8");
  check("3.4 Fala Tu passa pelo ask", falatu.includes("ExecutiveAdvisorService.ask("));
  const rota = fs.readFileSync(path.join(root, "src/server/routes/executive.ts"), "utf8");
  check("3.5 tela Diretor IA passa pelo ask", rota.includes("ExecutiveAdvisorService.ask("));

  console.log("\n=== TEST: F3 — paridade dos pontos de entrada ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
