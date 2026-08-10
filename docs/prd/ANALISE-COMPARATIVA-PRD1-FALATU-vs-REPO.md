# Análise Comparativa — PRD 1 "Fala Tu Universal Interaction Layer" × Repositório atual

**Data:** 2026-08-10
**Autor:** IA Dev (Fase 1 — auditoria e contrato, antes de código)
**PRD-fonte:** "PRD 1 — Fala Tu Universal Interaction Layer — A Porta Universal de Entrada, Saída e Interação do ZapFlow Execution Intelligence" (P0, programa ZEI).
**Objetivo deste documento:** cruzar cada capacidade pedida pelo PRD com o que **já existe** no `Eldastito/exaforgeStudio` (`main`), para **não duplicar engine** (CA15) e decidir o que é genuinamente novo antes de escrever qualquer linha. É o artefato que o próprio PRD pede na **Fase 1 (§78)**: a matriz **REUTILIZAR / ESTENDER / CRIAR / DEFERIR**.

> **Convenção de status** (mesma da `docs/decision-intelligence/ANALISE-COMPARATIVA-PRD-vs-REPO.md`):
> `EXISTE` (em produção) · `PARCIAL` (parte existe, resto é aditivo) · `NOVO` (não existe) · `DEFERIDO` (fora do escopo desta onda por decisão).
> A coluna **Ação** usa o vocabulário do §78: `REUTILIZAR` · `ESTENDER` · `CRIAR` · `DEFERIR` · `CLARIFICAR`.

---

## 0. Fontes lidas para esta análise

Auditoria de quatro clusters do `main` (todas as afirmações têm `file:symbol`/tabela no corpo), somada ao conhecimento direto das fatias F5–F9 (thread porta I/O, ADR-160 D5) entregues por esta IA Dev.

- **Entrada/saída & artefatos:** `StorageService`, `ReportPdfService` (pdfkit), `ClinicDocumentDeliveryService` (assinatura HMAC), `ClinicAttachmentService` (upload multer + magic-byte), `routes/clinicPublic.ts`, `llm.ts` (`extractStructuredFromImage`/`transcribeAudio`/`extractInvoiceItems`), `server.ts` (`/media` estático), tabela `clinical_encounter_attachments` (`db.ts:3427`).
- **Atenção / aprovação / runtime:** `BusinessSignalService` (`attention`/`publish`), `DecisionActionService`, `ApprovalPolicyService`, `ProcessRuntimeService`, `CommandExecutorService`, `MaestroService`, `routes/signals.ts`/`actions.ts`/`runtime.ts`; tabelas `business_signals` (`db.ts:5919`), `decision_actions` (`6206`), `action_approvals` (`6235`), `agent_policies` (`6246`), `process_instances` (`7172`), `action_confirmations` (`7265`).
- **RBAC / contexto / IA:** `PermissionService` (`can`/`levelFor`), `ContextEngineService`, `BusinessSnapshotV2Service`, `EvidencePackageService`, `AIOrchestratorService`, `llm.ts`, `usageContext`; tabelas `role_profiles`/`role_permissions` (`db.ts:5659`), `evidence_packages` (`7950`), `ai_usage_log` (`139` + ALTERs `7620`), `ai_interactions_log` (`125`).
- **Chat / notificações / canal / offline / LGPD:** `NotificationService`, `FalaTuPushService`, `MessageProviderService`, `webhookProcessor`, `FalaTuService.capture`/`interpret`, `FalaTuCaptureTokenService`, `src/lib/falatu/offlineQueue.ts`, `auditLog.ts` (`logAuthEvent`/`maskIdentifier`), `LgpdService`; tabelas `falatu_inbox_items` (`db.ts:6977`), `channels` (`21`), `notifications`, `falatu_push_subscriptions`, `contact_consents`.
- **Base porta I/O (já entregue):** F5 `TaskService` · F6 `AppointmentService.create` · F7 `PurchaseRequisitionService` · F8 `classifyFalaTuListType` + paridade WhatsApp · F9 `vectorSimilarity` (`cosineSimilarity`/`topKBySimilarity`). ADRs: 160 (Onda A/D5), 158/159 (Onda 0), 152 (Runtime), 136 (Decision-Action Ledger), 135 (Snapshot/Evidence).

---

## 1. Veredito executivo

**O PRD está correto no diagnóstico e é disciplinado no método** (§5 audita antes; §15/CA15 proíbe duplicar engine; §39 preserva as duas memórias; §76 não remove silo sem cobertura). As afirmações de baseline do PRD **conferem** com o `main`: bridges de tarefa/evento/compra, paridade parcial WhatsApp, dedup de RAG, feed de atenção, Context Engine e metas **existem** (F1–F9 / ADR-160).

**A realidade do código:** **~60–70% da fundação já existe** — mas espalhada em engines canônicos que o Fala Tu **ainda não consome**. O trabalho do PRD 1 não é construir capacidade nova; é uma **fina camada de composição** (o Fala Tu vira fachada dos engines) **+ duas construções genuinamente novas**: (a) **entrega/persistência de artefatos** e (b) **contexto filtrado por papel + redação**.

**Descoberta mais importante (e o maior risco):** o PRD trata "consumir o Context Engine canônico" (§38) como se o contexto já fosse seguro por papel. **Não é.** O Context Engine é **org + período, não role-filtered**; **não há camada de redação**; e o RBAC gateia **módulo/ação, não linha**. Ou seja, as promessas §29 ("vendedor vê só seus clientes") e §30 ("a LLM não recebe salários") **não são verdade hoje** e **não são wiring — são construção nova e sensível**, pré-requisito de qualquer business-query. Este é o item a proteger.

**Segundo achado:** quase tudo que parece "novo" no PRD é na verdade **wiring de engine existente para a superfície do Fala Tu** — aprovações (`ApprovalPolicyService`+`decision_actions`), status de execução (`ProcessRuntimeService`), inbox priorizado (`BusinessSignalService.attention`), metering (`ai_usage_log`), audit/LGPD (`LgpdService`). O risco de "criar mais um sistema" (§87) é real justamente porque as peças existem e é tentador reescrevê-las.

---

## 2. Matriz de cobertura — o §5 preenchido

| Capacidade | Estado | Ação | Evidência (`main`) |
|---|:--:|:--:|---|
| **Texto** | EXISTE | REUTILIZAR | `FalaTuService.capture`→`interpret`→`falatu_inbox_items` (`db.ts:6977`) |
| **Áudio** | EXISTE | REUTILIZAR | `interpret()`→`llm.transcribeAudio` (whisper-1) |
| **Imagem** | EXISTE | REUTILIZAR | `llm.extractStructuredFromImage` (vision, `OPENAI_VISION_MODEL`) |
| **Arquivos (PDF/XLSX/DOCX)** | NOVO | CRIAR | Fala Tu só aceita `image`/`audio` e **descarta o binário** (sem `storage_key` no inbox). Reutilizar upload multer+magic-byte de `ClinicAttachmentService` + `llm.extractInvoiceItems` |
| **Task bridge** | EXISTE | REUTILIZAR | F5 → `TaskService.create` (`source:'falatu'`, `falatu_tasks.bridged_task_id`) |
| **Event bridge** | PARCIAL | (manter) | F6 → `AppointmentService.create`; web-only + contact-gated **por decisão** (WhatsApp não resolve `contact_id` com segurança, RN-151) |
| **Purchase bridge** | EXISTE | REUTILIZAR | F7 → `PurchaseRequisitionService` (só `shopping` casado ao catálogo, draft) |
| **Output de artefatos** | NOVO | **CRIAR** | Fala Tu não entrega nada. PDF/CSV existem (`ReportPdfService` via pdfkit; exports CSV hand-rolled) mas **não plugados**; XLSX/DOCX **ausentes**; **sem tabela canônica de artefato** (só `clinical_encounter_attachments`, sem hash/expiry/ACL); HMAC copy-paste por módulo |
| **Smart Inbox** | PARCIAL | ESTENDER | `BusinessSignalService.attention()` (`BusinessSignalService.ts:100`) funde signals+risks, mas ranqueia só **severidade+recência** — os campos `impact_amount`/deadline/SLA existem mas **não entram no sort** |
| **Aprovações** | EXISTE (engine) / NOVO (UX) | REUTILIZAR + CRIAR | `decision_actions`+`action_approvals`+`ApprovalPolicyService` (bands valor→papel, default-deny financeiro/destrutivo, two-step com aprovadores distintos, hooks `StepUpMfaService`). Falta **UX conversacional + binding `actionId`** |
| **Chat interno** | NOVO | DEFERIR | Inexistente — toda mensageria é cliente↔ticket (`messages.ticket_id`, `sender_type ∈ {contact,bot,agent}`). §80 defere — correto |
| **Notificações** | PARCIAL | ESTENDER | `NotificationService.push` (in-app + Socket.io) + `FalaTuPushService` (web push, VAPID); dedup ok; **falta** política severity→papel / escalation / quiet-hours geral |
| **Permissões** | PARCIAL / **RISCO** | **CRIAR** | `PermissionService.can(org,user,módulo,ação)` (`PermissionService.ts:234`) existe. **Row-level ownership** e **contexto filtrado por papel** **NÃO existem** |
| **Context routing** | EXISTE (contexto) / NOVO (role-aware) | ESTENDER | `ContextEngineService`/`BusinessSnapshotV2Service`/`EvidencePackageService` — **org+período, não role-filtered** (nenhum importa `PermissionService`) |

### Linhas extras (o PRD exige, o §5 não lista)

| Capacidade | Estado | Ação | Evidência |
|---|:--:|:--:|---|
| Interaction envelope (§9) | PARCIAL | ESTENDER (aditivo) | `falatu_inbox_items` **é** o envelope de-facto (`source`, `intent`, `entities_json`, `confidence`, `client_command_id`); faltam `channel`, `input_type`, `correlation_id`, `attachments_json`. CREATE-then-ALTER — **não** tabela nova (§9 concorda) |
| Channel-agnostic (§10–11) | PARCIAL | CLARIFICAR | Outbound abstraído (`MessageProviderService.sendMessage`, branch por `provider`); inbound **estruturalmente WhatsApp** (`webhookProcessor.processIncomingMessage`, union fechada, sem provider `web`). Mas o caminho **operador** (`source='webapp'`) já é canal-neutro → CA1/CA12 quase verdade |
| AI gateway barato-vs-caro (§40,§74) | PARCIAL | ESTENDER (camada compartilhada) | Roteamento por **modalidade** sim (`llm.ts`); **texto tudo `gpt-4o`**, até classificadores (`CollectionIntentClassifier`). `gpt-4o-mini` só na tabela de preço. §75 manda nascer na camada compartilhada — correto |
| Metering correlacionado (§41,§52) | PARCIAL | ESTENDER (aditivo) | `ai_usage_log` rico (org/user/módulo/modelo/tokens/latency/custo, via `usageContext` AsyncLocalStorage); `request_id` **existe mas nunca é populado**; spine `correlation_id` (ADR-158) só em signals/actions, **não** na IA |
| Runtime status (§48) | EXISTE | REUTILIZAR | `ProcessRuntimeService.listInstances` (FSM `process_instances`) → "N processos ativos" |
| Offline/PWA (§55) | EXISTE | REUTILIZAR | `offlineQueue` + dedup `client_command_id` + share target + `FalaTuPushService` |
| Audit/LGPD (§58–59) | EXISTE | REUTILIZAR | `logAuthEvent`/`maskIdentifier` (`auditLog.ts`) + `LgpdService` (retention/export/erasure/consent + cascata de sensível) |
| Idempotência de aprovação (§54) | PARCIAL | ESTENDER | Idempotência server-side por chave natural existe (`CommandExecutorService` `action_already_executed`; `action_confirmations` UNIQUE(org,action_id)); **aprovar por conversa** precisa de `actionId` explícito no envelope |
| Prompt-injection em arquivo (§83) | PARCIAL | REUTILIZAR + ESTENDER | Heurística `isPromptInjection` existe (geminiRAG); estender para tratar conteúdo de arquivo como **dado não-confiável** |

**Leitura rápida:** REUTILIZAR domina (bridges, runtime, offline, audit/LGPD, engine de aprovação, contexto base, notificação, metering-base). **CRIAR** é curto e concentrado: **output/persistência de artefatos**, **contexto filtrado por papel + redação**, **intake de documentos**. **DEFERIR:** chat interno.

---

## 3. Ponderações (por ordem de importância)

**P1 — O maior risco é o contexto por papel, que o PRD trata como pronto.** §28–31 exigem contexto filtrado por RBAC e "minimum necessary context" antes da LLM. Auditoria: contexto é **org+período, não role-filtered**; **não há redação**; RBAC gateia **módulo/ação, não linha** (nenhum `WHERE owner_user_id = ?` no código — só isolamento por org). Logo §29/§30 **não são verdade hoje** e são **construção nova e sensível**, pré-requisito de business-query. **Recomendação:** tratar "projeção de contexto por papel + redação" como parte da **Fase 1 (contrato)**, não como consumo do que já existe.

**P2 — Aprovações: o motor existe inteiro; falta a boca e a gramática.** `ApprovalPolicyService.resolveContract` (bands, default-deny financeiro), `decision_actions`, `action_approvals` (aprovador autenticado obrigatório, two-step, audit, step-up MFA) prontos. A Fase 5 é **UX conversacional + binding explícito**: "aprovar" solto precisa carregar `actionId`/`approvalId` (§25 correto) — senão não há idempotência nem anti-ambiguidade.

**P3 — "Channel-agnostic" funde dois pipelines distintos.** O PRD mistura a *camada de interação do operador* (Fala Tu, interno) com o *canal do cliente* (WhatsApp). Inbound de cliente é estruturalmente WhatsApp (`webhookProcessor`); o Fala Tu do operador (`webapp`) **já é neutro**. Consequência boa: **CA1/CA12 já são essencialmente verdade** no caminho do operador. **Recomendação:** o PRD declarar que esta camada é a interação **interna/operacional**; "WhatsApp como connector" se refere à captura do operador, **não** ao rebuild do inbound de atendimento ao cliente.

**P4 — Artefatos é a maior construção nova; o §79 acerta em pô-la cedo (2º).** Nada de output existe no Fala Tu; PDF/CSV existem soltos, XLSX/DOCX faltam, sem tabela canônica de artefato. Dois cuidados: (a) o padrão **URL assinada HMAC** já é batido em produção (`ClinicDocumentDeliveryService.signedUrl`/`resolveSignedFile` — `timingSafeEqual` + whitelist de path + TTL) mas está **copiado em 4 lugares** → extrair `signUrl/verifyUrl` compartilhado; (b) hoje o Fala Tu **descarta binários** → intake e output ambos exigem primeiro **persistência de artefato** (tabela canônica com os campos do §15).

**P5 — Envelope canônico: evoluir `falatu_inbox_items`, não criar tabela.** O envelope do §9 **já existe** como `falatu_inbox_items`. Faltam `channel`, `input_type`, `correlation_id`, `attachments_json` — aditivo (CREATE-then-ALTER). O próprio §9 manda auditar antes de criar tabela. Resistir a um `interactions` paralelo.

**P6 — Metering correlacionado é fruta baixa de alto valor.** `ai_usage_log.request_id` **existe mas nunca é preenchido**, e há um spine `correlation_id` (ADR-158) em signals/actions. Ligar `request_id`/`correlation_id` do envelope até `recordUsage` (via `usageContext`) fecha o rastro "de onde veio → o que entendemos → o que fizemos → quanto custou" (§41/§52) e habilita §70/§84 — aditivo e barato.

**P7 — AI gateway barato-vs-caro é real, mas é da plataforma, não do Fala Tu.** Todo texto (inclusive classificadores) bate em `gpt-4o`; não há tier barato para texto. §75 ("não criar Fala Tu LLM") está certo: nasce na camada compartilhada (`llm.ts`/`AIOrchestratorService`). O F8 mostrou o ideal — **classificação determinística antes da LLM** (`classifyFalaTuListType`, zero IA). Generalizar esse hábito.

**P8 — Chat interno por último está certo.** Ausente por completo; §80 racionaliza bem (o valor é operar o ZapFlow, não funcionários conversando). Maior risco de virar clone de Slack, menor alavancagem. Deferir para fundação-só.

**P9 — Segurança que o PRD levanta e o repo já cobre (reutilizar):** prompt-injection em arquivo (§83) → `isPromptInjection` + tratar arquivo como dado não-confiável; multi-tenant (§82) → isolamento por `organization_id` é convenção dura; audit/LGPD (§58–59) → `logAuthEvent`/`LgpdService` completos; memória pessoal × RAG empresarial (§39) → **exatamente** a decisão da F9 (stores separados por escopo, primitiva compartilhada `vectorSimilarity`).

---

## 4. Sequência recomendada (ajuste fino ao §78/§79)

A ordem de fases do PRD é boa; o único ajuste é **injetar a segurança de contexto no início** (P1) e começar pela fundação barata e aditiva.

- **Fase 1 (contrato + fundação):** evoluir o envelope (`falatu_inbox_items` +`channel`/+`input_type`/+`correlation_id`/+`attachments_json`) · popular `request_id`/`correlation_id` no metering · **+ projeção de contexto por papel + redação** (pré-requisito de segurança). Barato, aditivo, destrava tudo.
- **Fase 2 (artefatos):** tabela canônica de artefato + util de assinatura HMAC compartilhado (extrair de `ClinicDocumentDeliveryService`) + intake de documentos (multer/magic-byte + `extractInvoiceItems`) + geração XLSX. Maior valor visível.
- **Fase 3 (aprovações no Fala Tu):** wiring de `decision_actions`/`ApprovalPolicyService` + gramática `actionId`.
- **Fase 4 (Smart Inbox):** estender `attention()` (ranking impacto/SLA) + compor categorias sobre signals/actions/runtime — **sem** fonte de alertas nova.
- **Depois:** threads/status (reusar `ProcessRuntimeService`), proativo (reusar briefing/push), chat (fundação), zero-training.

### Primeira fatia recomendada — **ENTREGUE (2026-08-10)**

A **Fase 1 de fundação** — evolução aditiva do envelope + wiring de correlação no metering. Reversível, testável de forma determinística, não toca engine nenhum, e entrega o `correlation_id` em que todas as fases seguintes vão pendurar. Mantém o padrão fatia→PR→CI→merge de F5–F9.

**Entregue:** 4 colunas aditivas em `falatu_inbox_items` (`channel` · `input_type` · `attachments_json` · `correlation_id`), derivadas deterministicamente na captura (channel de `source`/explícito com fallback; input_type = superset do media_type; attachments = descritores factuais, RN-151; correlation_id inicia cadeia nova ou continua a thread do caller, §51). `correlation_id` propagado ao `usageContext` **antes** de qualquer IA → popula `ai_usage_log.request_id` (coluna existia e nunca era escrita), fechando o rastro de custo §41/§52. Suíte `test:falatu-envelope` (20 checks) + regressão de todas as `falatu-*` e `ai-usage-ledger` PASS. 0 tabelas novas, 0 breaking changes.

**Fatia de segurança (P1) — ENTREGUE (2026-08-10).** `ContextProjectionService` projeta o contexto canônico pro escopo do usuário ANTES de qualquer entrega a modelo (§30/§31, CA13), **reusando `PermissionService`** (nenhum RBAC novo): mapa domínio→módulo **fail-closed** (domínio sem permissão CAI), **redação** de campos sensíveis (custo/margem/lucro/salário/comissão/CPF) quando o viewer não tem `full`, e narrativa org-wide só pra visão ampla. `ContextEngineService.buildForUser(orgId, user)` + rota `GET /api/falatu/context` entregam o contexto projetado + manifesto (dropped/redacted) pra explicabilidade (§49). Owner = no-op (vê tudo). Suíte `test:falatu-context-projection` (20 checks) + regressão de 8 suítes RBAC + context/snapshot/executive PASS. É a **fundação obrigatória** de qualquer business-query do Fala Tu.

**Fase 2 (artefatos) — 2.1 fundação ENTREGUE (2026-08-10).** Tabela CANÔNICA `artifacts` (§15: id/org/creator/kind/mime/size/storage_key/origin/classification/sha256/correlation_id/expires_at/purged_at) + `ArtifactService` (create grava binário no disco PRIVADO + sha256 + size; get/list isolados por org e sem vazar path; read com TTL; entrega por URL assinada) + **util de assinatura HMAC compartilhado** `fileSigning` (`signKey`/`verifyKey`/`safeStorageKey`, escopo isola assinaturas, `timingSafeEqual`, TTL — extraído do padrão copiado em 4 módulos, §16) + rotas (protegida: list/meta/link; pública: download assinado sem sessão). Suíte `test:artifacts` (28 checks). **2.2 — ENTREGUE (2026-08-10, CA6):** "Fala Tu entrega arquivo gerado". `ReportPdfService.renderSimplePdf` (renderizador genérico → Buffer, reusa pdfkit) + `FalaTuReportService.executiveSummary` que **compõe** contexto-por-papel (P1) + PDF + `ArtifactService` → devolve o **link assinado** (nunca o binário/path); o relatório **herda a projeção** (vendedor perde finance). Rotas `POST /api/falatu/reports/summary` + `GET /api/falatu/artifacts` (aba Arquivos, §60). Suíte `test:falatu-report` (10 checks). **2.3 — ENTREGUE (2026-08-10, §14/§65):** geração de XLSX **sem dependência nova** — `XlsxService.buildXlsx` (OOXML mínimo + ZIP stored + CRC32 próprio, determinístico, validado com `unzip` no teste). `FalaTuReportService.executiveSummary({format:'pdf'|'xlsx'})` — "me manda em Excel"; a planilha **herda a projeção** (vendedor não recebe o valor de finance; nota de omissão transparente §49). Suíte `test:xlsx` (13 checks). **2.4 — ENTREGUE (2026-08-10, CA7 / §17-18):** intake de documentos. `FalaTuFileIntakeService.intake` **reusa** `detectMime` (magic-byte, do Clinic — confia no conteúdo, nunca no tipo declarado, segurança H4) + `MAX_BYTES`; persiste como artefato canônico (origin `intake`, correlation) e classifica deterministicamente (mime → kind + domínio provável + sugestão §27, sem inventar). Rota `POST /api/falatu/files` (multer). Não duplica a conferência nota×lista (já em `FalaTuPurchaseService`). Suíte `test:falatu-file-intake` (12 checks). **Fase 2 fecha CA6+CA7** (par entrada↔saída de arquivos). **RBAC por classificação — ENTREGUE (2026-08-10, fecha a Fase 2):** `ArtifactService.canAccess`/`getForUser`/`listForUser`/`signedUrlForUser` — `public`/`internal` livres p/ a org; `sensitive` só p/ o CRIADOR ou visão ampla (owner/gerente, **reusa `hasFullBusinessVisibility`**, nenhum RBAC novo). Gate na EMISSÃO/LISTAGEM (o download público segue bearer). Rotas `/api/artifacts` + `/api/falatu/artifacts` gated; 404 (não 403) não revela existência. Suíte `test:artifact-rbac` (15 checks). **Fase 2 COMPLETA.**

### Fase 3 — Smart Inbox — ENTREGUE (2026-08-10, §20-23, §60)

`SmartInboxService.build(orgId, user)` — a Caixa de Entrada Inteligente. **NÃO é fonte de alertas nova** (CA15): COMPÕE três engines canônicos em categorias por AÇÃO (§21), ranqueadas por score determinístico (§22, não cronologia), filtradas por papel:
- `DecisionActionService.list` → **PRECISA DA SUA APROVAÇÃO** (awaiting_approval) / **DECISÃO** (proposed) / **RESOLVIDO** (done recente);
- `BusinessSignalService.attention` → **RISCO** (critical/risk) / **OPORTUNIDADE** (tipo heurístico) / **INFORMAÇÃO**;
- `ProcessRuntimeService.listInstances` → **EM EXECUÇÃO** (in-flight) / **RESOLVIDO** (completed nas últimas 48h).

Score = severidade + impacto (log) + prazo/SLA + `priority_score` (já calculado pelo ImpactPrioritization) — aprovação bloqueada no topo. Escopo por papel reusa `DOMAIN_MODULE` + `PermissionService` (vendedor não vê risco financeiro nem decisão de compras). Rota `GET /api/falatu/smart-inbox`. Suíte `test:smart-inbox` (12 checks). **Próxima:** Fase 4 Approval Center (UX conversacional sobre `decision_actions`/`ApprovalPolicyService` + gramática `actionId`).

---

## 5. O que NÃO construir (CA15 — engines a reutilizar, não duplicar)

| Necessidade do PRD | Engine canônico a consumir |
|---|---|
| Contexto empresarial (§38) | `ContextEngineService` / `BusinessSnapshotV2Service` / `EvidencePackageService` |
| Feed de atenção / Smart Inbox (§20–23) | `BusinessSignalService.attention` + `business_signals` |
| Aprovação / policy (§24–25) | `ApprovalPolicyService` + `decision_actions` + `action_approvals` |
| Status de execução (§48) | `ProcessRuntimeService.listInstances` |
| Metering de IA (§41) | `ai_usage_log` + `usageContext` |
| RBAC (§30) | `PermissionService.can` |
| Notificação/push (§42–45) | `NotificationService` + `FalaTuPushService` |
| Offline (§55) | `offlineQueue` + `client_command_id` |
| Audit/LGPD (§58–59) | `logAuthEvent` + `LgpdService` |
| Similaridade de RAG (§39) | `vectorSimilarity` (F9) — stores separados por escopo |
| Geração de PDF (§14) | `ReportPdfService` (pdfkit) |
| Assinatura de arquivo (§16) | padrão `ClinicDocumentDeliveryService` (a extrair como util) |

> **Pergunta-guia do §87, aplicada a cada fatia:** *"Estou tornando o Fala Tu uma porta, ou criando mais um sistema?"* — e *"esta informação já tem fonte canônica no ZapFlow?"*. Se sim, **consumir**, não replicar. Esta matriz é a resposta de referência para as duas perguntas.
