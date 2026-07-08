# ADR-067 — geminiRAG — retrieval de conhecimento por embedding

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit de decisão já em código. Sem base de conhecimento, a IA inventa: chuta preço, inventa horário, promete política de troca que não existe. RAG é a única forma de o `AIOrchestratorService` responder pela loja **específica** do tenant — o modelo base não sabe que a Pizzaria do Zé fecha às 23h nem que a devolução é em 7 dias. O módulo entrou em produção com a interface `searchContext()` consumida pelo orquestrador (`AIOrchestratorService.ts:147`) e pelo `generateRagResponse` legado, mas nunca teve ADR. Este documento fecha a lacuna.

---

## Contexto

O nome do arquivo (`geminiRAG.ts`) é histórico: nasceu na fase Gemini e permaneceu por inércia de imports. Hoje o retrieval usa **OpenAI `text-embedding-3-small`** (1536 dimensões) via `llm.embed()` — troca feita quando o custo/qualidade do 3-small superou o `embedding-001` do Gemini a $0,02/M tokens. Renomear o arquivo quebraria dezenas de imports (`AIOrchestratorService`, `routes/knowledge`, `PLANO-MODULO-VOZ-0800`), então o nome fica; a ADR é o lugar onde a discrepância é registrada.

Requisitos:

- **Isolamento por organização** — chunk de um tenant nunca vaza para outro. Toda query filtra por `organization_id` no SQL e no cache in-memory.
- **Isolamento opcional por canal e por área** — a mesma org pode ter WhatsApp e Instagram com documentos distintos; e dentro de um canal, áreas de atendimento (suporte, vendas) podem ter conhecimento próprio. `channel_id = 'global'` e `area_id = NULL` são coringas que valem para tudo.
- **Persistência entre redeploys** — a versão original mantinha vetores só em memória e perdia tudo em cada boot. Hoje o banco é a fonte da verdade.
- **Latência sub-100ms** no caminho quente — a query do embedding via OpenAI já custa ~200ms; não dá pra somar mais 200ms de I/O em cada mensagem.

## Decisão

1. **Modelo:** OpenAI `text-embedding-3-small` (env `OPENAI_EMBED_MODEL`), 1536 dim, custo $0,02/M tokens de input. Suficiente para o volume atual; upgrade para `3-large` (1x flag de env) se qualidade de recall cair.
2. **Storage:** SQLite, tabela `knowledge_chunks(id, organization_id, document_id, channel_id, area_id, chunk_index, content, embedding TEXT)`. O vetor vai como **JSON stringificado** em coluna `TEXT`, não `BLOB`. Menos eficiente por byte, mas debugável com `sqlite3 CLI` e sem dependência de extensão nativa. Índice único: `idx_knowledge_chunks_org` em `organization_id`.
3. **Cache em memória por org:** `orgCache: Map<orgId, DocumentChunk[]>` populado sob demanda no primeiro `searchContext()`. Evita o `JSON.parse` de milhares de embeddings a cada mensagem. Invalidado explicitamente em `processDocument`/`deleteDocument`.
4. **Chunking:** split ingênuo por parágrafo (`\n\s*\n`), sem overlap, sem tokenização por tamanho. Simples e funciona para os PDFs curtos que lojistas mandam (cardápio, FAQ, política).
5. **Similarity search:** cosseno puro em JS (`cosineSimilarity`), full-scan da org, `sort` descendente, `slice(0, topK)`. Default `topK=3`. Sem índice vetorial (nada de sqlite-vss/vec/HNSW).
6. **Filtragem antes do score:** `channel_id === 'global' || === channelId`, e se `areaId` foi passado, aceita `null` (geral) ou match exato. Reduz o N do full-scan.
7. **Fallback sem docs:** `searchContext` devolve `[]`; o orquestrador injeta a string `"Nenhum documento encontrado na base de RAG."` no prompt e a IA responde com o conhecimento geral do modelo (ou transfere pra humano se a regra pedir).
8. **Prompt injection guard** (`isPromptInjection`) — heurística de keywords apenas no fluxo legado `generateRagResponse`. O orquestrador principal não passa por esse guard porque tem sua própria camada.

## Consequências

**Positivas:**
- IA responde com o material real do lojista, sem alucinar preço nem horário.
- Sobrevive a redeploy (SQLite persiste; cache reidrata sob demanda).
- Zero dependência nativa — o código roda em qualquer host que tenha `better-sqlite3` sem exigir build de extensão vetorial.
- Isolamento por org é garantido no SQL, não só no filtro em memória — impossível de "esquecer" no code path.

**Trade-offs aceitos:**
- **Sem hybrid search (BM25 + vetor)** — dúvida com termo raro ("SKU-4291-X") pode falhar no recall porque o embedding suaviza. Aceitável no volume atual de PDFs curtos; revisitar quando um lojista subir catálogo com milhares de SKUs.
- **Sem re-ranking** — top-K vai direto pro prompt. Não usamos cross-encoder pra reordenar. Custo/latência não justifica hoje.
- **Sem chunk overlap** — uma frase quebrada exatamente entre dois parágrafos perde contexto. Overlap ideal (10-20%) fica pra V2; simplicidade agora vale mais que recall marginal.
- **Full-scan O(N) por org** — funciona porque N é pequeno (< 5k chunks/tenant típico). Cai apart quando alguém subir 500 PDFs. Migração pra `sqlite-vec` ou Postgres+pgvector fica anotada como próximo passo.
- **Embedding como JSON string em TEXT** desperdiça ~4x o espaço vs. BLOB de floats. Aceitável enquanto o banco couber em disco; problema real só a partir de milhões de chunks.
- **Single store per query** — cada mensagem faz 1 chamada à OpenAI pra embeddar a query. Sem cache de query embedding (cliente pergunta a mesma coisa 3x → paga 3x). Aceitável a $0,02/M tokens.

## Testes

**Cobertura direta hoje: nenhuma.** Não existe `scripts/test-gemini-rag.ts` nem `test-knowledge-search.ts`. O que valida o retrieval na prática:

- `AIOrchestratorService` em produção — se `searchContext` devolver lixo, a resposta da IA fica visivelmente ruim e o lojista reclama. Feedback lento, mas real.
- `scripts/test-openai-integration.ts` (se existir na rotina de deploy) — cobre `llm.embed()`, dependência direta do RAG.

**Lacunas honestas** que devem virar `scripts/test-gemini-rag.ts`:
- Isolamento entre orgs: doc da org A não aparece em search da org B, nem no cache in-memory após queries cruzadas.
- Filtro por `channel_id`/`area_id`: doc com `channel_id='whatsapp'` não vaza em search de `channel_id='instagram'`; doc com `area_id=null` aparece em qualquer área; doc com `area_id='vendas'` não aparece em search sem `areaId`.
- `processDocument` → `searchContext` end-to-end: subir texto conhecido, buscar termo do texto, confirmar que o chunk certo volta no top-K.
- Invalidação de cache: `deleteDocument` remove o chunk do resultado de search imediatamente (sem exigir restart).
- Fallback sem docs: org zerada devolve `[]`, não crasha, não loga erro.
- Idempotência de reload: `loadOrgChunks` chamado 2x seguidas devolve a mesma referência (cache hit) e não lê o banco de novo.

Enquanto esses testes não existirem, mudança em `cosineSimilarity`, `splitIntoChunks` ou nas queries SQL exige revisão manual do `AIOrchestratorService` e um teste ponta-a-ponta em staging com um lojista real.
