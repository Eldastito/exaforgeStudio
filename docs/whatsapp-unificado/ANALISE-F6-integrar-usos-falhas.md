# F6.0 — Auditoria de Integração dos Usos + Falhas Parciais (RF-08 / CA-08 / CA-10)

> Abertura da **Fase 6** no mesmo espírito da F0/F3.0/F4.0/F5.0: **revalidar o que
> existe antes de mexer**. Doc-only. Referências `arquivo:linha` no HEAD.

## Contexto

A Fase 6 (RF-08, PRD §14 + §18.6) **liga** o que as fases anteriores construíram e
valida as falhas parciais. Duas frentes:
1. **Todo produtor automático declara finalidade** (RF-03/RF-08) — pra que o gate
   de finalidade (F2.4) realmente se aplique e nenhum produtor consiga **ignorar um
   uso desativado** (Gate G6).
2. **Entrada durável + envio idempotente + falhas distinguíveis** (CA-08) e **falha
   observável sem vazar token/segredo** (CA-10).

A Fase 6 **não** reescreve regra de domínio (§F6.1 "sem alterar regras de domínio"):
ela faz cada produtor **passar pelo resolvedor único** e **declarar sua finalidade**.

## O que JÁ existe (reusar, não reconstruir)

### Gate de finalidade — `ChannelBindingService` (F2.2/F2.4)
`src/server/ChannelBindingService.ts`:
- `resolve(orgId, featureKey, {unitId?, direction?})` (`:102`) — **resolvedor único**,
  read-only, **nunca lança**; devolve `BindingDecision` com `code` (`resolved` ·
  `no_binding` · `feature_disabled` · `channel_unavailable` · `org_missing`).
  Precedência UNIT→ORG→fallback, `priority DESC`, revalida `channelUsable`.
- `assertOutboundAllowed(orgId, featureKey?, {unitId?})` (`:245`) — o **gate de saída**:
  lança `OutboundFeatureDisabledError` (`:38`) SÓ quando `resolve().code ===
  "feature_disabled"`. Sem `orgId`/`feature` → passa (`:247`).
- `KNOWN_FEATURES` (`:52`): `atendimento, gestao, campanhas, cobranca, agenda,
  prospeccao, recompra, satisfacao, clinica, escola`.
- Tabela `channel_feature_bindings` (`db.ts:11417`), `upsert`/`remove`/`list`.
- **Gate plugado no SINK**: `MessageProviderService.ts:45` (sendMessage) e `:223`
  (sendDocument) — `if (channel.organization_id && opts?.feature)
  assertOutboundAllowed(...)`. **Opt-in por `feature`**: sem `feature` → não passa
  pelo gate; com `feature` mas sem binding → `no_binding` → passa (0-regressão).
- Testes: `test:channel-binding` (resolvedor) · `test:channel-binding-gate` (sink) ·
  `test:channel-binding-migration`.

### Modo misto — `MixedModeInboundService`/`MixedModeRouterService` (F3.3b)
Flag `organization_settings.mixed_mode_enabled` (`db.ts:11481`, **default 0**), lida em
`MixedModeInboundService.isEnabled` (`:28`); checada no inbound em
`webhookProcessor.ts:254` (flag off → nem entra, 0-regressão; fail-open pra
atendimento). Testes `test:mixed-mode-router`/`-inbound`.

### Durabilidade de entrada (RF-08) — JÁ resolvido
- **Dedup de webhook** `claimWebhookEvent(provider, eventId)` (`webhookSecurity.ts:89`)
  ligado nos **3 caminhos** de inbound no `server.ts`: Evolution (`:879`), Payment
  (`:1160`), Meta/Cloud + Instagram (`:1343`, F1.2a). Sem `messageId` confiável →
  não deduplica (documentado `server.ts:1339`). Testes `test:security-webhook`,
  `test:meta-webhook-dedup`.
- **Fila de jobs** `JobQueueService` — retry/`maxAttempts` (default 3, `:55`),
  backoff exponencial (`:40`), **taxonomia de erro** `JobErrorClass`
  (`retryable`/`external_unavailable`/`permission`/`non_retryable`, `:27`),
  `sweepStale` (`:114`), `deadLetters` (`:181`), `retry` (`:163`). Teste `test:job-queue`.
- **Camada de entrega durável** `MessageDeliveryService` — at-least-once com
  pre-claim lease (`:141`), `provider_message_id`/wamid (`:163`), `markProviderStatus`
  idempotente (`:223`); atrás da flag `CONTINUITY_DELIVERY_QUEUE_ENABLED` (default
  OFF, `:75`). Detecção de canal degradado `degradedChannels` (`:263`) +
  `checkChannelHealth` → `NotificationService.push` com dedupe (`:281`). Alertas só
  contagem/`channelId`/`errMsg.slice(0,180)` — **nunca token** (`token_encrypted`
  nunca entra nesses caminhos). Testes `test:delivery-receipts`, `test:channel-health`.

## Gaps da Fase 6 (o que FALTA)

| Fatia | O que o PRD pede | Estado hoje | Gap |
|---|---|---|---|
| **F6.1** | Migrar produtores remanescentes pra **seleção por finalidade** (§F6.1), sem mexer em regra de domínio | Gate existe e é testado, mas **só 1 de ~40 pontos de envio passa `feature`** — e esse (`FileDeliveryService.ts:97`) usa `"falatu"`, que **não** é `KNOWN_FEATURE` → `no_binding` permanente (gate no-op). `MessageDeliveryService.ts:54` **DESCARTA** o `feature` no caminho assíncrono. | Falta: (a) **carregar a finalidade pela fila** (parar de descartar em `MessageDeliveryService`); (b) **vocabulário de finalidade** que cubra os produtores (ex.: relatórios/documentos do Fala Tu); (c) migrar os produtores em grupos declarando a finalidade certa. Gate G6: "nenhum produtor automático ignora uso desativado". |
| **F6.2** | Consolidar entrega + dedup + **timeout/falha parcial** + política na execução (§F6.2, CA-08) | Fila de jobs já distingue permanente/transitório; **camada de envio de canal NÃO classifica** (retry uniforme até `MAX_ATTEMPTS` → `failed`, `MessageDeliveryService.ts:153`); **sem chave idempotente do chamador** no sink (`sendMessage`/`sendDocument` é fire-and-forget). | Falta: **taxonomia permanente/transitório/desconhecido** no envio de canal + **chave idempotente** de comando na entrega (reconciliar em "resultado desconhecido" antes de repetir — CA-08). |
| **F6.3** | Verificar **guardas por domínio** (marketing/cobrança/agenda/clínica/escola/varejo/prospecção + demais) (§F6.3) | Produtores de domínio existem mas **nenhum** declara finalidade; a finalidade certa por produtor ainda não está mapeada. | Falta: mapear e migrar cada grupo de domínio pra sua `feature` (`cobranca`/`agenda`/`clinica`/`escola`/`campanhas`/`prospeccao`/`recompra`/`satisfacao`) + provar que "interno" não burla guarda (§14). |
| **F6.4** | Saúde/métricas/auditoria + **CA-10** + regressões + teste de carga do piloto (§F6.4) | `degradedChannels`/`checkChannelHealth` existem; **sem taxonomia de etapa** (qual canal × qual etapa falhou) exposta ao operador; sem teste de carga representativo. | Falta: **CA-10** (operador vê canal+etapa sem token; usuário vê mensagem prática + recuperação) + métricas mínimas (§18.6) + regressão de outros canais + carga representativa. Fecha **Gate G6**. |

## Achados que orientam o recorte

1. **O gate é opt-in por `feature` no sink** — não há flag org-level ligando/desligando
   o sistema de binding. A "ativação" da Fase 6 é fazer **cada produtor passar sua
   finalidade**; sem isso o gate nunca se aplica (Gate G6). Se o piloto quiser um
   *kill-switch* org-level, ele **não existe** hoje (decisão pra F6.4/F7, se necessário).
2. **`MessageDeliveryService.ts:54` descarta `feature`** — mesmo que um produtor
   declare a finalidade, o caminho assíncrono a perde. **Pré-requisito** de qualquer
   migração: a fila precisa carregar a finalidade ponta a ponta.
3. **`"falatu"` não é `KNOWN_FEATURE`** — o único caller que declara finalidade hoje
   usa uma chave inválida (no-op). O vocabulário precisa cobrir o uso real (relatórios/
   documentos de gestão) — ou mapear pra `gestao`.
4. **Não mexer em regra de domínio** (§F6.1) — a migração é **só** rotear pelo
   resolvedor + declarar finalidade; nada de mudar quando/como cada produtor envia.
5. **Durabilidade de entrada já OK** (dedup nos 3 caminhos, fila com DLQ) — o que
   falta em CA-08 é a **idempotência de saída** + taxonomia de resultado (F6.2).
6. **CA-10 sem vazamento** — os alertas atuais já são token-safe; falta expor
   **canal + etapa** da falha ao operador e a **ação de recuperação** ao usuário (F6.4).

## Recorte proposto (fatia-por-PR)

- **F6.0** — esta auditoria (doc-only). ✅
- **F6.1** — **fundação da finalidade**: (a) `MessageDeliveryService` passa a
  **carregar** o `feature` pela fila (para de descartar); (b) vocabulário de finalidade
  cobre o uso de relatórios/documentos (corrige o `"falatu"`); (c) migra o **1º grupo**
  (núcleo Fala Tu/gestor + entrega de arquivo F5) pra declarar finalidade. Teste
  `test:feature-routing-falatu`. Sem tocar regra de domínio.
- **F6.2** — **entrega/dedup/timeout**: taxonomia permanente/transitório/desconhecido
  no envio de canal + chave idempotente de comando na entrega (reconciliar antes de
  repetir — CA-08). Teste de falha parcial.
- **F6.3** — **guardas por domínio**: migra os grupos de domínio (cobrança/agenda/
  clínica/escola/varejo/prospecção/campanhas) pra sua `feature`; prova que "interno"
  não burla guarda; regressão por domínio.
- **F6.4** — **saúde/CA-10/carga**: operador vê canal+etapa sem token; usuário vê
  mensagem prática + recuperação; métricas mínimas; regressão de outros canais; carga
  representativa do piloto. Fecha **Gate G6 (CA-08 + CA-10)**.

## Guardrails (não regredir)

- **0-regressão** — produtor sem `feature` e org sem binding continuam passando; a
  migração é aditiva e reversível.
- **Sem mexer em regra de domínio** (§F6.1) — só roteamento + declaração de finalidade.
- **Isolamento multi-tenant** — `orgId` 1º arg; binding por org; dedup por org.
- **Token-safe** (CA-10) — nenhuma superfície de falha expõe `token_encrypted`, QR de
  outra empresa ou conteúdo confidencial.
- **Determinístico antes de IA** — resolvedor e taxonomia rodam em CI sem chave de IA.
- **Sem 2ª fila/ledger/alerta** — reusa `JobQueueService`/`MessageDeliveryService`/
  `business_signals`; nada de mecanismo paralelo.
