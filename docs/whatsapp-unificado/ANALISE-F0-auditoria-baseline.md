# PRD WhatsApp Unificado / Fala Tu — Fase 0: auditoria e baseline

> **Estado:** Fase 0 (F0.1–F0.4) — revalidação read-only do HEAD. **Nenhum código de
> produção foi alterado.** Este documento é o entregável de auditoria exigido pela
> §19 do PRD (`docs/prd/PRD-WhatsApp-Unificado-FalaTu-v1.md`) antes de qualquer
> implementação. A retirada de redundância só ocorre depois de migração + validação
> provadas (Fases 4–7).

## Contexto e linha de base

- **Commit auditado pelo PRD:** `836283828df743043772ae479678f2f6a0875d42`.
- **HEAD desta auditoria:** `40508f13f74598549e1bd47cf1d33904fc6d76fc`.
- **Delta HEAD × commit auditado:** apenas 2 PRs — detalhamento de "estoque sem giro"
  na Central de Saúde (#1532) e auto-refresh da Central (#1533). **Nenhum dos dois
  toca** WhatsApp, Evolution, webhook, Fala Tu ou roteamento. Logo a baseline do PRD
  segue válida para todo o escopo aqui.
- **Método:** 4 varreduras read-only paralelas (conexão/Evolution, roteamento/identidade,
  paridade Fala Tu + arquivos, inventário de produtores). Cada achado da §4.1 do PRD
  recebeu veredicto **CONFIRMADO / JÁ CORRIGIDO / NÃO REPRODUZIDO** com evidência
  `arquivo:linha`.

**Resultado global:** dos achados verificados, **todos os de conexão, roteamento e
identidade reproduzem no HEAD**; nenhum estava "já corrigido". O único
"NÃO REPRODUZIDO" é a *existência* de gerador DOCX — que na verdade **confirma** a
lacuna do PRD (DOCX não existe, precisa ser criado). A auditoria ainda achou **2
riscos extras** não listados na §4.1 (token de canal em texto puro; dedup ausente no
inbound Meta/Cloud).

---

## F0.1 — Matriz de achados §4.1 revalidada

Legenda: **C** = CONFIRMADO no HEAD · **NR** = NÃO REPRODUZIDO · **JC** = JÁ CORRIGIDO.

| # | Achado do PRD (§4.1) | Veredicto | Evidência (`arquivo:linha`) |
|---|---|---|---|
| A1 | Gestor autorizado fala pelo canal de atendimento, mas por caminho DIFERENTE do Controller/Fala Tu interno | **C** | `AIOrchestratorService.ts:51,61-62,411` (manager na atenção → `orchestrator_agent` read-only, `actions:[]`) vs caminho interno `webhookProcessor.ts:171,178,205,214,225` (só com `channel.kind='internal'`) |
| A2 | Fala Tu reusa o Diretor para perguntas abertas (não criar outro) | **C** | `FalaTuAskService.ts:325` → `ExecutiveAdvisorService.ask(orgId, q)` |
| A3 | Web usa `converse`; WhatsApp usa `answer` — paridade não garantida | **C** | Web `routes/falatu.ts:106` (`converse`) × WhatsApp `FalaTuWhatsAppService.ts:130` (`answer`). `converse` expõe os pipelines governados `record_*` (`FalaTuAskService.ts:339,431`) que o `answer` **não alcança** |
| A4 | Seleção de `kind` só admite interno/cliente, sem matriz por funcionalidade | **C** | Sem tabela `channel_feature_bindings` em `src/` (0 matches); `channels.kind` só interno/cliente |
| A5 | Consumidores escolhem o "primeiro canal", filtrando só `status != disabled` | **C** | Idiom repetido ~20× (Pattern 1): `Scheduler.ts:181,249,284,313,665,744,1919,1988,2054,2178,2266,2329`, `QuoteService.ts:206`, `PaymentService.ts:615`, `TaskReminderService.ts:129`, `routes/escola.ts:25,109,206`, `routes/admin.ts:471`, `routes/falatu.ts:518`, `routes/health.ts:112` |
| A6 | Saída Evolution prioriza credencial GLOBAL sobre a do canal | **C** | `MessageProviderService.ts:143` `process.env.EVOLUTION_API_KEY || channel.token_encrypted`; `getConfig` env-first `EvolutionService.ts:63-69` |
| A7 | Pareamento legado tem eventos/parser/rotas distintos do serviço novo; pode indicar conexão sem prova | **C** | Legado subscribe **minúsculo** `server.ts:877` × typed **maiúsculo** `EvolutionService.ts:175`; QR em `base64/data.Qrcode/qrcode.base64` `server.ts:917-919`; legado sem auto-heal, retorna 400 `server.ts:977` |
| A8 | webhookProcessor usa identificadores diferentes dos eventos de conexão GO | **C** | Inbound bind por `payload.instance` `server.ts:1113` × eventos GO por `instanceName||instance` `server.ts:1155,1182` |
| A9 | Vínculo legado com `default_org`, config em memória, diagnóstico global | **C** | `default_org` `server.ts:1184,967`; config module-global `server.ts:785-800`; diagnóstico global `webhookSecurity.ts:76-81`, `integrations.ts:188` |
| A10 | URL do pareamento pode divergir da URL protegida (assinada) das integrações | **C** | Legado registra URL **sem** segredo `server.ts:838,876,889`; owner vê URL **assinada** `integrations.ts:185` (`?secret=`) |
| A11 | Recuperação do serviço pode DELETAR/recriar instância por falta de QR sem provar que o reset é apropriado | **C** | `EvolutionService.ts:242-269` — após 3 tentativas de QR vazias + `instanceId`, faz `DELETE /instance/delete/${id}` e recria |
| A12 | PDF/XLSX existem; não há entrega conversacional de XLSX/DOCX pelo WhatsApp; registrar MIME DOCX ≠ gerar DOCX | **C (DOCX) / parcial** | Sem gerador DOCX em `src/` nem lib (`docx`/`officegen`/…); só o mapa MIME→ext `ArtifactService.ts:37`. `FalaTuReportService.ts:19` só `"pdf"\|"xlsx"` |
| A13 | Tarefas/eventos/listas do Fala Tu têm estrutura própria + vínculo opcional; não apagar/pressupor sync | **C** | Silo próprio `falatu_tasks/events/lists` (`FalaTuService.ts:497,512,535`), link opcional `bridged_task_id/bridged_appointment_id/bridged_requisition_id` (`:508,525,555`); edição fica no silo (`completeTask :687`) |

### Achados EXTRA (não estavam na §4.1, mas impactam INV-09 e RF-08)

| # | Achado | Evidência |
|---|---|---|
| X1 | **Token de canal em TEXTO PURO** — a coluna `channels.token_encrypted` sugere criptografia que não acontece. Grava/lê plaintext | Insert legado `server.ts:970-971`; Solo `FalaTuSoloWhatsAppService.ts:135`; leitura direta como bearer `MessageProviderService.ts:89,143`, `InstagramService.ts:22-24`. `EncryptionService` existe e é usado no Alterdata (`db.ts:3739-3740`) mas **nunca** no `channels`. → toca **INV-09** |
| X2 | **Dedup ausente no inbound Meta/Cloud + Instagram** — só logging, sem `claimWebhookEvent`; retry da Meta reprocessa | Path Cloud/IG `server.ts:1360-1481` nunca chama `claimWebhookEvent`; dedup Evolution é message-id-only `webhookSecurity.ts:94-95`. → toca **RF-08/INV-02** |
| X3 | **Identidade: JID vira "telefone" sem validação** — sufixo `@…` e device `:NN` removidos sem checar se sobrou telefone | `server.ts:1109-1110` `split('@')[0].split(':')[0]` sem validação; grupo `@g.us`/LID viram senderId falso. → toca **RF-04/INV-01** |
| X4 | **MIME travado em `application/pdf`** no envio de documento Evolution | `MessageProviderService.ts:190` (sem param MIME), `:228` `mimetype:'application/pdf'` hardcoded → qualquer XLSX/DOCX sai rotulado como PDF. → toca **RF-07 §13.4** |
| X5 | **Diretor `ask(orgId, question)` sem usuário** — panorama org-wide entra no prompt sem projeção por usuário | `ExecutiveAdvisorService.ts:292,295`; chamada sem identidade `FalaTuAskService.ts:325`. → toca **INV-11** |
| X6 | **ArtifactService devolve URL RELATIVA** (sem host) — provider precisa resolver absoluto | `ArtifactService.ts:125` retorna `/api/public/artifacts/...` sem esquema/host. → toca **RF-07 §13.4** |
| X7 | **XLSX sem guarda de fórmula** (`=`,`+`,`-`,`@` no início não neutralizados) | `XlsxService.ts:34,56` (`xmlEscape` só escapa `& < > "`). → toca **RF-07 §13.3** |

---

## F0.2 — Mapa de produtores/consumidores (U01–U36)

**Existência:** os 36 grupos existem no HEAD (`src/server/*` e `src/server/routes/*`);
nenhum renomeado/ausente. Família `Collection*Service` tem 6 serviços +
`CollectionPlaybook.ts` + `CollectionCopy.ts`.

**Seleção de canal — NÃO há resolvedor único.** Há `resolveChannel` re-declarado por
serviço + muito SQL inline copiado. Padrões distintos:

1. **"prefere evolution, primeiro não-disabled"** (dominante, ~20 cópias do MESMO
   SQL) — Scheduler (12×), Quote, Supplier, Payment, TaskReminder, escola, admin,
   falatu, health, Campaign.
2. **contato-primeiro depois org** com `status NOT IN ('disabled','disconnected')` —
   família Clinic (7 serviços, cada um redefine).
3. **valida channelId recebido** (`WHERE id=? AND organization_id=?`) — CollectionPlaybook, RuntimeCommandHandlers, BeautyReviewInvite.
4. **whatsapp-provider + connected-only** — ProspectExecution, Subscription.
5. **provider fixo** (balcao/manual/storefront/falatu/internal/facebook/instagram/evolution) — BalcaoService, BeautyClient, FashionCustomer, FalatuRecordCommandHandler, TaskAudio, Facebook, Instagram, evolutionAvatar.
6. **primeiro-canal frouxo** — SchoolImport, RetailFloorPilot, Radar.
7. **fetch por id (camada de entrega, não seleção)** — webhookProcessor, messages, MessageProvider, edgeCommandHandlers.

**`channel_feature_bindings` (uso por finalidade):** **AUSENTE** — 0 matches em código,
migrations e schema. `ai_enabled` existe só como coluna de `channels`, não como
binding por finalidade. → confirma a necessidade da **RF-03** (fonte única de usos +
resolvedor único).

**5 atalhos `wa.me` (preservar — não viram envio automático):** Comigo confirmação
`ComigoView.tsx:282-288`; Comigo fiado `ComigoCollectionService.ts:50`; vitrine
`routes/storefrontPublic.ts:523`; Fashion Studio `FashionStudio.tsx:304`; Instagram
forward `AIOrchestratorService.ts:227`.

---

## F0.3 — Contrato Evolution (estado e limite de evidência)

**Limite honesto:** esta auditoria **não** tem acesso à Evolution GO real do assinante
(`https://evolutiongo.tesseractauto.com.br`) nem a credenciais/tráfego. O contrato
abaixo é derivado **do código** e das docs públicas citadas na §25 do PRD. A
validação por Swagger da instalação efetiva é **pendente** (Gate G0 permite seguir por
contrato, registrando a validação real como pendente).

Do código, dois clientes coexistem:

| Aspecto | Caminho **typed** (`EvolutionService.ts`) | Caminho **legado** (`server.ts` /api/evolution/*) |
|---|---|---|
| Subscribe de eventos | maiúsculo `["MESSAGE","CONNECTION","QRCODE"]` (`:175`) | minúsculo `["messages","connection"]` (`:877`) |
| QR | tenta N vezes, campos normalizados | `base64 / data.Qrcode / qrcode.base64` (`:917-919`) |
| Auto-heal | **destrutivo** (delete+recreate) `:242-269` | nenhum; 400 "pode já estar conectada" `:977` |
| Webhook URL | `${APP_URL}/api/webhooks/evolution` sem segredo `:66` | idem, sem segredo `:838,876,889` |
| Credencial | env-first `:63-69` | module-global mutável `:785-800` |
| Identidade | `falatu_solo_${orgId}` `:53-56`; update por nome `:1169` | `instance`/`instanceName`; `default_org` `:1184` |

Estados lógicos propostos pela RF-02 (Sessão/Webhook/Administração/Operação) ainda
**não** existem como máquina de estados; hoje `channels.status` é um enum plano
(`connected/disabled/disconnected/...`). "Conectada" é inferida de eventos por nome,
sem exigir prova do provedor em todos os caminhos (viola INV-07 no legado).

**Fixtures sanitizadas (F0.3):** ainda não geradas — dependem de exemplos reais de
envelope GO (MESSAGE/CONNECTION/QRCODE) para congelar o parser. Registrado como
pendência da Fase 1 (F1.1).

---

## F0.4 — Baseline (testes, schema, flags, rollback)

**Testes relevantes existentes (confirmados no `package.json` do HEAD):**
`test:falatu-whatsapp`, `test:falatu-ask-whatsapp`, `test:falatu-solo-whatsapp`,
`test:falatu-trigger-only`, `test:gestor-command`, `test:falatu-ask`,
`test:falatu-context-projection`, `test:context-security`, `test:security-money-gating`,
`test:falatu-capture-dedup`, `test:falatu-bridge-recon`, `test:falatu-approve-whatsapp`,
`test:two-step-approval-security`, `test:falatu-report`, `test:falatu-file-intake`,
`test:security-media-signing`, `test:security-webhook`, `test:delivery-receipts`,
`test:channel-health`, `test:security-tenant`, `test:instagram-send`,
`test:social-channel-contract`, `test:falatu-entitlement`, `test:falatu-enforcement`,
`test:falatu-plans` — **todos presentes** (25/25). CI descobre `test:*` por sharding
(`scripts/ci-shard.mjs`), sem wiring manual por teste.

> Execução real da suíte + separação falhas preexistentes × regressões: **pendente**
> para o início da Fase 1 (F0.4 registra os comandos; a execução ambientada é da IA
> implementadora, conforme §20.1).

**Schema/flags relevantes:** `channels` (`db.ts:22-36`) com `identifier`,
`token_encrypted` (texto puro — X1), `kind`, `status`, `ai_enabled`, `metadata_json`.
Silo Fala Tu: `falatu_tasks/events/lists/list_items` (`db.ts:7104-7114`) com
`bridged_*`. Flag de fila: `WEBHOOK_QUEUE_ENABLED` (default ON em produção,
`webhookProcessor.ts:76-81`). Convenção do repo: CREATE-then-ALTER aditivo, flags
opt-in em `organization_settings.{modulo}_{feature}_enabled DEFAULT 0`.

**Rollback:** o roteamento novo ainda não existe; a reversão preservadora (§21) será
desenhada por fase. Nenhuma migração destrutiva proposta na Fase 0.

**Simulação de migração (F0.4):** o inventário de `falatu_tasks/events/lists` ×
`bridged_*` × domínios principais está mapeado (A13); a simulação numérica
(quantos vinculados/sem-vínculo/conflitantes por org) roda na Fase 4 (F4.1) em modo
sem efeitos — **não** foi executada agora para não tocar dados.

---

## Gate G0 — status

- ✅ Inventário rastreável (U01–U36 + padrões de canal + atalhos `wa.me`).
- ✅ Achados §4.1 revalidados com evidência (13/13) + 7 achados extras.
- ✅ Baseline de testes/schema/flags registrada.
- ⏳ Contrato Evolution real (Swagger da instalação) + fixtures sanitizadas: **pendente**
  por falta de acesso — permitido seguir por contrato (Gate G0), registrando a
  validação real como pendente.
- ⏳ Execução real da suíte de regressão: pendente para abertura da Fase 1.

**Conclusão G0:** linha de base congelada e auditável. **Nada removido, nada alterado
em produção.** Apto a iniciar a Fase 1 (corrigir fundação da conexão) por PRs pequenos.

---

## Riscos priorizados para a Fase 1 (não implementados aqui)

1. **A11 (reset destrutivo)** — remover o delete+recreate automático do caminho novo;
   é o candidato nº 1 do porquê a instância "ExaForge" não regenera QR se algum
   caminho disparar reset. (F1.3)
2. **A6/X1 (credencial)** — resolver credencial por canal/contrato e proteger o token
   de fato (INV-09). (F1.1/F1.2)
3. **A7/A8/A9/A10 (legado divergente)** — unificar num adaptador; corrigir subscribe,
   URL protegida, identidade e `default_org`. (F1.1/F1.2/F1.4)
4. **X2/X3 (inbound Meta/Cloud sem dedup; JID sem validação)** — INV-02/INV-01. (F1.2)

> Correção do que é **inseguro/incorreto** (ex.: `default_org`, dedup ausente) é
> permitida e desejável (§1), documentando o comportamento anterior. O que é
> comportamento legítimo é preservado por adaptador + teste de migração (INV-05).
</content>
</invoke>
