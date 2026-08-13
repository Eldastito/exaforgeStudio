# ADR-167 — Final Integration, Social Intelligence, Creative Execution & Commercial Proof (PRD 10)

**Programa:** ZapFlow Execution Intelligence (ZEI)
**Estado:** **F0 FECHADA (auditoria + matriz de reutilização — doc-only, mergeada). F1 FECHADA — `SocialChannelProvider`: contrato provider-agnóstico de canal social (Instagram/Facebook/TikTok/… + Ads) espelhando `ReputationProvider.ts:134`; capabilities DESCOBERTAS não presumidas (RN-SI-06) + flags grossas derivadas (§7); estados de conexão observáveis §5 (`not_connected`/`connecting`/`connected`/`permission_limited`/`token_expiring`/`auth_expired`/`rate_limited`/`degraded`/`unavailable` — token vencido nunca "conectado"); `StubSocialChannelProvider` determinístico (sem rede/db/OAuth — isso é F2); degradação explícita sem a capacidade (`manual_required`/`capability_unavailable`, NUNCA simula §7); publish/schedule IDEMPOTENTES (RN-SI-08); analytics honestos (métrica ausente → null, RN-SI-12); registry `SOCIAL_CHANNEL_PROVIDER`→stub; ads/competitor DEFERIDOS por default (§4); `test:social-channel-contract` 25 checks. F2 FECHADA — `SocialConnectionService` (Social Connection Hub): ESTENDE Canais e IA com o ESTADO por-org da conexão de canal social, espelhando `ReputationConnectorService`. Tabela `social_connections` (aditiva, opt-in `enabled` DEFAULT 0, UNIQUE(org,channel)) guarda credenciais CIFRADAS (`config_enc`, AES-GCM via `EncryptionService` — nunca cru numa rota, RN-SI-05), estado de conexão observável (§5, persistido do provider — token vencido nunca "connected"), capacidades DESCOBERTAS/cacheadas (RN-SI-06) + escopos concedidos. `status()`/`list()` REDIGEM (só `hasToken`/escopos/capacidades/estado); `refreshHealth()` conecta→lê health→persiste estado+capacidades; `providerFor()` resolve instância FRESCA com config decifrada (só `stub` hoje; reais na F3+); `disconnect()` zera credencial→`not_connected` (preserva linha p/ histórico). Rotas `/api/social/connections*` (owner/admin, `logAuthEvent`). `test:social-connection-hub` 24 checks. F3 FECHADA — `InstagramChannelProvider`: PRIMEIRO provider REAL do contrato (F1), envolvendo o `InstagramService` já provado em produção (Graph API). NÃO duplica OAuth/token (a credencial fica no `channels`, lida via `InstagramService.getChannel` — sem 2ª tela §42, RN-SI-05). CAPABILITY DESCOBERTA (RN-SI-06): desconectado→capabilities vazias+`not_connected` (determinístico, só DB — roda em CI); conectado→base (getProfile/getPosts/publish) + `getAudienceAnalytics` SÓ se o probe de insights responder (App Review); `getProfile` lê a identidade do canal sem rede/LLM (seguidores null honesto, RN-SI-12). Degrada explícito: publish sem conexão/mídia→`manual_required`, schedule→`manual_required` (o Scheduler do app cuida do horário, F10), getPostAnalytics DEFERIDO p/ F4, ads DEFERIDO (§4)→`capability_unavailable`. Publish idempotente in-memory (RN-SI-08; durável cross-processo é do publicador governado F11). Hub `providerFor` roteia `instagram`+provider=`instagram`→provider real (default `stub`, opt-in, 0-regressão). `test:social-provider-instagram` 21 checks. F4 FECHADA — `SocialAnalyticsService` (Social Analytics Ingestion): puxa posts PRÓPRIOS + analytics do provider (via Hub) e PERSISTE snapshot por-org em `social_post_metrics` (aditiva, UNIQUE(org,channel,post_external_id)→upsert IDEMPOTENTE, RN-SI-08). HONESTO (RN-SI-12): métrica ausente→NULL nunca 0; sem capacidade de analytics grava só o feed + `analytics_available=0`; `summary` agrega por query e devolve total NULL sem prova. `pass()` roda no `Scheduler.tick` horário (§42 — sem 2º Scheduler), só conexões HABILITADAS de provider REAL (pula stub), best-effort por org. `InstagramChannelProvider.getPostAnalytics` ganhou implementação real (media insights via `InstagramService.fetchMediaInsights`) + capability descoberta (getPostAnalytics junto de getAudienceAnalytics após probe). Rotas `/api/social/analytics/:channel[/sync]`. `test:social-analytics-sync` 18 checks. F5+ segue o plano.** Tese: o "cérebro" do ZapFlow (percepção→contexto→evidência→decisão→governança→execução→confirmação→garantia→aprendizado, PRDs 0–9) e toda a infra de pesquisa externa / vertical intelligence / procedência / Scheduler / JobQueue / entitlements / RBAC / criptografia / OAuth / Admin Master **já existem e são reusáveis**. O PRD 10 **NÃO é um motor novo de social media**: é a **camada final de integração** que liga essas peças às superfícies reais (**Canais e IA** + **Estúdio**) e preenche **três lacunas de borda** — (a) `SocialChannelProvider` unificado (contrato+registry+capabilities+OAuth seguro), (b) Estúdio **orientado por inteligência** (Oportunidade→handoff→variantes→calendário→publicação governada), (c) closed-loop de conteúdo (analytics→Outcome Assurance→Creative Learning). Achados F0: quase tudo é COMPOR/REUTILIZAR; as lacunas reais são a borda de canais (só Instagram+WhatsApp publicam; sem registry unificado), o Estúdio (sem variantes A/B/C, sem calendário editorial draft→approved, sem best-time-to-post) e a fiação conectiva (Opportunity Matching, handoff, publicação governada via `CommandExecutor`, analytics por-post, creative learning). Aditivo puro; **NÃO** cria Social Intelligence Engine / segundo Scheduler / segundo JobQueue / segundo Decision/Learning/Approval Engine / tabela de alerta paralela / segundo Estúdio / segunda tela de credenciais / segundo calendário / integração frontend→API social / segredo OAuth no browser (§42). Guardrails RN-SI-01..15. Plano F0–F18. Análise em `docs/prd/ANALISE-PRD10-vs-CODEBASE.md`.
**Prioridade:** P0 — a prova comercial ponta-a-ponta do programa ZEI (§47/§48).
**Acesso:** conexões e capacidades sociais opt-in por flag + gated por entitlement/plano (server-side); custo restrito ao Admin Master.
**Natureza:** Integração final + inteligência social + execução criativa governada + prova comercial.
**Estratégia:** REUTILIZAR → ESTENDER → COMPOR → **só então** CRIAR.
**Dependência dura:** PRDs 0–9 **encerrados** — pré-condição **ATENDIDA** (ADR-158/159 espinha+governança, 161 Radar, 164 Reliability, 165 Outcome Assurance, 166 Enterprise Learning, 156/157 External Intelligence, 153 Entitlements, 095 RBAC, 054 Encryption).
**Não é:** novo motor de social media, novo Scheduler/JobQueue, novo Decision/Learning/Approval Engine, nova tabela de alerta, novo Estúdio, nova camada de credenciais por módulo, novo calendário, nem integração direta frontend→APIs sociais.

> **Regra de ouro (PRD 10):** *`PUBLISHED` não é `RESULTADO`, assim como `DONE` não é `RESULTADO`. Publicar conteúdo é efeito externo — só está encerrado quando o resultado de negócio prometido foi confirmado e medido, e alimentou o aprendizado.*

---

## 1. Contexto e objetivo

Os PRDs 0–9 entregaram, peça por peça, um sistema que **percebe** (Radar/Signals), **contextualiza** (Context Engine/Evidence), **decide** (Decision Intelligence L0–L4), **governa** (Autonomy Contract/Approval), **executa** (Command Executor auditado), **confirma** (Confirmation Engine), **garante** (Outcome Assurance) e **aprende** (Pattern Memory), com **inteligência externa viva e com procedência** (External Intelligence 2.0) e **plataforma confiável** (Reliability). O Estúdio já gera conteúdo (marca→imagem/vídeo→legenda) e publica no Instagram; Canais e IA já conecta WhatsApp/Instagram com credenciais criptografadas.

O que **falta** não é inteligência nem execução — é **conectar** essas capacidades às superfícies onde o assinante vive, transformando o Estúdio de "gerador de posts" em **Estúdio orientado por inteligência empresarial**, e abrindo a borda de canais para um contrato unificado que descobre capabilities em vez de presumi-las. A diferença de produto:

> *"Crie um post sobre camisa de linho."* → *"O ZapFlow identificou crescimento desse assunto em fontes externas, verificou que sua empresa tem estoque elevado e margem favorável com vendas em queda, preparou três abordagens e recomenda publicar a opção B amanhã porque situações semelhantes tiveram melhor desempenho assegurado."*

O segundo cenário **já é possível** porque cada elo existe — o PRD 10 costura o fio.

---

## 2. F0 — Auditoria do `main` (evidência `file:symbol`)

**Conclusão: ~85% é COMPOR/REUTILIZAR.** As peças do cérebro e da plataforma existem inteiras; as lacunas são de borda e de fiação. (Auditoria completa e narrativa em `docs/prd/ANALISE-PRD10-vs-CODEBASE.md`.)

| # | Superfície | `file:symbol` | Veredito | Papel / lacuna |
| --- | --- | --- | --- | --- |
| 1 | **Canais e IA** | `routes/channels.ts:10/38/63`; `channels` (`db.ts:21`); `features/ChannelsPanel.tsx:12` | EXISTE | Ponto único de conexão; estender com card observável + OAuth social. |
| 2 | **Provider contract+registry+capabilities** | `ReputationProvider.ts:134` (`capabilities:27/136`, `REGISTRY:246`); `ReputationConnectorService.ts:19` (`ReputationHealthStatus`) | EXISTE (template) | Molde exato do `SocialChannelProvider`. |
| 3 | **WhatsApp/Evolution/Instagram** | `EvolutionService.ts:46`; `MessageProviderService.sendMessage:11`; `InstagramService.ts:17` (`publish:148`); `routes/instagramOAuth.ts` | EXISTE (parcial) | Só IG+WA publicam; sem FB-feed/TikTok/LinkedIn/YouTube/X (DEFERIR). |
| 4 | **Segredos/OAuth** | `EncryptionService.ts:31` (AES-GCM, `ENCRYPTION_KEY`); `oauth_connections` (`db.ts:261`); `GoogleOAuthService.ts:27`; `fileSigning.ts:25` | EXISTE | Reusar p/ credenciais sociais; nunca no frontend (RN-SI-05). |
| 5 | **Estúdio** | `StudioService.ts:55` (`generate:122`, `suggestCaption:216`, `schedulePost:231`); `routes/studio.ts`; `StudioView.tsx:54` | EXISTE (parcial) | Sem variantes A/B/C; sem entrada "Oportunidades". |
| 6 | **Geração imagem/vídeo** | `llm.ts:168` (Imagen+OpenAI); `:301` Veo; `brand_profiles` (`db.ts:154`), `analyzeBrand:67` | EXISTE | Reusar. |
| 7 | **Ativos** | `ArtifactService.ts:67`; `StorageService.ts:44`; `studio_creations` (`db.ts:162`) | EXISTE | Biblioteca canônica reusável. |
| 8 | **Calendário/agenda de posts** | `scheduled_posts` (`db.ts:173`, estados `scheduled\|published\|failed\|canceled`); `InstagramService.publishScheduledPass:178` | PARCIAL | Sem `draft`/`awaiting_approval`/`approved`; sem grade. |
| 9 | **Scheduler / JobQueue** | `Scheduler.ts:72` (passes `:748/751`); `JobQueueService.ts:48` (`background_jobs` `db.ts:4782`) | EXISTE | Adicionar jobs sociais; nunca criar 2º scheduler/queue. |
| 10 | **External Intelligence** | `ExternalResearchProvider.ts` (Live `:243`, `evidenceMode:51`); `VerticalIntelligenceService.ts:49`; `ResearchNeedService.detect:46`; `ResearchCuratorService.assessQuality:111`; `ResearchBudgetService.ts:18`; `ResearchBrokerService.resolve:29` | EXISTE | Reusar inteiro; pool por fingerprint+TTL. |
| 11 | **Signals / Radar** | `BusinessSignalService.publish:58`/`attention:109`; `business_signals` (`db.ts:5919`); `HumanSignalService:81`; `ExternalSignalService:81`; `RadarService.ts:48` | EXISTE | Social é +1 origem; nunca `social_alerts`. |
| 12 | **Context / Evidence** | `BusinessSnapshotV2Service.build:23`; `ContextEngineService:39`; `EvidencePackageService.compose:96` | EXISTE | Base do Opportunity Matching. |
| 13 | **Decision** | `DecisionEngine.analyze:58` (`learningPrior:237`); `ImpactPrioritizationService.levelFor:170` | EXISTE | Distingue internal/live/model_knowledge (§31). |
| 14 | **Execução governada** | `DecisionActionService.propose:40`; `ApprovalPolicyService.resolveContract:107`; `CommandExecutorService.execute:188` (`action_execution_log` `db.ts:6278`); `ConfirmationEngine.expect:85` | EXISTE | Publicação vira comando governado (F11). |
| 15 | **Outcome / Learning** | `OutcomeAssuranceService.assessAction:34`; `OutcomeMeasurementService.record:44`; `PatternMemoryService.recordOutcome:256`; `PatternLearningFromAssuranceService.learnFromAction:40`; `ExecutionTraceService.trace:41` | EXISTE | Creative Learning = COMPOR. |
| 16 | **Entitlements / RBAC** | `EntitlementService.check:204` (gate `server.ts:503`); `middleware/auth.ts` (`requireMasterAdmin:63`); `PermissionService.ts:161`; `plansGrade.ts:48` | EXISTE | Capacidades sociais gated server-side. |
| 17 | **Reliability / Admin / Custo** | `OperationalHealthService:34`; `DependencyHealthService:32` (social `not_instrumented`); `PlatformProtectionModeService:44`; `routes/admin.ts`; `ai_usage_log.cost_brl` | EXISTE | Health social integra ao Reliability. |

---

## 3. Decisões arquiteturais

- **D1 — Um único ponto de conexão.** Canais sociais entram em **Canais e IA / Canais e Automação** (estende `ChannelsPanel`/`routes/channels.ts`/`channels`), NUNCA numa segunda tela de credenciais no Estúdio (§4/§42). O Estúdio **consome** conexões, não pede credenciais.
- **D2 — `SocialChannelProvider` espelha `ReputationProvider`.** Contrato + registry + `capabilities[]` descobertas + resolução por env, exatamente como `ReputationProvider.ts:134`/`REGISTRY:246`. Cada provider declara o que faz (analytics/publish/schedule/ads/competitorData); frontend e IA nunca presumem (RN-SI-06).
- **D3 — Credenciais server-side, sempre.** OAuth quando suportado, tokens via `EncryptionService` (AES-GCM) em `channels.token_encrypted`/`oauth_connections`, refresh/revogação/audit, isolamento por org. Nunca no frontend/localStorage/logs (RN-SI-05, §6).
- **D4 — Publicação é comando GOVERNADO.** Publicar é efeito externo → passa por `DecisionAction → ApprovalPolicy(Autonomy Contract) → CommandExecutor(auditado) → ConfirmationEngine`, com idempotência (retry nunca dobra post — RN-SI-08). NÃO cria mecanismo de aprovação/execução paralelo (§23/§42).
- **D5 — Inteligência social reusa a pesquisa do PRD 9.** Vertical Social Intelligence = `VerticalIntelligenceService` + pool (fingerprint+TTL+L2/L3) + `ResearchBudgetService` + `ResearchCuratorService`. Uma pesquisa por vertical, N contextualizações privadas (§13). Concorrente = só dado público/legal (RN-SI-11). NÃO cria 2º pipeline.
- **D6 — Opportunity Matching publica `business_signal`.** "descoberta externa × contexto do tenant → oportunidade" COMPÕE `EvidencePackage.externalEvidence` × contexto, e publica em `business_signals` (dedupe), NUNCA em tabela de alerta paralela (§16/§29/§42).
- **D7 — Estúdio orientado por inteligência.** Entrada "Oportunidades" + handoff que injeta contexto estruturado (marca/produto/estoque/preço/margem/objetivo/evidência/histórico) — o usuário não reexplica o que o ZapFlow já sabe (§17/§18). Gera **opções** (A/B/C) por objetivo/canal/hipótese/evidência, não uma resposta (§19).
- **D8 — Calendário editorial estende `scheduled_posts`.** Adiciona estados `draft`/`awaiting_approval`/`approved` + grade; NÃO cria segundo calendário (§22/§42). A agenda clínica (`AppointmentService`) permanece separada.
- **D9 — Closed-loop de conteúdo.** publicação→analytics por-post→`OutcomeMeasurement`→`OutcomeAssurance`→`PatternMemory`. `PUBLISHED ≠ RESULTADO` (RN-SI-03); só `assured` vira Creative Learning forte (herda RN-EL-1). Best-time = padrão aprendido por (canal×formato×objetivo×dia×hora); sem histórico → `insufficient_history` (RN-SI-13).
- **D10 — Distinção de procedência preservada.** `internal_fact` / `external_live_evidence` / `model_knowledge` / `estimate` / `hypothesis` seguem separados no Context/Decision (§30/§31); dado de concorrente permanece `external_evidence`, nunca "fato interno".
- **D11 — Entitlement server-side + custo master-only.** Capacidades sociais gated por `EntitlementService` no `protectedApi` (esconder botão ≠ segurança, §32); custo AI/API restrito ao Admin Master (§33).
- **D12 — Rollout progressivo.** Flags nascem OFF/shadow; autonomous publishing nunca entra direto em GA (§51/§52). Health social integra ao Reliability/Protection Mode (§34/§35) — operação crítica nunca é sacrificada por pesquisa competitiva.

---

## 4. Guardrails duros (RN-SI — no header dos services + testados)

- **RN-SI-01** — pesquisa externa ≠ fato interno (fica `external_evidence`).
- **RN-SI-02** — `model_knowledge` ≠ `live` (herda `evidenceMode`, gate `ungrounded_live`).
- **RN-SI-03** — `PUBLISHED` ≠ `RESULTADO` (Outcome Assurance; só `assured` aprende).
- **RN-SI-04** — dado privado nunca no pool compartilhado da vertical (`assertNoTenantData`/`tenantTerms`).
- **RN-SI-05** — credenciais nunca no frontend/localStorage/logs (server-side, criptografadas).
- **RN-SI-06** — capability descoberta, não presumida (`capabilities[]`).
- **RN-SI-07** — pesquisa obedece budget (`ResearchBudgetService`).
- **RN-SI-08** — retry de publicação idempotente (nunca dobra post).
- **RN-SI-09** — toda ação externa respeita política/autonomia (Autonomy Contract).
- **RN-SI-10** — nenhum motor paralelo (§42/§184).
- **RN-SI-11** — concorrente = só dado público/autorizado/legal (sem scraping proibido, sem burlar auth).
- **RN-SI-12** — IA não inventa métricas (RN-004, derivar por query).
- **RN-SI-13** — sem histórico suficiente = `insufficient_history` (nunca inventa precisão).
- **RN-SI-14** — entitlement validado server-side (esconder botão ≠ segurança).
- **RN-SI-15** — resultado financeiro exige evidência de atribuição compatível (fact/estimate/influenced nunca somados; correlação ≠ atribuição).

---

## 5. Plano de fatias (F0–F18)

| Fatia | Entrega | Natureza | Teste (nome provisório) |
| --- | --- | --- | --- |
| **F0** | Esta ADR + `ANALISE-PRD10-vs-CODEBASE.md` (doc-only) | Auditoria | — |
| **F1 ✅** | `SocialChannelProvider` (contrato+registry+capabilities DESCOBERTAS + estados de conexão §5 + `StubSocialChannelProvider` determinístico) espelhando `ReputationProvider`; degradação explícita (`manual_required`/`capability_unavailable`, RN-SI-06); publish idempotente (RN-SI-08); analytics honestos (null≠0); sem db/rede/OAuth (F2) | CRIAR (mín.)/COMPOR | `test:social-channel-contract` (25) |
| **F2 ✅** | **Social Connection Hub** — `SocialConnectionService` estende Canais e IA: tabela `social_connections` (config CIFRADA, estado §5, capabilities descobertas, escopos, health), `status`/`list` REDIGIDOS, `refreshHealth`/`providerFor`/`disconnect`, rotas `/api/social/connections*` (owner/admin) | ESTENDER/CRIAR (mín.) | `test:social-connection-hub` (24) |
| **F3 ✅** | **Primeiro provider real (Instagram)** — `InstagramChannelProvider` envolve `InstagramService` (Graph API provada); capability DESCOBERTA por estado de conexão, degradação honesta, Hub roteia opt-in; sem duplicar OAuth/token (§42) | CRIAR (mín.)/COMPOR | `test:social-provider-instagram` (21) |
| **F4 ✅** | **Social Analytics Ingestion** — `SocialAnalyticsService` puxa posts+analytics próprios (passe no `Scheduler.tick`), persiste `social_post_metrics` (upsert idempotente, null≠0); `InstagramChannelProvider.getPostAnalytics` real; rotas `/api/social/analytics/*` | ESTENDER/COMPOR | `test:social-analytics-sync` (18) |
| F5 | **Competitive Intelligence Adapter** — fonte pública/legal → pipeline PRD 9 | COMPOR/CRIAR (mín.) | `test:competitive-intelligence` |
| F6 | **Vertical Social Intelligence** — pool + cache + freshness + budget (reusa PRD 9) | REUTILIZAR | `test:vertical-social-intelligence` |
| F7 | **Opportunity Matching** — external evidence × contexto → `business_signal` | COMPOR | `test:opportunity-matching` |
| F8 | **Studio Intelligence Handoff** — oportunidade → contexto estruturado → Estúdio | COMPOR | `test:studio-handoff` |
| F9 | **Creative Variants** — opções A/B/C por objetivo/canal/hipótese/evidência | ESTENDER | `test:creative-variants` |
| F10 | **Calendar + Scheduling** — draft→awaiting_approval→approved→scheduled + grade | ESTENDER | `test:editorial-calendar` |
| F11 | **Governed Publishing** — Execution Runtime + policy + confirmation + idempotência | COMPOR | `test:governed-publishing` |
| F12 | **Analytics & Attribution** — publicação → resultado observável (correlação ≠ atribuição) | ESTENDER | `test:content-analytics` |
| F13 | **Creative Learning** — Outcome Assurance → Pattern Memory (best-time, formato vencedor) | COMPOR | `test:creative-learning` |
| F14 | **Fala Tu + Radar + Proatividade** — gestão por exceção (oportunidades proativas) | ESTENDER | `test:social-proactive` |
| F15 | **Entitlements + Billing Readiness** — planos, upgrades, capacidades sociais gated | ESTENDER | `test:social-entitlements` |
| F16 | **Reliability + Security Hardening** — health/rate-limit/token-expiry/retry/queues/secrets | ESTENDER | `test:social-reliability` |
| F17 | **Commercial Proof** — golden paths reais (Moda/Clínica/Restaurante) | COMPOR | `test:golden-path-*` |
| F18 | **Production Hardening + Runbook** — testes transversais RN-SI, rollback, `docs/runbook/social-intelligence-operacao.md` | CRIAR (teste) | `test:social-intelligence-hardening` |

**F1+ está bloqueada até esta F0 (ADR-167) mergear (§43/§54).** Cada fatia = 1 PR draft → CI verde → merge → próxima. A F3 escolhe **um** provider real (não cinco simultâneos).

---

## 6. Golden paths (provas comerciais — §44–46)

- **Moda** — pesquisa detecta ↑interesse por camisa de linho → Vertical Intelligence → tenant com estoque alto + margem boa + vendas em queda → Opportunity Matching → `business_signal` → Fala Tu "preparei 3 campanhas" → Estúdio → aprovação → Instagram/TikTok → publicação → analytics → vendas → Outcome Assurance → Pattern Memory.
- **Clínica** — ↑interesse por serviço permitido pela política → cruza com capacidade de agenda/especialidades → conteúdo **educativo** (sem alegação médica não sustentada, sem dado de paciente).
- **Restaurante** — tendência de prato/momento/comportamento local → cruza com estoque/margem/capacidade → campanha só quando operacionalmente faz sentido (marketing não gera demanda para o indisponível).

---

## 7. O que o PRD 10 NÃO faz (§42)

- **NÃO** cria Social Intelligence Engine paralelo ao External Intelligence — reusa `VerticalIntelligenceService`/`ExternalResearchProvider`.
- **NÃO** cria segundo Scheduler nem segundo JobQueue — adiciona passes/jobs aos existentes.
- **NÃO** cria segundo Decision/Learning/Approval Engine — compõe `DecisionEngine`/`PatternMemory`/`ApprovalPolicy`.
- **NÃO** cria tabela de alerta paralela (`social_alerts`) — publica em `business_signals`.
- **NÃO** cria segundo Estúdio nem segundo calendário — estende `StudioService`/`scheduled_posts`.
- **NÃO** cria segunda tela de credenciais por módulo — Canais e IA é o ponto único.
- **NÃO** integra frontend direto às APIs sociais, nem guarda segredo OAuth no browser.
- **NÃO** pesquisa por-tenant o que é reutilizável por vertical.

---

## 8. Observabilidade, LGPD e rollout

- **Observabilidade (§38):** todo fluxo carrega `organization_id`/`correlation_id`/`research_id`/`opportunity_id`/`campaign_id`/`content_id`/`publication_id` quando aplicável; reconstruível por `ExecutionTraceService.trace`. Idempotência (§39) em sync/ingest/pesquisa/sinal/agendamento/publicação/analytics/outcome/learning.
- **LGPD (§36):** minimização, purpose limitation, isolamento por org, retenção definida, revogação, exclusão, segredo criptografado, RBAC. Nunca compartilhar dado privado entre tenants via pool (RN-SI-04).
- **Rollout (§51/§52):** flags OFF → internal → shadow → single tenant → approved execution → small cohort → GA. **Autonomous publishing nunca entra direto em GA.**

---

## 9. Pré-requisito atendido e sucessor

- **Entrada:** PRDs 0–9 **FECHADOS** — o cérebro, a governança, a plataforma e a inteligência externa existem.
- **Saída:** o PRD 10 é a **prova comercial** que fecha o programa ZEI: mercado real → decisão contextualizada → conteúdo executável → publicação governada → resultado mensurável → aprendizado empresarial (§47/§48).
