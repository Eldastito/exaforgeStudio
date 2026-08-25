# F0 — Análise: CEO Operating Layer vs. Codebase (ExaforgeStudio)

**Tipo:** auditoria de prior art (doc-only, obrigatória antes de qualquer código — §64/§89 do PRD).
**Veredito de uma linha:** o CEO Operating Layer é **~90% composição** do que já existe. O PRD superestima
o esforço em dois pontos-chave (financeiro e priorização), que já estão construídos. O código
genuinamente novo cabe em **~4 primitivas** + amarração. **Recomendação: colapsar 18 fatias → ~11.**

---

## 1. Sumário executivo (o que a auditoria PROVOU)

Três achados reorientam o plano:

1. **O braço FINANCEIRO NÃO é a maior lacuna (§30 do PRD está desatualizado para ESTE repo).** É, na
   verdade, o mais consolidado: receita (`PnlReconciliationService`, fact, all-channels), custo/despesa
   (`PnlCostReconciliationService` + `payables`/`cost_centers`, fact), margem (`ManagerialDreService` +
   `ConsolidatedResultService`, estimate), **caixa REAL** (`FinancialLedgerService.cashOnHand`, fact) +
   projeção (`CashForecastService`), inadimplência vencida (`FinancialLedgerService.overdueReceivables`,
   fact), break-even (`ResultProjectionService`, ADR-188). E **já existe `FinanceSnapshotAdapter` que
   monta o bloco financeiro com `basis` (fact/estimate) e `scope`** — exatamente o formato do §8. → **F9
   encolhe de "consolidar o financeiro" para "expor `default_rate` como métrica + compor o que existe".**

2. **A priorização executiva já existe pronta.** `ImpactPrioritizationService.prioritize` devolve **≤3
   prioridades globais + ≤3 por domínio**, com score determinístico (impact·0.40 + urgency·0.20 +
   confidence·0.15 + strategic·0.15 + actionability·0.10) e classificação **L0–L4** (`levelFor`), boosts
   de goal-relevance e SLA/irreversibilidade. → **F7 (Executive Priority) e F21/Executive Constraint são
   projeção deste serviço, não motor novo. Mesclar F6+F7.**

3. **O padrão de composição executiva role-gated já existe** no `FalaTuHomeService` (compõe
   attention/decisões/riscos/processos/metas/missões, com dinheiro/metas gated por
   `ContextProjectionService.hasFullBusinessVisibility`). O CEO Layer **imita esse padrão** + acrescenta
   a única coisa que falta: o **estado por PILAR** (comercial/operações/financeiro).

**Conclusão:** o novo de verdade é (a) a noção de PILAR (comercial/ops/finanças) sobre os domínios do
snapshot; (b) `basis`/`availability` no registro de métricas; (c) o objeto de VISÃO estratégica; (d) 3–4
métricas com fonte real que hoje faltam (`new_customers`, `default_rate`, `cancellation/churn rate`,
`sla_compliance`). Todo o resto **compõe** serviços existentes.

---

## 2. Matriz requisito → prior art → ação

| # | Requisito do PRD | Já existe? | Serviço/arquivo existente | Ação |
|---|---|---|---|---|
| §7/§9 | Executive Metric Registry (métricas + pillar/basis/availability) | **Parcial** | `BusinessGoalService.METRICS` (label/unit/derive; **sem** pillar/basis/availability) | **Estender** o registro (não criar) |
| §8 | Indicador com `{value,basis,source,measuredAt,confidence,status}` | **Parcial** | `business_signals` tem basis/confidence/impact; `FinanceSnapshotAdapter` já rotula basis/scope; snapshot V2 por domínio | Estender registro + compor |
| §11 | Expandir Business Goals (novos KPIs) | **Sim (mecanismo)** | `BusinessGoalService.set/progress/currentValue`; registro schema-free | Adicionar entradas de métrica |
| §12/§56 | Business Vision (visão estratégica) | **Não** | `business_manifesto` é MARCA (Why/How/What), não estratégia; `business_goals` = intenção por métrica | **Criar** persistência mínima |
| §13 | Strategic Pillars (commercial/operations/finance) | **Não (esses)** | Radar tem 7 pilares OUTROS (estrategia/receita/processos/dados/pessoas/governanca/metricas), e é diagnóstico pontual | **Criar** mapa domínio→pilar |
| §14 | Executive Business Snapshot (composição read-only) | **Base pronta** | `BusinessSnapshotV2Service.read` (por domínio, cacheado via `EvidencePackageService`) | **Compor** (serviço fino novo) |
| §15/§16 | Estado executivo + status por pilar (determinístico) | **Base pronta** | `BusinessHealthService.overview` (priorities), severidade em signals | Compor + regra por pilar |
| §17/§18 | Executive Exception (sem alerta paralelo) | **Sim** | `BusinessSignalService.attention` (percepção transversal) | **Projetar** (§18: um problema só existe uma vez) |
| §19 | Diagnóstico fato≠hipótese | **Sim** | `business_signals.basis` (fact/estimate/hypothesis) + `evidence_json`/`premises_json`; `DecisionEngine` | Compor |
| §20/§21 | Priority Engine (≤3) + Primary Constraint | **Sim** | `ImpactPrioritizationService.prioritize` (≤3 global + ≤3/domínio, score, L0–L4) | **Reusar**; constraint = top-1 derivado |
| §22/§24 | Mission Bridge + "o que faço agora?" | **Sim** | `MissionService`/`MissionProactiveService`/`MissionNextStepService`/`MissionReversePlanner` (ADR-189, F0–F29) | **Reusar** (nada de `ceo_missions`) |
| §23 | Reverse Planning | **Sim** | `MissionReversePlanner` (cadeias revenue + appointments; honesto sem premissa) | Reusar |
| §25/§26 | Governança + Outcome Assurance | **Sim** | `DecisionAction→ApprovalPolicy→CommandExecutor→Confirmation`; `OutcomeAssuranceService` | Reusar (nunca furar) |
| §27 | Executive Accountability (7 indicadores) | **Parcial** | `AnalyticsService.getMetrics` (vendas/receita/ticket/CSAT/leads); `FinanceSnapshotAdapter` (caixa/custo/margem/vencido); `SatisfactionService` (CSAT) | **Compor** + availability |
| §30–§34 | Financial Executive Projection | **Quase pronto** | ADR-125/128/182/184/185/186/188 + `FinanceSnapshotAdapter` | **Compor**; +`default_rate` métrica |
| §35 | Satisfação (CSAT/NPS/reclamações) | **Parcial** | CSAT: `SatisfactionService`/`AnalyticsService.csat`; reputação: **ADR-162 completo**; **NPS real ausente** | Compor CSAT+reputação; NPS = `unknown` |
| §36 | Cancelamento/Churn | **Parcial** | `appointments.status='cancelled'` (clínica), `orders` cancelado, `SubscriptionService`; `ChurnRiskDetectorService` (risco por cliente) | Derivar taxa (fonte por vertical) |
| §37 | new_customers | **Não** | proxy `newLeadsCount` (é lead, não cliente) | **Criar** derive (system-of-record clientes) |
| §38 | key_person_dependency | **Não (pessoa)** | só `BusinessHealthService.customerConcentration` (cliente) | **Criar** detector shadow — **DEFERÍVEL** |
| §39/§40 | Executive Briefing | **Base pronta** | composição do snapshot | **Criar** formatador determinístico |
| §41/§42 | Fala Tu executive intents | **Parcial** | intents de negócio roteados por `AIOrchestratorService`/`ExecutiveAdvisorService`/`ContextEngineService.render` (não pelo enum de `FalaTuService`) | Adicionar intent + consumir snapshot |
| §44 | Evidência rastreável | **Sim** | `EvidencePackageService` + `evidence_json` | Compor `evidenceRefs` |
| §45 | Confiança (high/medium/low) | **Sim** | `confidence` em signals/decision/evidence | Reusar |
| §46–§49 | UX Hoje (bloco por exceção) | **Sim (padrão)** | `FalaTuHomeService` (attention/goals/missions role-gated) | **Estender** (bloco pilar) |
| §50 | Role gating / dinheiro | **Sim** | `ContextProjectionService.hasFullBusinessVisibility`/`canSeeDomain`/redação | Reusar |
| §57 | Cache do snapshot | **Sim** | `EvidencePackageService` (TTL 12h, freshness, generatedAt) | Reusar |
| §59 | Observabilidade | **Parcial** | padrão de métricas por query (RN-004) | Adicionar contadores |
| §63 | Complexity Budget | — | — | Ver §5 abaixo |

---

## 3. Prior art canônico (o que reusar, por peça)

- **Estado da empresa (dados):** `BusinessSnapshotV2Service.read` → domínios `finance/sales/inventory/procurement/retail_ops/tasks`, cacheado por `EvidencePackageService`. Falha isolada por adapter.
- **Contrato único de contexto:** `ContextEngineService.build/render/buildForUser` (fachada ADR-160 D3).
- **Metas + distância:** `BusinessGoalService.progress` (current/remaining/attainmentPct/paceStatus reached|on_track|behind).
- **Percepção transversal (exceções):** `BusinessSignalService.attention` — funde signals abertos + decision_risks, por severidade/domínio. **É o "Exception Engine" — não criar outro (§17/§18).**
- **Priorização (≤3) + níveis:** `ImpactPrioritizationService.prioritize`/`levelFor`. **É o "Priority Engine" e o "Constraint" (§20/§21).**
- **Fusão ação-priorizada:** `SmartInboxService.build` (needsApproval/needsDecision/risk/opportunity/inExecution/resolved).
- **Composição role-gated de referência:** `FalaTuHomeService.home` (o molde do CEO Layer).
- **Role gating / dinheiro:** `ContextProjectionService` (fail-closed, redação custo/margem/salário).
- **Financeiro:** `FinanceSnapshotAdapter` (bloco pronto com basis/scope) sobre `FinancialLedgerService` (caixa fact, vencido fact), `ManagerialDreService`/`ConsolidatedResultService` (margem estimate), `PnlReconciliationService`/`PnlCostReconciliationService` (receita/custo fact), `ResultProjectionService` (break-even).
- **Comercial/ops:** `AnalyticsService.getMetrics` (vendas/receita/ticket/leads/funil/perdas/CSAT/canal), `TicketSlaService` (SLA por ticket), `ChurnRiskDetectorService` (risco por cliente), ADR-162 reputação (completo).
- **Execução governada + garantia + aprendizado:** `DecisionActionService`→`ApprovalPolicyService`→`CommandExecutorService`→`ConfirmationEngine`→`OutcomeAssuranceService`→`PatternMemoryService`.
- **Missão:** `MissionService`/`MissionReversePlanner`/`MissionReadinessService`/`MissionNextStepService`/`MissionProactiveService` (ADR-189, fechado F0–F29 nesta linha de trabalho).

---

## 4. Ponderações & decisões arquiteturais propostas

- **D1 — Snapshot executivo é serviço FINO de composição, não novo system-of-record (§14).** Novo
  `ExecutiveBusinessSnapshotService` (read-only) que **mapeia** os domínios do V2 → 3 pilares e agrega
  metas/exceções/prioridades/missões. **Não** tocar a estrutura por domínio do V2 (não regredir). Cachear
  via `EvidencePackageService` (§57), nunca persistir o derivado.
- **D2 — PILAR é um mapa, não um motor.** `domain→pillar`: `sales`→commercial; `finance`→finance;
  `retail_ops`/`tasks`/`procurement`/`inventory` + SLA/cancelamentos/CSAT→operations. Determinístico.
- **D3 — Métricas estendem `BusinessGoalService.METRICS` (§9/§62).** Acrescentar aos itens do registro
  os campos `pillar`, `basis`, `availability()`, `source`, `betterDirection` — mantendo `derive`. **Não**
  criar `ExecutiveMetricRegistry` paralelo (a auditoria confirma que estender preserva a arquitetura).
- **D4 — Exceção e prioridade REUSAM signals + ImpactPrioritization (§17/§20).** O CEO Layer só
  **projeta** para a moldura executiva (pilar + linguagem). Zero tabela de alerta nova (§18/RN-CEO-12).
- **D5 — Financeiro é composição (§30 revisado).** `ExecutiveFinancialProjectionService` (se necessário)
  é um wrapper fino sobre `FinanceSnapshotAdapter` + `default_rate` novo. Provável que nem precise de
  serviço próprio — o adapter já entrega quase tudo.
- **D6 — Visão é a ÚNICA persistência nova candidata (§56).** Avaliar `organization_settings` (3 colunas
  aditivas: `vision_statement`/`vision_horizon`/`strategic_priority`) vs. tabela `business_strategy`.
  **Recomendação: 3 colunas em `organization_settings`** (padrão de flag/coluna aditiva já dominante;
  evita tabela nova — Complexity Budget). Nunca persistir snapshot derivado.
- **D7 — Fala Tu: a intent de negócio já é roteada pelo `AIOrchestratorService`/`ExecutiveAdvisorService`.**
  O trabalho é fazer essa resposta **consumir o `ExecutiveBusinessSnapshot` determinístico** (§42/§43) em
  vez de reconstruir a empresa no prompt. A IA só narra; o fato é do snapshot.
- **D8 — `null`/`unknown` de verdade (§8/§10/§31).** Sem fonte → `availability:'unavailable'` + mensagem;
  nunca 0. NPS real é `unknown` (só existe CSAT). `default_rate` sem base → `unknown`.
- **D9 — Key-person dependency (§38) é a peça mais nova e menos crítica → DEFERIR** para o fim (shadow),
  ou tratar como fatia opcional. Não bloqueia o North Star (§4).

---

## 5. Complexity Budget (§63) — projeção

| Item | Orçado (§63) | Projeção desta análise |
|---|---|---|
| Superfície no Fala Tu/Hoje | +1 | +1 (bloco pilar) ✅ |
| Tabela nova | 0 ou 1 | **0** (visão = 3 colunas em `organization_settings`) ✅ |
| Executor | 0 | 0 (reusa CommandExecutor) ✅ |
| Scheduler | 0 se pass servir | 0 (reusa passes existentes) ✅ |
| Motor de decisão/alerta/missão/learning | 0 | 0 (reusa DecisionEngine/signals/Mission/PatternMemory) ✅ |
| Flag | opcional | +1 `executive_operating_layer_enabled` (default OFF) |

Cabe no orçamento. O maior risco de estouro é **inventar** um `ExecutiveMetricRegistry`/snapshot/priority
paralelos — que esta análise recomenda explicitamente **não** fazer.

---

## 6. Guardrails RN-CEO-01..15 → como o codebase já os sustenta

- RN-CEO-01 (composição, não motor) → D1/D4/D5. RN-CEO-02 (null≠zero) → D8/RN-004. RN-CEO-03 (fato≠hipótese)
  → `business_signals.basis`. RN-CEO-04 (IA não calcula KPI) → snapshot determinístico (§43). RN-CEO-05
  (executado≠resultado) → `OutcomeAssuranceService`. RN-CEO-06/07 (sugerir≠criar) → `BusinessGoalService.set`
  e `MissionService.create` exigem ação humana; proativo nasce shadow. RN-CEO-08 (governança) →
  DecisionAction→ApprovalPolicy. RN-CEO-09 (isolamento) → `orgId` 1º arg. RN-CEO-10 (dinheiro role-gated) →
  `ContextProjectionService`. RN-CEO-11 (sem fonte→unknown) → D8. RN-CEO-12/13/14/15 (sem sinal/executor/
  mission/learning paralelo) → reuso de `business_signals`/CommandExecutor/Mission/PatternMemory.

Todos os 15 já têm sustentação arquitetural — o hardening (F17) os codifica como regressão, no molde do
`test:mission-hardening`.

---

## 7. Plano de fatias REVISADO (18 → 11)

> Regra: cada fatia = 1 PR draft → testes/tsc/build verdes → merge. F0 (esta) é doc-only.

| Fatia | Escopo | Origem no PRD | Natureza |
|---|---|---|---|
| **F0** | Esta análise | §64 | doc (FEITO) |
| **F1** | Estender `BusinessGoalService.METRICS`: `pillar`/`basis`/`availability`/`source`/`betterDirection` + mapa domínio→pilar; testes | §9/§13/§65 | extensão |
| **F2** | Métricas novas com fonte real + availability honesta: `new_customers`, `default_rate`, `cancellation_rate`, `sla_compliance` (unknown onde não houver fonte); compõe Analytics/Finance/SLA | §11/§37/§36 | composição+derive |
| **F3** | Business Vision: 3 colunas em `organization_settings` + `GET/PUT /api/executive/vision` (RBAC) | §12/§56/§67 | persistência mínima |
| **F4** | `ExecutiveBusinessSnapshotService` (composição read-only): overall + 3 pilares + indicators + goals + exceptions(attention) + priorities(ImpactPrioritization) + missions + vision; `GET /api/executive/snapshot`; cache via EvidencePackage | §14–§21/§27/§68/§69 | **primitiva nova (fina)** |
| **F5** | Executive Exceptions + Primary Constraint = projeção de `BusinessSignalService.attention` + `ImpactPrioritizationService` (mescla F6+F7 do PRD) | §17–§21/§70/§71 | composição |
| **F6** | Mission Bridge: goal+gap+constraint → sugestão de missão via `MissionProactiveService`/`MissionNextStepService` (governado, nunca cria direto) | §22–§24/§72 | composição |
| **F7** | Financeiro executivo: expor o `FinanceSnapshotAdapter` no snapshot + `default_rate`; `unknown` honesto (F9 do PRD, muito reduzida) | §30–§34/§73 | composição |
| **F8** | Executive Briefing determinístico (`GET /api/executive/briefing`) + versão narrada opcional (LLM narra, não calcula) | §39/§40/§74 | composição+formatador |
| **F9** | Fala Tu executive intents ("como está minha empresa?", "qual minha prioridade?", "o que faço agora?") consumindo o snapshot; + bloco "Sua empresa hoje" no `FalaTuHomeService`/Hoje (mescla F11+F12) | §41/§42/§46–§49/§75/§76 | extensão UI+intent |
| **F10** | Golden path end-to-end (visão→goal→snapshot→constraint→missão→plano→next step→decisão→execução→outcome→snapshot atualizado) | §80 | teste |
| **F11** | Hardening (`test:executive-layer-hardening`, RN-CEO-01..15) + runbook `docs/runbook/executive-operating-layer.md` + flag `executive_operating_layer_enabled` | §81/§82/§83 | teste+doc |

**Diferidas/opcionais (fora do caminho crítico do North Star §4):**
- **Key-person dependency (§38/F14)** — detector shadow novo; deferir para depois do GA ou fatia opcional.
- **Proactive Executive Briefing (§79/F15)** — reusa `FalaTuProactiveService` + Scheduler; opcional, entra depois se o briefing matinal for prioridade.
- **Evidence/Explainability dedicada (§77/F13)** — já coberta por `EvidencePackageService` + `evidence_json` no snapshot (F4); só vira fatia própria se a UI de "por quê?" exigir.

### Por que o corte de 18→11
- F6+F7 do PRD → **F5** (exceção e prioridade são o mesmo serviço: `ImpactPrioritization`).
- F9 do PRD (financeiro) → **F7**, drasticamente reduzida (o financeiro já existe).
- F11+F12 do PRD → **F9** (intent + bloco Hoje andam juntos e consomem o mesmo snapshot).
- F13 (evidência) absorvida pela F4 (EvidencePackage já entrega).
- F14/F15 → diferidas (não bloqueiam o North Star).

---

## 8. Riscos & questões abertas (para você fechar antes da F1)

1. **`new_customers` e `default_rate` — qual system-of-record por vertical?** `new_customers` = 1ª compra
   em `orders`? 1º ticket fechado? cadastro em `contacts`? `default_rate` = vencido/total a receber
   (como o `SurvivalIndexService` já faz inline)? Precisa da sua definição para não inventar semântica.
2. **Cancelamento como churn (§36):** cada vertical aponta o que é "abandono de cliente" — clínica
   (cancelamento de consulta ≠ churn), varejo, assinatura. Sugiro começar honesto: expor
   `cancellations` por tipo e deixar `churn_rate` como `unknown` até definirmos a regra por vertical.
3. **Visão: `organization_settings` (3 colunas) vs. tabela `business_strategy`?** Recomendo colunas
   (Complexity Budget), mas se você prevê versionamento da visão, a tabela se justifica.
4. **NPS real:** confirmamos que só existe CSAT. Manter NPS `unknown` no MVP (não fabricar 0–10)?
5. **Escopo do primeiro piloto (§83):** qual vertical? (a clínica/petshop, que já exercitou o Mission OS,
   é a candidata natural, pois o braço de agenda já está provado.)

---

## 9. Recomendação de execução

Seguindo sua orientação (§89 e sua nota final): **entrego esta F0 e paro.** Você cruza com o PRD, decide
as 5 questões abertas do §8, e então fechamos a versão executável (provavelmente as 11 fatias acima, com
as diferidas confirmadas). A arquitetura existente prevalece sobre o PRD onde já há solução equivalente —
e a auditoria mostrou que isso acontece na maioria das fatias. O objetivo, como o PRD diz, é **preencher
lacunas, não inflar o ZapFlow** — e as lacunas reais são poucas e bem localizadas.
