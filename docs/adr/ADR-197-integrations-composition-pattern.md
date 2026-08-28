# ADR-197 — Integrations: composição por conector (não fábrica abstrata)

**Estado:** decisão retrospectiva — documenta o padrão que o repo já pratica há tempo. Fecha o `blocked_reason` do `INTEGRATION_FACTORY` no Product Evolution Ledger: **decisão entre reengenharia da tabela `integrations` ou pacote novo → nenhum dos dois; composição por conector com utilitários compartilhados.**
**Data:** 2026-08-28.
**Natureza:** ADR de design pattern (não introduz código). Consolida a decisão de arquitetura que informa toda integração externa do monolito e serve de referência pros próximos conectores (Meta Ads, TikTok Business, LinkedIn, X, ERP genérico, etc.).

---

## 1. Contexto

O repo tem hoje uma dezena de integrações externas ativas — Google Workspace (OAuth), Instagram OAuth, Meta webhook, WhatsApp Cloud/Web, Alterdata (ERP), backup S3-like, webhooks de terceiros. Cada uma é implementada como **service próprio** (`GoogleOAuthService`, `InstagramService`, `AlterdataConnectorService`, `ReputationConnectorService`, `BackupService`, `WhatsAppCloudService`, etc.), com rotas montadas em `routes/integrations.ts` (~560 linhas) ou em routes dedicadas (`instagramOAuth.ts`, `webhooks.ts`, `wa.ts`).

O Ledger anotou isso como "sem fábrica abstrata — cada conector é service+route dedicado" e listou como blocker: "decisão pendente entre reengenharia da tabela `integrations` ou pacote novo".

Este ADR responde: **manter o padrão atual — composição por conector, sem fábrica abstrata.** Formaliza os motivos e o guardrail pra próximos conectores.

## 2. Decisões (D1–D6)

### D1 — Composição por conector (não fábrica)

**Cada integração externa é um `<Provider>Service.ts` + rota (própria ou compartilhada em `routes/integrations.ts`).** Não construir uma classe abstrata `IntegrationConnector<Config>` nem um registry runtime dinâmico.

**Motivo**: as ~10 integrações atuais divergem em quase todos os eixos que a fábrica abstrairia:
- **auth** (OAuth server-side com refresh, OAuth device flow, API key, HMAC webhook, mTLS/EFT bancário)
- **shape do estado** (Google guarda tokens+scopes+quotas, Alterdata guarda cursor+lastRunAt+config, WhatsApp Cloud guarda phone_number_id+webhook_verify_token)
- **cadência** (sync scheduled por cron, webhook push, request-response por chamada do agente)
- **UI de status** (alguns têm dashboard próprio no Studio, outros são invisíveis)
- **RN de compliance** (Google/Instagram têm gate LGPD `dados_pessoais`; bancário tem gate BACEN; Alterdata é B2B sem PII)

Uma "fábrica" tentaria uniformizar essas dimensões e viraria ou (a) um contrato mínimo que cada conector sobrescreve inteiro — inútil, ou (b) uma engine complexa que 8 dos 10 conectores contornam com escape hatches — pior que o estado atual.

### D2 — Tabela `integrations` (`db.ts:252`) é **cache leve, não system-of-record**

Colunas `(id, organization_id, type, config_json, active, created_at)` — deliberadamente esparsa. Cada conector é responsável pelo seu próprio schema (via ALTER aditivo ou tabelas dedicadas — Alterdata tem `alterdata_sync_state`, Google tem `oauth_connections` global, WhatsApp Cloud tem colunas em `channels.metadata_json`).

`integrations.type` é uma etiqueta que a UI usa pra decidir o que renderizar. Não é chave que restringe implementação. **Não reengenheirar essa tabela** — o que ela guarda hoje já é pouco e a extensão vem por schema próprio do conector, seguindo `CREATE-then-ALTER estrito` do CLAUDE.md.

### D3 — Rota montada onde faz sentido, não onde a "fábrica" mandaria

- OAuth server-side (Google, Instagram) → rotas dedicadas com callback público — `instagramOAuth.ts`, seção `/google/*` em `routes/integrations.ts`.
- Webhooks externos → `routes/wa.ts`, endpoints `/webhooks/*` — cada provider valida assinatura à sua maneira.
- Sync scheduled (Alterdata, backup S3) → rotas admin dentro de `routes/integrations.ts` ou `routes/admin.ts`.
- Chamadas do agente (busca de produto na Alterdata) → **não expor rota** — o service é chamado direto pelo agente/orchestrator.

**Nenhuma dessas superfícies deve mudar por "consistência da fábrica"** — o custo de refactor supera qualquer economia de manutenção.

### D4 — Utilitários horizontais compartilhados, sem base class

Onde há mecânica repetida entre conectores, extrair pra utilitário puro (função ou singleton), não pra classe base:

- **OAuth refresh loop** — cada service resolve seu próprio (Google/Instagram têm padrões diferentes). Se aparecer o 3º conector OAuth padrão IETF idêntico, extrair então.
- **Retry com backoff** — já vive em vários lugares (WhatsApp cloud usa fetch nativo com retry manual; JobQueueService tem sua própria retry policy). Se virar padrão em 3+ conectores, extrair pra `src/server/lib/backoffRetry.ts`.
- **Cache de bearer token com TTL** — hoje inline em cada service. Extrair só se 3+ compartilharem exatamente o mesmo padrão.
- **HMAC signature verification** — já compartilhado em `webhookSecurity.ts`.
- **JobQueueService** — já é o mecanismo horizontal pra background work de qualquer conector (Alterdata sync usa).

### D5 — Pacote novo (`packages/integrations-*`) fica pra depois

Extrair conectores pra apps/packages separados requer boundary de deploy próprio, versionamento, publish, etc. Custo alto pra ganho baixo enquanto o monolito atende. **Reavaliar quando:**
- Um conector precisar rodar em processo separado (ex.: WhatsApp Web usa processo Chromium; hoje spawnado do main; se virar micro-serviço, sim justifica package).
- Um cliente pedir integração custom SEM re-deploy do monolito (então packages com plugin loader viram valor).
- O time de integrações separar-se do time do core.

Nenhum desses cenários é iminente.

### D6 — Novos conectores seguem o padrão declarado nas RNs abaixo

Quando entrar Meta Ads, TikTok Business, LinkedIn, X (mencionados em `SOCIAL_PROVIDERS.blocked_reason`), ou qualquer conector novo, seguir o walkthrough da §4 abaixo, não inventar padrão próprio.

## 3. Guardrails / invariantes (RN-INT-01..05)

1. **RN-INT-01 — Um conector = um service `<Provider>Service.ts`**. Não fatiar em N services só porque tem múltiplos endpoints externos; o service resolve o SDK/HTTP e expõe métodos de alto nível pra rotas/agente.
2. **RN-INT-02 — Multi-tenant desde a linha 1**. Todo método público recebe `orgId` como primeiro arg. Storage por org (via `organization_id` na tabela dedicada ou em `integrations.config_json` da row correspondente).
3. **RN-INT-03 — Credenciais NUNCA em `config_json` cru**. Tokens/secrets vão em `oauth_connections` (cifrados em transit + at-rest onde a infra suportar) ou em coluna `token_encrypted` dedicada (padrão `channels.token_encrypted`). `config_json` é pra config não-sensível (webhook_id, endpoint URL, feature flags).
4. **RN-INT-04 — Falha externa é sinal, não crash**. Todo conector emite `business_signals` (ADR-136) quando falha crítica — nunca `console.error` mudo; nunca tabela de alertas paralela.
5. **RN-INT-05 — Rota respeita o gate de plano**. Se a integração é premium/add-on, gate no `routes/*` via `requireRole` ou `PlanService.hasCapability`, não dentro do service — service é reutilizado por caminhos internos (agente, cron) que já rodam autenticados.

## 4. Walkthrough — novo conector

Passos pra adicionar `<Provider>` seguindo o padrão (ex.: hipotético "SlackConnector"):

1. **Criar `src/server/SlackConnectorService.ts`** com métodos estáticos ou classe singleton exportando:
   - `SlackConnectorService.connect(orgId, config)` — persiste credencial + registra row em `integrations` com `type='slack'`.
   - `SlackConnectorService.disconnect(orgId)`
   - `SlackConnectorService.status(orgId): { connected, lastSync, quotaRemaining? }`
   - Métodos de alto nível: `sendMessage(orgId, channel, text)`, `listChannels(orgId)`, etc.
2. **Se OAuth**: nova rota pública `src/server/routes/slackOAuth.ts` com `/slack/callback` (não protegida) + `/slack/status` (protegida).
3. **Se sync scheduled**: registrar job em `JobQueueService` ou seção nova em `routes/integrations.ts` com endpoint `/slack/sync`.
4. **Se webhook inbound**: adicionar handler em `routes/wa.ts` (que já faz isso pra Meta) ou nova rota `/webhooks/slack`.
5. **Se o conector tem estado próprio**: nova tabela `slack_*` no fim de `db.ts` (CREATE-then-ALTER estrito), não estender `integrations`.
6. **Testes**: `scripts/test-slack-connector.ts` seguindo o padrão `tmpDir + check(name, ok) + imports dinâmicos`. Mockar HTTP externo — nunca chamar API real em teste.
7. **Doc**: `docs/integrations/slack-<escopo>.md` com o contrato + limitações conhecidas.
8. **Ledger**: novo item ou source em `INTEGRATION_FACTORY` no seed do PEL.

Nenhuma dessas 8 etapas requer código de fábrica.

## 5. Reuso

- `integrations` (tabela leve) + `oauth_connections` (schema global de OAuth) — já existem.
- `JobQueueService` — background work compartilhado.
- `webhookSecurity.ts` — HMAC helpers.
- `auditLog.ts` — log de eventos importantes.
- `business_signals` (ADR-136) — sinal universal de status/erro.

## 6. Diferidos (nenhum é bloqueador)

- Base class `Connector<Config>` — só quando aparecer o 3º OAuth idêntico.
- Registry runtime dinâmico (`ConnectorRegistry.get(type)`) — só quando plugin loader entrar.
- Packages separados (`packages/integrations-*`) — só quando D5 disparar.
- Refactor da tabela `integrations` — só se novo caso concreto precisar de coluna que não cabe em `config_json`.

## 7. Rollback

ADR doc-only. Nada a reverter. Se o padrão mudar (ex.: aparecer o 3º OAuth idêntico e virar razoável extrair `OAuthConnector<Config>`), ADR-198+ superseding este.

## 8. Fecha

- `INTEGRATION_FACTORY.blocked_reason` no seed — removido; `source_of_truth: "ADR-197"`.
- `INTEGRATION_FACTORY.target_status`: `IMPLEMENTING` → `TESTED` (o padrão está formalizado, cada conector individual tem cobertura própria; upgrade pra `PRODUCTION` fica pra quando houver métrica de adoção — mas o gap "decisão pendente" está resolvido).
