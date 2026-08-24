# Runbook — Mission Operating Layer (ADR-189)

A camada HORIZONTAL de orquestração de objetivos: o usuário escolhe o RESULTADO, o ZapFlow escolhe
a ferramenta. **Composição do que já existe, não expansão.** O ciclo: intenção → missão → plano
reverso → prontidão/risco → execução governada → checkpoint/replan → aprendizado — pedindo o humano
só na exceção. Tudo atrás da flag `mission_layer_enabled` (default OFF, 0-regressão). Convenções:
isolamento multi-tenant, RN-004 (derivado por query), `business_signals` (nunca fila paralela),
determinístico antes de LLM, shadow-first, resultado ≠ execução, governança intacta.

---

## 1. O que resolve

O ZapFlow acumulou muita capacidade dependente da iniciativa humana. O Mission Layer inverte a
relação: o dono expressa um objetivo e o sistema entende o estado final, planeja de trás pra frente,
verifica prontidão/risco, executa **pelo caminho governado que já existe**, acompanha, replaneja,
confirma o resultado de NEGÓCIO e aprende. **~90% composição** (BusinessGoal + SkillOS + a espinha
decisão/execução/outcome/aprendizado + a camada Invisible-UX); o código novo cabe em ~4 primitivas.

## 2. Mapa dos serviços / pontos de código

| Fatia | Peça | Papel |
| --- | --- | --- |
| F1 | `MissionService` + tabela `missions` | Mission Contract — entidade própria que COMPÕE o `BusinessGoal` (não é linha de goal; §7). Shadow-first (nasce off; autopilot proibido). |
| F2 | `MissionIntentService` | Intenção→missão determinística (6 padrões); shadow (só grava se pedido). |
| F3 | `MissionReversePlanner` | Planejamento REVERSO: alvo → eventos → gap vs base + gargalo + Último Momento Seguro. Determinístico; honesto (premissa faltante → unknown). |
| F4 | `MissionReadinessService` | Prontidão + risco (compõe Radar/saúde/estoque/agenda/canal + Pre-Mortem via business_signals). NÃO expõe infra (Admin-only). |
| F5 | `MissionRuntimeService` | Ponte governada: efeito → `DecisionAction`→`ApprovalPolicy`→`CommandExecutor` (sem executor paralelo). Liga por `correlation_id='mission:<id>'`. |
| F6 | `MissionCheckpointService` | Planned×actual×tempo → on_track/at_risk/off_track; sinal `mission/at_risk`; replan GOVERNADO. |
| F7 | `FalaTuHomeService.missionsBlock` | "Hoje" por exceção (aguardando você / em risco / concluídas). null com a flag off. |
| F8 | `NavigationManifestService.forUser` | Nav: "Executando" FUNDE em "Missões" com o layer ligado (net-zero, §25). |
| F9 | `LegacyReductionService` (par Executando→Missões) | Gate advisório por telemetria; nunca remove tela. |
| F10 | `MissionDebriefService` | Debrief read-model + aprendizado no MOTOR ÚNICO (`PatternMemoryService`); só achieved/failed ensina. |
| F11 | `MissionProactiveService` | Radar propõe missão (shadow-first: off/shadow/suggest; nunca auto). |

## 3. Superfícies (rotas `/api/missions/*`, owner/admin, gated pela flag)

CRUD: `GET/POST /` · `GET/PATCH /:id` · `POST /:id/{status,autonomy,cancel}` · `POST /intent`.
Ciclo: `POST /:id/plan` · `POST /:id/readiness` · `POST /:id/actions` · `GET /:id/runtime` ·
`GET /:id/checkpoint` · `POST /:id/replan` · `GET /:id/debrief` · `POST /:id/learn`.
Proativo: `GET /proactive/scan` · `POST /proactive/{mode,run}`.

## 4. Passes do Scheduler (só orgs com a flag)

- `MissionCheckpointService.pass` — checkpoint das missões em andamento (métrica/alvo/prazo) → `mission/at_risk`.
- `MissionProactiveService.pass` — traduz sinais abertos em propostas (postura shadow/suggest).

## 5. Guardrails RN-MOL (testados em `test:mission-hardening`)

1. **Composição > extensão > criação** — nenhum motor crítico duplicado (efeito em `decision_actions`).
2. **Missão = entidade própria que COMPÕE o Goal** — não é linha de goal; métrica desconhecida rejeitada.
3. **Determinístico antes de LLM** — reverse-plan/readiness reprodutíveis.
4. **Shadow-first** — nasce off; autopilot/`auto` recusados; missão off não propõe.
5. **Resultado ≠ execução** — checkpoint nunca marca `achieved`; propor ≠ executar (nunca `done`).
6. **Governança intacta** — todo efeito via propose→policy→executor (nasce awaiting_approval/approved).
7. **UX reversível** — nav swap por flag (net-zero); legacy reduction advisória (nunca apaga).
8. **Isolamento por org; RBAC; idempotência; fail-closed.**
9. **Complexity Budget** — cada PR declarou telas/cliques (fundação: +0; UX: +0/−cliques).

## 6. Postura de autonomia (shadow-first)

Missão: `off` (default) → `shadow` → `suggest` → `approval`. **`autopilot` nunca é declarável.**
Proativo: `mission_proactive_mode` off/shadow/suggest — **`auto` recusado**. A execução real SEMPRE
atravessa o caminho governado (F5), mesmo em suggest.

## 7. Troubleshooting

| Sintoma | Causa | Ação |
| --- | --- | --- |
| Nenhuma missão aparece | `mission_layer_enabled` = 0 | Ligar a flag (opt-in). Tudo é 0-regressão até lá. |
| Reverse-plan com estágio `unknown` | premissa faltante (ticket/conversão/base) | Informar a premissa ou cadastrar vendas/contatos (deriva). |
| Missão não propõe ação | autonomia `off` | Subir pra `shadow`/`suggest`/`approval` (nunca autopilot). |
| Sem `mission/at_risk` | missão sem métrica/alvo/prazo, ou no ritmo | Checkpoint só se aplica a missão mensurável. |
| Proativo não cria missões | `mission_proactive_mode` = off, ou domínio do sinal não mapeado | Definir shadow/suggest; só domínios mapeados viram proposta. |

## 8. Rollout

`OFF` (default) → ligar `mission_layer_enabled` num tenant piloto → usar o ciclo manual (F1–F6) →
proativo em `shadow` (comparar proposta × ação humana) → `suggest` → nav simplificada A/B (F8) →
legacy reduction só com telemetria verde (F9). Autonomia sobe só com evidência; nunca autopilot direto.

## 9. Testes (12)

`test:mission-contract` · `test:mission-intent` · `test:mission-reverse-plan` · `test:mission-readiness`
· `test:mission-runtime` · `test:mission-checkpoint` · `test:mission-home` · `test:mission-nav` ·
`test:mission-legacy-reduction` · `test:mission-debrief` · `test:mission-proactive` ·
`test:mission-hardening` (RN-MOL + fiação de produção).
