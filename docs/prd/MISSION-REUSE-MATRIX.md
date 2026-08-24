# MISSION-REUSE-MATRIX — PRD "Mission OS" vs `main` (Fase 0)

Cada requisito do PRD classificado em **EXISTE / PARCIAL / NOVO / NÃO FAZER** + a ação
**REUTILIZAR / ESTENDER / COMPOR / CRIAR / DEPRECAR / NÃO FAZER**. Fonte da verdade = código da `main`
em 2026-08-24. Regra: composição > extensão > criação (PRD §0).

---

## A. Núcleo Mission

| # | Requisito (PRD) | Estado | Ação | Onde no código |
| --- | --- | --- | --- | --- |
| §6/§7 | Mission Contract (estado final + prazo + restrições + critério) | **PARCIAL** | **ESTENDER** `BusinessGoal` | `BusinessGoalService` + `business_goals` (title/baseline/deadline/priority/owner/status/target já existem) |
| §8 | Status da missão (DRAFT…ACHIEVED) | **PARCIAL** | **ESTENDER** | `business_goals.status` existe; falta o enum de missão (`mission_status` aditivo) |
| §9/§30 | Intent→Mission via linguagem natural | **PARCIAL** | **ESTENDER** Fala Tu | `FalaTuService`/`AIOrchestratorService` (1370 ln — rotear intents NOVOS por registry, não engrossar) |
| §10 | Fontes: user/system-proposed/system-generated | **PARCIAL** | **COMPOR** | `RadarService`+`BusinessSignalService`+`DecisionEngine` já geram sinais/oportunidades; falta o campo `source` |
| §11 | Reverse Planning Engine | **NOVO** | **CRIAR** `MissionReversePlanner` | grep zero — genuinamente novo (o PRD §11 admite) |
| §12 | Determinístico antes de LLM no planejamento | **EXISTE (padrão)** | **REUTILIZAR** | padrão da casa (SkillOsResolver/Planner são determinísticos) |
| §13 | Mission Event Chain | **PARCIAL** | **COMPOR** sobre `ExecutionPlan` | `SkillOsPlannerService` (steps+deps+topo-sort) é o substrato; falta o read-model de eventos-de-negócio |
| §14 | Caminho crítico | **NOVO** | **CRIAR** (read-model) | deriva do event chain + gargalo; grep zero |
| §15 | Last Safe Moment | **NOVO** | **CRIAR** (read-model) | deriva de prazo × dependências; grep zero |
| §16/§17 | Mission Readiness + score | **PARCIAL** | **COMPOR** | `RadarService`+`OperationalHealthService`/`CapacityHeadroomService` (ADR-164)+estoque/agenda/financeiro/entitlements |
| §18 | Pre-Mortem automático | **EXISTE** | **REUTILIZAR** | `DecisionEngine.analyze({mode:'pre_mortem'})` (DI-2) + `DecisionRiskService` |
| §19 | Autonomy Ladder (verde/amarelo/vermelho) | **EXISTE** | **REUTILIZAR** | `ApprovalPolicyService` + Autonomy Contract (ADR-159) |

## B. Runtime & governança (tudo REUTILIZAR — §71)

| # | Requisito | Estado | Ação | Onde |
| --- | --- | --- | --- | --- |
| §31 | Intent→Capability→Policy→Runtime | **EXISTE** | **REUTILIZAR** | `SkillOsResolverService`→`SkillOsExecutionBridge` |
| §32 | Capability Registry | **EXISTE** | **REUTILIZAR/ESTENDER** | `SkillOsRegistryService` (registerCapability/registerSkill/skillsForCapability) |
| §71 | Mission Runtime (Mission→…→Outcome) | **EXISTE** | **COMPOR** | `SkillOsExecutionBridge`→`DecisionAction`→`ApprovalPolicy`→`CommandExecutor`→`ConfirmationEngine` |
| §35 | Shadow-first | **EXISTE (padrão)** | **REUTILIZAR** | `GrowthAutopilotService` (ADR-168 F15) já provou o padrão off/shadow |
| §36 | Mission Checkpoint (planned×actual) | **PARCIAL** | **COMPOR** | `OutcomeAssuranceService`(escada) + `BusinessGoalService.progress` |
| §37 | Probabilidade de sucesso | **PARCIAL** | **COMPOR** | `statsWilson`/`DecisionSimulatorService.scenarios` (bandas calibradas, ADR-166 F6/DI-2) |
| §38/§39 | Replanejamento (auto seguro) | **NOVO (fino)** | **CRIAR** sobre política | decide alternativa + `ApprovalPolicy`; auto só se verde/reversível |
| §40 | Resultado ≠ execução | **EXISTE** | **REUTILIZAR** | `OutcomeAssuranceService` (ADR-165, DONE≠RESULTADO) |
| §41/§42 | Debrief + Mission Memory | **EXISTE** | **REUTILIZAR** | `PatternMemoryService` (motor único ADR-166) — não criar 2º banco de memória |
| §61 | Custo de IA (escada event→…→LLM) | **EXISTE** | **REUTILIZAR** | `AiReliabilityKernel`+`ModelRouter`+`ai_usage_log` |
| §79 | AI Governance (injection/inventar/confidence) | **EXISTE** | **REUTILIZAR** | `AiReliabilityKernel`+`SkillOsGroundingService`+provenance |

## C. UX & simplificação

| # | Requisito | Estado | Ação | Onde |
| --- | --- | --- | --- | --- |
| §20 | Exception-driven UX | **PARCIAL** | **ESTENDER** | `FalaTuHomeService` (Hoje por exceção, ADR-163 F3) já é por-exceção |
| §21/§22 | Home "Hoje" | **EXISTE** | **ESTENDER** | `FalaTuHomeService` — acrescentar bloco Missões/Decisões/Resultados |
| §23/§24 | Sidebar sem expansão / hipótese | **EXISTE (base)** | **COMPOR** | `NavigationManifestService` (nav por necessidade) + `Sidebar.tsx` (~38 itens) |
| §25 | "Executando" → Missões | **EXISTE** | **FUNDIR (candidato)** | `ExecutionResultsService` — fusão guiada por telemetria (§74), não deleção |
| §26/§27 | Radar/Decision fora do 1º nível | **EXISTE** | **ESCONDER (candidato)** | telemetria-gated; capacidade continua, muda exposição |
| §28 | Relatórios por Fala Tu | **PARCIAL** | **COMPOR** | `ComigoMonthlyReportService`/`ReportsPanel` já existem; falta o resumo conversacional |
| §29 | Config por observar→inferir→sugerir | **EXISTE** | **REUTILIZAR** | `InferredSettingsService` (ADR-163 F6, RN-UX-3 nunca auto-aplica) |
| §43/§55 | Simplificação por perfil / RBAC | **EXISTE** | **REUTILIZAR** | `ContextProjectionService` + RBAC |
| §44 | Progressive disclosure | **EXISTE (padrão)** | **REUTILIZAR** | `UxPresentationService` (Decision Card, ADR-163 F4) |
| §45 | "Precisa de você" | **PARCIAL** | **COMPOR** | `attention()` + aprovações pendentes → 1 estado transversal |
| §50/§51/§52 | Legacy Reduction | **EXISTE** | **REUTILIZAR** | `LegacyReductionService` (ADR-163 F12/F16, gate advisório por telemetria) |
| §46/§48 | UARR / Zero-Training Rate | **PARCIAL** | **COMPOR** | `UxTelemetryService` (ADR-163 F10, opt-in) — instrumentar as 10 jornadas |

## D. Anti-duplicação (o que NÃO fazer)

| Tentação | Ação | Porquê |
| --- | --- | --- |
| Criar `missions` table | **NÃO FAZER** | Estende `business_goals` (§7/D1) |
| Criar 2º Runtime/executor | **NÃO FAZER** | `SkillOsExecutionBridge`+`CommandExecutor` (§71/ADR-159) |
| Criar 2º Scheduler/JobQueue | **NÃO FAZER** | `Scheduler`+`JobQueueService` existentes |
| Criar 2º Decision/Learning/Approval Engine | **NÃO FAZER** | DecisionEngine/PatternMemory/ApprovalPolicy |
| Criar 2ª tabela de alerta | **NÃO FAZER** | `business_signals` (convenção nº 12) |
| Criar 2º banco de memória de missão | **NÃO FAZER** | `PatternMemoryService` (§42) |
| Engrossar `AIOrchestratorService` com if/else | **NÃO FAZER** | Roteia por registry SkillOS (§31) |
| Adicionar "Missões" à Sidebar sem prova | **NÃO FAZER** | Gate §83 (7 condições) + A/B §74 |
| Apagar tela legada | **NÃO FAZER** | Retira do 1º nível; deprecação só com telemetria (§52/§80) |

## E. Resumo quantitativo

- **REUTILIZAR (existe, usar como está):** ~18 requisitos (todo o Runtime/governança/Pre-Mortem/
  Autonomy/Outcome/Learning/config-inferida/legacy-reduction).
- **ESTENDER (existe, somar pouco):** ~7 (Mission Contract sobre Goal, status, Fala Tu intent, Home).
- **COMPOR (agregar existentes):** ~9 (readiness, event chain, checkpoint, probabilidade, "precisa de
  você", relatório conversacional, UARR).
- **CRIAR (genuinamente novo):** **~4** — `MissionReversePlanner`, caminho-crítico, Last-Safe-Moment,
  replanejamento fino. Tudo determinístico-primeiro, read-model sobre o que já existe.
- **NÃO FAZER:** 9 duplicações explicitamente proibidas.

**Veredito:** o Mission Layer é ~90% composição/extensão. O código novo cabe em ~4 primitivas pequenas.
