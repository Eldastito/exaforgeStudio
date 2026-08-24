# IMPLEMENTATION-PLAN — Mission OS (fatias, flags, gates, testes, rollback)

Plano de implementação pós-Fase 0. Cada fatia = 1 PR draft, com flag opt-in, teste, rollback e
**Complexity Budget declarado** (§82). Nada de produção antes do merge/aprovação da F0 (gate §66).
Regra: composição > extensão > criação; shadow-first; sem big-bang (§80).

Convenção de flags (nomes finais seguem o padrão da casa em `organization_settings`/`platform_settings`):
`mission_layer_enabled` · `mission_reverse_planning_enabled` · `mission_proactive_enabled` ·
`mission_auto_replan_enabled` · `mission_simplified_nav_enabled` · `mission_capability_router_enabled`.

---

## Fase 0 — Auditoria (ESTA, doc-only, GATE)
Entregáveis: `ANALISE-MISSION-SIMPLIFICATION-vs-CODEBASE.md` · `SIDEBAR-UX-AUDIT.md` ·
`MISSION-REUSE-MATRIX.md` · `ADR-189-mission-operating-layer.md` · `LEGACY-REDUCTION-PLAN.md` ·
este arquivo. **Gate:** nenhuma fatia F1+ antes do merge/aprovação da F0.

## F1 — Mission Contract (estende Goal)
- ESTENDE `business_goals`: colunas aditivas `desired_state`, `baseline_state`, `autonomy_level`,
  `source`, `confidence`, `mission_status` (CREATE-then-ALTER). `MissionService` (read/write finos sobre
  `BusinessGoalService`). Status enum + tradução pra linguagem simples (§8). Audit/RBAC/tenant.
- **Flag:** `mission_layer_enabled` (default 0). **Sem UX ainda.**
- **Teste:** `test:mission-contract` (estado, isolamento, RBAC, 0-regressão de goal).
- **Complexity Budget:** telas 0 · menus 0 · campos 0 (usuário) · cliques 0.

## F2 — Intent → Mission (Fala Tu, shadow)
- ESTENDE Fala Tu: detecta intenção empresarial, propõe missão, confirma estado final, resolve
  capabilities pelo **registry SkillOS** (`SkillOsResolverService`), explica o plano. **Shadow-first**
  (calcula, não executa). Intents NOVOS pelo registry (`mission_capability_router_enabled`), legado intacto.
- **Teste:** `test:mission-intent` (intent→mission, sem execução, AI governance).

## F3 — Reverse Planning (determinístico)
- CRIA `MissionReversePlanner`: alvo → eventos necessários → gap vs base; caminho crítico (§14);
  Último Momento Seguro (§15). Determinístico → regra → histórico (`PatternMemory`) → LLM (§12).
- **Flag:** `mission_reverse_planning_enabled`. **Teste:** `test:mission-reverse-plan` (determinístico,
  gaps, caminho crítico, sem inventar dado).

## F4 — Readiness + Risk (compõe)
- COMPÕE `RadarService` + `OperationalHealthService`/`CapacityHeadroomService` + estoque/agenda/
  financeiro/entitlements → readiness score (§16/§17). Pre-Mortem = `DecisionEngine` modo pre_mortem (reuso).
- **Teste:** `test:mission-readiness` (composição, honesto-null, sem motor novo).

## F5 — Mission Runtime (liga SkillOS/Runtime)
- COMPÕE `SkillOsExecutionBridge` → `DecisionAction`→`ApprovalPolicy`→`CommandExecutor`→`Confirmation`.
  **Primeiras missões executam pelos command handlers JÁ existentes** (cobrança, `social_publish`,
  `auto_booking`, `growth_optimization`) — SkillOS inerte não bloqueia. Autonomy Ladder = ApprovalPolicy.
- **Teste:** `test:mission-runtime` (efeito só via choke-point, idempotência, fail-closed, resultado≠execução).

## F6 — Checkpoint + Replan
- CRIA `MissionCheckpointService` (planned×actual×tempo×capacidade → on_track/at_risk/off_track, §36);
  sinal `mission/at_risk` em `business_signals`. Replan fino (§38): auto só se verde/reversível
  (`mission_auto_replan_enabled`), senão propõe via ApprovalPolicy.
- **Teste:** `test:mission-checkpoint` + `test:mission-replan`.

## F7 — UX "Hoje"
- ESTENDE `FalaTuHomeService`: bloco Decisões (humanas) + Exceções + Resultados + "Precisa de você"
  (§21/§45). Por exceção (§20/§22), nunca dashboard.
- **Complexity Budget:** cliques REMOVIDOS > 0; telas 0.

## F8 — Sidebar simplification (A/B)
- **Flag** `mission_simplified_nav_enabled`; experimento A (atual) × B (simplificada, hipótese §24).
  Compõe `NavigationManifestService`. Mede tempo/cliques/erro/abandono/ajuda/resultado/retorno-ao-legado.
- **Regra §83:** "Missões" só entra se passar as 7 condições.

## F9 — Legacy Reduction
- Reusa `LegacyReductionService` (gate advisório por telemetria). "Executando"→Missões só sai do 1º
  nível com prova. Nada apagado (§52/§80). Ver `LEGACY-REDUCTION-PLAN.md`.

## F10 — Learning + Debrief
- Missão concluída → `OutcomeAssuranceService` (resultado) + `PatternMemoryService` (aprendizado, motor
  único §42). Mission Debrief (§41) = read-model. **Sem 2º banco de memória.**

## F11 — Proactive Missions (shadow)
- Radar propõe missão (§34): off→shadow→suggest→approval; autopilot só em casos seguros comprovados.
  **Flag** `mission_proactive_enabled`.

## F12 — Simplificação GA
- Só com evidência (§84): reduz Sidebar/config, consolida jornadas, amplia Fala Tu, preserva acesso
  avançado via "Explorar". −50% interações / −30% nav **se** a telemetria provar.

---

## Testes obrigatórios (toda fase, §79/§80)
Unitário (planejamento/estado/política/cálculo) · Integração (Mission→Runtime→Outcome) · Multi-tenant
(A nunca vê B) · RBAC (sem permissão não executa) · Idempotência (retry não duplica) · **Regression (o
fluxo antigo continua funcional)** · Mobile (iOS/Android) · Performance (missão não recalcula tudo no
load) · AI governance (injection/inventar dado/ação não autorizada/confidence).

## Critérios de aceite (CA-01..CA-20 do PRD) — rastreados por fatia
CA-03/04/05 (reverse plan/gap/caminho crítico) → F3 · CA-06/07 (readiness/risco) → F4 · CA-08/09
(Runtime/ApprovalPolicy) → F5 · CA-10/11/12 (planned×actual/at_risk/replan) → F6 · CA-13/14 (resultado/
aprendizado) → F10 · CA-15 (Fala Tu consulta missão) → F2/F7 · CA-16/17 (Hoje relevante/menos
interações) → F7/F8 · **CA-18 (nenhum motor duplicado)** e **CA-19 (nada quebrado)** e **CA-20 (sidebar
não cresce sem justificativa)** → invariantes de TODA fatia.

## Complexity Budget (gate de PR, §82)
Todo PR declara: telas +/− · menus +/− · campos +/− · cliques +/− · configurações removidas · ações
automatizadas. PR que aumenta permanentemente cliques/telas/conceitos do usuário comum é reconsiderado.
