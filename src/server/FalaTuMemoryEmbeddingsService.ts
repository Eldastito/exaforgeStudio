/**
 * ADR-154 Fatia 5.1 + 5.2 — FalaTuMemoryEmbeddingsService.
 *
 * F5.1 (fundação): gera embeddings da memória do FalaTu (entidades + notas
 * confirmadas) ASSÍNCRONAMENTE via JobQueue, sem atrasar o "Fala → Faz →
 * Confere". Tabela + handler + hook no confirm.
 *
 * F5.2 (RAG on-read): dado o texto de entrada de uma captura, faz busca
 * top-K por similaridade cosseno em falatu_memory_embeddings — filtro
 * OBRIGATÓRIO por (organization_id, user_id) — e devolve um bloco
 * <memoria_relevante>...</memoria_relevante> pra ser prepend no system do
 * llm.chat DENTRO de FalaTuService.interpret. Só roda se
 * organization_settings.falatu_rag_enabled=1 (default 0). Custo do embedding
 * da query é atribuído à org via setUsageContext ANTES da chamada (F1.1).
 *
 * Cálculo em SQLite: fallback puro JS (loop cosseno) — o ADR aceita porque o
 * volume por usuário é pequeno (<1000). sqlite-vss é otimização futura.
 *
 * RN-154 §RAG (duros, testados em test-falatu-rag):
 *  - Só busca em memória CONFIRMADA (F5.1 já garante — só entra na tabela
 *    quando confirm() chama enqueue*).
 *  - Filtro (organization_id, user_id) OBRIGATÓRIO — cross-tenant é bug de
 *    segurança (convenção nº 1 do CLAUDE.md).
 *  - System prompt injetado é ROTULADO como "contexto histórico" e instrui
 *    explicitamente a NÃO inventar fatos — se a memória contradiz a entrada,
 *    prevalece a entrada (RN-151 "não invente").
 *  - Best-effort: qualquer erro no RAG (embed falha, DB down) NUNCA impede a
 *    captura — devolve "" e a interpretação segue sem preamble.
 *
 * Guardrails RN-154 (duros, testados):
 *  §4 (RAG): só gera sobre conteúdo CONFIRMADO — hook só é chamado no
 *     confirm() e o handler dupla-checa `status='confirmed'` (pending nunca
 *     alimenta memória).
 *  §7 (multi-tenant): TODA query filtra (organization_id, user_id). A
 *     assinatura tipada de `enqueue*` obriga passagem — sem contexto, o
 *     compilador rejeita.
 *  §5/§7 (opt-in): checa `organization_settings.falatu_rag_enabled` antes
 *     de enfileirar. Skip silencioso se desligado (não é erro).
 *  Convenção §7 (best-effort): erros NUNCA propagam pro FalaTuService.confirm
 *     — o RAG é feature nova e não pode derrubar o fluxo canônico.
 *  ai_usage_log (F1.1): custo do embedding é atribuído à org via
 *     setUsageContext no handler — auditoria correta sem trabalho extra.
 *
 * Modelo default: 'text-embedding-3-small' (1536-dim) — mesmo do llm.ts.
 * Serialização: Float32Array → Buffer (bytes), NÃO JSON de doubles (6x
 * menor + sem drift). Deserialização é fácil de recuperar quando a F5.2
 * fizer busca por cosseno.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { JobQueueService, JobQueueError } from "./JobQueueService.js";
import { setUsageContext } from "./usageContext.js";
import { cosineSimilarity, topKBySimilarity } from "./vectorSimilarity.js";

export type EmbeddingSourceType = "entity" | "note";

export interface EmbeddingRow {
  id: string;
  organization_id: string;
  user_id: string;
  source_type: EmbeddingSourceType;
  source_id: string;
  content_snippet: string;
  embedding: Buffer;
  model: string;
  created_at: string;
}

// Tipos dos payloads dos jobs — tipagem forte pra o compilador rejeitar
// chamada sem contexto multi-tenant (guardrail RN-154 §7).
interface EmbedJobPayload {
  organizationId: string;
  userId: string;
  sourceType: EmbeddingSourceType;
  sourceId: string;
}

const EMBED_JOB_ENTITY = "falatu_embed_entity";
const EMBED_JOB_NOTE = "falatu_embed_note";
const DEFAULT_MODEL = "text-embedding-3-small";

export class FalaTuMemoryEmbeddingsService {
  /** A org ligou RAG? Opt-in explícito — default é 0. */
  static isEnabled(orgId: string): boolean {
    try {
      const r = db
        .prepare(`SELECT falatu_rag_enabled FROM organization_settings WHERE organization_id = ?`)
        .get(orgId) as { falatu_rag_enabled?: number } | undefined;
      return !!Number(r?.falatu_rag_enabled);
    } catch {
      return false;
    }
  }

  /** Setter (Fase 3 UI vai usar; F5.1 expõe pra testes + rota admin futura). */
  static setEnabled(orgId: string, enabled: boolean): { enabled: boolean } {
    db.prepare(`UPDATE organization_settings SET falatu_rag_enabled = ? WHERE organization_id = ?`).run(enabled ? 1 : 0, orgId);
    return { enabled };
  }

  /**
   * Enfileira embedding pra uma entidade que acabou de ser materializada no
   * confirm(). Best-effort: se a org não ligou RAG, no-op silencioso. Se o
   * enqueue falhar (DB fora), engole erro — RAG NUNCA pode derrubar confirm.
   */
  static enqueueForEntity(orgId: string, userId: string, entityId: string): void {
    if (!this.isEnabled(orgId)) return;
    try {
      const payload: EmbedJobPayload = {
        organizationId: orgId, userId, sourceType: "entity", sourceId: entityId,
      };
      JobQueueService.enqueue(EMBED_JOB_ENTITY, payload, { organizationId: orgId });
    } catch (e) {
      console.error("[FalaTuMemoryEmbeddings] Falha ao enfileirar embedding de entidade:", e);
    }
  }

  /**
   * Enfileira embedding pra uma nota (inbox item) confirmada. Aplica pra
   * TODOS os kinds (task/event/list/note/etc) — o que interessa pra RAG é o
   * texto livre, não o intent estruturado.
   */
  static enqueueForInboxItem(orgId: string, userId: string, inboxItemId: string): void {
    if (!this.isEnabled(orgId)) return;
    try {
      const payload: EmbedJobPayload = {
        organizationId: orgId, userId, sourceType: "note", sourceId: inboxItemId,
      };
      JobQueueService.enqueue(EMBED_JOB_NOTE, payload, { organizationId: orgId });
    } catch (e) {
      console.error("[FalaTuMemoryEmbeddings] Falha ao enfileirar embedding de nota:", e);
    }
  }

  /**
   * Serializa vetor 1536-dim em bytes (Float32Array → Buffer). Reversível
   * via `deserializeEmbedding` na F5.2. Falha explicitamente se o vetor tem
   * NaN/Infinity — protege a busca por cosseno contra divisão por zero.
   */
  static serializeEmbedding(vec: number[]): Buffer {
    if (!Array.isArray(vec) || vec.length === 0) throw new Error("Embedding vazio");
    const f32 = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i++) {
      const v = Number(vec[i]);
      if (!Number.isFinite(v)) throw new Error(`Embedding com valor inválido no índice ${i}: ${vec[i]}`);
      f32[i] = v;
    }
    return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
  }

  /** Reverte serializeEmbedding — leitura pela F5.2. */
  static deserializeEmbedding(buf: Buffer): number[] {
    // ArrayBuffer real (não compartilhado com o pool do Node) evita ler bytes
    // de outros Buffers ao passar por Float32Array.
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return Array.from(new Float32Array(ab));
  }

  /**
   * Handler do job de entidade: lê a entidade, monta content_snippet (name +
   * context), chama llm.embed sob contexto de usage (custo vai pra org
   * certa no ai_usage_log via F1.1), grava linha ou atualiza embedding.
   */
  static async processEntityJob(payload: EmbedJobPayload): Promise<void> {
    const { organizationId, userId, sourceId } = payload;

    // Multi-tenant filter obrigatório — SEM ele isso é bug de segurança.
    const entity = db
      .prepare(`SELECT id, name, context FROM falatu_entities WHERE id = ? AND organization_id = ? AND user_id = ?`)
      .get(sourceId, organizationId, userId) as { id?: string; name?: string; context?: string } | undefined;
    if (!entity?.id) {
      // Entidade sumiu entre enqueue e run (rare — LGPD delete race). Não é
      // erro do RAG; marca no-op non_retryable pro job sair da fila.
      throw new JobQueueError(`Entidade ${sourceId} não encontrada (org ${organizationId}/user ${userId})`, "non_retryable");
    }

    const snippet = [entity.name, entity.context].filter(Boolean).join(" — ").trim();
    if (!snippet) throw new JobQueueError("Entidade sem texto pra embedding", "non_retryable");

    await this.embedAndStore(organizationId, userId, "entity", entity.id, snippet);
  }

  /**
   * Handler do job de nota: lê o inbox item, valida `status='confirmed'`
   * (RN-151 §4 — pending NUNCA gera embedding, mesmo se o hook errar), monta
   * snippet do texto mais rico disponível (summary → transcription → content),
   * gera + grava.
   */
  static async processNoteJob(payload: EmbedJobPayload): Promise<void> {
    const { organizationId, userId, sourceId } = payload;

    const item = db
      .prepare(`SELECT id, status, summary, transcription, content FROM falatu_inbox_items WHERE id = ? AND organization_id = ? AND user_id = ?`)
      .get(sourceId, organizationId, userId) as { id?: string; status?: string; summary?: string; transcription?: string; content?: string } | undefined;
    if (!item?.id) throw new JobQueueError(`Inbox item ${sourceId} não encontrado`, "non_retryable");

    // Guardrail RN-151 §4 duplo — o hook só é chamado no confirm(), mas se
    // por qualquer razão (backfill futuro, teste, race) chegar aqui pending
    // ou discarded, ABORTA (memória confirmada é única coisa que vai pro RAG).
    if (item.status !== "confirmed") {
      throw new JobQueueError(`Inbox item ${sourceId} status='${item.status}' — RAG exige 'confirmed'`, "non_retryable");
    }

    const snippet = (item.summary || item.transcription || item.content || "").trim();
    if (!snippet) throw new JobQueueError("Inbox item sem texto pra embedding", "non_retryable");

    await this.embedAndStore(organizationId, userId, "note", item.id, snippet);
  }

  /**
   * Fluxo comum entity+note: chama llm.embed sob contexto tipado e faz
   * upsert em falatu_memory_embeddings. Único ponto de I/O pra IA — se cair,
   * o JobQueue faz backoff exponencial (retryable é o default).
   */
  static async embedAndStore(
    orgId: string, userId: string, sourceType: EmbeddingSourceType, sourceId: string, snippet: string,
  ): Promise<void> {
    // Import dinâmico do llm pra permitir mock em teste (mesmo padrão do
    // FalaTuService.interpret — ver FalaTuService.ts:151).
    const llm = await import("./llm.js");
    if (!llm.isAIConfigured()) throw new JobQueueError("OPENAI_API_KEY ausente", "permission");

    // ai_usage_log recebe (orgId, userId, module='falatu') via AsyncLocalStorage.
    setUsageContext({ orgId, userId, module: "falatu" });
    const vectors = await llm.embed([snippet]);
    const vec = vectors[0];
    if (!vec || vec.length === 0) throw new JobQueueError("embed() devolveu vetor vazio", "retryable");

    const buf = this.serializeEmbedding(vec);
    const model = llm.EMBED_MODEL || DEFAULT_MODEL;
    // UPSERT via ON CONFLICT (UNIQUE em org+user+type+id+model): re-run do
    // job (backoff) NÃO duplica; re-embed com o mesmo modelo apenas atualiza.
    db.prepare(`
      INSERT INTO falatu_memory_embeddings (id, organization_id, user_id, source_type, source_id, content_snippet, embedding, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (organization_id, user_id, source_type, source_id, model)
      DO UPDATE SET content_snippet = excluded.content_snippet, embedding = excluded.embedding, created_at = CURRENT_TIMESTAMP
    `).run(randomUUID(), orgId, userId, sourceType, sourceId, snippet, buf, model);
  }

  /** Consulta multi-tenant — usada por testes + F5.2. */
  static listForUser(orgId: string, userId: string): EmbeddingRow[] {
    return db
      .prepare(`SELECT * FROM falatu_memory_embeddings WHERE organization_id = ? AND user_id = ? ORDER BY created_at DESC`)
      .all(orgId, userId) as EmbeddingRow[];
  }

  // ============================================================
  // F5.2 — busca top-K + montagem do bloco <memoria_relevante>
  // ============================================================

  /**
   * Chama llm.embed com o texto da query e devolve o vetor (ou null se IA
   * não configurada / vazio). Método próprio pra ser mockável em teste
   * (ESM não permite mutar o binding `llm.embed` — mesmo padrão de
   * embedAndStore em F5.1).
   */
  static async embedQuery(text: string): Promise<number[] | null> {
    const llm = await import("./llm.js");
    if (!llm.isAIConfigured()) return null;
    const vecs = await llm.embed([text]);
    return vecs[0] || null;
  }

  /**
   * ADR-160 F9 — delega pro primitivo ÚNICO de similaridade (dedup de RAG).
   * Mantido como método estático porque é API pública (testes + F5.2 chamam
   * `.cosine`); a matemática (single-pass, guardas de dim/norma) mora só em
   * vectorSimilarity.ts.
   */
  static cosine(a: number[], b: number[]): number {
    return cosineSimilarity(a, b);
  }

  /**
   * Busca top-K memórias mais similares a `queryText` pra (orgId, userId).
   * Passos:
   *   1) Embed do queryText via llm.embed — custo atribuído à org via
   *      setUsageContext (o caller precisa já ter setado — capture() faz).
   *   2) Carrega TODOS os embeddings do (org, user) — filtro obrigatório.
   *   3) Deserializa e computa cosseno em JS (fallback aceitável — <1000
   *      embeddings por usuário no volume esperado).
   *   4) Ordena desc por score, devolve top K.
   *
   * Retorna [] se: RAG desligado, queryText vazio, sem embeddings, ou erro
   * (best-effort — F5.2 nunca pode derrubar interpret).
   */
  static async searchTopK(
    orgId: string, userId: string, queryText: string, k = 5,
  ): Promise<Array<{ sourceType: EmbeddingSourceType; sourceId: string; snippet: string; score: number }>> {
    if (!this.isEnabled(orgId)) return [];
    const q = (queryText || "").trim();
    if (!q) return [];

    try {
      const rows = db
        .prepare(`SELECT source_type, source_id, content_snippet, embedding FROM falatu_memory_embeddings WHERE organization_id = ? AND user_id = ?`)
        .all(orgId, userId) as Array<{ source_type: EmbeddingSourceType; source_id: string; content_snippet: string; embedding: Buffer }>;
      if (rows.length === 0) return [];

      // Custo do embed da query vai pro ai_usage_log com module='falatu' e
      // (orgId, userId) — o caller (capture) já setou o contexto; reafirma
      // aqui pra ficar defensivo caso F5.2 seja chamada por outro caminho.
      setUsageContext({ orgId, userId, module: "falatu" });
      const qvec = await this.embedQuery(q);
      if (!qvec || qvec.length === 0) return [];

      // ADR-160 F9 — ranqueamento pelo primitivo ÚNICO (dedup de RAG). A
      // desserialização BLOB→vetor fica aqui (formato próprio deste store); o
      // top-K é o mesmo do RAG canônico. Piso de 1 preserva o contrato anterior.
      return topKBySimilarity(
        qvec,
        rows,
        (r) => this.deserializeEmbedding(Buffer.from(r.embedding)),
        Math.max(1, k),
      ).map(({ item, score }) => ({
        sourceType: item.source_type,
        sourceId: item.source_id,
        snippet: item.content_snippet,
        score,
      }));
    } catch (e) {
      console.error("[FalaTuMemoryEmbeddings] searchTopK falhou (best-effort — segue sem RAG):", e);
      return [];
    }
  }

  /**
   * Monta o bloco `<memoria_relevante>` pra prepend no system prompt de
   * interpret(). Se não há memória (RAG off, queryText vazio, top-K vazio),
   * devolve "". O bloco carrega o guardrail RN-154 EXPLÍCITO — "contexto
   * histórico", "prevalece a entrada", "não invente" — pra a LLM não tratar
   * memória como verdade ao contradizer o pedido novo do usuário.
   */
  static async buildRelevantMemoryBlock(
    orgId: string, userId: string, queryText: string, k = 5,
  ): Promise<string> {
    const hits = await this.searchTopK(orgId, userId, queryText, k);
    if (hits.length === 0) return "";
    const items = hits
      .map((h, i) => `${i + 1}. [${h.sourceType}] ${h.snippet.replace(/\s+/g, " ").trim().slice(0, 240)}`)
      .join("\n");
    return [
      "<memoria_relevante>",
      "Contexto histórico do usuário (memória do FalaTu — para consulta, não é o pedido atual):",
      items,
      "Regras rígidas:",
      "- Se a memória contradiz a entrada do usuário, PREVALECE a entrada — nunca corrija o usuário a partir da memória.",
      "- NUNCA invente fatos usando esta memória: ela é referência, não fonte de verdade nova.",
      "- Se a entrada NÃO cita algo desta memória, NÃO puxe pra dentro do JSON de saída.",
      "</memoria_relevante>",
    ].join("\n");
  }
}

// Registra handlers ao carregar o módulo (mesmo padrão de
// StorefrontLookGenerationService.ts / FashionTryOnService.ts). O
// import side-effect é feito por server.ts no boot.
JobQueueService.registerHandler(EMBED_JOB_ENTITY, async (payload) => {
  await FalaTuMemoryEmbeddingsService.processEntityJob(payload);
  return { ok: true };
});
JobQueueService.registerHandler(EMBED_JOB_NOTE, async (payload) => {
  await FalaTuMemoryEmbeddingsService.processNoteJob(payload);
  return { ok: true };
});
