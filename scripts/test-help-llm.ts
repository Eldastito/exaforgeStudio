/**
 * TEST — Camada LLM GROUNDED do Tutor de Ajuda (ADR-179 F7). DB-backed, det.
 * A LLM é INJETADA (stub) — roda em CI sem chave. Prova (RN-HELP-1/2/8):
 *   - SEM IA → answerAsync é idêntico ao determinístico (0-regressão) e os efeitos
 *     (lacuna + métrica) acontecem UMA vez (deferSideEffects funciona);
 *   - COM IA, artigo achado → resposta é REESCRITA (natural) e mantém a citação;
 *   - COM IA, palavra falha mas há artigo certo → rerank semântico ACHA e responde
 *     grounded, SEM registrar lacuna ("cadastrar vendedores" → artigo de vendedores);
 *   - grounded: semanticPick só devolve id da lista (id inventado → ignora);
 *   - NAO_COBERTO / NENHUM → admite e registra a lacuna (não inventa);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:help-llm
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-help-llm-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-help-llm-123456";
delete process.env.OPENAI_API_KEY; // garante SEM IA real (o stub é injetado)

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { HelpKnowledgeService: KB } = await import("../src/server/HelpKnowledgeService.js");
  const { ZeroTrainingHelpService: HELP } = await import("../src/server/ZeroTrainingHelpService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status) VALUES (?, ?, 'A', 'active', 'moda', 'autonomo', 'active')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status) VALUES (?, ?, 'B', 'active', 'moda', 'autonomo', 'active')`).run(randomUUID(), B);
  PermissionService.seedSystemProfiles(A); PermissionService.seedSystemProfiles(B);
  const owner = { userId: "u1", email: "a@x.com", role: "owner", organizationId: A };

  // Artigo curado "cadastrar vendedores" (o exemplo do dono). Palavras propositalmente
  // SEM "cadastrar/vendedor" pra provar que só o rerank semântico o encontra.
  const sellersId = "help_test_sellers";
  db.prepare(`INSERT INTO help_articles (id, vertical, module_key, title, what, purpose, steps_json, common_errors_json, keywords, reviewed_by, status) VALUES (?, NULL, 'equipe', 'Registrar a equipe de loja', 'Onde a loja gerencia quem atende.', 'Manter a lista da equipe atualizada.', ?, '[]', 'equipe loja gerenciar atende', 'Curador', 'published')`)
    .run(sellersId, JSON.stringify(["Abra Configurações da loja", "Vá em Equipe", "Toque em Adicionar e preencha os dados"]));

  // Stub de LLM injetável: se o prompt lista "Artigos:" → é o rerank (retorna JSON id);
  // senão é o groundedAnswer (retorna texto natural). Um flag controla o cenário.
  let mode: "answer" | "sellers" | "nao_coberto" | "bogus_id" = "answer";
  const chatStub = async (prompt: string): Promise<string> => {
    if (/Artigos:/.test(prompt)) { // rerank semântico
      if (mode === "sellers") return JSON.stringify({ id: sellersId });
      if (mode === "bogus_id") return JSON.stringify({ id: "id-que-nao-existe" });
      return JSON.stringify({ id: null }); // NENHUM
    }
    // groundedAnswer — simula a IA julgando relevância:
    if (mode === "nao_coberto") return "NAO_COBERTO";
    // no cenário "sellers", o artigo do keyword (Atendimento) NÃO responde; só o de equipe responde.
    if (mode === "sellers") return /Registrar a equipe/.test(prompt) ? "Vá em Configurações da loja > Equipe." : "NAO_COBERTO";
    return "Resposta reescrita pela IA, direto ao ponto.";
  };
  const deps = { chatFn: chatStub, aiConfigured: true };

  // ═══════════════ 1. SEM IA → idêntico ao determinístico + efeitos 1x ═══════════════
  const noAi = await HELP.answerAsync(A, owner, { text: "como faço a reposição de estoque?", moduleKey: "compras" });
  check("1.1 sem IA: acha artigo pelo determinístico", noAi.found !== false && !!noAi.article);
  check("1.2 sem IA: llmUsed=false", noAi.llmUsed === false);
  const asks1 = (db.prepare(`SELECT COALESCE(SUM(asks),0) s, COALESCE(SUM(answered),0) a FROM help_ask_stats WHERE organization_id=?`).get(A) as any);
  check("1.3 métrica registrada UMA vez (asks=1, answered=1)", asks1.s === 1 && asks1.a === 1);
  const noAiMiss = await HELP.answerAsync(A, owner, { text: "como configuro xpto zzz obscuro?" });
  check("1.4 sem IA + sem cobertura → lacuna registrada 1x", noAiMiss.gapLogged === true && (db.prepare(`SELECT COUNT(*) c FROM help_gap_log WHERE organization_id=?`).get(A) as any).c === 1);

  // ═══════════════ 2. COM IA: artigo achado → resposta REESCRITA + citação ═══════════════
  mode = "answer";
  const rew = await HELP.answerAsync(A, owner, { text: "como faço a reposição de estoque?", moduleKey: "compras" }, deps);
  check("2.1 IA reescreve a resposta (llmUsed)", rew.llmUsed === true);
  check("2.2 resposta natural da IA + mantém citação", /Resposta reescrita pela IA/.test(rew.message) && /fonte:/i.test(rew.message));

  // ═══════════════ 3. COM IA: rerank semântico acha o artigo que a palavra não achou ═══════════════
  mode = "sellers";
  const gapsBefore = (db.prepare(`SELECT COUNT(*) c FROM help_gap_log WHERE organization_id=?`).get(A) as any).c;
  const sell = await HELP.answerAsync(A, owner, { text: "onde eu cadastro meus vendedores?", moduleKey: null }, deps);
  check("3.1 rerank ACHA o artigo certo (que o keyword perdeu)", !!sell.article && sell.article.id === sellersId);
  check("3.2 responde grounded + llmUsed, SEM lacuna", sell.llmUsed === true && sell.gapLogged === false && sell.noCoverage === false);
  const gapsAfter = (db.prepare(`SELECT COUNT(*) c FROM help_gap_log WHERE organization_id=?`).get(A) as any).c;
  check("3.3 não registra lacuna quando a IA resolve", gapsAfter === gapsBefore);

  // ═══════════════ 4. grounded: id inventado é ignorado (RN-HELP-1) ═══════════════
  mode = "bogus_id";
  const bogus = await KB.semanticPick(A, "qualquer pergunta", null, deps);
  check("4.1 semanticPick ignora id fora da lista (não inventa)", bogus === null);

  // ═══════════════ 5. NAO_COBERTO / NENHUM → admite lacuna ═══════════════
  mode = "answer"; // rerank devolve {id:null} = NENHUM
  const none = await HELP.answerAsync(A, owner, { text: "como faço nota fiscal modelo 55 xyz?", moduleKey: null }, deps);
  check("5.1 rerank NENHUM → sem artigo + lacuna registrada", !none.article && none.gapLogged === true);
  mode = "nao_coberto"; // artigo do keyword existe, mas a IA julga que NÃO responde + rerank não acha
  const nc = await HELP.answerAsync(A, owner, { text: "como faço a reposição de estoque?", moduleKey: "compras" }, deps);
  check("5.2 keyword achou artigo, mas IA julga irrelevante → lacuna honesta (não força resposta errada)", !nc.article && nc.gapLogged === true && nc.noCoverage === true);

  // ═══════════════ 6. isolamento multi-tenant ═══════════════
  const mB = (db.prepare(`SELECT COALESCE(SUM(asks),0) s FROM help_ask_stats WHERE organization_id=?`).get(B) as any);
  check("6.1 métricas de A não vazam p/ B", mB.s === 0);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} help-llm: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
