# ADR-189 — Mission Operating Layer & Simplificação Radical (PRD "Mission OS")

**Estado:** **FECHADO — F0–F24 em produção** (#1311–#1335) + tela "Missões" (`MissionsView`).
**F25 (hardening em dia — trava a regressão cross-vertical) EM PR** — o `test:mission-hardening`
afirmava "14 testes mission wired" mas 4 novos (`enablement`/`metrics`/`appointments-plan`/`golden-
path-agenda`) tinham ficado de fora do doc-of-record; agora são 18, e o hardening ganha a REGRESSÃO
cross-vertical (F22): missão de agenda tem cadeia própria (`applicable`, comparecimento derivado). 28
checks. **F24 = premissas do plano na UI (destrava a profundidade) — fecha uma lacuna de usabilidade: o detalhe da missão
chamava plano/prontidão/próximo-passo com corpo vazio, então as premissas de conversão nunca eram
coletadas e a cadeia parava em "premissa faltante" (via UI o próximo passo virava sempre "registre a
premissa"). Agora há uma seção **"Premissas do plano"** (opcional, colapsável) que envia, por métrica:
receita → ticket/oportunidade→venda %/contato→oportunidade %; agenda → comparecimento %/contato→
agendamento %. Vazio = derivado do histórico (honesto). Com as taxas preenchidas, o plano completa e o
próximo passo vira a alavanca de campanha real. UI-only sobre endpoints já testados (tsc+build verdes).
**F23 = golden-path de AGENDA (paridade cross-vertical) — `test:mission-golden-path-agenda`
roda o MESMO ciclo do golden-path de varejo (receita) ponta a ponta pra uma CLÍNICA (métrica
`appointments`): intenção "encher a agenda com 200 atendimentos" → missão → plano reverso de agenda
(comparecimento derivado → agendamentos → contatos → gap) → prontidão → execução governada (correlation
`mission:<id>`, impacto em atendimentos) → trajetória `at_risk` → superfícies "Hoje"/nav → resultado
assegurado → aprendizado no motor único → debrief → isolamento. Crava a paridade receita×agenda como
regressão permanente (17 checks). **F22 = plano reverso de AGENDA (cross-vertical) — o Mission OS é HORIZONTAL (zero gate de
vertical; a flag/toggle é universal e o detector de intenção já cobre encher-agenda/cobrar/reduzir-
estoque/etc.), mas o plano reverso (F3) só montava a cadeia completa pra `revenue`. A F22 estende à
métrica `appointments` (encher a agenda): alvo de atendimentos → agendamentos (via COMPARECIMENTO
DERIVADO do histórico de `appointments`, RN-004; sem histórico → unknown, nunca inventa taxa) →
contatos (via conversão contato→agendamento) → gap vs base — tornando clínica/petshop/beleza/serviços
primeira-classe (prontidão + próximo passo passam a funcionar pra elas). Determinístico; receita 0-
regressão. Rotas encaminham `showRate`/`bookingConversionRate`; `test:mission-appointments-plan` 13.
**F21 = faixa de KPIs na tela de Missões — a `MissionsView` consome `GET /api/missions/metrics`
(F20) e mostra uma faixa de 6 KPIs (missões · em andamento · concluídas · em risco · taxa de conclusão ·
% que virou ação), honesta (`—` quando a taxa é null; só aparece com ≥1 missão). Completa o loop de
medição do piloto (backend F20 → visível). UI-only sobre endpoint testado (tsc+build verdes).
**F20 = `MissionMetricsService` — todo PRD grande fecha com métricas
(DecisionMetrics/OutcomeAssuranceMetrics/LearningMetrics); o Mission OS ganha o seu. KPIs DERIVADOS por
query (RN-004): total · byStatus · inFlight · achieved/failed/cancelled/atRisk · `achievedRatePct`
(concluídas ÷ terminais, cancelada FORA do denominador; null sem desfecho) · bySource · byAutonomy ·
`withGovernedAction`/`governedActionRatePct` (missões que viraram ação pelo fio `mission:<id>`) ·
`avgConfidence` (só as que declararam; null ≠ 0). Honesto: percentual sem denominador é null, nunca 0.
Rota `GET /api/missions/metrics`; `test:mission-metrics` 11. **F19 = seção "Missões (piloto)" na aba
Módulos (liga/desliga a flag; nav reage na hora); UI-only sobre endpoints testados.** **F18 = `MissionService.setEnabled/settings` + rotas `GET/PUT
/api/missions/enablement` (antes do gate `requireMissionLayer` — bootstrapping); reversível, desligar
NUNCA apaga missões (convenção nº 9); runbook `docs/runbook/mission-piloto.md`; `test:mission-enablement` 10.** **F17 = `test:mission-hardening` (27 checks) codificando
F15/F16 como REGRESSÃO dos RN-MOL: shadow (suggest não escreve `decision_action`) · grounding (alavanca
só se o comando EXISTE de fato, `canHandle`) · determinístico · premissa faltante → tarefa (nunca
campanha no escuro / dinheiro inventado) · qualitativa → honesto · propose recusa `off` e delega ao
caminho governado (correlation `mission:<id>`, nunca `done`) + fiação (rotas `/next-step[/propose]`,
14 testes wired). **F15 (`MissionNextStepService`, a ponte gargalo→ação governada) + F16 (UI "O que eu
faço agora?") em produção.** Fecha o elo que
faltava entre o plano reverso (F3, que acha o gargalo) e o runtime (F5, que propõe ação DADO um efeito):
`suggest()` deriva do caminho crítico um PRÓXIMO PASSO governado, aterrado só em command handlers que
**realmente existem** (`CommandExecutorService.canHandle` — grounding); premissa faltante → tarefa
governada (`create_task`), gap quantitativo real → campanha (`prepare_campaign`) com impacto = alvo
restante (`BusinessGoalService.currentValue`, nunca inventa dinheiro); shadow (read-only, não escreve).
`propose()` encaminha pelo caminho GOVERNADO existente (`MissionRuntimeService.proposeAction` — recusa
`off`, nunca executa direto). Composição pura (§184 — sem planner/executor novo). É o norte do PRD
(CA-01: "identifica gap e caminho crítico, executa pelo Runtime existente"). `test:mission-next-step` 14.
F14 = `test:mission-golden-path` (17) — compõe F1–F11 num único fluxo (intenção → plano reverso →
prontidão → execução governada → trajetória `at_risk` → superfícies "Hoje"/nav → resultado assegurado →
aprendizado no motor único → debrief → isolamento), provando o fio ponta a ponta sem motor novo (CA-18).
Mission Layer completo, atrás da flag `mission_layer_enabled` (default OFF, 0-regressão).
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
