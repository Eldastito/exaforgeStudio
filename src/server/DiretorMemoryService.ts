/**
 * DiretorMemoryService — persiste a Q&A do Diretor IA no RAG do PERFIL.
 *
 * Quando o dono pergunta ao Diretor (via Diretor IA, Fala Tu ou WhatsApp gestor)
 * e recebe uma resposta REAL, gravamos {pergunta, resposta} e enfileiramos um
 * embedding com `source_type='advisor_qa'` no MESMO store do RAG do perfil
 * (`falatu_memory_embeddings`). Assim a recuperação já existente
 * (`buildRelevantMemoryBlock`, que lê todos os source_types por (org, user))
 * passa a considerar as respostas do Diretor como memória consultável.
 *
 * Invariantes:
 *  - Opt-in pelo MESMO flag do RAG do perfil (`falatu_rag_enabled`, default 0);
 *  - Só grava com userId + pergunta + resposta reais (erro do Diretor NÃO entra);
 *  - Best-effort: qualquer falha aqui NUNCA derruba a resposta ao usuário;
 *  - Multi-tenant: tudo por (organization_id, user_id).
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { JobQueueService, JobQueueError } from "./JobQueueService.js";
import { FalaTuMemoryEmbeddingsService } from "./FalaTuMemoryEmbeddingsService.js";

const EMBED_JOB_ADVISOR_QA = "diretor_embed_qa";

interface AdvisorQaJobPayload { organizationId: string; userId: string; sourceId: string; }

export class DiretorMemoryService {
  /**
   * Grava a Q&A e enfileira o embedding. No-op silencioso se RAG desligado,
   * sem userId, ou sem texto. Best-effort — engole erro (não pode derrubar o ask).
   */
  static remember(orgId: string, userId: string | null | undefined, qa: { question: string; answer: string; tool?: string | null }): void {
    const uid = String(userId || "").trim();
    const question = String(qa?.question || "").trim();
    const answer = String(qa?.answer || "").trim();
    if (!uid || !question || !answer) return;
    if (!FalaTuMemoryEmbeddingsService.isEnabled(orgId)) return; // opt-in: RAG do perfil
    try {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO diretor_qa_memory (id, organization_id, user_id, question, answer, tool) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, orgId, uid, question.slice(0, 2000), answer.slice(0, 4000), qa.tool || null);
      const payload: AdvisorQaJobPayload = { organizationId: orgId, userId: uid, sourceId: id };
      JobQueueService.enqueue(EMBED_JOB_ADVISOR_QA, payload, { organizationId: orgId });
    } catch (e) {
      console.error("[DiretorMemory] Falha ao gravar/enfileirar Q&A (best-effort):", e);
    }
  }

  /** Handler do job: lê a Q&A e gera o embedding no store do RAG do perfil. */
  static async processQaJob(payload: AdvisorQaJobPayload): Promise<void> {
    const { organizationId, userId, sourceId } = payload;
    const row = db.prepare(
      `SELECT id, question, answer FROM diretor_qa_memory WHERE id = ? AND organization_id = ? AND user_id = ?`
    ).get(sourceId, organizationId, userId) as { id?: string; question?: string; answer?: string } | undefined;
    if (!row?.id) throw new JobQueueError(`Q&A ${sourceId} não encontrada (org ${organizationId}/user ${userId})`, "non_retryable");
    const snippet = `Pergunta do gestor: ${row.question}\nResposta do Diretor IA: ${row.answer}`.trim();
    if (!snippet) throw new JobQueueError("Q&A sem texto pra embedding", "non_retryable");
    await FalaTuMemoryEmbeddingsService.embedAndStore(organizationId, userId, "advisor_qa", row.id, snippet);
  }

  /** Consulta multi-tenant (auditoria/testes). */
  static listForUser(orgId: string, userId: string): any[] {
    return db.prepare(
      `SELECT id, question, answer, tool, created_at FROM diretor_qa_memory WHERE organization_id = ? AND user_id = ? ORDER BY created_at DESC`
    ).all(orgId, userId) as any[];
  }
}

// Registra o handler ao carregar o módulo (import side-effect no boot via
// server.ts, mesmo padrão do FalaTuMemoryEmbeddingsService).
JobQueueService.registerHandler(EMBED_JOB_ADVISOR_QA, async (payload) => {
  await DiretorMemoryService.processQaJob(payload);
  return { ok: true };
});

export default DiretorMemoryService;
