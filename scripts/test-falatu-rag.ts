/**
 * TEST — ADR-154 Fatia 5.2: RAG on-read — busca top-K + injeção de memória
 * no prompt de interpret() (feature flag falatu_rag_enabled).
 *
 * Prova os invariantes duros da fatia:
 *
 * 1. `cosine()`: dot-product/norma correto; retorna 0 pra dim divergente ou
 *    vetor zero (evita NaN no sort — protege o top-K).
 *
 * 2. `searchTopK` com RAG OFF → devolve [] silenciosamente (feature flag
 *    respeitada; default 0).
 *
 * 3. `searchTopK` com queryText vazio → [] (sem chamada de IA — não gasta
 *    embed à toa).
 *
 * 4. `searchTopK` com RAG ON e memória pré-seedada: devolve top-K ordenado
 *    desc por cosseno, filtro (org, user) OBRIGATÓRIO — cross-tenant não
 *    vaza.
 *
 * 5. `buildRelevantMemoryBlock` monta o bloco `<memoria_relevante>` com o
 *    guardrail RN-154 EXPLÍCITO ("prevalece a entrada", "não invente") — se
 *    a LLM não recebe esse aviso, ela vai tratar memória como verdade.
 *
 * 6. `buildRelevantMemoryBlock` sem memória (top-K vazio) → "" (sem bloco
 *    injetado, interpret usa só EXTRACTION_SYSTEM).
 *
 * 7. Integração capture() → interpret(): com RAG OFF, `interpret` recebe
 *    system sem preamble. Com RAG ON e match, recebe system com bloco.
 *
 * 8. Isolamento cross-tenant no fluxo full: orgA com memória rica NÃO
 *    contamina o preamble de orgB (mesmo com match textual idêntico).
 *
 * 9. ai_usage_log: cada searchTopK real gera 1 linha de embed com
 *    (organization_id, user_id, module='falatu') — atribuição granular.
 *
 * 10. Best-effort: se `embedQuery` throw, capture NÃO explode — segue sem
 *     preamble (RAG nunca derruba "Fala → Faz → Confere").
 *
 * Uso: npm run test:falatu-rag
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-rag-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-rag-1234567890";
process.env.MASTER_ADMIN_EMAIL = "master@zapflow.test";
process.env.OPENAI_API_KEY = "sk-test-fake";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

/**
 * Insere embedding direto na tabela (bypass do fluxo F5.1) pra montar
 * cenário determinístico do top-K.
 */
function seedEmbedding(
  db: any, orgId: string, userId: string,
  sourceType: "entity" | "note", sourceId: string,
  snippet: string, vec: number[],
) {
  const f32 = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) f32[i] = vec[i];
  const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
  db.prepare(`
    INSERT INTO falatu_memory_embeddings (id, organization_id, user_id, source_type, source_id, content_snippet, embedding, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'text-embedding-3-small')
    ON CONFLICT (organization_id, user_id, source_type, source_id, model)
    DO UPDATE SET content_snippet = excluded.content_snippet, embedding = excluded.embedding
  `).run(randomUUID(), orgId, userId, sourceType, sourceId, snippet, buf);
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuService } = await import("../src/server/FalaTuService.js");
  const { FalaTuMemoryEmbeddingsService } = await import("../src/server/FalaTuMemoryEmbeddingsService.js");
  const { setUsageContext, currentUsageContext } = await import("../src/server/usageContext.js");
  const llm = await import("../src/server/llm.js");

  // ===== Mock: embedQuery devolve um vetor determinístico calculado do
  //       hash do texto. Isso garante que dois textos iguais produzem o
  //       mesmo vetor (cosseno=1 → top match), e diferentes produzem
  //       vetores diferentes. Também loga ai_usage_log como o real faria. =====
  let embedQueryCalls: { text: string; orgId: string | null; userId: string | null; module: string }[] = [];
  let embedShouldThrow = false;
  (FalaTuMemoryEmbeddingsService as any).embedQuery = async (text: string) => {
    if (embedShouldThrow) throw new Error("boom (test)");
    const ctx = currentUsageContext();
    embedQueryCalls.push({ text, orgId: ctx.orgId, userId: ctx.userId, module: ctx.module });
    // Grava usage log — mesmo shape do llm.recordUsage
    db.prepare(`
      INSERT INTO ai_usage_log (id, organization_id, user_id, model, kind, module, operation,
        input_tokens, output_tokens, total_tokens, cost_usd, cost_brl, cost_cents, latency_ms)
      VALUES (?, ?, ?, ?, 'embed', ?, 'embed', 5, 0, 5, 0.0001, 0.00054, 1, 2)
    `).run(randomUUID(), ctx.orgId, ctx.userId || null, llm.EMBED_MODEL, ctx.module || "legacy");
    // Vetor 1536-dim derivado do texto (soma dos char codes espalhados)
    // pra dar cosseno estável entre textos parecidos e ~zero entre diferentes.
    const vec = new Array(1536).fill(0);
    for (let i = 0; i < text.length; i++) vec[i % 1536] += text.charCodeAt(i) / 255;
    return vec;
  };

  // ===== Mock interpret: captura o que o system prompt continha =====
  let interpretCalls: { input: any; systemPreamble: string }[] = [];
  (FalaTuService as any).interpret = async (input: any, opts: any = {}) => {
    interpretCalls.push({ input, systemPreamble: opts.systemPreamble || "" });
    return {
      transcription: input.text || "", summary: (input.text || "").slice(0, 60), intent: "NOTE",
      entities: { people: [], projects: [], actions: [], listItems: [], eventDate: null, eventTime: null },
      confidence: 0.9, suggestedAction: "",
    };
  };

  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const userA = randomUUID();
  const userB = randomUUID();
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org B', 'active')`).run(randomUUID(), orgB);
  FalaTuService.setOrgEnabled(orgA, true);
  FalaTuService.setOrgEnabled(orgB, true);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'Dona A', 'a@t.com', 'owner', 'active')`).run(userA, orgA);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'Dono B', 'b@t.com', 'owner', 'active')`).run(userB, orgB);

  // ===== 1. cosine() unit =====
  const c1 = FalaTuMemoryEmbeddingsService.cosine([1, 0, 0], [1, 0, 0]);
  check("1.1 cosine(a,a) = 1 (vetores idênticos)", Math.abs(c1 - 1) < 1e-9);

  const c2 = FalaTuMemoryEmbeddingsService.cosine([1, 0, 0], [0, 1, 0]);
  check("1.2 cosine(a,b) = 0 (vetores ortogonais)", Math.abs(c2) < 1e-9);

  const c3 = FalaTuMemoryEmbeddingsService.cosine([1, 2, 3], [1, 2, 3, 4]);
  check("1.3 cosine com dim divergente = 0 (protege sort)", c3 === 0);

  const c4 = FalaTuMemoryEmbeddingsService.cosine([0, 0, 0], [1, 2, 3]);
  check("1.4 cosine com vetor zero = 0 (evita NaN por divisão)", c4 === 0);

  const c5 = FalaTuMemoryEmbeddingsService.cosine([1, 1, 0], [1, 0, 0]);
  check("1.5 cosine(0.5) ~= 0.707", Math.abs(c5 - 1 / Math.sqrt(2)) < 1e-6);

  // ===== 2. searchTopK com RAG OFF → [] =====
  check("2.0 pré-condição: orgA RAG OFF", !FalaTuMemoryEmbeddingsService.isEnabled(orgA));
  const off = await FalaTuMemoryEmbeddingsService.searchTopK(orgA, userA, "qualquer coisa", 5);
  check("2.1 RAG OFF: searchTopK devolve []", off.length === 0);
  check("2.2 RAG OFF: NÃO chamou embedQuery (nem gastou embed)", embedQueryCalls.length === 0);

  // ===== 3. searchTopK com queryText vazio → [] =====
  FalaTuMemoryEmbeddingsService.setEnabled(orgA, true);
  embedQueryCalls = [];
  const empty1 = await FalaTuMemoryEmbeddingsService.searchTopK(orgA, userA, "", 5);
  const empty2 = await FalaTuMemoryEmbeddingsService.searchTopK(orgA, userA, "   ", 5);
  check("3.1 queryText '' → []", empty1.length === 0);
  check("3.2 queryText só whitespace → []", empty2.length === 0);
  check("3.3 queryText vazio NÃO chama embedQuery (economia)", embedQueryCalls.length === 0);

  // ===== 4. searchTopK com memória pré-seedada — top-K ordenado, filtrado =====
  // Seed: 4 memórias pra userA + 1 pra userB (mesma org, cross-user)
  // + 1 pra orgB (cross-org) — nenhuma pode vazar pra userA/orgA.
  seedEmbedding(db, orgA, userA, "note", "n1", "ligar com Ana Beatriz sobre orçamento", [1, 1, 0]);
  seedEmbedding(db, orgA, userA, "entity", "e1", "Ana Beatriz — cliente novo, projeto Alpha", [1, 0.9, 0]);
  seedEmbedding(db, orgA, userA, "note", "n2", "comprar leite no mercado amanhã", [0, 1, 0]);
  seedEmbedding(db, orgA, userA, "note", "n3", "pagar boleto de aluguel", [0, 0, 1]);
  seedEmbedding(db, orgA, userB, "note", "n-cross", "algo do usuário B na org A", [1, 1, 0]);
  seedEmbedding(db, orgB, userA, "note", "n-crossorg", "algo do usuário A na org B", [1, 1, 0]);

  // Query com vetor derivado do texto — como o mock deriva do char code,
  // vamos usar as próprias tuplas de vetores acima como se fossem embeddings.
  // Truque: o mock devolve um vetor 1536-dim; pra ter cosseno significativo
  // vamos re-mockar temporariamente pra devolver um vetor pré-definido.
  const origEmbedQuery = (FalaTuMemoryEmbeddingsService as any).embedQuery;
  (FalaTuMemoryEmbeddingsService as any).embedQuery = async (_text: string) => {
    embedQueryCalls.push({ text: _text, orgId: currentUsageContext().orgId, userId: currentUsageContext().userId, module: currentUsageContext().module });
    // Grava usage log
    const ctx = currentUsageContext();
    db.prepare(`
      INSERT INTO ai_usage_log (id, organization_id, user_id, model, kind, module, operation,
        input_tokens, output_tokens, total_tokens, cost_usd, cost_brl, cost_cents, latency_ms)
      VALUES (?, ?, ?, ?, 'embed', ?, 'embed', 5, 0, 5, 0.0001, 0.00054, 1, 2)
    `).run(randomUUID(), ctx.orgId, ctx.userId || null, llm.EMBED_MODEL, ctx.module || "legacy");
    return [1, 1, 0];
  };

  embedQueryCalls = [];
  setUsageContext({ orgId: orgA, userId: userA, module: "falatu" });
  const hits = await FalaTuMemoryEmbeddingsService.searchTopK(orgA, userA, "reunião com Ana", 3);
  check("4.1 searchTopK devolve <=K resultados", hits.length === 3);
  check("4.2 top hit é 'Ana Beatriz' (cosseno=1 com [1,1,0])", hits[0].sourceId === "n1" && Math.abs(hits[0].score - 1) < 1e-6);
  check("4.3 ordenado desc por score", hits[0].score >= hits[1].score && hits[1].score >= hits[2].score);
  check("4.4 NÃO inclui n-cross (userB, mesma org — cross-user)", !hits.some((h) => h.sourceId === "n-cross"));
  check("4.5 NÃO inclui n-crossorg (userA, orgB — cross-org)", !hits.some((h) => h.sourceId === "n-crossorg"));
  check("4.6 embedQuery foi chamado 1x (top-K = 1 embed)", embedQueryCalls.length === 1);
  check("4.7 embedQuery viu o contexto certo (orgA + userA + module=falatu)",
    embedQueryCalls[0].orgId === orgA && embedQueryCalls[0].userId === userA && embedQueryCalls[0].module === "falatu");

  // Cross-org lookup: mesma query, orgB — só vê o `n-crossorg` (a única que pertence a userA em orgB).
  // Precisa RAG ligado em orgB pra searchTopK não abortar antes do filtro.
  FalaTuMemoryEmbeddingsService.setEnabled(orgB, true);
  setUsageContext({ orgId: orgB, userId: userA, module: "falatu" });
  const hitsB = await FalaTuMemoryEmbeddingsService.searchTopK(orgB, userA, "reunião com Ana", 3);
  check("4.8 orgB (mesmo user) vê APENAS suas embeddings", hitsB.length === 1 && hitsB[0].sourceId === "n-crossorg");

  // ===== 5. buildRelevantMemoryBlock — bloco montado + guardrails =====
  setUsageContext({ orgId: orgA, userId: userA, module: "falatu" });
  const block = await FalaTuMemoryEmbeddingsService.buildRelevantMemoryBlock(orgA, userA, "reunião com Ana", 3);
  check("5.1 bloco começa com <memoria_relevante>", block.startsWith("<memoria_relevante>"));
  check("5.2 bloco fecha com </memoria_relevante>", block.trim().endsWith("</memoria_relevante>"));
  check("5.3 bloco tem o snippet do top-1 (Ana Beatriz)", block.includes("Ana Beatriz"));
  check("5.4 bloco carrega guardrail 'PREVALECE a entrada' (RN-154)", block.includes("PREVALECE"));
  check("5.5 bloco carrega guardrail 'NUNCA invente' (RN-151)", block.includes("NUNCA invente"));
  check("5.6 bloco rotula como 'contexto histórico'", block.toLowerCase().includes("contexto histórico"));

  // ===== 6. buildRelevantMemoryBlock sem memória → "" =====
  // userB em orgB não tem NADA na memória
  setUsageContext({ orgId: orgB, userId: userB, module: "falatu" });
  const emptyBlock = await FalaTuMemoryEmbeddingsService.buildRelevantMemoryBlock(orgB, userB, "qualquer coisa", 5);
  check("6.1 sem memória: bloco = ''", emptyBlock === "");

  // RAG OFF também retorna ""
  FalaTuMemoryEmbeddingsService.setEnabled(orgB, false);
  const offBlock = await FalaTuMemoryEmbeddingsService.buildRelevantMemoryBlock(orgB, userB, "qualquer coisa", 5);
  check("6.2 RAG OFF: bloco = ''", offBlock === "");
  FalaTuMemoryEmbeddingsService.setEnabled(orgB, true);

  // ===== 7. Integração capture() → interpret com/sem preamble =====
  // (7a) RAG OFF: preamble vazio
  FalaTuMemoryEmbeddingsService.setEnabled(orgA, false);
  interpretCalls = [];
  const cap1 = await FalaTuService.capture(orgA, userA, { text: "ligar com Ana" });
  check("7.1 RAG OFF: capture chamou interpret", interpretCalls.length === 1 && !!cap1);
  check("7.2 RAG OFF: interpret recebeu systemPreamble VAZIO", interpretCalls[0].systemPreamble === "");

  // (7b) RAG ON: preamble com memória de Ana
  FalaTuMemoryEmbeddingsService.setEnabled(orgA, true);
  interpretCalls = [];
  const cap2 = await FalaTuService.capture(orgA, userA, { text: "ligar com Ana" });
  check("7.3 RAG ON: capture chamou interpret", interpretCalls.length === 1 && !!cap2);
  check("7.4 RAG ON: interpret recebeu systemPreamble com <memoria_relevante>", interpretCalls[0].systemPreamble.includes("<memoria_relevante>"));
  check("7.5 RAG ON: preamble cita Ana Beatriz", interpretCalls[0].systemPreamble.includes("Ana Beatriz"));
  check("7.6 RAG ON: preamble carrega guardrail RN-154", interpretCalls[0].systemPreamble.includes("PREVALECE"));

  // ===== 8. Isolamento cross-tenant no fluxo full — orgB vê SÓ o dele =====
  // Só orgB, userB, texto "reunião com Ana" (mesmo texto do orgA), mas SEM memória local
  FalaTuMemoryEmbeddingsService.setEnabled(orgB, true);
  interpretCalls = [];
  const cap3 = await FalaTuService.capture(orgB, userB, { text: "ligar com Ana" });
  check("8.1 orgB captura ok", !!cap3);
  check("8.2 orgB NÃO recebe memória de Ana Beatriz (isolamento cross-tenant)",
    !interpretCalls[0].systemPreamble.includes("Ana Beatriz"));
  // Como orgB/userB tem 0 embeddings, buildRelevantMemoryBlock devolveu "" → sem preamble
  check("8.3 orgB systemPreamble VAZIO (não tem memória própria)", interpretCalls[0].systemPreamble === "");

  // ===== 9. ai_usage_log ganhou 1 linha por captura com RAG ON + memória =====
  const usageA = db.prepare(`SELECT organization_id, user_id, module, operation FROM ai_usage_log WHERE kind = 'embed' AND organization_id = ? AND user_id = ?`).all(orgA, userA) as any[];
  check("9.1 orgA/userA tem >=1 linha de embed (RN-154 F1.1 metering)", usageA.length >= 1);
  check("9.2 module='falatu' em todas", usageA.every((u) => u.module === "falatu"));
  check("9.3 operation='embed'", usageA.every((u) => u.operation === "embed"));
  check("9.4 user_id preservado (attribuição granular)", usageA.every((u) => u.user_id === userA));

  // ===== 10. Best-effort: embedQuery throw → capture NÃO explode =====
  embedShouldThrow = true;
  // Restaura o mock original (que respeita embedShouldThrow)
  (FalaTuMemoryEmbeddingsService as any).embedQuery = origEmbedQuery;
  interpretCalls = [];
  let captureThrew = false;
  let cap4: any = null;
  try {
    cap4 = await FalaTuService.capture(orgA, userA, { text: "outra nota" });
  } catch { captureThrew = true; }
  check("10.1 embedQuery throw: capture NÃO explode (best-effort)", !captureThrew && !!cap4);
  check("10.2 embedQuery throw: interpret ainda foi chamado", interpretCalls.length === 1);
  check("10.3 embedQuery throw: systemPreamble vazio (fallback silencioso)", interpretCalls[0].systemPreamble === "");

  const passed = results.length - failures;
  console.log(`\n=== TEST FALATU RAG (ADR-154 F5.2) ===`);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} — ${r.name}`);
  console.log(`\n${passed}/${results.length} passed (${failures} failed)\n`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
});
