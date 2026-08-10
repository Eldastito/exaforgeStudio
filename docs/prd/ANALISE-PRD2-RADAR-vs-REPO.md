# PRD 2 — Business Signal & Radar Engine — Fase 1: Auditoria de Percepção

> Matriz **REUTILIZAR / ESTENDER / CRIAR / DEFERIR** exigida pelo §99 (Fase 1) do PRD 2.
> Baseline auditado: `main` @ `dad3a50` (após PRD 1 fechado). Data: 2026-08-10.

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
| Prioridade econômica | `ImpactPrioritizationService` (score 5-fatores, L0–L4, `analysisFor` depth-gate) | Forte. Falta SLA/reversibility/**goal-relevance** no score |
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
| SLA + reversibility no score | §38 lista fatores ausentes no score atual | F7 |
| ~~Expansão do TRIGGER_MAP~~ | ✅ **F8 ENTREGUE** — +mapa explícito (stalled_opportunities→sales_recovery) + mecanismo recommendedProcessType com allowlist de processos maduros. `test:signal-routing-expansion` (9 checks) | ~~F8~~ ✅ |
| ~~`recommendedProcessType` no sinal~~ | ✅ **F8** — o detector declara (F4.2) e o router honra se o processo for maduro (allowlist) | ✅ |
| Budget por-detector / max-investigations-dia | Só há ceiling por-org + budget de plataforma (§84) | F12 |

### 🆕 CRIAR (justificado — capacidade genuinamente ausente)

| Item | Por quê | Fase PRD |
| --- | --- | --- |
| **Anomaly framework genérico** (baseline + deviation + min-sample + cooldown + TTL) como primitiva reutilizável | Hoje é código inline repetido. §22/§25/§26. **F4.1 ENTREGUE:** `anomalyPrimitives` (mean/stdDev/percentile/evaluateAnomaly/cooldown/ttl, puro, sem IA), `test:anomaly-primitives` (17 checks). **F4.2 ENTREGUE:** `AnomalyDetectorRegistry` (contrato §67 + register/byVertical + evaluate→SignalInput via F4.1), `test:anomaly-registry` (13 checks). **F4.3 ENTREGUE:** RetailFloor `conversion_drop` migrado (decisão via registry+primitiva, sinal preservado, equivalência provada), `test:detector-migration` (9 checks). **Fase 4 FECHADA** | ✅ |
| **Detector registry** (contrato §67 + defaults por vertical §89-90) | ✅ **F4.2 ENTREGUE** — `AnomalyDetectorRegistry` (contrato + packs + byVertical + evaluate). `test:anomaly-registry` (13 checks) | ✅ |
| **Correlation Engine** (N sinais → 1 situação, multi-evidência) | Inexistente. Só há dedupe (mesmo evento). §16-20 pedem correlação (evento≠evento). **F3.1 ENTREGUE:** `SignalCorrelationService.clusters` — confiança ALTA (mesmo `(subject_type,subject_id)`, multi-domínio, janela), derivado, evidência preservada. `test:signal-correlation` (10 checks). **F3.2 ENTREGUE:** `attention()` colapsa a situação (opt-in flag/param, evidenceCount+signalIds), `test:attention-correlation` (9 checks). **F3.3 ENTREGUE:** confiança MÉDIA (padrão do mesmo signal_type em sujeitos distintos, `related[]`, não colapsa), `test:signal-related` (9 checks). **Fase 3 FECHADA** | F3 |
| **Investigation pipeline** (causa-candidata + supporting/contradicting evidence + confidence) | `analysisFor` roteia profundidade mas não havia geração de causa. **F6.1 ENTREGUE:** `SignalInvestigationService.investigate` — causas-candidatas determinísticas (evidência a favor/contra + confiança, basis hypothesis, nunca vira fato §13), sem IA. `test:signal-investigation` (11 checks). **F6.2 ENTREGUE:** `investigateDeep` — gate de LLM por nível de impacto (L3+, reusa DI-1), sintetizador injetável, IA nunca é loop principal (§81-83), `test:signal-investigation-deep` (10 checks). **Fase 6 FECHADA** | ✅ |
| **Feedback & calibration** (dismiss reason + false-positive rate por detector) | §63-66 métricas de qualidade ausentes | F11 |
| **External signal contract** (molde p/ Reclame AQUI / External Intelligence) | §10C/§48-51 — só o **contrato**, não os conectores | F10 |
| **Radar health / métricas** (§94-98) | Observabilidade admin dos detectores | F12 |

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
| CA2 contrato normalizado (H/D/E) | 🟡 parcial | F9 (human) + F10 (external) |
| CA3 fato×estimativa distinguível | 🟡 falta `hypothesis` | F2 |
| CA4 correlação sem destruir evidência | ✅ **F3.1 alta + F3.2 surface + F3.3 média** — evidência sempre preservada | não regredir |
| CA5 framework de anomalia | ✅ **F4.1+F4.2+F4.3** (primitivas+registry+1 detector migrado) | ✅ |
| CA6 baseline | ✅ **primitiva em uso real (F4.3)** | ✅ |
| CA7 goal-aware | ✅ **F5 wired** (metas atrasadas boostam a prioridade) | ✅ |
| CA8 impacto não inventado | ✅ `basis=estimate` + premises | reforçar em F6 |
| CA9 sinais priorizados | ✅ `ImpactPrioritizationService` | F7 refina |
| CA10 attention feed único | ✅ já é | não regredir |
| CA11 Fala Tu consome | ✅ Smart Inbox/Home consomem | não regredir |
| CA12 sinal→processo | ✅ router (mapa explícito + recommendedProcessType maduro, F8) | ✅ |
| CA13 auto-trigger não bypassa policy | ✅ choke-point garante | não regredir |
| CA14 correlationId no ciclo | ✅ **F2.3 fechou o furo em process_instances** | não regredir |
| CA15 TTL/dedupe/cooldown anti-storm | 🟡 dedupe sim; **TTL agora vale (F2.2 ✅)**; cooldown só PlanFit | F4 (cooldown genérico) |
| CA16 detector isolado não derruba | ✅ best-effort em cada pass | reforçar em F12 |
| CA17 custo de IA mensurado | ✅ `ai_usage_log` + budgets | F12 (per-detector) |
| CA18 tenant isolation | ✅ toda query filtra org | testar em cada fatia |
| CA19 false-positive metrics | ❌ ausente | F11 |
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
| **F7** | Impact prioritization refino (SLA/reversibility/goal) | ESTENDER | fatores no score |
| **F8** | Routing expansion (beachhead §71) | ESTENDER | +mapeamentos maduros (collection/sales_recovery) |
| **F9** | Human signals (Fala Tu → radar) | ESTENDER | observação estruturada + evidence accrual |
| **F10** | External signal contract (molde) | CRIAR | só contrato de ingestão |
| **F11** | Feedback & calibration | CRIAR | dismiss reason + false-positive rate |
| **F12** | Production readiness | — | perf/observability/budgets/runbooks |

## Fatia recomendada a seguir: **F2.1 — basis+hypothesis + subject_id**

Menor incremento que destrava tudo, 100% aditivo, 0 risco, alinhado ao §99-F2 ("completar o contrato apenas onde necessário; sem novo ledger"):
- `basis` passa a aceitar **`hypothesis`** (`BASES` + validação em `publish`), separando dado de interpretação (CA3, §12-13);
- coluna **`subject_id`** (ALTER aditivo) + campo opcional em `SignalInput` — hoje o "sujeito" do sinal (SKU/contato/proposta) só tem `subject_type`;
- retrocompat total: sinais existentes seguem `fact|estimate`, `subject_id` NULL.

Testes: `test:signal-contract-hardening` (fato×estimativa×hipótese; subject_id; dedupe/TTL intactos; isolamento). Regressão: `business-signals` + `decision-intelligence-*` + `signal-auto-trigger` + detectores.

> **Princípio §106 aplicado a cada fatia:** antes de criar detector — "que decisão muda?"; antes de alerta — "precisa interromper alguém?"; antes de IA — "dá pra detectar deterministicamente?"; antes de processo — "há playbook governado?"; antes de causa — "tenho evidência ou estou supondo?".
