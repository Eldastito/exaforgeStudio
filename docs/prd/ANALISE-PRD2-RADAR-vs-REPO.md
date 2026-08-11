# PRD 2 — Business Signal & Radar Engine — Fase 1: Auditoria de Percepção

> Matriz **REUTILIZAR / ESTENDER / CRIAR / DEFERIR** exigida pelo §99 (Fase 1) do PRD 2.
> Baseline auditado: `main` @ `dad3a50` (após PRD 1 fechado). Data: 2026-08-10.

> **STATUS 2026-08-11 — PRD 2 FECHADO.** Todas as fases entregues (F1–F12) em fatias
> pequenas (§100), 0 breaking change, aditivas e reversíveis (opt-in). As 20 CAs (§101)
> atendidas. Runbook operacional em `docs/runbook/radar-operacao.md`. Os incrementos:
> F2 contract hardening · F3 correlação · F4 anomalia · F5 goal-aware · F6 investigação ·
> F7 SLA/reversibilidade · F8 roteamento · F9 sinal humano · F10 sinal externo ·
> F11 calibração · F12 production readiness (health + budget por-detector + runbook).
> **Decisão arquitetural consolidada em `docs/adr/ADR-161-radar-empresarial-percepcao-transversal.md`** (esta matriz permanece como a auditoria de partida da Fase 1, §99).

## Sumário executivo

O PRD 2 é **explícito** (§5, §107): **não construir outro Radar do zero**. A auditoria confirma que o `main` já possui a espinha da percepção — **~80% do contrato e da mecânica já existem**. O trabalho é dar **sensibilidade empresarial** (anomalia + correlação + contexto + metas + impacto + evidência + prioridade) à infraestrutura existente, **sem criar ledger/feed/alerta paralelo** (CA1/CA10).

**Regra arquitetural crítica (§5) — já respeitada pelo baseline:** `business_signals` é o ledger canônico único; todos os ~15 detectores publicam por `BusinessSignalService.publish`; `attention()` é o feed único. Nada a "consertar" aqui — apenas **não regredir**.

## A espinha que já existe (baseline)

| Capacidade | Onde | Estado |
| --- | --- | --- |
| Ledger canônico de sinais | `business_signals` (`db.ts:5919`) + `BusinessSignalService` | Sólido. 24 colunas, UNIQUE(org,dedupe_key), 3 índices |
| Publish idempotente + dedupe | `publish()` (`BusinessSignalService.ts:49`) | Upsert por dedupe_key; **nunca reabre resolvido**; nunca reescreve correlation_id |
| Attention feed único | `attention()` (`BusinessSignalService.ts:100`) | Funde signals abertos (TTL-filtrados) + `decision_risks`; normaliza 2 vocabulários; ordena por severidade+recência |
| Espinha correlation_id | ADR-158: signals, decision_actions, action_outcomes, action_execution_log | **Furo: `process_instances` NÃO tem correlation_id** |
| Detectores projetando no contrato | Opportunity/Recovery/Manipulation + Churn/Security/PlanFit + 6 publishers | Todos publicam por `publish()`. Rule/threshold (poucos com baseline) |
| Auto-resolução (sweep) | Churn/Security/Consumption/RetailOps/PlanFit | Padrão "publica chaves válidas + resolve órfãs" **copy-pasted** (não framework) |
| Sinal→processo (auto-trigger) | `SignalProcessRouterService` (`:54`) | TRIGGER_MAP com **2 mapeamentos**; double opt-in; nunca auto-executa |
| Choke-point de execução | `CommandExecutorService.execute` (G1/G2/G3) | **auto-trigger ≠ auto-execute já garantido** (§43/CA13) |
| Autonomia L1–L4 | `autonomy_level` (observe/suggest/prepare/execute) + Autonomy Contract + ProgressiveAutonomy | Completo; IA nunca se auto-eleva |
| Distância à meta / pacing | `BusinessGoalService.progress()` (`:111`) | Existe (remaining/attainment/paceStatus) **mas isolado** — não alimenta prioridade |
| Prioridade econômica | `ImpactPrioritizationService` (score 5-fatores, L0–L4, `analysisFor` depth-gate) | ✅ Forte + goal-relevance (F5) + **SLA/reversibility (F7)** — boosts situacionais multiplicativos |
| Impacto esperado×realizado | `OutcomeMeasurementService` + `UnifiedImpactLedgerService` | Valor protegido/capturado derivado por query |
| Governança de custo de IA | `ResearchBudgetService` (plataforma) + `AiQuotaSignalService` (por-org) + `ai_usage_log` | Falta **budget por-detector / max-investigations-dia** |

## Matriz REUTILIZAR / ESTENDER / CRIAR / DEFERIR

### ♻️ REUTILIZAR (sem tocar — só consumir/não regredir)

| Item | Referência | Nota |
| --- | --- | --- |
| Contrato `business_signals` (severidade, evidence, premises, dedupe, correlation, TTL-schema) | `db.ts:5919`, `:8257`, `:8275` | Ledger canônico (CA1). Base de tudo |
| `publish` / `list` / `resolveByDedupe` / setters de status | `BusinessSignalService.ts` | Idempotência + dedupe (CA15 parcial) |
| `attention()` como feed único | `BusinessSignalService.ts:100` | Fonte única (CA10/CA11). Smart Inbox/Fala Tu já consomem |
| Detectores que já projetam (Opportunity/Recovery/Manipulation) | ADR-046/047/050 | §7: **não reimplementar**. Generalizar depois |
| Choke-point de execução (G1/G2/G3) | `CommandExecutorService.execute` | §43/CA13 já garantido |
| Autonomia L1–L4 + Autonomy Contract + ProgressiveAutonomy | `agent_policies.autonomy_level`, `ApprovalPolicyService.resolveContract` | §44 (Radar nunca passa de L3) já enforceável |
| `ImpactPrioritizationService` (score, L0–L4, `analysisFor`) | ADR-136/DI-1 | §38/§39; depth-gate de LLM (§83) |
| `OutcomeMeasurementService` / `UnifiedImpactLedger` | ADR-136/158 | §95 valor realizado |
| `BusinessGoalService.progress()` (distância/pacing) | ADR-160 D4 | §30/§31 — pronto pra consumir |
| Budgets de IA (`ResearchBudgetService`, `AiQuotaSignalService`, `ai_usage_log`) | ADR-154/156 | §84 base |
| Cluster `Radar*` (maturidade + B2B prospecting) | `RadarService`, `RadarB2BService` | **NÃO CONFUNDIR** — feature diferente. Não tocar |

### 🔧 ESTENDER (aditivo, sem novo ledger)

| Item | Gap concreto | Fase PRD |
| --- | --- | --- |
| `basis` aceitar **`hypothesis`** | Hoje `BASES=["fact","estimate"]` bloqueia no `publish` (`:52`). §12/§13 exigem 3 valores | F2 |
| Coluna dedicada **`subject_id`** | Só existe `subject_type`; hoje usa-se `source_entity_id` (source-scoped, não subject) | F2 |
| **Freshness / staleness** | `confidence` é estática; TTL só filtra na leitura; sem `expired`/decay (§78-79) | F2 |
| ~~**Enforcement de TTL**~~ | ✅ **F2.2 ENTREGUE** — filtro corrigido (`datetime(expires_at)`) + sweep `expireStale`→`expired` (Scheduler `signalTtlSweepPass`, antes do auto-trigger). `test:signal-ttl` (9 checks) | ~~F2~~ ✅ |
| **Recorrência/reopen** | Republish nunca reabre resolvido (§55). Recorrência precisa de novo ciclo com histórico | F2 |
| ~~**`process_instances.correlation_id`**~~ | ✅ **F2.3 ENTREGUE** — coluna+índice; `startFromSignal` propaga o correlation do sinal; thread (F6) costura o processo do router. `test:signal-process-spine` (7 checks) | ~~F2~~ ✅ |
| ~~**Goal-relevance no score**~~ | ✅ **F5 ENTREGUE** — boost multiplicativo (0 sem meta atrasada) via `BusinessGoalService.progress`; `goalRelevance`+`affectedGoal` na saída. `test:goal-aware-priority` (8 checks) | ~~F5~~ ✅ |
| ~~SLA + reversibility no score~~ | ✅ **F7 ENTREGUE** — `slaPressure` (pressão de prazo via `expires_at`, horizonte 72h) + `irreversibility` (hint `evidence.reversibility`); boosts multiplicativos default-0 (zero regressão); detector declara, scorer honra. `test:impact-sla-reversibility` (21 checks) | ~~F7~~ ✅ |
| ~~Expansão do TRIGGER_MAP~~ | ✅ **F8 ENTREGUE** — +mapa explícito (stalled_opportunities→sales_recovery) + mecanismo recommendedProcessType com allowlist de processos maduros. `test:signal-routing-expansion` (9 checks) | ~~F8~~ ✅ |
| ~~`recommendedProcessType` no sinal~~ | ✅ **F8** — o detector declara (F4.2) e o router honra se o processo for maduro (allowlist) | ✅ |
| ~~Budget por-detector / max-investigations-dia~~ | ✅ **F12.2 ENTREGUE** — `DetectorBudgetService` (teto diário de investigação profunda LLM por detector, via marcador no `ai_usage_log` — sem tabela nova; override por org; gate em `investigateDeep` → `budget_exhausted`). `GET /api/signals/detector-budget`. `test:detector-budget` (13) | ~~F12~~ ✅ |

### 🆕 CRIAR (justificado — capacidade genuinamente ausente)

| Item | Por quê | Fase PRD |
| --- | --- | --- |
| **Anomaly framework genérico** (baseline + deviation + min-sample + cooldown + TTL) como primitiva reutilizável | Hoje é código inline repetido. §22/§25/§26. **F4.1 ENTREGUE:** `anomalyPrimitives` (mean/stdDev/percentile/evaluateAnomaly/cooldown/ttl, puro, sem IA), `test:anomaly-primitives` (17 checks). **F4.2 ENTREGUE:** `AnomalyDetectorRegistry` (contrato §67 + register/byVertical + evaluate→SignalInput via F4.1), `test:anomaly-registry` (13 checks). **F4.3 ENTREGUE:** RetailFloor `conversion_drop` migrado (decisão via registry+primitiva, sinal preservado, equivalência provada), `test:detector-migration` (9 checks). **Fase 4 FECHADA** | ✅ |
| **Detector registry** (contrato §67 + defaults por vertical §89-90) | ✅ **F4.2 ENTREGUE** — `AnomalyDetectorRegistry` (contrato + packs + byVertical + evaluate). `test:anomaly-registry` (13 checks) | ✅ |
| **Correlation Engine** (N sinais → 1 situação, multi-evidência) | Inexistente. Só há dedupe (mesmo evento). §16-20 pedem correlação (evento≠evento). **F3.1 ENTREGUE:** `SignalCorrelationService.clusters` — confiança ALTA (mesmo `(subject_type,subject_id)`, multi-domínio, janela), derivado, evidência preservada. `test:signal-correlation` (10 checks). **F3.2 ENTREGUE:** `attention()` colapsa a situação (opt-in flag/param, evidenceCount+signalIds), `test:attention-correlation` (9 checks). **F3.3 ENTREGUE:** confiança MÉDIA (padrão do mesmo signal_type em sujeitos distintos, `related[]`, não colapsa), `test:signal-related` (9 checks). **Fase 3 FECHADA** | F3 |
| **Investigation pipeline** (causa-candidata + supporting/contradicting evidence + confidence) | `analysisFor` roteia profundidade mas não havia geração de causa. **F6.1 ENTREGUE:** `SignalInvestigationService.investigate` — causas-candidatas determinísticas (evidência a favor/contra + confiança, basis hypothesis, nunca vira fato §13), sem IA. `test:signal-investigation` (11 checks). **F6.2 ENTREGUE:** `investigateDeep` — gate de LLM por nível de impacto (L3+, reusa DI-1), sintetizador injetável, IA nunca é loop principal (§81-83), `test:signal-investigation-deep` (10 checks). **Fase 6 FECHADA** | ✅ |
| ~~**Feedback & calibration**~~ | ✅ **F11 ENTREGUE** — `dismiss(reason)` (§65) + `SignalCalibrationService.detectorMetrics` (false-positive/dismissal rate + calibração por detector, §66). `test:signal-calibration` (8 checks) | ~~F11~~ ✅ |
| ~~**External signal contract**~~ | ✅ **F10 ENTREGUE** — `ExternalSignalService.ingest` (opt-in `radar_external_signals_enabled`): molde provider-agnóstico com proveniência obrigatória (`source`+`externalId`→dedupe idempotente), basis `fact` só com `verifiable` (§13), severidade derivada de rating/sentiment, autor mascarado (LGPD), confiança externa <1. `POST /api/signals/ingest-external`. Conectores seguem PRDs próprios (§50). `test:external-signals` (22 checks) | ~~F10~~ ✅ |
| **Radar health / métricas** (§94-98) | ✅ **F12.1 ENTREGUE** — `RadarHealthService.overview` (volume + freshness/stale §96 + storm §53 + calibração F11 reusada + status geral, derivado por query). `GET /api/signals/health` (admin). `test:radar-health` (12). Resta budget por-detector (F12.2) + runbooks (F12.3) | F12 |

### ⏸️ DEFERIR (fora do escopo deste PRD)

| Item | Razão |
| --- | --- |
| Conectores externos (Reclame AQUI, External Intelligence providers) | §10C/§50 — pertencem a PRDs próprios (Customer Recovery & Reputation Engine). Aqui só o contrato de ingestão |
| Detecção por IA complexa (ML/z-score/seasonality avançada) | §22 — começar determinístico (média móvel/desvio/percentil). LLM só interpreta |
| Reescrever `RadarService`/`RadarB2B` | Features diferentes; colisão só de nome |
| 20 detectores de uma vez | §70/§100 — escolher poucos por impacto×dados×ação |

## Estado dos Critérios de Aceite (§101) no baseline

| CA | Estado hoje | Trabalho |
| --- | --- | --- |
| CA1 ledger canônico | ✅ já é | não regredir |
| CA2 contrato normalizado (H/D/E) | ✅ **COMPLETO** | ✅ **F9 (human)** `HumanSignalService.observe` (acúmulo de evidência) + ✅ **F10 (external)** `ExternalSignalService.ingest` (proveniência + dedupe por origem, nunca fato não verificado). Digital já existia (detectores). As três origens de percepção normalizadas no ledger canônico |
| CA3 fato×estimativa distinguível | 🟡 falta `hypothesis` | F2 |
| CA4 correlação sem destruir evidência | ✅ **F3.1 alta + F3.2 surface + F3.3 média** — evidência sempre preservada | não regredir |
| CA5 framework de anomalia | ✅ **F4.1+F4.2+F4.3** (primitivas+registry+1 detector migrado) | ✅ |
| CA6 baseline | ✅ **primitiva em uso real (F4.3)** | ✅ |
| CA7 goal-aware | ✅ **F5 wired** (metas atrasadas boostam a prioridade) | ✅ |
| CA8 impacto não inventado | ✅ `basis=estimate` + premises | reforçar em F6 |
| CA9 sinais priorizados | ✅ `ImpactPrioritizationService` + **F7 (SLA/reversibility)** | ✅ |
| CA10 attention feed único | ✅ já é | não regredir |
| CA11 Fala Tu consome | ✅ Smart Inbox/Home consomem | não regredir |
| CA12 sinal→processo | ✅ router (mapa explícito + recommendedProcessType maduro, F8) | ✅ |
| CA13 auto-trigger não bypassa policy | ✅ choke-point garante | não regredir |
| CA14 correlationId no ciclo | ✅ **F2.3 fechou o furo em process_instances** | não regredir |
| CA15 TTL/dedupe/cooldown anti-storm | 🟡 dedupe sim; **TTL agora vale (F2.2 ✅)**; cooldown só PlanFit | F4 (cooldown genérico) |
| CA16 detector isolado não derruba | ✅ best-effort em cada pass + **F12.1 observabilidade** (detector que parou/storm fica visível) | ✅ |
| CA17 custo de IA mensurado | ✅ `ai_usage_log` + budgets + **F12.2 teto por-detector** (storm não drena a verba) | ✅ |
| CA18 tenant isolation | ✅ toda query filtra org | testar em cada fatia |
| CA19 false-positive metrics | ✅ **F11** (por detector, derivado por query) | ✅ |
| CA20 2 ciclos reais fecham | 🟡 cobrança/recovery têm runtime | F8 beachhead (§71) |

## Mapa de fases → fatias pequenas (§100 — nada de big bang)

| Fase | Escopo | Tipo | Fatias sugeridas |
| --- | --- | --- | --- |
| **F1** | Esta auditoria + matriz | doc | **1 PR (este)** |
| ~~**F2**~~ ✅ | Signal Contract Hardening — **FECHADA**: F2.1 basis+subject (#921) · F2.2 TTL enforcement (#922) · F2.3 correlation_id no processo | ESTENDER | ✅ |
| **F3** | Correlation Engine (vendas/cobrança/estoque) | CRIAR | F3.1 primitivas (subject+janela+família) · F3.2 cluster derivado · F3.3 confiança (auto/possível/separado) |
| **F4** | Anomaly framework + registry | CRIAR | F4.1 primitivas (baseline/deviation/min-sample/cooldown) · F4.2 registry+contrato · F4.3 1 detector piloto migrado |
| **F5** | Goal-aware prioritization | ESTENDER | wire `BusinessGoalService.progress` → score |
| **F6** | Investigation pipeline (causa-candidata) | CRIAR | determinístico→correlação→histórico→LLM-gated |
| ~~**F7**~~ ✅ | Impact prioritization refino — **FECHADA**: `slaPressure` (prazo via `expires_at`) + `irreversibility` (hint `evidence.reversibility`), boosts multiplicativos default-0 (§38); goal-relevance já vinha da F5. `test:impact-sla-reversibility` (21) | ESTENDER | ✅ |
| **F8** | Routing expansion (beachhead §71) | ESTENDER | +mapeamentos maduros (collection/sales_recovery) |
| ~~**F9**~~ ✅ | Human signals (Fala Tu → radar) — **FECHADA**: `HumanSignalService.observe` (opt-in `radar_human_signals_enabled`) normaliza a observação humana num `business_signal` (`origin:human`, `basis=estimate\|hypothesis`, **nunca fact §13**) com **acúmulo de evidência** (mesmo assunto sobe confiança 0.30→0.85 e severidade info→attention→risk, derivado de `observations.length`, RN-004); atômico (tx); `POST /api/signals/observe`; sem tabela nova (CA1) | ESTENDER | ✅ |
| ~~**F10**~~ ✅ | External signal contract (molde) — **FECHADA**: `ExternalSignalService.ingest`, proveniência + dedupe por origem, fact só se verificável (§13), `POST /api/signals/ingest-external`, `test:external-signals` (22). CA2 fica **100%** (H/D/E) | CRIAR | ✅ |
| **F11** | Feedback & calibration | CRIAR | dismiss reason + false-positive rate |
| ~~**F12**~~ ✅ | Production readiness — **FECHADA**: ✅ F12.1 radar health (`RadarHealthService`, `test:radar-health` 12) · ✅ F12.2 budget por-detector (`DetectorBudgetService`, `test:detector-budget` 13) · ✅ F12.3 runbook operacional (`docs/runbook/radar-operacao.md`) | — | ✅ |

## Fatia recomendada a seguir: **F2.1 — basis+hypothesis + subject_id**

Menor incremento que destrava tudo, 100% aditivo, 0 risco, alinhado ao §99-F2 ("completar o contrato apenas onde necessário; sem novo ledger"):
- `basis` passa a aceitar **`hypothesis`** (`BASES` + validação em `publish`), separando dado de interpretação (CA3, §12-13);
- coluna **`subject_id`** (ALTER aditivo) + campo opcional em `SignalInput` — hoje o "sujeito" do sinal (SKU/contato/proposta) só tem `subject_type`;
- retrocompat total: sinais existentes seguem `fact|estimate`, `subject_id` NULL.

Testes: `test:signal-contract-hardening` (fato×estimativa×hipótese; subject_id; dedupe/TTL intactos; isolamento). Regressão: `business-signals` + `decision-intelligence-*` + `signal-auto-trigger` + detectores.

> **Princípio §106 aplicado a cada fatia:** antes de criar detector — "que decisão muda?"; antes de alerta — "precisa interromper alguém?"; antes de IA — "dá pra detectar deterministicamente?"; antes de processo — "há playbook governado?"; antes de causa — "tenho evidência ou estou supondo?".
