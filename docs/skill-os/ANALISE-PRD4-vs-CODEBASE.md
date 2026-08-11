# ANÁLISE PRD 4 (ZapFlow SkillOS + AI Reliability Kernel) × CODEBASE

**Fase 0 — Auditoria obrigatória do codebase.** Entregável exigido antes de qualquer
implementação (PRD 4 §4.2). Nenhuma fatia do SkillOS pode começar antes desta análise.

- **Baseline auditado:** `main` @ `4df6e9c` (pós-merge PRD 3 F12 — Business Context Engine FECHADO).
- **Método:** 6 varreduras paralelas read-only cobrindo (1) infra de execução de IA, (2) contabilidade/custo/budget de IA, (3) Context/Decision/Signals, (4) Execution/Policy/Approval/Runtime, (5) Skills/Capability/Planner, (6) confiabilidade/observabilidade/capacidades.
- **Regra central (PRD 4 §3):** `REUTILIZAR > ESTENDER > COMPOR > CRIAR`. Duplicidade funcional = regressão arquitetural. Antes de qualquer novo engine/registry/ledger/scheduler/policy/observability, é obrigatório provar que o equivalente não existe.

---

## 1. Sumário executivo

**Conclusão:** ~75–80% do que o SkillOS precisa **já existe** e é reuso/composição direta. O PRD 4 é predominantemente **camada de coordenação** sobre peças construídas nos PRDs 1–3 e nas ADRs 095/126/136/152/154/158/159/160. O verdadeiro *net-new* (CRIAR) é pequeno e bem delimitado:

**Núcleo a CRIAR (não existe sob nenhum nome):**
- **Capability Registry** — abstração "o que o sistema sabe fazer", independente de implementação.
- **Skill Registry + Manifest** — implementações de uma Capability, com manifesto explícito.
- **Capability Resolver** — escolha entre implementações concorrentes por regra/health/custo/latência.
- **Planner (síntese)** — transformar um objetivo/intent aberto num plano novo (o *authored* já existe).
- **Model Router + Model Profile + Provider Abstraction** — seleção dinâmica de modelo (hoje é `env` estático).
- **Prompt Management (versionamento)** — id/versão/hash/status de prompt (hoje prompts são strings inline).
- **Reliability Kernel — primitivas faltantes:** circuit breaker, `withTimeout()`, e o *gate* de grounding.
- **Continuous Evals / Regression Gate / Shadow Mode** — harness de avaliação de IA (a convenção de teste existe; o scorer/baseline/shadow não).
- **OCR / ingestão binária** — hoje arquivos são roteados mas nunca *lidos*.

**Tudo o mais é REUTILIZAR/ESTENDER/COMPOR** — e há mandatos arquiteturais que *proíbem* recriar:
- **ADR-159 (choke-point de execução):** todo efeito externo já passa por `CommandExecutorService`. Um executor de skill paralelo reabre exatamente o buraco que a ADR-159 fechou (§67 do PRD).
- **AC-A01 (PRD 3):** `ContextEngineService` é a fachada única de contexto — proibido motor de contexto paralelo.
- **Convenção #12 (ADR-136):** alertas vão para `business_signals` — proibida tabela de alertas paralela.
- **RN-004:** métricas/budgets derivados por query, nunca contador mutável.

---

## 2. MATRIZ DE COBERTURA (o entregável §4.2)

Estado: **EXISTE** (pronto) · **PARCIAL** (existe base, falta parte) · **NOVO** (não existe).
Decisão: **REUTILIZAR / ESTENDER / COMPOR / CRIAR / DEFERIR**.

### 2.1 Núcleo SkillOS (Capability / Skill / Planner)

| Requisito PRD 4 | Componente atual | Estado | Decisão |
| --- | --- | --- | --- |
| **Capability Registry** | — (nada modela "capacidade" abstrata; só `type Capability` local de UI em `RetailDiagnosticService`) | NOVO | **CRIAR** — modelar no padrão declarativo de `AnomalyDetectorRegistry` (registry + defaults por vertical) |
| **Skill Registry + Manifest** | — (o termo "skill" está OCUPADO: tabela `skills` = competências de RH via `PeopleDevelopmentService`) | NOVO | **CRIAR** — reusar o *shape* de `CommandHandler`; **namespacing obrigatório** (ver Decisão D1) |
| **Capability Resolver** | — (`CommandExecutorService.REGISTRY` é 1:1 command→handler, sem ranking/health/custo) | NOVO | **CRIAR** — net-new; começar conservador (1 skill → resolve direto) |
| **Planner — planos autorais** | `ProcessRuntimeService` (FSM `process_definitions`/`process_instances`) + `PlaybookEngine` (`PlaybookStep`/`chooseNextStep`) | PARCIAL | **ESTENDER** — encadeamento de passos já existe |
| **Planner — síntese goal→plano** | — (playbooks são JSON hand-authored; nada sintetiza plano novo) | NOVO | **CRIAR** — a camada de síntese é o net-new |
| **ExecutionPlan (plan_id/steps/deps/status)** | `process_definitions`/`process_instances`/`process_transitions` + `context_json.results` + `correlation_id` | EXISTE | **REUTILIZAR** — ExecutionPlan = um `process_type`, não tabela nova |
| **Skill Runtime** | — (executor de skill não existe) | NOVO | **CRIAR (fino)** — executa 1 skill; despacha efeito via `CommandExecutorService` (nunca direto) |
| **Tool Registry (catálogo com schema)** | `CommandExecutorService` (`CommandHandler{key,commandTypes,prepare,execute}`, `REGISTRY`, `registerHandler`) + `RuntimeCommandHandlers`/`edgeCommandHandlers` | PARCIAL | **ESTENDER** — já é o registro de tools; falta **schema declarado por comando** (payload hoje é JSON solto) |
| **Tool permissions (allowed/forbidden por skill)** | `AiGovernanceService.PEOPLE_AFFECTING` (registro de ações que exigem humano) + `EXECUTION_MODE_LEVELS` | PARCIAL | **COMPOR** — manifesto declara allowed/forbidden; Skill Runtime rejeita tool não declarada |

### 2.2 AI Reliability Kernel

| Requisito PRD 4 | Componente atual | Estado | Decisão |
| --- | --- | --- | --- |
| **Reliability Kernel (choke-point)** | `llm.ts` — choke-point real (40 módulos importam; só ele fala com SDK/HTTP de provider) | PARCIAL | **ESTENDER** — hospedar resiliência/roteamento/tracing dentro do choke-point que já existe |
| **Provider Abstraction (`invoke/health/estimateUsage/supports`)** | ad-hoc (OpenAI SDK singleton vs Google `fetch`); `isAIConfigured()` é a única sonda | PARCIAL | **CRIAR (fino) + COMPOR** — extrair `Provider` atrás de `chat/embed/image` (baixo risco: callers já passam por `llm.ts`) |
| **Model Router (seleção dinâmica)** | — (modelo é `env` estático: `CHAT_MODEL`, `EMBED_MODEL`; `PRICES` só para custo) | NOVO | **CRIAR** — inputs reusáveis: `PRICES` + latência de `ai_usage_log` + health |
| **Model Profile (reasoning/vision/tool_call/…)** | — | NOVO | **CRIAR** |
| **Prompt Management (id/versão/hash/status)** | — (prompts inline em `AIOrchestratorService.buildPrompt`, `geminiRAG`, extractors de `llm.ts`; zero versionamento) | NOVO | **CRIAR** — a lacuna greenfield mais clara |
| **AI Run (execução rastreável)** | `ai_usage_log` (tokens/custo/módulo/`request_id`/latência) + `ai_interactions_log` + `ai_decisions` | PARCIAL | **ESTENDER** — schema+correlação já presentes; adicionar `run_id`/`skill_id`/status de validação/grounding/confidence |
| **Failure taxonomy (AI-FAIL 1–6)** | `JobErrorClass` (`retryable/external_unavailable/permission/non_retryable`) | PARCIAL | **ESTENDER técnico + CRIAR semântico** (format/grounding/policy/outcome não existem como classe) |
| **Output Validator (schema)** | padrão `validateContextPacket` (F10) + validações hand-coded (`sanitizeActions`, `VALID_STAGES`) | PARCIAL | **COMPOR + CRIAR** — adotar zod/JSON-Schema; falha → retry corretivo/fallback |
| **Grounding Validator** | `EvidenceReference` + `evidenceFromSignal`/`evidenceFromRagHit` + `ContextQualityReport.evidence.bySourceType` | PARCIAL | **COMPOR** — primitiva claim→evidência existe; o *gate* que rejeita `UNSUPPORTED_CLAIM` é net-new |
| **Response-type (fact/estimate/hypothesis)** | `basis` enum `[fact,estimate,hypothesis]` + `factTypeFromBasis`→`ContextFactType`(6) | EXISTE | **REUTILIZAR** — não criar enum incompatível (`recommendation` só existe em `DecisionEngine.synthesize`; ESTENDER p/ tipar saída) |
| **Confidence Engine (altera comportamento)** | `ImpactPrioritizationService.scoreSignal` (6 fatores + boosts) · `levelFor` L0–L4 · `confidenceBand` · `ContextQuality.confidence` | PARCIAL | **COMPOR/ESTENDER** — fatores já emitidos; thresholds por Capability/Skill/risco são net-new |
| **Fallback chain** | `JobQueue` error-class + `PlaybookEngine.onFailure/fallbackStep` | PARCIAL | **COMPOR + CRIAR** — cadeia model→provider→determinístico→humano; nunca reduzir segurança p/ disponibilidade |
| **Circuit Breaker (healthy/watch/degraded/open/half_open)** | — ("degraded" existe só como *label* de observabilidade; `degradedChannels()` detecta mas não bloqueia) | NOVO | **CRIAR** — a única primitiva de Kernel genuinamente nova; trip-signal de `degradedChannels` + `error_class='external_unavailable'` |
| **Retry / backoff** | `JobQueueService.computeBackoffSeconds` (canônico) + `MessageDeliveryService` (schedule duplicado) | EXISTE | **ESTENDER** — promover a `retry()` canônico do Kernel e dedup as duas escadas |
| **Timeout** | ad-hoc `AbortController` inline; `action_confirmations.deadline_at` + sweep no `Scheduler` | PARCIAL | **CRIAR `withTimeout()` + REUTILIZAR** o padrão `deadline_at`/sweep para timeouts assíncronos/humanos |

### 2.3 Governança de custo, consumo e privacidade (§29–34)

| Requisito PRD 4 | Componente atual | Estado | Decisão |
| --- | --- | --- | --- |
| **AI usage ledger** | `ai_usage_log` + `llm.recordUsage()` (tokens, cost_usd/brl/cents, latência, módulo, `request_id`) | EXISTE | **REUTILIZAR** — é o campo-fonte do AI Run |
| **Pricing / cost model** | `PRICES` (USD/1M in-out) + `priceFor` + `USD_BRL` em `llm.ts` | EXISTE | **REUTILIZAR / ESTENDER** — adicionar modelos Claude/Anthropic (hoje só OpenAI/Google) |
| **Admin-Master cost visibility** | `AiUsageDashboardService` + `GET /api/admin/ai-usage[/:orgId]` (`requireMasterAdmin`) + `AiUsageDashboardView` | EXISTE | **REUTILIZAR** — é literalmente o alvo §29 |
| **Tenant % capacity view** | `ConsumptionService.status().pct` (contagem de ações) + `GET /api/plans/consumption` | EXISTE | **REUTILIZAR** — usar a **pct de AÇÃO** (§30-safe), não a de custo |
| **Cost-privacy §30 (esconder R$/US$ do tenant)** | estrutural: R$/US$ só sob `requireMasterAdmin`; endpoint do tenant devolve só ações+% | EXISTE | **REUTILIZAR + FORMALIZAR** — codificar como invariante/teste, não plumbing nova |
| **Budget Governance** | `ResearchBudgetService` (plataforma) + `DetectorBudgetService` (per-detector, marker-row em `ai_usage_log`, derivado por query) | EXISTE | **COMPOR** — budget per-skill/tenant segue o padrão `DetectorBudgetService` (RN-004), sem tabela nova |
| **Consumo / entitlement metering** | `ConsumptionService` + `PlanService.aiAllowed` (gate real) + `ai_topup_credits` | EXISTE | **REUTILIZAR** — cuidado com colisões: `ConsumptionLedgerService` (estoque físico) e `SubscriptionService` (clientes do tenant) NÃO são de IA |
| **AI governance / kill by billing** | `AiGovernanceService.policy()` (read-only por billing) + `PEOPLE_AFFECTING` + `recordDecision`→`ai_decisions` | EXISTE | **REUTILIZAR / COMPOR** — base do kill-switch e da allow-list de tools |

### 2.4 Execução governada, política, resultado (reuso obrigatório — §67)

| Requisito PRD 4 | Componente atual | Estado | Decisão |
| --- | --- | --- | --- |
| **Skill → Policy → Execution bridge (§67, sem bypass)** | `CommandExecutorService.execute`/`dispatchGoverned` — único sink governado (guards G1 autonomy · G2 execution_mode · G3 approved+idempotência); **ADR-159** | EXISTE | **REUTILIZAR (obrigatório)** — 2º executor = violação direta da ADR-159 |
| **Approval / Policy** | `ApprovalPolicyService.resolve/resolveContract` (`none/single/role/two_step`; bandas `allow/require_approval/escalate/deny`) + `decision_actions`/`action_approvals` | EXISTE | **REUTILIZAR / ESTENDER** (registrar action_types de skill) |
| **RBAC** | `PermissionService.levelFor/can/isOwner` (ADR-095), default-deny faseado | EXISTE | **REUTILIZAR** |
| **Confirmation Engine** | `ConfirmationEngine.expect/confirm/sweepTimeouts` (dispatch→provado) | EXISTE | **REUTILIZAR** — skill dependente de evento externo faz `expect`/`confirm` (não marca "done" no dispatch) |
| **Outcome Measurement** | `OutcomeMeasurementService.record/ledger` + `UnifiedImpactLedgerService` (categorias isoladas, ADR-085) | EXISTE | **REUTILIZAR** — impacto de skill via `complete`→`record`; novo provider no ledger unificado = COMPOR |
| **Autonomy ceilings (auto-trigger ≠ auto-execute)** | `agent_policies` (bandas + `max_auto_amount`) + `execution_mode` (shadow<assisted<approved_execution<autonomous) + `ProgressiveAutonomyService` | EXISTE | **REUTILIZAR** — IA nunca auto-eleva (RN-014); `autonomous` nunca semeado (LGPD) |
| **Human escalation** | `RuntimeExceptionsService` (derivado por query, sem tabela) + FSM `escalated` + `business_signals` + Approval Center | EXISTE | **REUTILIZAR / ESTENDER** — adicionar `ExceptionSource` de skill; nunca fila nova |
| **Audit (ações admin)** | `logAuthEvent`→`auth_audit_logs` (`maskIdentifier` LGPD) | EXISTE | **REUTILIZAR + ESTENDER** — novos event types `SKILL_*`/`KILLSWITCH_*` |

### 2.5 Contexto, sinais, evidência (PRD 3 — reuso direto)

| Requisito PRD 4 | Componente atual | Estado | Decisão |
| --- | --- | --- | --- |
| **Context input (Planner)** | `ContextEngineService.resolve/resolveFor` → `ContextPacket` (moment/facts/entities/goals/constraints/skillHints/quality) | EXISTE | **REUTILIZAR** — fachada única (AC-A01); `SkillHint` já é a pista deixada pro Planner |
| **Business Signals input** | `BusinessSignalService.attention` (funde signals+decision_risks, ranqueado) | EXISTE | **REUTILIZAR** — 2º input do Planner |
| **Business Constraints** | `BusinessConstraintService.applicable(scope)` + `ContextConstraint` no packet | EXISTE | **REUTILIZAR** — skill não ignora constraint; enforcement real fica no Policy gate |
| **Evidence package** | `EvidencePackageService` (`freshness/confidence/sources`, opt-in) + `evidence_packages` | EXISTE | **REUTILIZAR** |
| **Data-vs-instrução (prompt injection §43)** | `ContextGuardService.classify/neutralize/fence` (`<untrusted_external_data>`) | EXISTE | **REUTILIZAR** — todo texto externo passa por `fence` antes do modelo |
| **Projeção/redação por papel+propósito** | `ContextProjectionService.projectPacket` (manifesto de redação) | EXISTE | **REUTILIZAR / ESTENDER** `PURPOSE_FORBIDDEN` por skill |
| **Decision strategies (pre-mortem/red-team/advocate)** | `DecisionEngine.analyze({mode})` | EXISTE | **REUTILIZAR** — Planner pode invocar |

### 2.6 Capacidades reusáveis (implementações de Capability)

| Requisito PRD 4 | Componente atual | Estado | Decisão |
| --- | --- | --- | --- |
| **RAG capability** | `geminiRAG.searchContextRich`→`RagHit[]` (proveniência estruturada) + `vectorSimilarity` | EXISTE | **REUTILIZAR / COMPOR** — embrulhar como Capability "RAG"; ingestão só utf-8 (binário → CRIAR) |
| **Memory capability** | `FalaTuMemoryEmbeddingsService.searchTopK/buildRelevantMemoryBlock` (JobQueue-backed, opt-in) | EXISTE | **REUTILIZAR** — generalizar tabelas `falatu_*` numa interface de Capability |
| **PDF / XLSX / file gen** | `ReportPdfService` (pdfkit) · `XlsxService` · `FalaTuFileIntakeService` · `StorageService`/`fileSigning` | EXISTE | **REUTILIZAR** como Capability impls |
| **OCR / extração de arquivo** | — (arquivos são roteados/classificados mas nunca lidos; `llm.describeImage` é a base de visão) | NOVO | **CRIAR** — Capability de OCR via LLM-visão; inserir em `FalaTuFileIntakeService` |

### 2.7 Observabilidade, evals, rollout

| Requisito PRD 4 | Componente atual | Estado | Decisão |
| --- | --- | --- | --- |
| **Observability / Central de Saúde** | `routes/health.ts` (`/api/health-center`, ADR-126) + `RuntimeExceptionsService.indicators` + `RadarHealthService` + `ProductionReadinessService` | EXISTE | **ESTENDER** — indicadores de IA no que já existe; nunca tela nova por default |
| **correlation_id / tracing** | espinha única ADR-158 (`ProcessRuntimeService` herda correlation_id; presente em ~30 arquivos) | EXISTE | **REUTILIZAR** — fio do AI Run/skill |
| **Exception types (`ai_*`)** | `RuntimeExceptionsService` (10 categorias, derivado, sem tabela) | EXISTE | **ESTENDER** — novos `ExceptionSource`; evitar tabela |
| **Scheduler / background jobs** | `Scheduler.ts` (~40 passes, best-effort/idempotente/per-org) + `JobQueueService` | EXISTE | **ESTENDER** — hospedar passes de eval/regressão; execução via JobQueue |
| **Dead-letter** | `JobQueueService.deadLetters/retry/health` + `background_jobs` | EXISTE | **REUTILIZAR** |
| **Continuous Evals** | convenção `scripts/test-*.ts` + `ci-shard.mjs` + `contextGolden.goldenStringify` + `SignalCalibrationService` | PARCIAL | **ESTENDER convenção + CRIAR** o scorer de eval |
| **Regression Gate** | — (só golden de ContextPacket; sem baseline-diff de LLM) | NOVO | **CRIAR (simples primeiro)** — não construir plataforma de ML |
| **Canary / % rollout** | flags binárias `*_enabled` (sem percent/cohort) | PARCIAL | **ESTENDER + CRIAR** conceito de cohort/percent |
| **Shadow Mode** | — | NOVO | **CRIAR** — runner que compara candidata×atual sem efeito (host no Scheduler) |
| **Kill Switch (sem deploy)** | `AiGovernanceService.policy` (read-only por billing) + `*_enabled` + `agent_policies` | PARCIAL | **ESTENDER** — kill de provider/modelo/skill/capability/vertical/tenant + audit |
| **Feature flags** | `organization_settings.*_enabled` (convenção, off-by-default) | EXISTE | **ESTENDER** — reusar convenção; accessor fino se precisar rollout faseado |
| **Entitlement (gating de capability/skill)** | `EntitlementService.check` (7 estados, ações `view/use/enable/buy/execute`) + `plansGrade` + 84 flags `*_enabled` | EXISTE | **ESTENDER** — adicionar `resource='capability'|'skill'` (o comentário do enum já cita "futuro registry") |
| **Vertical compatibility** | `VerticalBlueprintService.BlueprintConfig` (já referencia `runtimePlaybooks[]`) + `BlueprintSeeder` | EXISTE | **ESTENDER** — adicionar `capabilities`/`skills` ao lado de `runtimePlaybooks` |
| **Multi-tenancy** | convenção `organization_id` 1º arg em todo service; `test-tenant-isolation` | EXISTE | **REUTILIZAR** |

---

## 3. Duplicidades e riscos detectados

| # | Achado | Impacto | Ação |
| --- | --- | --- | --- |
| DUP-1 | **Dois stacks de RAG/embeddings**: `geminiRAG` (org-wide) e `FalaTuMemoryEmbeddingsService` (per-user), tabelas separadas, ambos `text-embedding-3-small` | risco de 3º stack no SkillOS | Unificados só na matemática (`vectorSimilarity.topKBySimilarity`). SkillOS trata cada um como uma **Capability** distinta; **não** criar 3º índice |
| DUP-2 | **Duas escadas de retry/backoff**: `JobQueueService.computeBackoffSeconds` vs `MessageDeliveryService` | manutenção divergente | Promover a de JobQueue a canônica no Kernel; refatorar MessageDelivery a consumi-la |
| DUP-3 | **Duas "pct de capacidade"**: custo-% (`AiQuotaSignalService`) e ação-% (`ConsumptionService`) | risco de 3ª métrica + vazamento §30 | Tenant vê **ação-%**; custo-% fica admin-only |
| DUP-4 | **Colisão de nome "skill"**: tabela/serviço `skills` = RH (`PeopleDevelopmentService`) | colisão de schema/tipo | **Namespacing** (Decisão D1) |
| DUP-5 | **Colisão `ConsumptionService`/`SubscriptionService`**: já existem para IA (Consumption) e para clientes-do-tenant (Subscription) e estoque (`ConsumptionLedgerService`) | reuso do errado | Reusar os de IA; nunca os de estoque/assinatura-de-cliente |
| DUP-6 | `geminiRAG.generateRagResponse` auto-declarado **legado** (superado pelo orquestrador) e roda em **OpenAI** apesar do nome | confusão de path | DEFERIR/aposentar; SkillOS não assume path Gemini de texto |
| RISK-1 | **§67 — executor paralelo**: ADR-159 colapsou ≥3 paths de efeito num choke-point | reabrir o buraco fechado | Todo efeito de skill = `command_type` atrás de `CommandExecutorService` |
| RISK-2 | **Reliability Kernel virar cadeia de 3 LLMs por chamada** (§52) | latência/custo | Validação **determinística primeiro**, cache depois, probabilística só quando necessário |
| RISK-3 | Pricing sem modelos Claude/Anthropic | custo não contabilizado se rotear p/ Claude | ESTENDER `PRICES` |
| RISK-4 | Evidência de `AiQuotaSignalService` carrega `usedBrl` | vazamento §30 se sinal for a UI de tenant | manter evidência de sinal admin-scoped |

---

## 4. Decisões arquiteturais (Fase 0)

- **D1 — Namespacing do domínio SkillOS.** O termo de produto "Skill" permanece na UX/PRD, mas **tabelas e serviços persistidos usam prefixo `skillos_`** (`skillos_capabilities`, `skillos_skills`, `skillos_runs`…) e tipos TS `Capability`/`SkillManifest`/`SkillOsRun` — para não colidir com a tabela `skills` (RH). Sem isso, colisão de schema garantida.
- **D2 — Kernel dentro do choke-point.** O AI Reliability Kernel é construído **dentro de `llm.ts`** (o choke-point que já existe), não como serviço paralelo. Toda chamada relevante passa a rotear por um único `invoke()`.
- **D3 — Execução sempre via `CommandExecutorService`.** Nenhum Skill Runtime executa efeito externo direto (ADR-159 / §67). Skill emite `command_type`; o executor governado aplica G1/G2/G3.
- **D4 — AI Run estende o ledger existente.** Não criar tabela de tracing paralela: estender `ai_usage_log` (+`run_id`/`skill_id`/status de validação/grounding/confidence) e correlacionar via `correlation_id` (ADR-158).
- **D5 — Privacidade de custo como invariante testável.** §30 já é atendido por construção; formalizar com um teste que prova que nenhum endpoint de tenant expõe R$/US$.
- **D6 — Budget/exception/alerta por query, nunca tabela nova.** Budget per-skill segue `DetectorBudgetService` (marker-row/RN-004); exceptions estendem `RuntimeExceptionsService`; alertas em `business_signals` (convenção #12).
- **D7 — Registry no padrão declarativo existente.** Capability/Skill Registry copiam o *shape* de `AnomalyDetectorRegistry` (registro + defaults por vertical, "ativa a vertical → ganha as capabilities certas").
- **D8 — Confidence reusa fatores existentes.** O Confidence Engine COMPÕE sobre `ImpactPrioritizationService.scoreSignal` + `confidenceBand`; não recalcula fatores.

---

## 5. Migrations necessárias (aditivas — CREATE-then-ALTER estrito)

Tabelas NOVAS (mínimas, prefixadas): `skillos_capabilities`, `skillos_skills` (manifestos), `skillos_runs` *(ou coluna em `ai_usage_log` — decidir em Fase 4)*, `skillos_prompt_versions`, `skillos_eval_cases`, `skillos_evals`, `skillos_provider_health` *(plataforma, sem org_id — ver §49)*, `skillos_model_profiles` *(plataforma)*.
Colunas ADITIVAS: `ai_usage_log`(+`run_id`,`skill_id`,`capability_id`,`prompt_version`,`context_hash`,`validation_status`,`grounding_status`,`confidence`); `organization_settings`(+flags `skill_os_enabled`,`ai_reliability_enabled`,`model_router_enabled`,`grounding_validation_enabled`,`continuous_evals_enabled`); `BlueprintConfig`(+`capabilities`,`skills`).
NENHUMA tabela nova de: alertas (→`business_signals`), aprovação (→`decision_actions`), execução (→`process_*`/`command_*`), budget (→marker pattern), exceptions (→derivado).

---

## 6. Serviços impactados (superfície de mudança)

- **ESTENDIDOS:** `llm.ts` (Kernel/router/provider iface/retry/timeout/breaker), `AIOrchestratorService` (extrair prompt-build/routing por baixo), `CommandExecutorService` (schemas por comando), `EntitlementService` (resource capability/skill), `VerticalBlueprintService`/`BlueprintSeeder` (capabilities/skills), `RuntimeExceptionsService` (fontes `ai_*`), `Scheduler` (passes de eval/shadow), `ai_usage_log`/`recordUsage` (campos de run), `auditLog` (event types), `ProcessRuntimeService`/`PlaybookEngine` (metadata de skill step).
- **REUTILIZADOS sem mudar:** `ContextEngineService`, `ContextGuardService`, `ContextProjectionService`, `BusinessSignalService`, `BusinessConstraintService`, `ApprovalPolicyService`, `PermissionService`, `DecisionActionService`, `ConfirmationEngine`, `OutcomeMeasurementService`, `ProgressiveAutonomyService`, `JobQueueService`, `ConsumptionService`, `AiUsageDashboardService`, `EvidencePackageService`, `geminiRAG`, `FalaTuMemoryEmbeddingsService`, `ReportPdfService`, `XlsxService`.

---

## 7. Compatibilidade / retrocompatibilidade

- **Aditivo puro.** Nenhum fluxo legado muda de comportamento: SkillOS entra por trás dos serviços atuais.
- **Off-by-default** para todos os tenants (`skill_os_enabled=0`); ativação progressiva.
- **Fluxo atual preservado:** `AIOrchestratorService` continua funcionando; a extração de prompt/router é *interna*, sem alterar caller.
- **AI Run como coluna aditiva** não invalida linhas de `ai_usage_log` existentes.

---

## 8. Rollout / rollback

- **Rollout (§68):** `development → tests → shadow → pilot tenant → assisted → approved_execution → broader`. Pilotos recomendados (§61): **Collection Intent Classifier**, **Sales Recovery Message**, **Signal Investigation** — todos já com output estruturado + fallback + evidência.
- **Rollback (§69):** feature flag off · provider fallback · rollback de versão de skill/prompt · disable Capability · disable SkillOS · reverter migration aditiva. Cada fatia entrega o seu.

---

## 9. Fatiamento proposto (pós-Fase 0)

Alinhado ao §60 do PRD, com a decisão de reuso já embutida:

| Fase | Entrega | Predominância |
| --- | --- | --- |
| **F1 — Core Contracts** | Tipos puros: `Capability`, `SkillManifest`, `SkillResult`, `ModelRequirements`, `ReliabilityResult`, failure taxonomy. Testes determinísticos. | CRIAR (tipos) |
| **F2 — Capability + Skill Registry** | `skillos_capabilities`/`skillos_skills` no padrão `AnomalyDetectorRegistry`; enable/disable/lookup; compat vertical+entitlement | CRIAR + ESTENDER |
| **F3 — Capability Resolver** | resolução conservadora (1 skill→direto; depois ranking por regra). Sem IA escolhendo. | CRIAR |
| **F4 — Reliability Core** | AI Run (ESTENDER `ai_usage_log`), schema validation, error taxonomy, retry (promover JobQueue), correlation | ESTENDER + COMPOR |
| **F5 — Model Router + Provider Health** | provider abstraction, model profiles, health, fallback, circuit breaker | CRIAR + COMPOR |
| **F6 — Grounding + Confidence** | gate `UNSUPPORTED_CLAIM` sobre `EvidenceReference`; confidence sobre `scoreSignal`/`confidenceBand` | COMPOR |
| **F7 — Planner** | intent/goal → capabilities → ExecutionPlan (reusa `ProcessRuntimeService`) | ESTENDER + CRIAR |
| **F8 — Policy + Execution Bridge** | Skill Result → `DecisionActionService`/`ApprovalPolicyService` → `CommandExecutorService`, sem bypass | REUTILIZAR |
| **F9 — Observability + Admin Master** | AI Runs/fallback/grounding/provider health na Central de Saúde; custo só admin | ESTENDER |
| **F10 — Tenant Usage Experience** | %-franquia/tokens/tendência/alertas; nunca R$ | REUTILIZAR |
| **F11 — Evals + Shadow** | eval contínuo em 2–3 skills maduras (pilotos §61) | ESTENDER + CRIAR |
| **F12 — Canary + Production Readiness** | rollout progressivo, rollback, kill switch, runbook, SLO, drills | CRIAR + ESTENDER |

---

## 10. Guardrails herdados (não regredir)

ADR-159 (choke-point único de execução) · AC-A01 (fachada única de contexto) · AC-A02 (Context Engine READ+DERIVE) · AC-A05 (`ContextPacket` = contrato versionado) · RN-004 (derivar por query) · convenção #1 (isolamento multi-tenant, `orgId` 1º arg) · convenção #2 (CREATE-then-ALTER estrito) · convenção #12 (alertas em `business_signals`) · RN-014 (IA nunca auto-eleva autonomia) · P6/P7 (IA é proposta sujeita a validação; determinístico antes de probabilístico) · §30 (custo financeiro só Admin Master).

**ADRs de referência:** 095 (RBAC) · 126 (Central de Saúde) · 136 (Decision/Approval) · 152 (Execution Runtime) · 154 (Memory embeddings) · 158 (espinha única/correlation) · 159 (choke-point) · 160 (RAG/similarity + Context Engine Onda A).

---

_Fase 0 concluída. Próximo passo: revisão desta matriz e, aprovada, início da Fase 1 (Core Contracts) — tipos puros, sem alterar comportamento._
