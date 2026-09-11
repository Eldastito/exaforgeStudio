# Runbook — Financial Recovery OS (operação)

**Módulo:** Financial Recovery OS (PRD-ZF-UNIFIED-GAP-CLOSURE-03, Fase 3).
**Status:** Onda 2 fechada — PR-5..PR-11 em produção.
**Flag:** `organization_settings.financial_recovery_enabled` (default `0`, opt-in por org).
**Gate de rota:** server-side (404 quando off). Rotas em `/api/financial-recovery/*`, owner/admin.
**Análise/plano:** `docs/prd/AUDIT-ZF-UNIFIED-GAP-CLOSURE-03.md` (Gate F0).

## Tese

`Você está devendo muito` → `Este é o tamanho do problema, as causas, a capacidade de
recuperação, onde o caixa rompe, as ações que mudam a trajetória, as negociações compatíveis
com o caixa, os riscos que exigem profissional e o plano acompanhado semana a semana.`

**Não** promete impedir falência. É orientativo; escala pro profissional quando ultrapassa
planejamento operacional.

## Mapa dos serviços (todos read-only/determinísticos, compõem infra existente)

| Serviço | Papel | Fatia | Cria? |
| --- | --- | --- | --- |
| `RecoveryDebtService` | Mapa da Dívida (CRUD + summary) — obrigações externas | PR-5 | tabela `recovery_debt_items` (única de dados) |
| `RecoveryAssessmentService` | Quadro consolidado + face do módulo (isEnabled/setEnabled) | PR-5 | — (compõe `ExecutiveFinanceService`) |
| `RecoveryViabilityService` | IRF (0-100) + diagnóstico crise operacional×financeira | PR-6 | — (ESTENDE `SurvivalIndexService`, não índice paralelo) |
| `DebtPriorityService` | Matriz de priorização (4 eixos) — NÃO ordem jurídica | PR-7 | — |
| `SurvivalBudgetService` | Orçamento A/B/C/D (sugere, não cancela) | PR-7 | — |
| `RecoveryScenarioService` | Simulador + "quanto prometer?" + Negociação | PR-8 | — (compõe `CashForecastService` 13 semanas) |
| `RecoveryPlanService` | Plano consolidado + sugestão de missão | PR-9 | — (compõe tudo; `ExecutiveMissionBridge` pattern) |
| `ProfessionalEscalationService` | Gatilhos → `professional_review_required` | PR-10 | — |
| `RecoveryDataRoomService` | Pacote pra contador/advogado/banco | PR-10 | — (sem storage paralelo) |

## Rotas (`/api/financial-recovery/*`, owner/admin, gate por flag)

- `GET/PUT /enablement` — liga/desliga (antes do gate).
- `GET /assessment` — quadro financeiro + Mapa da Dívida.
- `GET /viability` — IRF + diagnóstico de crise.
- `GET /debts` · `GET /debts/summary` · `GET /debts/priority` · `POST /debts` · `PATCH /debts/:id` · `DELETE /debts/:id` (cancela) — Mapa da Dívida.
- `GET /survival-budget` — sugestão A/B/C/D.
- `POST /scenario/simulate` · `POST /scenario/commitment` · `POST /scenario/negotiation`.
- `GET /plan` · `GET /plan/mission-suggestion`.
- `GET /escalation` · `GET /data-room`.

## Fluxo (golden path GP-01)

endividamento → `assessment` (quadro) → `viability` (IRF + crise) → `debts`/`debts/priority`
(mapa + prioridade) → `survival-budget` (o que cortar) → `scenario/simulate` + `commitment`
(o que muda a trajetória / o que cabe) → `plan` + `plan/mission-suggestion` (plano + missão
sugerida) → `escalation` (quando escala) → `data-room` (pacote pro profissional).

Acompanhamento semana a semana: a missão sugerida (se o dono criar) reusa o
**checkpoint/replan do Mission OS** (ADR-189) — planejado × realizado × desvio.

## Guardrails RN-FR (codificados em teste)

- **RN-FR-1** nunca inventa dívida/número: campo desconhecido = `null`, nunca 0/fabricado.
- **RN-FR-3** nunca dá parecer jurídico; `legal_risk` é rótulo do operador; escalonamento só sinaliza.
- **RN-FR-4** priorização NÃO é ordem jurídica de pagamento (separa 4 eixos + explica).
- **RN-FR-6** dinheiro role-gated (§73) — R$ redigido sem permissão; contagem/%/label/veredito preservados.
- **RN-FR-7** read-only — não muda caixa/DRE/FSM.
- **RN-FR-9** retenção — cancelar dívida é UPDATE `status`, nunca DELETE.
- **RN-FR-10** IRF 100% determinístico (LLM nunca calcula caixa/índice; só narra).
- **RN-FR-11** fato ≠ hipótese nunca somados (baseline × factOnly × scenario; fact/estimate/hypothesis).
- **§23** IA nunca aceita/assina acordo, contrata crédito, renegocia sozinha nem recomenda automaticamente falência/recuperação judicial.

## Testes (todos rodam em CI sem chave de IA)

`test:financial-recovery` (34) · `test:recovery-viability` (20) · `test:debt-priority` (14) ·
`test:survival-budget` (15) · `test:recovery-scenario` (21) · `test:recovery-plan` (18) ·
`test:recovery-escalation-dataroom` (21) · `test:financial-recovery-golden-path` (24, GP-01 + hardening RN-FR).

## Rollout / rollback

- **Rollout:** flag `financial_recovery_enabled` opt-in por org (default 0 — orgs não ativadas não veem nada).
- **Rollback:** desligar a flag (recurso some, 404); ou reverter os PRs. A tabela `recovery_debt_items`
  é aditiva (CREATE IF NOT EXISTS) — dado preservado; nenhuma migration destrutiva.

## Pendências (fora da Onda 2)

- **PR-9b (entry point UI/NL):** renderizar a sugestão de recuperação no Diretor IA (`ExecutiveView`,
  endpoint `mission-suggestions` já existe) e rotear linguagem natural ("estou cheio de dívidas") no
  `FalaTuAskService` → `MissionIntentService`/plano. Mexe em superfícies compartilhadas — fazer com cuidado.
- **F3.12 Cash Generation Plan (integração profunda):** puxar oportunidades de Collection/SalesRecovery/
  Prospect/Pricing pro plano (hoje o plano referencia os levers; a integração-motor é evolução).
- **F3.18 Tax Regularization:** depende da infra de research externo aprovada; PR separado.
