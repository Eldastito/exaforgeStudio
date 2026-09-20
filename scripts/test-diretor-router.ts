/**
 * TESTE — F2 do Diretor IA com ferramentas: o ROTEADOR
 * (docs/prd/PLANO-DIRETOR-IA-FERRAMENTAS.md).
 * -----------------------------------------------------------------------------
 * Prova, offline (LLM injetável — roda em CI sem chave):
 *  - roteamento DETERMINÍSTICO por palavra-chave: "vendas de ontem da avenida
 *    brasil" resolve ferramenta+loja+período SEM LLM e responde com o número
 *    do sistema (cota → BATEU);
 *  - fechamentos/estoque/metas roteiam pelas próprias palavras;
 *  - pergunta ANALÍTICA ("por que caíram?") NÃO roteia → null (panorama);
 *  - fallback LLM: frase sem palavra-chave → chat(json) mockado escolhe do
 *    cardápio; {"tool":null} → null; ferramenta inventada → null;
 *  - §73: papel sem dinheiro perguntando venda → null (panorama redige) e o
 *    cardápio oferecido ao LLM não contém ferramenta de dinheiro;
 *  - loja ambígua → devolve o clarify da ferramenta;
 *  - LLM de fraseio indisponível → devolve os FATOS crus (nunca trava);
 *  - fiação: ExecutiveAdvisorService.ask consulta o roteador antes do panorama.
 *
 * Uso: npm run test:diretor-router
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-dirrouter-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-dirrouter-1234567890";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ExecutiveQueryRouterService: R } = await import("../src/server/ExecutiveQueryRouterService.js");

  const tz = process.env.TZ_DISPLAY || "America/Sao_Paulo";
  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const ontem = new Date(Date.parse(hoje + "T12:00:00Z") - 86400000).toISOString().slice(0, 10);

  const orgId = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Rede A', 'active')`).run(randomUUID(), orgId);
  const mkStore = (name: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active) VALUES (?, ?, ?, 1)`).run(id, orgId, name);
    return id;
  };
  const avBrasil = mkStore("Av. brasil");
  mkStore("Grande Rio");
  mkStore("Carioca");
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, quota_amount) VALUES (?, ?, ?, ?, 'received', 5476.7, 5200)`)
    .run(randomUUID(), orgId, avBrasil, ontem);

  // LLM mock: registra chamadas; fraseio devolve eco simples; seleção configurável.
  const calls: { prompt: string; opts: any }[] = [];
  let selectReply: string | null = null; // JSON da seleção quando o mock for chamado com json:true
  R.llmFn = async (prompt: string, opts: any = {}) => {
    calls.push({ prompt, opts });
    if (opts.json) { if (selectReply == null) throw new Error("sem seleção configurada"); return selectReply; }
    return "RESPOSTA_FRASEADA: " + prompt.split("FATOS")[1]?.slice(0, 80);
  };

  // ── 1) Determinístico (a pergunta REAL do incidente). ──
  calls.length = 0;
  const a1 = await R.answer(orgId, "como foram as vendas de ontem da loja avenida brasil?");
  check("1.1 roteou sem LLM de seleção (só a chamada de fraseio)", calls.length === 1 && !calls[0].opts?.json, `calls=${calls.length}`);
  check("1.2 resposta traz o fato do sistema (fraseada)", !!a1?.includes("RESPOSTA_FRASEADA"), a1 || "");
  // Fatos crus por baixo: valida a ferramenta certa via detect.
  const d1 = R.detect(orgId, "como foram as vendas de ontem da loja avenida brasil?");
  check("1.3 detect: ferramenta/loja/período certos", d1?.tool === "vendas_por_loja" && d1?.args?.store === "Av. brasil" && d1?.args?.period === "ontem", JSON.stringify(d1));
  const d2 = R.detect(orgId, "quem nao mandou fechamento ontem?");
  check("1.4 detect fechamentos_status", d2?.tool === "fechamentos_status", JSON.stringify(d2));
  const d3 = R.detect(orgId, "tem estoque da camisa ref 123 na carioca?");
  check("1.5 detect estoque com produto e loja", d3?.tool === "estoque_loja" && String(d3?.args?.product).includes("camisa ref 123") && d3?.args?.store === "Carioca", JSON.stringify(d3));
  const d4 = R.detect(orgId, "quanto falta pra meta do mes?");
  check("1.6 detect metas", d4?.tool === "metas_progresso", JSON.stringify(d4));
  check("1.7 pergunta analítica NÃO roteia (é do panorama)", R.detect(orgId, "por que as vendas cairam este mes?") === null);

  // ── 2) Fraseio sem LLM → fatos crus (nunca trava). ──
  const saveFn = R.llmFn;
  R.llmFn = async () => { throw new Error("llm off"); };
  const a2 = await R.answer(orgId, "vendas de ontem da avenida brasil");
  check("2.1 LLM indisponível → devolve os fatos crus com o número", !!a2?.includes("R$ 5476.70") && !!a2?.includes("BATEU"), a2 || "");
  R.llmFn = saveFn;

  // ── 3) Fallback LLM de seleção (frase sem palavra-chave). ──
  calls.length = 0;
  selectReply = JSON.stringify({ tool: "vendas_por_loja", args: { store: "avenida brasil", period: "ontem" } });
  const a3 = await R.answer(orgId, "me passa o resultado da av brasil referente ao dia anterior");
  check("3.1 seleção via chat(json) executou a ferramenta", !!a3 && calls.some((c) => c.opts?.json), a3 || "");
  check("3.2 cardápio no prompt de seleção (nunca ferramenta inventada)", calls[0]?.prompt.includes("vendas_por_loja") && calls[0]?.prompt.includes("FERRAMENTAS"), "");
  selectReply = JSON.stringify({ tool: null, args: {} });
  check("3.3 LLM devolve tool null → null (panorama)", (await R.answer(orgId, "qual a previsão do tempo?")) === null);
  selectReply = JSON.stringify({ tool: "apagar_tudo", args: {} });
  check("3.4 ferramenta fora do cardápio → null (nunca executa inventada)", (await R.answer(orgId, "xyz abc")) === null);
  selectReply = null;

  // ── 4) §73 — papel sem dinheiro. ──
  const a4 = await R.answer(orgId, "vendas de ontem da avenida brasil", { canSeeMoney: false });
  check("4.1 pergunta de venda de papel restrito → null (panorama redige)", a4 === null, a4 || "null");
  calls.length = 0;
  selectReply = JSON.stringify({ tool: null, args: {} });
  await R.answer(orgId, "resultado da av brasil do dia anterior", { canSeeMoney: false });
  const selPrompt = calls.find((c) => c.opts?.json)?.prompt || "";
  check("4.2 cardápio oferecido ao LLM SEM ferramenta de dinheiro", selPrompt.length > 0 && !selPrompt.includes("vendas_por_loja"), selPrompt.slice(0, 80));
  selectReply = null;

  // ── 5) Loja ambígua → clarify. ──
  const a5 = await R.answer(orgId, "vendas de ontem da loja rio");
  check("5.1 ambíguo devolve o clarify (nunca chuta)", !!a5?.includes("Qual"), a5 || "");

  // ── 6) Fiação: ask() consulta o roteador antes do panorama. ──
  const askSrc = fs.readFileSync(path.join(process.cwd(), "src/server/ExecutiveAdvisorService.ts"), "utf8");
  check("6.1 ExecutiveAdvisorService.ask usa o ExecutiveQueryRouterService", askSrc.includes("ExecutiveQueryRouterService"));

  console.log("\n=== TEST: F2 — roteador de ferramentas do Diretor IA ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
