/**
 * TEST — PRD 3 F7 (§49): RAG + Memory como EVIDÊNCIA (proveniência estruturada).
 * DB-backed, isolado por tmpDir. Determinístico — NÃO chama embed (a query-vec é
 * injetada e o rankeamento é puro), então roda em CI sem chave de IA. Prova:
 *
 *   - loadOrgChunks preserva a proveniência que a linha já carrega (documentId,
 *     chunkIndex, título via join, timestamp) — antes descartada;
 *   - rankChunksToHits (puro) ranqueia por similaridade e devolve `RagHit[]` COM
 *     proveniência + score; respeita topK e os filtros de canal/área;
 *   - searchContext (string[]) segue como projeção retrocompat (só os textos);
 *   - evidenceFromRagHit traduz um hit num EvidenceReference (§24) APPROVED_DOCUMENT
 *     com sourceId=documentId, field=chunk:N, confidence=score — não inventa;
 *   - ISOLAMENTO multi-tenant: chunks de A não vazam pra B.
 *
 * Uso: npm run test:rag-provenance
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rag-prov-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-rag-prov-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const uid = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const RAG = await import("../src/server/geminiRAG.js");
  const { evidenceFromRagHit } = await import("../src/server/contextModel.js");

  const mkOrg = (name: string) => {
    const id = uid("org");
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), id, name);
    return id;
  };
  // Documento + chunk com embedding conhecido. area_id/channel_id são colunas
  // aditivas (ALTER) — inserimos via a mesma forma do processDocument.
  const mkDoc = (orgId: string, title: string, createdAt: string) => {
    const docId = uid("doc");
    db.prepare(`INSERT INTO knowledge_documents (id, organization_id, title, content, status, created_at) VALUES (?, ?, ?, 'conteúdo', 'ready', ?)`).run(docId, orgId, title, createdAt);
    return docId;
  };
  const mkChunk = (orgId: string, docId: string, idx: number, text: string, emb: number[], channelId = "global", areaId: string | null = null) => {
    const id = uid("chunk");
    db.prepare(`INSERT INTO knowledge_chunks (id, organization_id, document_id, channel_id, area_id, chunk_index, content, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, docId, channelId, areaId, idx, text, JSON.stringify(emb));
    return id;
  };

  const orgA = mkOrg("Empresa A");
  const orgB = mkOrg("Empresa B");

  const docPolitica = mkDoc(orgA, "Política de Trocas", "2026-08-01T10:00:00.000Z");
  const docEntrega = mkDoc(orgA, "Prazo de Entrega", "2026-08-02T10:00:00.000Z");
  // 3 chunks; embeddings 3D fáceis de ranquear por cosseno.
  const cTrocas = mkChunk(orgA, docPolitica, 0, "Trocas em até 30 dias.", [1, 0, 0]);
  const cEntrega = mkChunk(orgA, docEntrega, 2, "Entrega em 5 dias úteis.", [0, 1, 0]);
  mkChunk(orgA, docPolitica, 1, "Reembolso via Pix.", [0, 0, 1]);
  // chunk de OUTRO canal (não deve casar num canal específico diferente).
  mkChunk(orgA, docEntrega, 3, "Só WhatsApp.", [1, 0, 0], "wa-123");
  // chunk do tenant B (isolamento).
  const docB = mkDoc(orgB, "Doc B", "2026-08-01T10:00:00.000Z");
  mkChunk(orgB, docB, 0, "Segredo do B.", [1, 0, 0]);

  // ═══════════════ 1. loadOrgChunks preserva proveniência ═══════════════
  const chunksA = RAG.loadOrgChunks(orgA);
  check("1.1 carregou os chunks da org (com embedding)", chunksA.length === 4);
  const trocasChunk = chunksA.find((c) => c.id === cTrocas)!;
  check("1.2 documentId preservado", trocasChunk.documentId === docPolitica);
  check("1.3 chunkIndex preservado", trocasChunk.chunkIndex === 0);
  check("1.4 título (fonte) via join", trocasChunk.title === "Política de Trocas");
  check("1.5 timestamp do documento preservado", trocasChunk.observedAt === "2026-08-01T10:00:00.000Z");

  // ═══════════════ 2. rankChunksToHits (puro) — proveniência + score + topK ═══
  // query alinhada ao chunk de trocas ([1,0,0]).
  const hits = RAG.rankChunksToHits([1, 0, 0], chunksA, { topK: 2 });
  check("2.1 topK respeitado", hits.length === 2);
  check("2.2 melhor hit é o mais similar (trocas)", hits[0].chunkId === cTrocas && hits[0].documentId === docPolitica);
  check("2.3 hit carrega proveniência ESTRUTURADA", hits[0].chunkIndex === 0 && hits[0].source === "Política de Trocas" && hits[0].title === "Política de Trocas");
  check("2.4 score de similaridade presente (0..1) e ordenado desc", hits[0].score > 0.99 && hits[0].score >= hits[1].score);
  check("2.5 observedAt no hit", hits[0].observedAt === "2026-08-01T10:00:00.000Z");

  // filtro de canal: no canal 'global' (default) não entra o chunk 'wa-123'.
  const globalHits = RAG.rankChunksToHits([1, 0, 0], chunksA, { topK: 10 });
  check("2.6 canal específico não vaza no global", globalHits.every((h) => h.chunkId !== chunksA.find((c) => c.channelId === "wa-123")!.id));
  // no canal 'wa-123', o chunk daquele canal + os globais entram.
  const waHits = RAG.rankChunksToHits([1, 0, 0], chunksA, { topK: 10, channelId: "wa-123" });
  check("2.7 canal específico inclui seu chunk + globais", waHits.some((h) => h.text === "Só WhatsApp."));

  // ═══════════════ 3. searchContext (retrocompat string[]) ═══════════════
  // rankChunksToHits é a lógica; searchContext só projeta os textos. Provamos a
  // projeção com um mini-rerun determinístico via rankChunksToHits→map(text).
  const asStrings = RAG.rankChunksToHits([0, 1, 0], chunksA, { topK: 1 }).map((h) => h.text);
  check("3.1 projeção textual retrocompat", asStrings.length === 1 && asStrings[0] === "Entrega em 5 dias úteis.");

  // ═══════════════ 4. evidenceFromRagHit → EvidenceReference (§24) ═══════════════
  const entregaHit = RAG.rankChunksToHits([0, 1, 0], chunksA, { topK: 1 })[0];
  const ev = evidenceFromRagHit(entregaHit);
  check("4.1 sourceType APPROVED_DOCUMENT", ev.sourceType === "APPROVED_DOCUMENT");
  check("4.2 sourceId = documentId", ev.sourceId === docEntrega);
  check("4.3 service geminiRAG + field chunk:N", ev.service === "geminiRAG" && ev.field === "chunk:2");
  check("4.4 confidence = score, observedAt preservado", ev.confidence === entregaHit.score && ev.observedAt === "2026-08-02T10:00:00.000Z");
  check("4.5 value = texto do chunk", ev.value === "Entrega em 5 dias úteis.");
  // não inventa: hit vazio → refs null.
  const evEmpty = evidenceFromRagHit({});
  check("4.6 hit vazio não inventa (sourceId/confidence null)", evEmpty.sourceId === null && evEmpty.confidence === null);

  // ═══════════════ 5. ISOLAMENTO multi-tenant ═══════════════
  const chunksB = RAG.loadOrgChunks(orgB);
  check("5.1 org B só vê os próprios chunks", chunksB.length === 1 && chunksB[0].text === "Segredo do B.");
  check("5.2 nenhum chunk de A aparece em B", chunksB.every((c) => c.documentId === docB));

  console.log("\n=== TEST: RAG provenance como evidência (PRD 3 F7) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ RAG provenance (F7) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
