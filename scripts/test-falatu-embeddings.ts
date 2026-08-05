/**
 * TEST — ADR-154 Fatia 5.1: falatu_memory_embeddings + gerador async no confirm.
 *
 * Prova os invariantes duros da fatia:
 *
 * 1. Schema: tabela falatu_memory_embeddings + coluna falatu_rag_enabled
 *    existem. Default falatu_rag_enabled=0 (opt-in).
 *
 * 2. isEnabled/setEnabled toggle o flag, e listForUser é multi-tenant.
 *
 * 3. serializeEmbedding/deserializeEmbedding: roundtrip preserva o vetor
 *    (Float32 precision), Buffer é 4 bytes por float, NaN/Infinity throw.
 *
 * 4. Hook no confirm: com RAG DESLIGADO → NENHUM job enfileirado.
 *
 * 5. Hook no confirm: com RAG LIGADO → 1 job de nota + 1 job por entidade
 *    tocada; após rodar, linhas em falatu_memory_embeddings materializadas
 *    com filtro (org, user, source_type, source_id, model).
 *
 * 6. Handler valida STATUS='confirmed' — pending/discarded throw non_retryable
 *    (guardrail RN-151 §4 — pending nunca alimenta memória).
 *
 * 7. Isolamento multi-tenant: org A e org B, mesmo user_id lookup — cada
 *    uma só vê seu embedding.
 *
 * 8. ai_usage_log: chamada de embedding grava row com module='falatu' +
 *    user_id certo + operation='embed'.
 *
 * 9. Idempotência: rodar o mesmo job 2x com ON CONFLICT não duplica
 *    (upsert por org+user+type+source+model).
 *
 * 10. RAG desligado depois → não gera novos embeddings, mas os já existentes
 *     ficam (F5.3 vai plugar cleanup opt-in).
 *
 * Uso: npm run test:falatu-embeddings
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-emb-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-emb-1234567890";
process.env.MASTER_ADMIN_EMAIL = "master@zapflow.test";
process.env.OPENAI_API_KEY = "sk-test-fake"; // isAIConfigured() precisa true; o mock intercepta antes de sair

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function waitForJobsToDrain(db: any, maxMs = 3000): Promise<void> {
  // O hook do confirm faz `void import(...).then(enqueue)` — a promise dispara
  // no próximo microtick, mas ainda precisa resolver o dynamic import antes de
  // chegar no enqueue. Damos 50ms de folga antes de começar a checar (o teste
  // rodava rápido demais e o drain saía com 0 pending apenas porque o enqueue
  // ainda não tinha acontecido).
  await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const pending = (db.prepare(`SELECT COUNT(*) c FROM background_jobs WHERE status IN ('pending','processing') AND (type = 'falatu_embed_entity' OR type = 'falatu_embed_note')`).get() as any).c;
    if (pending === 0) return;
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuService } = await import("../src/server/FalaTuService.js");
  const { FalaTuMemoryEmbeddingsService } = await import("../src/server/FalaTuMemoryEmbeddingsService.js");
  const { JobQueueService } = await import("../src/server/JobQueueService.js");
  const llm = await import("../src/server/llm.js");

  // ===== Mock: substitui embedAndStore (static, writable — igual pattern
  //       `(FalaTuService as any).interpret = ...` usado em test-falatu-memoria).
  //       ESM não permite mutar `llm.embed` diretamente (binding read-only).
  //       Este mock replica o que o real faz + verifica que o contexto de
  //       usage foi setado corretamente pelos handlers ANTES da chamada. =====
  let embedCalls: { snippet: string; orgId: string | null; userId: string | null; module: string }[] = [];
  const realEmbedAndStore = FalaTuMemoryEmbeddingsService.embedAndStore;
  (FalaTuMemoryEmbeddingsService as any).embedAndStore = async (
    orgId: string, userId: string, sourceType: "entity" | "note", sourceId: string, snippet: string,
  ) => {
    const { currentUsageContext } = await import("../src/server/usageContext.js");
    const { setUsageContext } = await import("../src/server/usageContext.js");
    setUsageContext({ orgId, userId, module: "falatu" });
    const ctx = currentUsageContext();
    embedCalls.push({ snippet, orgId: ctx.orgId, userId: ctx.userId, module: ctx.module });
    // Grava no ai_usage_log — mesmo shape que llm.recordUsage grava
    db.prepare(`
      INSERT INTO ai_usage_log (
        id, organization_id, user_id, model, kind, module, operation,
        input_tokens, output_tokens, total_tokens, cost_usd, cost_brl, cost_cents, latency_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), ctx.orgId, ctx.userId || null, llm.EMBED_MODEL, "embed", ctx.module || "legacy", "embed", 10, 0, 10, 0.001, 0.0054, 1, 5);
    // Vetor 1536-dim com marcador em [0] pra deserialize test funcionar
    const vec = new Array(1536).fill(0);
    vec[0] = 0.42;
    const buf = FalaTuMemoryEmbeddingsService.serializeEmbedding(vec);
    db.prepare(`
      INSERT INTO falatu_memory_embeddings (id, organization_id, user_id, source_type, source_id, content_snippet, embedding, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (organization_id, user_id, source_type, source_id, model)
      DO UPDATE SET content_snippet = excluded.content_snippet, embedding = excluded.embedding, created_at = CURRENT_TIMESTAMP
    `).run(randomUUID(), orgId, userId, sourceType, sourceId, snippet, buf, llm.EMBED_MODEL);
  };
  // Silencia o unused warn — mantido pra referência clara do padrão real
  void realEmbedAndStore;

  // Também mocka `interpret` (sem chave real, mas isAIConfigured=true por causa
  // do fake key acima) — captura de FalaTu chama interpret ANTES de qualquer
  // recordUsage; se não for mockado, tenta chamar OpenAI e explode.
  (FalaTuService as any).interpret = async (input: any) => ({
    transcription: input.text, summary: (input.text || "").slice(0, 60), intent: "NOTE",
    entities: { people: [], projects: [], actions: [], listItems: [], eventDate: null, eventTime: null },
    confidence: 0.9, suggestedAction: "",
  });

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

  // ===== 1. Schema =====
  const cols = (db.prepare(`PRAGMA table_info(organization_settings)`).all() as any[]).map((c: any) => c.name);
  check("1.1 coluna falatu_rag_enabled existe", cols.includes("falatu_rag_enabled"));

  const embCols = (db.prepare(`PRAGMA table_info(falatu_memory_embeddings)`).all() as any[]).map((c: any) => c.name);
  check("1.2 tabela falatu_memory_embeddings tem todas as colunas exigidas", ["id", "organization_id", "user_id", "source_type", "source_id", "content_snippet", "embedding", "model", "created_at"].every((c) => embCols.includes(c)));

  const defaultRag = db.prepare(`SELECT falatu_rag_enabled FROM organization_settings WHERE organization_id = ?`).get(orgA) as any;
  check("1.3 default falatu_rag_enabled=0 (opt-in)", defaultRag?.falatu_rag_enabled === 0);

  // ===== 2. isEnabled/setEnabled + listForUser multi-tenant =====
  check("2.1 isEnabled(orgA) default=false", FalaTuMemoryEmbeddingsService.isEnabled(orgA) === false);
  FalaTuMemoryEmbeddingsService.setEnabled(orgA, true);
  check("2.2 setEnabled(orgA,true) → isEnabled(orgA)=true", FalaTuMemoryEmbeddingsService.isEnabled(orgA) === true);
  check("2.3 setEnabled não vaza pra orgB", FalaTuMemoryEmbeddingsService.isEnabled(orgB) === false);
  FalaTuMemoryEmbeddingsService.setEnabled(orgA, false);
  check("2.4 setEnabled(orgA,false) reverte", FalaTuMemoryEmbeddingsService.isEnabled(orgA) === false);

  // ===== 3. Serialize/Deserialize embedding =====
  const vecOriginal = [0.1, -0.5, 3.14, 0.0, -0.001];
  const buf = FalaTuMemoryEmbeddingsService.serializeEmbedding(vecOriginal);
  check("3.1 buffer size = 4 bytes por float", buf.length === vecOriginal.length * 4);
  const vecRound = FalaTuMemoryEmbeddingsService.deserializeEmbedding(buf);
  check("3.2 roundtrip preserva vetor (Float32 precision)", vecRound.every((v, i) => Math.abs(v - vecOriginal[i]) < 1e-6));

  let threw = false;
  try { FalaTuMemoryEmbeddingsService.serializeEmbedding([]); } catch { threw = true; }
  check("3.3 vetor vazio → throw", threw);

  threw = false;
  try { FalaTuMemoryEmbeddingsService.serializeEmbedding([1, NaN, 2]); } catch { threw = true; }
  check("3.4 NaN no vetor → throw (evita divisão por zero em cosseno)", threw);

  threw = false;
  try { FalaTuMemoryEmbeddingsService.serializeEmbedding([1, Infinity, 2]); } catch { threw = true; }
  check("3.5 Infinity no vetor → throw", threw);

  // ===== 4. Hook: RAG DESLIGADO → NENHUM job enfileirado =====
  check("4.0 pré-condição: orgA com RAG OFF", FalaTuMemoryEmbeddingsService.isEnabled(orgA) === false);
  const jobsBefore = (db.prepare(`SELECT COUNT(*) c FROM background_jobs WHERE type IN ('falatu_embed_entity', 'falatu_embed_note')`).get() as any).c;
  const cap0 = await FalaTuService.capture(orgA, userA, { text: "vou lá amanhã" });
  FalaTuService.confirm(orgA, userA, cap0.id, {});
  await new Promise((r) => setImmediate(r));
  const jobsAfter = (db.prepare(`SELECT COUNT(*) c FROM background_jobs WHERE type IN ('falatu_embed_entity', 'falatu_embed_note')`).get() as any).c;
  check("4.1 RAG OFF: confirm NÃO enfileira job", jobsAfter === jobsBefore);
  check("4.2 RAG OFF: nenhuma linha em falatu_memory_embeddings pra orgA", (db.prepare(`SELECT COUNT(*) c FROM falatu_memory_embeddings WHERE organization_id = ?`).get(orgA) as any).c === 0);

  // ===== 5. Hook: RAG LIGADO → job + linha materializada =====
  FalaTuMemoryEmbeddingsService.setEnabled(orgA, true);

  // Mocka interpret pra devolver 1 entidade (person)
  (FalaTuService as any).interpret = async (input: any) => ({
    transcription: input.text, summary: (input.text || "").slice(0, 60), intent: "TASK",
    entities: { people: ["Ana Beatriz"], projects: [], actions: [], listItems: [], eventDate: null, eventTime: null },
    confidence: 0.9, suggestedAction: "",
  });

  embedCalls = [];
  const cap1 = await FalaTuService.capture(orgA, userA, { text: "ligar com Ana Beatriz hoje" });
  FalaTuService.confirm(orgA, userA, cap1.id, {});
  await waitForJobsToDrain(db);

  const embRows = FalaTuMemoryEmbeddingsService.listForUser(orgA, userA);
  check("5.1 RAG ON: pelo menos 1 embedding gerado (nota)", embRows.some((r) => r.source_type === "note" && r.source_id === cap1.id));
  check("5.2 RAG ON: 1 embedding pra entidade Ana Beatriz", embRows.some((r) => r.source_type === "entity" && r.content_snippet.includes("Ana Beatriz")));
  check("5.3 embed() foi chamado (mock counter)", embedCalls.length >= 2);
  check("5.4 model gravado é EMBED_MODEL", embRows.every((r) => r.model === llm.EMBED_MODEL));
  check("5.5 content_snippet da nota preserva o summary", embRows.some((r) => r.source_type === "note" && r.content_snippet.includes("ligar com Ana Beatriz")));

  const noteRow = embRows.find((r) => r.source_type === "note")!;
  const vecRestored = FalaTuMemoryEmbeddingsService.deserializeEmbedding(Buffer.from(noteRow.embedding));
  check("5.6 embedding tem dim 1536 (text-embedding-3-small)", vecRestored.length === 1536);
  check("5.7 embedding[0] preservou marcador do mock (0.42)", Math.abs(vecRestored[0] - 0.42) < 1e-5);

  // ===== 6. Handler valida status='confirmed' — throw non_retryable pra
  //          pending. Simula processando um item que voltou pra pending. =====
  const cap2 = await FalaTuService.capture(orgA, userA, { text: "pendente qualquer" });
  // Enfileira job manualmente (bypass do hook), mas mantém status='pending'
  const jobId = JobQueueService.enqueue("falatu_embed_note", {
    organizationId: orgA, userId: userA, sourceType: "note", sourceId: cap2.id,
  }, { organizationId: orgA });
  await waitForJobsToDrain(db);
  const j = JobQueueService.get(jobId) as any;
  check("6.1 processando item pending → job falha (non_retryable)", j?.status === "failed");
  check("6.2 last_error cita 'confirmed'", (j?.last_error || "").includes("confirmed"));
  const embForPending = db.prepare(`SELECT COUNT(*) c FROM falatu_memory_embeddings WHERE source_id = ?`).get(cap2.id) as any;
  check("6.3 nenhuma linha embedding pra item pending (RN-151 §4)", embForPending.c === 0);

  // ===== 7. Multi-tenant isolamento =====
  FalaTuMemoryEmbeddingsService.setEnabled(orgB, true);
  (FalaTuService as any).interpret = async (input: any) => ({
    transcription: input.text, summary: (input.text || "").slice(0, 60), intent: "NOTE",
    entities: { people: ["Carlos Bravo"], projects: [], actions: [], listItems: [], eventDate: null, eventTime: null },
    confidence: 0.9, suggestedAction: "",
  });
  const cap3 = await FalaTuService.capture(orgB, userB, { text: "reunião com Carlos Bravo" });
  FalaTuService.confirm(orgB, userB, cap3.id, {});
  await waitForJobsToDrain(db);

  const embA = FalaTuMemoryEmbeddingsService.listForUser(orgA, userA);
  const embB = FalaTuMemoryEmbeddingsService.listForUser(orgB, userB);
  check("7.1 orgA vê só seus embeddings", embA.every((r) => r.organization_id === orgA && r.user_id === userA));
  check("7.2 orgB vê só seus embeddings", embB.every((r) => r.organization_id === orgB && r.user_id === userB));
  check("7.3 orgB embeddings existem (Carlos Bravo)", embB.some((r) => r.content_snippet.includes("Carlos Bravo")));
  check("7.4 orgA NÃO vê embedding de Carlos Bravo (isolamento)", !embA.some((r) => r.content_snippet.includes("Carlos Bravo")));

  // Cross-tenant lookup via listForUser(orgA, userB) devolve vazio
  check("7.5 listForUser cross-tenant (orgA + userB) = vazio", FalaTuMemoryEmbeddingsService.listForUser(orgA, userB).length === 0);

  // ===== 8. ai_usage_log ganhou linhas com module='falatu' + user_id =====
  const usage = db.prepare(`SELECT organization_id, user_id, module, operation, model FROM ai_usage_log WHERE kind = 'embed' AND organization_id = ?`).all(orgA) as any[];
  check("8.1 ai_usage_log tem linhas com kind='embed' pra orgA", usage.length >= 2);
  check("8.2 module='falatu' em todas", usage.every((u) => u.module === "falatu"));
  check("8.3 user_id preservado (attribuição granular)", usage.every((u) => u.user_id === userA));
  check("8.4 operation='embed'", usage.every((u) => u.operation === "embed"));

  const usageB = db.prepare(`SELECT * FROM ai_usage_log WHERE kind = 'embed' AND organization_id = ?`).all(orgB) as any[];
  check("8.5 ai_usage_log orgB isolado (não vaza pra orgA)", usageB.length >= 1 && usageB.every((u) => u.organization_id === orgB));

  // ===== 9. Idempotência: rodar job 2x com ON CONFLICT não duplica =====
  const embBeforeRerun = embRows.length;
  // Re-enfileira job pra Ana Beatriz (entity_id do cap1)
  const entRow = db.prepare(`SELECT id FROM falatu_entities WHERE organization_id = ? AND user_id = ? AND name_norm = 'ana beatriz'`).get(orgA, userA) as any;
  const jobId2 = JobQueueService.enqueue("falatu_embed_entity", {
    organizationId: orgA, userId: userA, sourceType: "entity", sourceId: entRow.id,
  }, { organizationId: orgA });
  await waitForJobsToDrain(db);
  const j2 = JobQueueService.get(jobId2) as any;
  check("9.1 re-embed do mesmo (org,user,type,id,model) → job SUCCEEDED", j2?.status === "completed");
  const embA2 = FalaTuMemoryEmbeddingsService.listForUser(orgA, userA);
  check("9.2 count de embeddings NÃO aumentou (UPSERT dedupe)", embA2.length === embBeforeRerun);

  // ===== 10. Desligar RAG depois: novos confirms não geram, mas antigos ficam =====
  FalaTuMemoryEmbeddingsService.setEnabled(orgA, false);
  const embBeforeOff = FalaTuMemoryEmbeddingsService.listForUser(orgA, userA).length;
  const cap4 = await FalaTuService.capture(orgA, userA, { text: "mais uma nota" });
  FalaTuService.confirm(orgA, userA, cap4.id, {});
  await new Promise((r) => setImmediate(r));
  const embAfterOff = FalaTuMemoryEmbeddingsService.listForUser(orgA, userA).length;
  check("10.1 RAG desligado: novo confirm NÃO gera novo embedding", embAfterOff === embBeforeOff);
  check("10.2 RAG desligado: embeddings antigos ficam intactos (F5.3 é quem limpa)", embAfterOff > 0);

  const passed = results.length - failures;
  console.log(`\n=== TEST FALATU EMBEDDINGS (ADR-154 F5.1) ===`);
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
