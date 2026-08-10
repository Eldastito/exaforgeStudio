/**
 * TEST — ADR-160 F9 (Onda A): porta I/O, fatia final — DEDUP de RAG.
 *
 * Havia dois stacks de embeddings reimplementando a MESMA matemática de busca:
 * o RAG canônico org-wide (geminiRAG / knowledge_chunks) e a memória Fala Tu
 * por-usuário (falatu_memory_embeddings). Os STORES seguem separados de propósito
 * (escopo org-wide vs pessoal — juntar vazaria memória pessoal), mas cosseno +
 * top-K agora são UM primitivo (`vectorSimilarity`) por onde os dois passam.
 *
 * Prova (determinístico, sem IA):
 *   - cosineSimilarity: contrato (idênticos=1, ortogonais=0, dim divergente=0,
 *     zero=0, 0.707) — o mesmo que as duas implementações antigas garantiam;
 *   - FalaTuMemoryEmbeddingsService.cosine DELEGA ao primitivo (mesmos valores) —
 *     prova que a matemática não está mais duplicada;
 *   - topKBySimilarity ranqueia desc, respeita k, extrai vetor por getVec, e
 *     ranqueia IGUAL independente do formato do item (chunk canônico vs linha
 *     Fala Tu) — a convergência que a fatia entrega.
 *
 * Uso: npm run test:falatu-porta-rag
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-porta-rag-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-porta-rag-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  await import("../src/server/db.js");
  const { cosineSimilarity, topKBySimilarity } = await import("../src/server/vectorSimilarity.js");
  const { FalaTuMemoryEmbeddingsService: FME } = await import("../src/server/FalaTuMemoryEmbeddingsService.js");

  // ===== 1. cosineSimilarity — contrato (o que os dois stacks garantiam) =====
  check("1.1 idênticos → 1", Math.abs(cosineSimilarity([1, 0, 0], [1, 0, 0]) - 1) < 1e-9);
  check("1.2 ortogonais → 0", Math.abs(cosineSimilarity([1, 0, 0], [0, 1, 0])) < 1e-9);
  check("1.3 dim divergente → 0 (protege sort)", cosineSimilarity([1, 2, 3], [1, 2, 3, 4]) === 0);
  check("1.4 vetor zero → 0 (evita NaN)", cosineSimilarity([0, 0, 0], [1, 2, 3]) === 0);
  check("1.5 vazio → 0", cosineSimilarity([], []) === 0);
  check("1.6 ~0.707", Math.abs(cosineSimilarity([1, 1, 0], [1, 0, 0]) - 1 / Math.sqrt(2)) < 1e-6);
  check("1.7 negativos (opostos) → -1", Math.abs(cosineSimilarity([1, 2], [-1, -2]) + 1) < 1e-9);

  // ===== 2. Delegação: FalaTu.cosine NÃO duplica mais a matemática =====
  const pairs: Array<[number[], number[]]> = [
    [[1, 0, 0], [1, 0, 0]], [[1, 0, 0], [0, 1, 0]], [[1, 2, 3], [4, 5, 6]],
    [[0.1, 0.9, 0.3], [0.2, 0.8, 0.4]], [[1, 2, 3], [1, 2, 3, 4]], [[0, 0], [0, 0]],
  ];
  check("2.1 FME.cosine === cosineSimilarity em toda amostra (delega ao primitivo)",
    pairs.every(([a, b]) => FME.cosine(a, b) === cosineSimilarity(a, b)));

  // ===== 3. topKBySimilarity — ranqueamento único =====
  const q = [1, 0, 0];
  const vecs = [
    { id: "a", v: [1, 0, 0] },   // cos 1
    { id: "b", v: [0, 1, 0] },   // cos 0
    { id: "c", v: [0.9, 0.1, 0] }, // cos alto (~0.994)
    { id: "d", v: [-1, 0, 0] },  // cos -1
  ];
  const ranked = topKBySimilarity(q, vecs, (x) => x.v, 4);
  check("3.1 ordena desc por score", ranked[0].item.id === "a" && ranked[1].item.id === "c" && ranked[2].item.id === "b" && ranked[3].item.id === "d");
  check("3.2 score correto no topo", Math.abs(ranked[0].score - 1) < 1e-9);
  const top2 = topKBySimilarity(q, vecs, (x) => x.v, 2);
  check("3.3 respeita k (slice)", top2.length === 2 && top2[0].item.id === "a" && top2[1].item.id === "c");
  check("3.4 itens vazios → []", topKBySimilarity(q, [], (x: any) => x.v, 5).length === 0);
  check("3.5 k > n → devolve todos", topKBySimilarity(q, vecs, (x) => x.v, 99).length === 4);

  // ===== 4. Convergência: mesmo ranking p/ formatos de item diferentes =====
  // Simula a linha do RAG canônico (knowledge_chunk) e a do Fala Tu — o mesmo
  // vetor deve ranquear igual, independente de onde o embedding mora.
  const knowledgeRows = [{ text: "X", embedding: [1, 0, 0] }, { text: "Y", embedding: [0.9, 0.1, 0] }, { text: "Z", embedding: [0, 1, 0] }];
  const falatuRows = [{ content_snippet: "X", vec: [1, 0, 0] }, { content_snippet: "Y", vec: [0.9, 0.1, 0] }, { content_snippet: "Z", vec: [0, 1, 0] }];
  const rk = topKBySimilarity(q, knowledgeRows, (r) => r.embedding, 3).map((r) => r.item.text);
  const rf = topKBySimilarity(q, falatuRows, (r) => r.vec, 3).map((r) => r.item.content_snippet);
  check("4.1 ranking idêntico p/ chunk canônico e linha Fala Tu (mesmo primitivo)", JSON.stringify(rk) === JSON.stringify(rf) && rk.join("") === "XYZ");

  console.log("\n=== TEST: Fala Tu porta I/O — dedup de RAG (ADR-160 F9) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Fala Tu porta I/O — dedup de RAG (F9) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
