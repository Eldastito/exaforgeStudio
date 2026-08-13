# Análise Comparativa — PRD 10 (Final Integration, Social Intelligence, Creative Execution & Commercial Proof) × Codebase

**Escopo:** entregável da **F0** do PRD 10 (ADR-167). Prova, com evidência `file:symbol`, o que já existe no `main` para que a implementação (F1+) seja **predominantemente REUTILIZAR/ESTENDER/COMPOR** e só o mínimo CRIAR. **Documento sem código de produção** — a implementação está **bloqueada até esta F0 mergear** (Regra Zero / §43 / §54).

**Conclusão executiva:** o "cérebro" do ZapFlow — percepção → contexto → evidência → decisão → governança → execução → confirmação → garantia → aprendizado — **já existe inteiro** (PRDs 0–9). A infraestrutura de pesquisa externa, inteligência de vertical, procedência, Scheduler, JobQueue genérico, entitlements, RBAC, criptografia de segredos, OAuth e Admin Master **também**. O PRD 10 **NÃO é um motor novo de social media**: é a **camada final que conecta** essas peças às superfícies reais (Canais e IA + Estúdio) e preenche **três lacunas de borda** — (a) um contrato/registry unificado de **canal social** com OAuth seguro e capabilities descobertas; (b) o Estúdio **orientado por inteligência** (Oportunidade → handoff → variantes → calendário → publicação governada); (c) o **closed-loop de conteúdo** (analytics → Outcome Assurance → Creative Learning). **PUBLISHED ≠ RESULTADO**, assim como `DONE ≠ RESULTADO`.

---

## 1. Tese: o que já existe vs. o que o PRD 10 precisa ligar

| Camada do fluxo PRD 10 (§2) | Existe no `main`? | Evidência |
| --- | --- | --- |
| Pesquisa externa (viva + procedência) | ✅ | `ExternalResearchProvider.ts` (`LiveSearchResearchProvider:243`, `evidenceMode`/`sourceEvidence`); `VerticalIntelligenceService.ts:49` |
| Detecção de necessidade de pesquisa | ✅ | `ResearchNeedService.detect` (`ResearchNeedService.ts:46`) |
| Vertical Intelligence + pool + freshness | ✅ | `vertical_intelligence` (`db.ts:8138`, sem org, UNIQUE fingerprint); `getFresh:197`; `ResearchBrokerService.resolve:29` (L2/L3) |
| Evidência / procedência | ✅ | `EvidencePackageService.compose:96` (internal+external+historical); `SourceEvidence`/`EvidenceMode` (`ExternalResearchProvider.ts:36/51`) |
| **Opportunity Matching** (mercado × empresa → sinal) | ⚠️ **parcial** | detectores publicam em `business_signals`, mas **não há** um matcher "descoberta externa × contexto do tenant" |
| Decision Intelligence | ✅ | `DecisionEngine.analyze:58` (L0–L4, `learningPrior:237`); `ImpactPrioritizationService.levelFor:170` |
| **Creative Intelligence** (variantes A/B/C orientadas a objetivo) | ⚠️ **parcial** | `StudioService.generate/suggestCaption` produzem **1** resultado; sem geração de alternativas |
| Estúdio (marca→imagem/vídeo→legenda→publicar/agendar) | ✅ | `StudioService.ts:55`; `routes/studio.ts`; `features/StudioView.tsx:54` |
| Aprovação / Autonomia | ✅ | `ApprovalPolicyService.resolveContract:107` (Autonomy Contract ADR-159); `agent_policies` (`db.ts:6246`) |
| **Agendamento / calendário editorial** (draft→approved→scheduled) | ⚠️ **parcial** | `scheduled_posts` (`db.ts:173`, estados `scheduled\|published\|failed\|canceled`); **sem** `draft`/`approved`, sem grade de calendário |
| **Publicação governada** (via Execution Runtime) | ⚠️ **parcial** | publica Instagram via `InstagramService.publish:148` + `publishScheduledPass:178`, mas **fora** do `CommandExecutorService` governado |
| Analytics de publicação | ⚠️ **parcial** | `InstagramService.fetchAccountInsights:44` (conta); **sem** analytics por-post pós-publicação |
| Outcome Assurance | ✅ | `OutcomeAssuranceService.assessAction:34` (escada até `assured`); `OutcomeMeasurementService.record:44` |
| Enterprise Learning (Creative Learning) | ✅ | `PatternMemoryService.recordOutcome:256` (idempotente); `PatternLearningFromAssuranceService.learnFromAction:40` |
| **Canal social (contrato/registry unificado + OAuth + capabilities)** | ⚠️ **parcial** | `channels` table (`db.ts:21`) + `MessageProviderService`; **template** de registry em `ReputationProvider.ts:134`; só Instagram+WhatsApp publicam |

**Achado central:** ~85% do PRD 10 já é COMPOR/REUTILIZAR. As **⚠️ parciais** e as **❌ ausências** são a superfície real de trabalho — e nenhuma exige motor novo; todas ESTENDEM ou COMPÕEM peças existentes.

---

## 2. Matriz REUTILIZAR / ESTENDER / COMPOR / CRIAR / DEFERIR (§1/§43)

### 2.1 Canais & credenciais (borda de conexão)

| Capacidade | Existe | Reutilizar | Estender | Compor | Criar | Deferir |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| Área "Canais e IA / Automação" (UI+backend+`channels`) | ✅ | ✅ | ✅ | | | |
| WhatsApp / Evolution (send + webhook) | ✅ | ✅ | | | | |
| Instagram (OAuth + publish + insights) | ✅ | ✅ | ✅ | | | |
| Padrão contrato+registry+capabilities | ✅ (`ReputationProvider`) | ✅ | | ✅ | | |
| **`SocialChannelProvider` unificado** (capabilities descobertas) | | | | ✅ | ✅ (mín.) | |
| Facebook feed / TikTok / LinkedIn / YouTube / X | | | | | | ⏸️ **DEFERIR** (por API/plano/termos) |
| Meta Ads / Google Ads | | | | | | ⏸️ **DEFERIR** |
| OAuth seguro + refresh + revogação (server-side) | ✅ | ✅ (`GoogleOAuthService`/`instagramOAuth`) | ✅ | | | |
| Criptografia de segredos (AES-GCM) | ✅ (`EncryptionService.ts:31`) | ✅ | | | | |
| Modelo de saúde por-conexão (connected/expired/rate_limited) | ✅ (`ReputationHealthStatus`, `ReputationConnectorService.ts:19`) | ✅ | ✅ | | | |
| Card de conexão com estado observável (UI) | ⚠️ (`ChannelsPanel` status simples) | | ✅ | | | |

### 2.2 Inteligência social & oportunidade

| Capacidade | Existe | Reutilizar | Estender | Compor | Criar | Deferir |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| Scheduler (passes horário/5min) | ✅ (`Scheduler.ts:72`) | ✅ | | | | |
| JobQueue genérico (`background_jobs`) | ✅ (`JobQueueService.ts:48`) | ✅ | | | | |
| Pesquisa externa viva + procedência | ✅ | ✅ | | | | |
| Vertical Intelligence Pool (fingerprint+TTL+L2/L3) | ✅ | ✅ | | | | |
| Research Budget (global, master) | ✅ (`ResearchBudgetService.ts:18`) | ✅ | | | | |
| Pesquisa agendada + reativa | ✅ (`VerticalIntelligenceResearchService.maybeSweep` + `ResearchNeedService`) | ✅ | ✅ | | | |
| **Ingestão de analytics próprios (posts/conta)** | ⚠️ | | ✅ | ✅ | | |
| **Inteligência competitiva** (só dado público/legal) | | | | ✅ | ✅ (mín.) | |
| Anonimização + zero dado por-org no pool | ✅ (`researchAnonymize`, `tenantTermsFor`) | ✅ | | | | |
| **Concorrentes monitorados** (config) | | | | | ✅ (mín.) | |
| **Opportunity Matching** (mercado × contexto → `business_signal`) | | | | ✅ | ✅ (mín.) | |

### 2.3 Estúdio, execução & closed-loop

| Capacidade | Existe | Reutilizar | Estender | Compor | Criar | Deferir |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| Estúdio (marca→imagem/vídeo→legenda) | ✅ (`StudioService.ts:55`) | ✅ | ✅ | | | |
| Geração de imagem/vídeo (Imagen/Veo/OpenAI) | ✅ (`llm.ts:168/301`) | ✅ | | | | |
| Marca / brand guidelines | ✅ (`brand_profiles`, `analyzeBrand:67`) | ✅ | | | | |
| Biblioteca de ativos (canônica) | ✅ (`ArtifactService.ts:67`, `StorageService`) | ✅ | | | | |
| **Entrada "Oportunidades" no Estúdio** | | | | ✅ | ✅ (mín.) | |
| **Handoff Oportunidade→contexto estruturado→Estúdio** | | | | ✅ | ✅ (mín.) | |
| **Variantes criativas A/B/C** (objetivo/canal/hipótese) | | | ✅ | | ✅ (mín.) | |
| **Adaptação multicanal** (proporção/duração/CTA) | | | ✅ | | ✅ (mín.) | |
| **Best-time-to-post** (aprendido, `insufficient_history`) | | | | ✅ | ✅ (mín.) | |
| **Calendário editorial** (draft→approved→scheduled + grade) | ⚠️ (`scheduled_posts` só scheduled+) | | ✅ | | | |
| Aprovação/Autonomia (Execution Runtime) | ✅ | ✅ | ✅ | | | |
| **Publicação GOVERNADA** (via `CommandExecutorService`) | ⚠️ (IG publica fora do runtime) | ✅ | ✅ | ✅ | | |
| ConfirmationEngine (publicação confirmada) | ✅ (`ConfirmationEngine.expect:85`) | ✅ | ✅ | | | |
| **Analytics por-post pós-publicação** | | | ✅ | | ✅ (mín.) | |
| Outcome Assurance (PUBLISHED≠RESULTADO) | ✅ | ✅ | ✅ | | | |
| Creative Learning (Pattern Memory) | ✅ | ✅ | ✅ | | | |

### 2.4 Plataforma (entitlements, governança, observabilidade)

| Capacidade | Existe | Reutilizar | Estender | Compor | Criar | Deferir |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| Entitlements/planos (decisão server-side) | ✅ (`EntitlementService.ts:199`, gate em `server.ts:503`) | ✅ | ✅ | | | |
| RBAC (legacy + granular ADR-095) | ✅ (`middleware/auth.ts`, `PermissionService.ts:161`) | ✅ | | | | |
| Feature flags (per-org + global) | ✅ (`organization_settings.*_enabled`, `platform_settings`) | ✅ | ✅ | | | |
| Admin Master (fleet, custo, saúde) | ✅ (`routes/admin.ts`, `requireMasterAdmin`) | ✅ | ✅ | | | |
| Platform Reliability + Protection Mode | ✅ (`OperationalHealthService`, `PlatformProtectionModeService`, `PlatformAlertService`) | ✅ | ✅ | | | |
| Custo AI/API restrito ao master | ✅ (`ai_usage_log.cost_brl`, `research_usage_log`) | ✅ | ✅ | | | |
| Audit trail + maskIdentifier | ✅ (`auditLog.ts`) | ✅ | | | | |
| Observabilidade por correlation_id | ✅ (`ExecutionTraceService.trace:41`) | ✅ | ✅ | | | |
| **Health de provider social integrado ao Reliability** | ⚠️ (deps `not_instrumented`) | | ✅ | ✅ | | |

**PROIBIDO CRIAR (§42):** Social Intelligence Engine paralelo · segundo Scheduler · segundo JobQueue · segundo Decision Engine · segundo Learning Engine · segundo Approval Engine · tabela de alertas paralela (`social_alerts`) · segundo Estúdio · segunda tela de credenciais por módulo · segundo calendário · integração direta frontend→APIs sociais · segredo OAuth no browser · pesquisa por-tenant quando reutilizável por vertical.

---

## 3. Evidência por área (síntese das 5 auditorias)

### 3.1 Canais, WhatsApp/Instagram, OAuth, segredos — **borda parcial**
- **Canais:** área completa — `routes/channels.ts` (CRUD `:10/38/63/101`), tabela `channels` (`db.ts:21`: `provider/status/token_encrypted/webhook_secret/metadata_json`), UI `features/ChannelsPanel.tsx:12` ("Canais e Automação"), nav `Sidebar.tsx:72`. Tabela genérica `integrations` (`db.ts:252`).
- **WhatsApp/Evolution:** `EvolutionService.ts:46` (QR/instância), `MessageProviderService.sendMessage:11` (WA Cloud/IG/Evolution), webhook em `webhookProcessor.ts`.
- **Instagram/Meta:** `InstagramService.ts:17` (`fetchMedia:32`, `analyzeAccount:75`, `publish:148`, `publishScheduledPass:178`, `fetchAccountInsights:44`); OAuth em `routes/instagramOAuth.ts` (state HMAC `:12/22`, `login-url:48`, escopo `instagram_business_content_publish:44`). Meta webhooks `routes/metaDebug.ts`, `meta_webhook_hits` (`db.ts:5373`).
- **Padrão de provider (o template):** `ReputationProvider.ts:134` — `interface` com `capabilities:ReputationProviderCapability[]` (`:27/136`), `StubReputationProvider:191`, `REGISTRY:246`, `getReputationProvider:251`; concreto `ReclameAquiProvider.ts:58` transport-only; estado `ReputationConnectorService.ts` com `ReputationHealthStatus` (`connected|auth_expired|rate_limited|degraded|unavailable`, `:19`) e `recordHealth:87`. **É o molde exato do `SocialChannelProvider`.**
- **Segredos:** `EncryptionService.ts:31` (AES-256-GCM, `enc:v1:`, `ENCRYPTION_KEY`→`JWT_SECRET` fallback `:17`); tokens em `channels.token_encrypted`, `oauth_connections` (`db.ts:261`: access/refresh/scopes/expires_at), `reputation_connectors.config_enc`. `GoogleOAuthService.ts:27` (fluxo server-side offline). HMAC em `fileSigning.ts:25` (`sha256(JWT_SECRET:scope_v1)`).
- **Ausências:** registry unificado de canal social; Facebook-feed/TikTok/LinkedIn/YouTube/X; ads; publicação só Instagram.

### 3.2 Estúdio, criativo, calendário — **maduro, com 3 lacunas**
- **Estúdio:** `StudioService.ts:55` — `analyzeBrand:67`, `generate` (imagem `:122`), `startVideo/pollVideo` (`:151/178`), `suggestCaption:216` (com `CAMPAIGN_OBJECTIVES:36`), `schedulePost:231`, `listScheduled:249`, `markPosted:211`, `listCreations:269`. Rotas `routes/studio.ts`; UI `features/StudioView.tsx:54`; gate módulo `estudio` (`ModuleService.ts:33`).
- **Geração:** `llm.ts:168` `generateImageB64` (Imagen + OpenAI fallback), `:301/318` Veo vídeo, `:361` `describeImage` (visão p/ marca).
- **Marca/ativos:** `brand_profiles` (`db.ts:154`), `ArtifactService.ts:67` (artefato canônico, signed URL, RBAC), `StorageService.ts:44` (S3-compat), `studio_creations` (`db.ts:162`).
- **Calendário:** `scheduled_posts` (`db.ts:173`, estados `scheduled|published|failed|canceled`), `InstagramService.publishScheduledPass:178` disparado por `Scheduler.ts:106`. UI é **lista**, não grade.
- **Ausências:** variantes A/B/C (gera 1 só); estados `draft`/`approved` + grade de calendário editorial; best-time-to-post (greenfield).

### 3.3 Research/infra — **tudo EXISTS** (reusar, não duplicar)
- `Scheduler.ts:72` (tick horário + fastPass 5min; passes de pesquisa em `:748/751`); `JobQueueService.ts:48` (`enqueue/runJob/sweepStale`, `background_jobs` `db.ts:4782`).
- `ExternalResearchProvider.ts` (contrato `:53`, Stub/Llm/Live, `REGISTRY:268`, `parseLiveSearch:204`); `VerticalIntelligenceService.ts:49` (`runResearch:55`, `publish:133`, `getFresh:197`, `tenantTermsFor:30`); `ResearchNeedService.detect:46`; `ResearchCuratorService.assessQuality:111` (gates 2.0); `ResearchBudgetService.ts:18`; `ResearchBrokerService.resolve:29`; `researchAnonymize.sanitizeForShared:65`.
- Pool = propriedade emergente (fingerprint dedup + tabela sem org + `valid_until` TTL + L2/L3), **não** uma classe `Pool` separada.

### 3.4 Espinha inteligência/governança/execução — **tudo EXISTS**
- `BusinessSignalService.publish:58`/`attention:109`/`resolveByDedupe:207` (`business_signals` `db.ts:5919`, `UNIQUE(org,dedupe_key)`); Radar 3 origens (`HumanSignalService:81`, `ExternalSignalService:81`, digital via detector). Convenção dura: **nunca criar tabela de alerta própria** (`CLAUDE.md:89`).
- Context: `BusinessSnapshotV2Service.build:23`, `ContextEngineService:39`. Evidence: `EvidencePackageService.compose:96`.
- Decision: `DecisionEngine.analyze:58` (+`learningPrior:237`), `ImpactPrioritizationService.levelFor:170`, `DecisionRiskService:40`.
- Execução governada: `DecisionActionService.propose:40`, `ApprovalPolicyService.resolveContract:107` (Autonomy Contract), `CommandExecutorService.execute:188` (auditado em `action_execution_log` `db.ts:6278`), `ConfirmationEngine.expect:85`.
- Outcome/Learning: `OutcomeAssuranceService.assessAction:34`, `OutcomeMeasurementService.record:44`, `PatternMemoryService.recordOutcome:256`, `PatternLearningFromAssuranceService.learnFromAction:40`, `ExecutionTraceService.trace:41`.
- SkillOS/Processo: `PlaybookEngine`, `ProcessRuntimeService:113`, `SkillOsExecutionBridge:44`.

### 3.5 Plataforma — **tudo EXISTS**
- Entitlements: `EntitlementService.check:204` (7 estados, server-side em `server.ts:503-522`), `PlanService:32`, `plansGrade.ts:48`, `VerticalBlueprintService`. RBAC: `middleware/auth.ts` (`requireRole:77`, `requireMasterAdmin:63`, `requirePermission:99`), `PermissionService:161`.
- Flags: per-org `organization_settings.*_enabled` + `enabled_modules`/`vertical`; global `platform_settings` (`db.ts:8218`).
- Admin Master: `routes/admin.ts` (fleet/custo/plans/blueprints/reliability, tudo `requireMasterAdmin`). Custo master-only (`ai_usage_log.cost_brl`, `research_usage_log` sem org).
- Reliability (ADR-164): `OperationalHealthService:34`, `DependencyHealthService:32` (deps sociais hoje `not_instrumented`), `PlatformProtectionModeService:44` (shadow-first), `PlatformAlertService.raise:29` (`platform_health_events` `db.ts:8900`).

---

## 4. Gaps que a implementação (F1+) fecha — sem motor novo

| # | Gap | Onde fecha (REUTILIZAR/ESTENDER/COMPOR) |
| --- | --- | --- |
| G1 | Sem contrato/registry unificado de canal social | CRIAR (mín.) `SocialChannelProvider` **espelhando** `ReputationProvider` (capabilities+registry+env); reusar `EncryptionService`+`oauth_connections`+`channels`. |
| G2 | Estado de conexão observável (card) | ESTENDER `ChannelsPanel` + reusar o modelo `ReputationHealthStatus`. |
| G3 | Analytics próprios por-post | ESTENDER `InstagramService` + job `social.analytics.sync` no `JobQueue`/`Scheduler`. |
| G4 | Inteligência competitiva (público/legal) | COMPOR sobre o pipeline PRD 9 (`ExternalResearchProvider`/`ResearchCurator`); CRIAR adapter + config de concorrentes. |
| G5 | Vertical Social Intelligence | REUTILIZAR `VerticalIntelligenceService` + pool + budget (nada novo de infra). |
| G6 | Opportunity Matching | COMPOR `EvidencePackage`/`external evidence` × contexto do tenant → `business_signal` (sem tabela nova). |
| G7 | Handoff Oportunidade→Estúdio | COMPOR sinal → contexto estruturado (marca/produto/estoque/objetivo/evidência) → `StudioService`. |
| G8 | Variantes criativas A/B/C | ESTENDER `StudioService.generate/suggestCaption` p/ N alternativas rotuladas por objetivo/hipótese/evidência. |
| G9 | Calendário editorial (draft→approved) | ESTENDER `scheduled_posts` com estados `draft`/`awaiting_approval`/`approved` + grade na UI. |
| G10 | Publicação GOVERNADA | COMPOR `DecisionAction→ApprovalPolicy→CommandExecutor→ConfirmationEngine` p/ a publicação (idempotência RN-SI-08). |
| G11 | Analytics→Outcome→Learning (closed-loop) | COMPOR `OutcomeMeasurementService`/`OutcomeAssuranceService` + `PatternMemory` (PUBLISHED≠RESULTADO). |
| G12 | Best-time-to-post | COMPOR `PatternMemory` por (canal×formato×objetivo×dia×hora); sem histórico → `insufficient_history`. |
| G13 | Proatividade (Fala Tu + Radar) | ESTENDER `FalaTuProactiveService`/`RadarService` p/ consumir oportunidades (via `business_signals`). |
| G14 | Entitlements sociais | ESTENDER `EntitlementService`/`plansGrade` com capacidades sociais (validação server-side). |

---

## 5. Guardrails (RN-SI-01..15) — já cumpríveis por herança

| RN-SI | Onde já se apoia |
| --- | --- |
| 01 pesquisa externa ≠ fato interno | `EvidencePackage.externalEvidence` separado; Context Engine mantém `external_evidence` (§30) |
| 02 model_knowledge ≠ live | `evidenceMode` (`ExternalResearchProvider.ts:51`), gate `ungrounded_live` (`ResearchCuratorService:130`) |
| 03 PUBLISHED ≠ RESULTADO | `OutcomeAssuranceService` escada; `PatternMemory` só aprende de `assured` (RN-EL-1) |
| 04 dado privado nunca no pool | `researchAnonymize.assertNoTenantData`, `tenantTermsFor` (PRD 9 F10) |
| 05 credencial nunca no frontend | `EncryptionService` + tokens server-side (`channels.token_encrypted`, `oauth_connections`) |
| 06 capability descoberta, não presumida | padrão `capabilities[]` de `ReputationProvider` |
| 07 pesquisa obedece budget | `ResearchBudgetService.canSpend` |
| 08 retry de publicação idempotente | `CommandExecutorService` guarda `priorDone` (`:224`); `event_key` pattern |
| 09 ação externa respeita política/autonomia | `ApprovalPolicyService.resolveContract` (ADR-159) |
| 10 nenhum motor paralelo | convenção `CLAUDE.md:89` + §184 (ADR-166) |
| 11 concorrente = só dado legal/autorizado | política de fonte no adapter competitivo (F5) |
| 12 IA não inventa métricas | RN-004 (derivar por query); providers honestos |
| 13 sem histórico → `insufficient_history` | padrão já usado (Wilson `null`; capacity `insufficient_history`) |
| 14 entitlement validado server-side | `EntitlementService.isModuleAvailable` no `protectedApi` (`server.ts:503`) |
| 15 resultado financeiro exige atribuição compatível | `OutcomeMeasurementService.basis` (fact/estimate/influenced, nunca somados) |

---

## 6. Plano de fatias (resumo — detalhe no ADR-167)

| Fatia | Entrega | Natureza |
| --- | --- | --- |
| **F0** | Esta análise + ADR-167 (doc-only) | Auditoria |
| F1 | Channel Capability Contract (consolidar padrão de provider) | CRIAR (mín.)/COMPOR |
| F2 | Social Connection Hub (estende Canais e IA: OAuth/health/capabilities) | ESTENDER |
| F3 | Primeiro provider real (vertical slice ponta-a-ponta) | CRIAR (mín.) |
| F4 | Social Analytics Ingestion (posts + analytics próprios) | ESTENDER/COMPOR |
| F5 | Competitive Intelligence Adapter (fonte pública → pipeline PRD 9) | COMPOR/CRIAR (mín.) |
| F6 | Vertical Social Intelligence (pool + cache + freshness + budget) | REUTILIZAR |
| F7 | Opportunity Matching (external evidence × contexto → `business_signal`) | COMPOR |
| F8 | Studio Intelligence Handoff (oportunidade → contexto estruturado) | COMPOR |
| F9 | Creative Variants (opções por objetivo/canal) | ESTENDER |
| F10 | Calendar + Scheduling (draft→approval→scheduled) | ESTENDER |
| F11 | Governed Publishing (Execution Runtime + confirmação + idempotência) | COMPOR |
| F12 | Analytics & Attribution (publicação → resultado observável) | ESTENDER |
| F13 | Creative Learning (Outcome Assurance → Pattern Memory) | COMPOR |
| F14 | Fala Tu + Radar + Proatividade (gestão por exceção) | ESTENDER |
| F15 | Entitlements + Billing Readiness (planos, upgrades, capacidades) | ESTENDER |
| F16 | Reliability + Security Hardening (health/rate-limit/token/retry/secrets) | ESTENDER |
| F17 | Commercial Proof (golden paths reais) | COMPOR |
| F18 | Production Hardening + Runbook (testes transversais, rollback) | CRIAR (teste) |

**F1+ está bloqueada até esta F0 mergear (§43/§54).** Cada fatia = 1 PR draft → CI verde → merge → próxima.

---

## 7. Critério de sucesso (§47) — o teste ponta-a-ponta

O PRD 10 só encerra quando for demonstrável: **uma informação externa real** entra no ZapFlow → **preserva evidência/procedência** → vira **oportunidade contextualizada** para um tenant → gera **conteúdo no Estúdio** → passa por **política de aprovação** → é **publicada em canal real** → a publicação é **confirmada** → o **resultado é medido** → o resultado **alimenta o aprendizado**. Os 3 golden paths (Moda / Clínica / Restaurante, §44–46) são as provas comerciais.
