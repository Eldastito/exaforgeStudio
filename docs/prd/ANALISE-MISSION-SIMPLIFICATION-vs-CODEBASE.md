# ANÁLISE — Mission OS & Simplificação Radical vs `main` (Fase 0)

Mapeamento do PRD "Mission Operating Layer & Radical Simplification" contra a branch `main`
(2026-08-24). Doc de auditoria da Fase 0 (sem código de produção).

---

## 1. Tese do PRD (e onde ela acerta)

O PRD acerta no diagnóstico: **o problema não é falta de funcionalidade, é excesso de funcionalidade
dependente da iniciativa humana**. A Sidebar tem ~38 itens tenant-facing (ver `SIDEBAR-UX-AUDIT.md`),
e a `AIOrchestratorService` cresceu pra **1370 linhas / ~143 ramos** de intent — a curva cognitiva é a
barreira, não a capacidade. A visão "usuário escolhe o resultado, ZapFlow escolhe a ferramenta" (§4) é
a direção certa.

## 2. A descoberta central: o Mission Layer já é ~90% composição

O PRD assume que precisa construir a orquestração. A `main` mostra que os dois substratos já existem:

### 2.1. Mission Contract ≈ `BusinessGoal`
`business_goals` já tem `title · baseline · deadline · priority · owner · status · target` + registro
de métricas (`METRICS` com `content_revenue`, `content_leads`, `revenue`, `appointments`…) + `progress()`
derivado. **Decisão D1 (ADR-189):** Missão ESTENDE Goal (colunas aditivas: `desired_state`,
`baseline_state`, `autonomy_level`, `source`, `confidence`, `mission_status`), nunca uma tabela nova.

### 2.2. Capability Registry / Resolver / Planner / Runtime ≈ SkillOS (PRD 4)
15 serviços `SkillOs*` + `skillosModel.ts` + rotas `skillos.ts`/`plans.ts`:
- **Registry** (`SkillOsRegistryService`): registra Capabilities e Skills, gate por vertical/entitlement/
  lifecycle. É o "Capability Registry" do §32, literal.
- **Resolver** (`SkillOsResolverService`): Capability→Skill **determinístico, sem LLM, nunca silencioso**
  (§65). É o "Capability Resolver" do §31.
- **Planner** (`SkillOsPlannerService`): objetivo+capabilities → `ExecutionPlan` (passos, risco,
  dependências, topo-sort). Planejamento **forward**.
- **Bridge** (`SkillOsExecutionBridge`): Plan → `DecisionAction.propose` → `CommandExecutor` — **sem
  executor paralelo** (garantia ADR-159). É o "Mission Runtime" do §71.
- **Kernel** (`AiReliabilityKernel`+`ModelRouter`+`Grounding`+`Confidence`): escada de custo/governança
  de IA (§61/§79).

**A lista "REGRA ZERO" do PRD sequer menciona SkillOS** — o que confirma o próprio aviso do PRD (§0): o
codebase evoluiu além da análise. Qualquer "Mission OS" que ignore o SkillOS reconstruiria o que já existe.

### 2.3. A espinha de percepção→decisão→execução→outcome→aprendizado está completa
`RadarService`, `BusinessSignalService`, `DecisionEngine` (+ modos pre_mortem/red_team/advocate DI-2),
`EvidencePackageService`, `DecisionActionService`, `ApprovalPolicyService` (Autonomy Contract),
`CommandExecutorService`, `ConfirmationEngine`, `OutcomeAssuranceService` (DONE≠RESULTADO),
`PatternMemoryService` (motor único de aprendizado). E a camada Invisible-UX: `NavigationManifestService`,
`FalaTuHomeService` (="Hoje"), `ExecutionResultsService` (="Executando"), `ContextProjectionService`,
`InferredSettingsService`, `LegacyReductionService`, `UxTelemetryService`.

## 3. O que é genuinamente novo (superfície pequena)

Grep por `mission`/`reverse.?plan`/`critical.?path`/`last.?safe` = **zero**. As primitivas novas:
1. **`MissionReversePlanner`** — planejamento de trás pra frente (§11): alvo ÷ ticket → vendas ÷
   conversão → oportunidades ÷ taxa → contatos → **gap vs base**. Determinístico primeiro (§12).
2. **Caminho crítico** (§14) e **Último Momento Seguro** (§15) — read-models derivados.
3. **`MissionCheckpointService`** (§36) — planned×actual×tempo×capacidade (compõe OutcomeAssurance+progress).
4. **Replanejamento fino** (§38/§39) — escolhe alternativa + `ApprovalPolicy`; auto só se verde/reversível.

## 4. Tensões e riscos (declarados honestamente)

- **SkillOS está construído mas em grande parte INERTE** (headers: "nenhuma skill real ligada ainda",
  `PilotSeeder`+`RolloutService`). O braço de execução da Missão só faz o que estiver ligado. → **As
  primeiras missões executam pelos command handlers governados que JÁ existem** (cobrança, `social_publish`,
  `auto_booking`, `growth_optimization`), não por skills novas. Escopo honesto de F1–F5 limitado por isso.
- **`AIOrchestratorService` (1370 ln) é dívida** — migração completa é alto risco de regressão. → intents
  de missão NOVOS pelo registry; caminho legado intacto (§80, sem big-bang).
- **Baseline UARR/Complexity depende de telemetria opt-in** (`UxTelemetryService`). O baseline das 10
  jornadas pode ser parcialmente sintético — a F0 declara isso em vez de fabricar número.
- **Risco de "Mission OS paralelo"** (§5) — mitigado pela D2/D1: Mission Layer é amarração fina, não motor.

## 5. Impacto sobre a Sidebar (detalhe em `SIDEBAR-UX-AUDIT.md`)
Nenhum item novo entra sem passar o gate de 7 condições (§83) + A/B (§74). "Executando" é o candidato
principal a sair do 1º nível (absorvido por Missões, §25). Radar e Decision Intelligence viram
capacidades invisíveis pro usuário comum (§26/§27), sem perder função.

## 6. Recomendação
Seguir o gate do PRD: **Fase 0 doc-only, nada de produção antes do merge/aprovação**. As 4 primitivas
novas são pequenas e determinísticas; o resto é composição. O maior valor não é técnico — é
comportamental (§88): o usuário deixa de perguntar "como faço isso no ZapFlow?" e passa a dizer "o que
eu quero que aconteça?". A viabilidade disso já está 90% no código; falta a camada de amarração e a
disciplina de simplificação (Complexity Budget §82, UARR §46).
