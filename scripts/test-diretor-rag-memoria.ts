/**
 * TESTE — DiretorMemoryService: persiste a Q&A do Diretor no RAG do perfil.
 * Offline: mocka embedAndStore/embedQuery (sem OpenAI). Prova:
 *  - opt-in (falatu_rag_enabled): off → não grava nada; on → grava linha + job;
 *  - guardas: sem userId / pergunta / resposta → no-op;
 *  - processQaJob monta snippet pergunta+resposta e chama embedAndStore(advisor_qa);
 *  - loop fechado: a Q&A embutida vira memória recuperável por searchTopK;
 *  - ask() persiste só resposta REAL (userId presente).
 * Uso: npm run test:diretor-rag-memoria
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-diretor-rag-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-diretor-rag-1234567890";
process.env.OPENAI_API_KEY = "sk-test-fake";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { DiretorMemoryService } = await import("../src/server/DiretorMemoryService.js");
  const { FalaTuMemoryEmbeddingsService: MEM } = await import("../src/server/FalaTuMemoryEmbeddingsService.js");

  // Mock do embedAndStore: grava um embedding determinístico [1,0,0] na tabela
  // real (pra provar recuperação) e registra as chamadas.
  const embedCalls: { orgId: string; userId: string; type: string; id: string; snippet: string }[] = [];
  (MEM as any).embedAndStore = async (orgId: string, userId: string, type: string, id: string, snippet: string) => {
    embedCalls.push({ orgId, userId, type, id, snippet });
    const buf = MEM.serializeEmbedding([1, 0, 0]);
    db.prepare(
      `INSERT INTO falatu_memory_embeddings (id, organization_id, user_id, source_type, source_id, content_snippet, embedding, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'text-embedding-3-small')
       ON CONFLICT (organization_id, user_id, source_type, source_id, model)
       DO UPDATE SET content_snippet = excluded.content_snippet, embedding = excluded.embedding`
    ).run(randomUUID(), orgId, userId, type, id, snippet, buf);
  };
  (MEM as any).embedQuery = async () => [1, 0, 0]; // query casa com o vetor gravado

  const mkOrg = (rag: boolean) => {
    const orgId = `org_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, falatu_rag_enabled) VALUES (?, ?, ?, 'active', ?)`)
      .run(randomUUID(), orgId, "Rede", rag ? 1 : 0);
    return orgId;
  };
  const orgOn = mkOrg(true), orgOff = mkOrg(false);
  const USER = "user-1";

  // 1) RAG OFF → nada é gravado.
  DiretorMemoryService.remember(orgOff, USER, { question: "quais lojas abaixo da cota?", answer: "Loja X faltou R$ 1000." });
  check("1 RAG off → nenhuma Q&A gravada", DiretorMemoryService.listForUser(orgOff, USER).length === 0);

  // 2) RAG ON → grava linha + enfileira job.
  DiretorMemoryService.remember(orgOn, USER, { question: "quais lojas abaixo da cota em setembro?", answer: "Loja X: 2 dias abaixo, faltou R$ 1500 no mês." });
  const rows = DiretorMemoryService.listForUser(orgOn, USER);
  check("2 RAG on → 1 Q&A gravada", rows.length === 1, `n=${rows.length}`);
  const job = db.prepare(`SELECT type FROM background_jobs WHERE organization_id = ? AND type = 'diretor_embed_qa'`).get(orgOn) as any;
  check("3 job diretor_embed_qa enfileirado", !!job);

  // 3) Guardas: sem userId / pergunta / resposta → no-op.
  DiretorMemoryService.remember(orgOn, "", { question: "x", answer: "y" });
  DiretorMemoryService.remember(orgOn, USER, { question: "", answer: "y" });
  DiretorMemoryService.remember(orgOn, USER, { question: "x", answer: "" });
  check("4 guardas (sem user/pergunta/resposta) → segue com 1 só", DiretorMemoryService.listForUser(orgOn, USER).length === 1);

  // 4) processQaJob monta snippet e chama embedAndStore(advisor_qa).
  embedCalls.length = 0;
  await DiretorMemoryService.processQaJob({ organizationId: orgOn, userId: USER, sourceId: rows[0].id });
  check("5 processQaJob chamou embedAndStore com type advisor_qa", embedCalls.length === 1 && embedCalls[0].type === "advisor_qa");
  check("6 snippet contém pergunta E resposta", !!embedCalls[0]?.snippet.includes("quais lojas abaixo da cota em setembro") && !!embedCalls[0]?.snippet.includes("faltou R$ 1500"), embedCalls[0]?.snippet || "");

  // 5) Loop fechado: a Q&A virou memória recuperável (searchTopK).
  const hits = await MEM.searchTopK(orgOn, USER, "lojas abaixo da cota", 5);
  check("7 searchTopK recupera a memória advisor_qa", hits.some((h: any) => h.sourceType === "advisor_qa" && h.snippet.includes("faltou R$ 1500")), JSON.stringify(hits.map((h: any) => h.sourceType)));

  // 6) Isolamento: outra org não vê a memória.
  check("8 isolamento por org", DiretorMemoryService.listForUser(orgOff, USER).length === 0);

  // 7) ask() persiste só resposta REAL (com userId). Mocka o motor de resposta.
  const { ExecutiveAdvisorService } = await import("../src/server/ExecutiveAdvisorService.js");
  (ExecutiveAdvisorService as any).computeAnswer = async () => "Resposta real do Diretor.";
  const before = DiretorMemoryService.listForUser(orgOn, USER).length;
  await ExecutiveAdvisorService.ask(orgOn, "como estão as vendas?", { canSeeMoney: true, userId: USER });
  check("9 ask() com userId → +1 Q&A no RAG", DiretorMemoryService.listForUser(orgOn, USER).length === before + 1);
  // Sem userId → não persiste.
  await ExecutiveAdvisorService.ask(orgOn, "e o estoque?", { canSeeMoney: true });
  check("10 ask() sem userId → não persiste", DiretorMemoryService.listForUser(orgOn, USER).length === before + 1);
  // Resposta de erro (computeAnswer null) → não persiste.
  (ExecutiveAdvisorService as any).computeAnswer = async () => null;
  const errText = await ExecutiveAdvisorService.ask(orgOn, "falha?", { canSeeMoney: true, userId: USER });
  check("11 ask() em falha → sentinel + não persiste", errText.includes("Não consegui analisar") && DiretorMemoryService.listForUser(orgOn, USER).length === before + 1);

  console.log("\n=== Diretor IA — RAG de Q&A do perfil ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error("Erro fatal:", e); fs.rmSync(tmpDir, { recursive: true, force: true }); process.exit(1); });
