# ADR-073 — JobQueueService — fila em SQLite para trabalho assíncrono

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit. Antes da fila, trabalho pesado rodava dentro do ciclo da própria requisição: um webhook de mensagem do WhatsApp que dispara IA de resposta pode facilmente passar de 30s de latência, tempo suficiente para a Meta marcar o endpoint como instável e começar a suspender entregas. Geração de PDF do relatório gerencial e try-on de moda têm o mesmo perfil: caros, oportunistas, tolerantes a atraso. A fila desacopla o "aceitei o trabalho" do "terminei o trabalho".

---

## Contexto

Por que **SQLite** e não Redis/BullMQ/SQS:

- Deploy do ZappFlow é **single-node por tenant** (um container por hotel/rede). Introduzir Redis dobraria a superfície operacional para resolver um problema que a fila embutida resolve.
- O `db.ts` já é `better-sqlite3` síncrono e transacional. `INSERT` de um job custa < 1ms — enfileirar é essencialmente grátis, e não precisa de outro processo vivo.
- Custo marginal: **zero**. Sem infra extra, sem chave de API, sem SLA de terceiro.

O padrão já existia ad-hoc em `routes/integrations.ts` para o backup (`backup_jobs` + `setImmediate` inline). `JobQueueService` generaliza esse padrão numa única tabela `background_jobs` com **registro de handlers** por tipo (`registerHandler`), `maxAttempts` configurável por enqueue, e status terminal `failed` funcionando como *dead letter* — o job fica no banco com `last_error`, disponível para inspeção e reprocessamento manual via `retry()`.

Consumidores atuais (produção):

- `process_incoming_message` — webhook de mensagem recebida do WhatsApp (`webhookProcessor.ts:56,76`). **Não retry** (`maxAttempts: 1`): mensagem duplicada = resposta duplicada ao cliente final, pior do que perder um retry.
- `generate_manager_pdf` — relatório gerencial diário (`webhookProcessor.ts:35,826`). Retry padrão (3) — idempotente, só gera arquivo.
- `fashion_tryon` — geração de imagem por IA (`FashionTryOnService.ts:204,307`). `maxAttempts: 1` — cada tentativa custa dinheiro no provedor de IA, retry cego duplicaria custo silenciosamente.

## Decisão

**Regras invioláveis do `JobQueueService`:**

1. **Schema:** tabela `background_jobs` com `id` (UUID), `organization_id`, `type`, `payload_json`, `status` (`pending` | `processing` | `completed` | `failed`), `attempts`, `max_attempts`, `last_error`, `result_json`, `started_at`, `completed_at`. Payload é sempre JSON serializado.
2. **`enqueue` nunca bloqueia** o caller: `INSERT` síncrono → `setImmediate(runJob)` → retorna o `id`. O contrato é "aceitei", não "terminei".
3. **Handler registry global:** cada serviço se registra uma vez no boot via `registerHandler(type, fn)`. Job com tipo sem handler vira `failed` com mensagem clara — não trava a fila, não fica em loop.
4. **Retry por política do caller:** `maxAttempts` é decidido no `enqueue`, não no handler. Webhooks de mensagem entram com `1` (não pode duplicar side-effect visível ao cliente); geração de PDF entra com `3` (idempotente); try-on entra com `1` (custo de IA).
5. **Rede de segurança `sweepStale()`** (chamado pelo `Scheduler.fastPass` a cada 5 min): reprocessa jobs `pending` (o `setImmediate` pode nunca ter rodado — reinício do processo entre o `INSERT` e o dispatch) e jobs `processing` travados há mais de `staleMinutes` (default 10) — assinatura de "processo caiu no meio do handler".
6. **Jobs órfãos** (tipo sem handler) falham imediatamente com `last_error` explícito, em vez de ficarem eternamente `pending` esperando um handler que nunca vai chegar.
7. **`retry(jobId)`** só reanima jobs `failed` — zera `attempts`, limpa `last_error`, volta para `pending` e dispara `setImmediate`. Não mexe em `processing` (poderia rodar em paralelo com o worker travado).

## Consequências

**Positivas:**
- Webhook do WhatsApp responde em < 200ms mesmo quando o processamento downstream leva 30s+. Meta não suspende mais.
- Um único ponto de observabilidade (`health()`, `listRecent()`, `listByOrg()`) para todo trabalho assíncrono do produto.
- Sobrevive a reinício: job aceito antes do crash é retomado pelo `sweepStale` no próximo boot, não perdido.
- Isolamento por `organization_id` na consulta — cada tenant só enxerga seus jobs no painel.

**Trade-offs aceitos:**
- **Não escala além de ~N jobs/min** por instância — `better-sqlite3` é single-writer e `setImmediate` roda no mesmo event loop do HTTP. Volume atual (< 100 jobs/min por tenant) está longe do teto; revisitar quando um tenant justificar Redis.
- **Sem prioridade** — FIFO puro. Se um lote de 200 PDFs entrar antes de uma mensagem de WhatsApp, a mensagem espera. Consumidores hoje toleram; a saída, se preciso, é criar tabelas separadas por classe de tráfego antes de sofisticar o scheduler.
- **Sem observabilidade nativa** — nada de Prometheus, tracing, dashboard próprio. `listRecent()` + `health()` alimentam a página `/admin/jobs`; para além disso, `tail -f` no log e `SELECT` no SQLite.
- **Sem *scheduled jobs*** — a fila só dispara em resposta a `enqueue`. Trabalho recorrente (limpeza, relatório diário, `sweepStale` em si) vive no `Scheduler.ts` (ADR separado), que enfileira quando chega a hora.
- **`enqueue` retorna antes do handler rodar** — caller que precise do resultado tem que fazer polling em `get(id)`. É intencional: se você precisa de resposta síncrona, você não queria uma fila.

## Testes

`scripts/test-job-queue.ts` (12 verificações, banco temporário) cobre o contrato inteiro:

- `enqueue` retorna em < 20ms mesmo com handler que dorme (não bloqueia o caller).
- Job de sucesso vira `completed` com `result_json` preenchido e `attempts = 1`.
- Job intermitente (falha 2x, funciona na 3ª) sobe `attempts` a cada passada e conclui — retry funciona.
- Job que sempre falha vira `failed` após esgotar `max_attempts`, com `last_error` legível — *dead letter* de fato.
- Job com tipo sem handler falha imediatamente com mensagem "Nenhum handler registrado", sem travar a fila.
- `sweepStale(10)` reprocessa job `processing` com `started_at` de 20 min atrás (simula crash no meio) e **não** mexe em job `processing` recente (dentro da janela).
- `listByOrg` isola tenants — jobs da org A não aparecem para org B.

Complementarmente, `scripts/test-nfe-signature.ts:96` registra um handler falso de `process_incoming_message` para capturar o payload enfileirado pelo webhook, servindo como teste de integração do lado do produtor.
