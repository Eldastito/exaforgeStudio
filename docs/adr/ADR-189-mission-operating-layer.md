# ADR-189 — Mission Operating Layer & Simplificação Radical (PRD "Mission OS")

**Estado:** **F0–F8 MERGEADAS (#1311–#1319)** · **F9 EM PR** — Legacy Reduction (par Executando→Missões). Plano F0–F12.
**Data:** 2026-08-24.
**Natureza:** camada HORIZONTAL de orquestração de objetivos + simplificação de UX. **Não é expansão**
do ZapFlow — é composição do que já existe. Convenções herdadas: isolamento multi-tenant, RN-004
(derivado por query), `business_signals` (nunca tabela de alerta paralela), determinístico antes de
LLM, nunca inventa dinheiro/dado, aditivo/reversível, opt-in por flag.

---

## 1. Contexto (o que a auditoria da `main` PROVOU)

O PRD parte de uma premissa correta — "não faltam funcionalidades, falta o software produzir
resultado sem depender da iniciativa humana" — mas subestima **quanto do Mission Layer JÁ EXISTE**.
A auditoria da branch `main` (Fase 0) encontrou:

1. **`BusinessGoal` ≈ 80% do "Mission Contract".** `business_goals` já carrega `title · baseline ·
   deadline · priority · owner · status · target` + registro de métricas (`METRICS`) + `progress()`.
   O que uma Missão acrescenta é `desiredState/baselineState` estruturados, `autonomyLevel`, `source`
   (humano/proposto/gerado), `confidence` e — o essencial — um **plano + cadeia de eventos** pendurados.
2. **A espinha "Capability Registry → Resolver → Planner → Runtime governado" JÁ EXISTE como SkillOS
   (PRD 4)** — 15 serviços: `SkillOsRegistryService` (registro de Capabilities+Skills, gate por
   vertical/entitlement/lifecycle), `SkillOsResolverService` (Capability→Skill **determinístico, sem
   LLM**, nunca silencioso), `SkillOsPlannerService` (objetivo+capabilities → `ExecutionPlan` com
   passos/risco/dependências/topo-sort — planejamento FORWARD), `SkillOsExecutionBridge` (Plan →
   `DecisionAction.propose` → `CommandExecutor` — **sem executor paralelo**, a garantia da ADR-159),
   `AiReliabilityKernel`+`ModelRouter`+`Grounding`+`Confidence` (escada de custo/governança de IA).
3. **Toda a lista "REGRA ZERO — não duplicar" do PRD está presente por nome** — `RadarService`,
   `BusinessSignalService`, `DecisionEngine`, `DecisionActionService`, `ApprovalPolicyService`,
   `CommandExecutorService`, `ConfirmationEngine`, `ProcessRuntimeService`, `OutcomeAssuranceService`,
   `PatternMemoryService`, `EvidencePackageService`, `NavigationManifestService`, `FalaTuHomeService`
   (="Hoje"), `ExecutionResultsService` (="Executando"), `ContextProjectionService`,
   `LegacyReductionService`+`UxTelemetry` (ADR-163).
4. **Ausentes de fato** (grep zero): `mission`, `reverse.?plan`, `critical.?path`, `last.?safe`,
   `caminho crit`. → é AQUI que mora o código genuinamente novo.

**Conclusão:** o Mission Layer é ~90% composição. A `AIOrchestratorService` tem **1370 linhas / ~143
ramos** — exatamente o anti-padrão que o PRD §31 combate, e o substituto (registry) já existe (SkillOS).

## 2. Decisões arquiteturais

### D1 — Missão é uma ENTIDADE FINA PRÓPRIA que COMPÕE `BusinessGoal` (PRD §7, RN-004)
**CORRIGIDO na F1** (o schema real forçou a revisão, e é honesto documentar): a F0 propôs "Missão =
linha estendida de `business_goals`", mas `business_goals` tem **`UNIQUE(organization_id, metric)`** —
é SINGLETON por métrica, e não comporta várias missões concorrentes (ex.: duas iniciativas tocando
`revenue`). Estender ali exigiria dropar o UNIQUE, alto risco de regressão (o `BusinessGoalService.set`
faz upsert por (org,metric) e `.progress` itera um-por-métrica).
Decisão final: a Missão é uma **tabela fina nova `missions`** (id próprio, N por org) que **COMPÕE** o
registro de métricas do `BusinessGoal` (`isKnownMetric` + `progress`) pra medir — NÃO é uma linha de
goal e NÃO duplica o Goal: **Goal = alvo permanente por métrica; Missão = iniciativa bounded** (§6).
Isso É fiel ao §7 ("não duplicar entidades já representadas em Goal/DecisionAction/ProcessInstance") —
a Missão é uma entidade genuinamente distinta das três, que compõe as outras (mede via Goal, executa
via DecisionAction/Runtime, planeja via SkillOS). Colunas: `desired_state`, `baseline_state`,
`target_metric` (opcional, conhecida), `target_value`/`target_unit` (alvo inline), `deadline`, `owner`,
`autonomy_level`, `source`, `mission_status`, `confidence`. Aditivo, opt-in (`mission_layer_enabled`).

### D2 — A orquestração COMPÕE SkillOS; nenhum motor novo (PRD §5/§31/§32/§71)
- Capability Registry = `SkillOsRegistryService` (existe).
- Intent→Capability = `SkillOsResolverService` (existe, determinístico).
- Plano de execução = `SkillOsPlannerService` (existe — FORWARD).
- Execução governada = `SkillOsExecutionBridge` → `DecisionAction`→`ApprovalPolicy`→`CommandExecutor`
  →`ConfirmationEngine` (existe — choke-point único da ADR-159).
- Custo/governança de IA = `AiReliabilityKernel`/`ModelRouter` (existe).
O Mission Layer é uma **fina camada de amarração** que liga um Goal a um plano SkillOS e à cadeia
decisão→execução→confirmação→outcome→aprendizado. **Proibido** 2º Runtime/Scheduler/Decision/Learning.

### D3 — Código genuinamente NOVO (superfície mínima)
1. **`MissionReversePlanner`** — planejamento REVERSO (estado final → eventos necessários → gap vs
   base). Determinístico primeiro (aritmética: alvo ÷ ticket → vendas ÷ conversão → oportunidades ÷
   taxa → contatos → gap), depois regras, depois histórico (`PatternMemory`), LLM só no fim (§12).
   Complementa (não duplica) o `SkillOsPlanner` que é forward.
2. **`MissionEventChain` + caminho crítico + Último Momento Seguro** — read-models derivados que
   compõem `goal.progress` + `OutcomeAssurance` + o `ExecutionPlan`.
3. **`MissionCheckpointService`** — planned × actual × tempo × capacidade → `on_track/at_risk/off_track`
   (compõe `OutcomeAssuranceService` + `BusinessGoalService.progress`; sinal via `business_signals`).
4. **Intent→Mission no Fala Tu** — ESTENDE o Fala Tu, roteando intents de missão pelo **registry
   SkillOS** (não engrossando a `AIOrchestratorService`).

### D4 — Readiness/Risk/Pre-Mortem COMPÕEM o que existe (PRD §16/§18)
Readiness = composição de `RadarService` + `OperationalHealthService`/`CapacityHeadroomService`
(ADR-164) + estoque/agenda/financeiro/entitlements + `ApprovalPolicy`. Pre-Mortem = `DecisionEngine`
modo pre_mortem (DI-2, já existe). **Nenhum motor de readiness/risco novo** — só um agregador read-only.

### D5 — UX é EXPERIMENTO com flag + telemetria; nunca deleção (PRD §52/§74)
"Hoje" ESTENDE `FalaTuHomeService`; "Executando→Missões" é uma FUSÃO candidata guiada por
`LegacyReductionService` + `UxTelemetry`; a redução da Sidebar é A/B com flag
(`mission_simplified_nav_enabled`). Retirar do 1º nível ≠ apagar backend. Toda tela legada continua
acessível (via "Explorar"/Fala Tu) até a telemetria provar substituição (§50/§51/§80).

### D6 — Autonomia SHADOW-first (PRD §35)
Todo comportamento autônomo novo nasce `off` → `shadow` (calcula o que faria, não executa) →
`suggest` → `approval` → `autopilot`. Autonomia sobe só com evidência (compara recomendação × ação
humana × resultado). Reusa `ApprovalPolicyService`/Autonomy Contract — sem escada de autonomia paralela.

### D7 — Resultado ≠ Execução (PRD §40) — preserva Outcome Assurance
Missão só é `ACHIEVED` quando o critério de negócio do contrato foi atingido (via
`OutcomeAssuranceService`), nunca porque "a campanha foi enviada". Herda `DONE ≠ RESULTADO`.

## 3. Guardrails RN-MOL (duros — no header dos serviços novos + testados)
1. **Composição > extensão > criação** — nenhum motor crítico duplicado (CA-18).
2. **Missão = Goal estendido** — sem 2ª entidade; RN-004.
3. **Determinístico antes de LLM** — reverse-plan/readiness/critical-path são aritmética/regra/SQL primeiro.
4. **Shadow-first** — autonomia nova nunca vai direto pra execução.
5. **Resultado ≠ execução** — outcome de negócio via Outcome Assurance.
6. **Governança intacta** — todo efeito atravessa DecisionAction→ApprovalPolicy→CommandExecutor→Confirmation.
7. **UX reversível** — flag + telemetria; retirar do 1º nível ≠ apagar (§80 sem big-bang).
8. **Isolamento/RBAC/Entitlements/Idempotência/Fail-closed/Provenance** (PRD §54–61).
9. **Complexity Budget** — todo PR declara telas/cliques adicionados × removidos (§82); UARR por jornada.

## 4. Risco & escopo honesto (o que a F0 quer deixar explícito)
- **SkillOS está construído mas em grande parte INERTE** ("nenhuma skill real ligada ainda",
  `PilotSeeder`/`Rollout`). O braço de execução da Missão só faz o que já está ligado → as primeiras
  missões executam pelos **command handlers governados que JÁ existem** (cobrança, `social_publish`,
  `auto_booking`, `growth_optimization`…), não por skills novas. Isso limita o escopo honesto de F1–F5.
- **Migrar a `AIOrchestratorService` (1370 linhas) é alto risco** → roteamento por registry só pros
  intents NOVOS de missão; caminho legado intacto (§80).
- **Baseline de UARR/Complexity depende de telemetria** (`UxTelemetryService` é opt-in) → o baseline
  das 10 jornadas pode ser parcialmente sintético; a F0 declara isso, não finge número.

## 5. Plano de fatias (resumo — detalhe em `IMPLEMENTATION-PLAN.md`)
F0 (esta, doc-only) → F1 Mission Contract (estende Goal) → F2 Intent→Mission (shadow) → F3 Reverse
Planner (determinístico) → F4 Readiness+Risk (compõe) → F5 Mission Runtime (liga SkillOS/Runtime) →
F6 Checkpoint+Replan → F7 UX "Hoje" → F8 Sidebar A/B → F9 Legacy Reduction → F10 Learning+Debrief →
F11 Proactive Missions (shadow) → F12 Simplificação GA. Cada fatia = 1 PR, flag, teste, rollback,
**Complexity Budget declarado**.

## 6. Critério de sucesso (mapeado aos CA-01..CA-20 do PRD)
O operador expressa um OBJETIVO; o ZapFlow entende o estado final, planeja de trás pra frente,
identifica gap e caminho crítico, verifica prontidão e risco, executa **pelo Runtime existente** dentro
da política, acompanha planned×actual, replaneja, confirma o resultado de NEGÓCIO e aprende — pedindo o
humano só na exceção. E o usuário comum passa a fazer **menos** interações (UARR>0), sem perder controle,
segurança ou resultado, e **sem** nenhum motor crítico duplicado (CA-18) nem tela antiga quebrada (CA-19).
