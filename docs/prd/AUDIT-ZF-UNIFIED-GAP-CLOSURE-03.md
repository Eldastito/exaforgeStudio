# AUDIT-ZF-UNIFIED-GAP-CLOSURE-03 — Gate F0

**PRD auditado:** PRD-ZF-UNIFIED-GAP-CLOSURE-03 (Convergência Arquitetural, Recuperação Financeira e Inteligência Comercial Governada)
**Repositório:** `Eldastito/exaforgeStudio`
**Baseline real auditado:** `main` refletido em `da471052c443d37f21ad4446de6a2fefb83a2840`
**Baseline citado no PRD:** `0539924c…` (desatualizado — ver §1)
**Tipo desta fatia:** doc-only (zero código, zero migration, zero teste). Espelha o precedente `docs/product-evolution/SESSION-PAUSA-2026-08-29-DUP-AUDIT.md`.
**Autor:** auditoria automatizada + revisão humana pendente.

> **Regra do PRD (§7):** nenhuma fatia F1+ começa antes deste Gate F0 ser revisado e aprovado. Este documento é o gate.

---

## 0. TL;DR para decisão

Três correções de rota antes de qualquer código:

1. **A F0 já estava ~70% feita.** A auditoria DUP-001..007 (`docs/product-evolution/SESSION-PAUSA-2026-08-29-DUP-AUDIT.md`) + `INITIAL-GAP-MATRIX.md` + os `ANALISE-PRDx-vs-CODEBASE.md` já cobrem Requirement×Code Matrix e Ownership Matrix. Este doc **atualiza** aquele estado para o main atual, não recomeça do zero.
2. **O baseline do PRD está velho.** Entre `0539924c` (citado) e `da471052` (real) o Visual Kernel (DUP-004) **fechou** — `src/server/VisualGenerationKernel.ts` existe. O PRD já marca "ALREADY_DONE"; a auditoria de agosto ainda dizia "NÃO EXISTE".
3. **O sequenciamento do PRD é o inverso do risco/custo real.** F3 (Financial Recovery) é ~75% composição de infra que já existe (ADR-125 Motor de Caixa + Mission OS + DecisionEngine). F5/F6 (Sales Coach / Vendedor IA) são o greenfield caro (zero código) e o maior risco de governança — mas o PRD os joga pro fim.

---

## 1. Baseline técnico (F0.1)

| Item | Valor |
| --- | --- |
| Repo | `Eldastito/exaforgeStudio` |
| Baseline SHA (real) | `da471052c443d37f21ad4446de6a2fefb83a2840` |
| Baseline SHA (PRD) | `0539924c…` (desatualizado; Visual Kernel fechou depois) |
| Stack | React + Node/Express (monólito) + SQLite (`better-sqlite3`) |
| Services em `src/server/*.ts` | 649 |
| Tabelas `CREATE TABLE` em `db.ts` | 441 |
| Suítes `scripts/test-*.ts` | ~816 (CI em 16 shards; `scripts/ci-shard.mjs`) |
| Gate de build | `Build + typecheck` + `npm run lint` == 0 (ADR-138) |

**Build/typecheck/tests:** a autoridade de baseline é a CI matrix em `main` (16 shards). Este doc não roda a suíte completa localmente (≈816 suítes); qualquer fatia de código subsequente valida na CI antes do merge, conforme o fluxo padrão da casa.

**Nota de escopo do PRD:** BASE-01..BASE-11 (§5) confirmados como existentes e **fora do denominador de progresso** (ver §5 deste doc).

---

## 2. Requirement × Code Matrix (F0.2)

Estados: `REUSE` · `EXTEND` · `COMPOSE` · `MIGRATE` · `CREATE` · `ALREADY_DONE` · `DEFER` · `EXTERNAL`.

### F1 — Convergência arquitetural

| Requisito | Estado atual | Owner existente | Decisão | Evidência | Próximo passo |
| --- | --- | --- | --- | --- | --- |
| F1.1 Choke-point efeito externo | Executor sólido, mas 5 services com dual-path; flags `*_via_executor_enabled` **DEFAULT 0** (default = bypass). Bypass extra pelo Edge. | `CommandExecutorService` | **EXTEND** | `CommandExecutorService.ts:188/320/348`; dual-path em `CollectionCadenceService.ts:226`, `CollectionPromiseService.ts:267`, `CollectionResendPixService.ts:88`, `SalesRecoveryPlaybook.ts:344`, `ProspectExecutionService.ts:69/94`; flags `db.ts:8484/8492/8498`; bypass Edge `edgeCommandHandlers.ts:29/59` | Migrar orgs → default 1 → remover branch → ESLint `no-restricted-imports` + **incluir Edge SEND_MESSAGE no escopo** |
| F1.2 Scheduling Kernel | 4 impls de conflito independentes; `ClinicAgendaService` é hub de fato; `ComigoAgendaService` duplica. | (a definir) `ClinicAgendaService` | **EXTEND** (mas **desacoplar deste PRD** — dívida técnica sem relação com recuperação) | `ClinicAgendaService.findConflicts:190`; `ComigoAgendaService.findConflicts:98`; `ProfessionalAvailabilityService.ts:93`; `ReservationService.ts:57` | Extrair fachada; tratar em ciclo próprio |
| F1.3 SignalReactionPolicy | Não existe; consumidores independentes. | (novo) | **CREATE** (baixa prioridade; **irrelevante pro F3**) | `SignalProcessRouterService.ts:54/107`; `MissionProactiveService.ts:25/62`; ausente em grep | Seed→shadow→enforce, fora do caminho crítico |
| F1.4 Financial Event Identity | Detecção existe (avisa), resolução não. | (novo) `PnlReconciliationService` detecta | **CREATE** — **pré-requisito de verdade financeira**; **≠ Debt Map (F3.3)** | `PnlReconciliationService.ts` emite `pnl_reconciliation/overlap_risk`; sem `FinancialEventIdentity` (grep zero) | Chaves `(org,source,external_id)` + fallback; resolver determinístico |
| F1.5 Entitlement fallback | `FALLBACK_HIDDEN_BY_VERTICAL` coexiste com blueprint. | `EntitlementService` | **MIGRATE** | `EntitlementService.ts:85-146` (`resolveHiddenForOrg` cai no fallback) | Contar orgs sem blueprint → backfill → remover fallback |

### F2 — Verdade financeira

| Requisito | Estado atual | Owner | Decisão | Evidência | Próximo passo |
| --- | --- | --- | --- | --- | --- |
| F2.1 Retail→DRE | **Existe UM DRE**; receita varejo **já entra** via `ReportsService.retailPhysicalFlow`. Bridge alimenta **caixa**, não DRE. | `ManagerialDreService` | **ALREADY_DONE** (verificar dupla contagem) | `ManagerialDreService.monthly:134` (retail em :50-73); `RetailRevenueBridgeService` → `FinancialLedgerService.syncFromSales:212`; `ConsolidatedResultService.publishDoubleCountSignal:100` | Verificar dupla contagem por loja; **não recriar PR #1447** |
| F2.2 Alterdata | Integração real, gated por readiness/homologação/LGPD. | `AlterdataConnectorService` + readiness | **EXTERNAL** | `AlterdataReadinessService.compute:103`; blockers Guardian/token/prod-validated/LGPD `:113-198` | Só verificar prontidão; blockers são de Toulon/Alterdata |
| F2.3 Financial Source Map | Fontes existem e são compostas. | `FinanceSnapshotAdapter` | **ALREADY_DONE** (documentar) | `FinanceSnapshotAdapter.build:22`; `ConnectedFinancialsService.assemble:65` | Documentar o mapa como doc de referência |
| F2.4 Qualidade do dado | `source/basis/confidence`, null≠0 pervasivo. | `FinanceSnapshotAdapter` | **ALREADY_DONE** | `FinanceSnapshotAdapter.ts:38-99`; `cash_events.confidence`; `receivables.probability` | — |

### F3 — Financial Recovery OS

| Requisito | Estado atual | Owner | Decisão | Evidência | Próximo passo |
| --- | --- | --- | --- | --- | --- |
| F3.1 Entry point (Fala Tu/CEO) | Superfícies existem; **wiring falta**. | `ExecutiveMissionBridgeService`, `FalaTuAskService` | **COMPOSE** (+ wiring) | `/api/executive/mission-suggestions` existe (`routes/executive.ts:90`) mas não renderizado em `ExecutiveView.tsx`; `FalaTuAskService.classify:150` **não roteia** pra `MissionIntentService` | Renderizar sugestões + rota NL→intent |
| F3.2 RecoveryAssessment | Dados existem (caixa/runway/AR/AP/margem). | `FinanceSnapshotAdapter`, `ExecutiveFinanceService` | **COMPOSE** | `ExecutiveFinanceService.read:65` (survivalDays, firstRupture, defaultRatePct) | Read-model que agrega o existente |
| F3.3 Debt Map | **Não há tabela de dívida/obrigação externa.** | (novo) | **CREATE** (gap legítimo) | grep zero p/ debt/loan/liability; `payables` = contas a pagar; balanço PASSIVO = payables only (`ManagerialBalanceSheetService.ts:43`) | Tabela de obrigações (juros/amortização/risco jurídico/negociabilidade) |
| F3.4 Cash 13 semanas | **Existe.** | `CashForecastService` | **ALREADY_DONE / EXTEND** | `cash_forecast_weeks` (`db.ts:6488`); 3 cenários, `firstRisk`, `survivalDays`, confiança (`CashForecastService.forecast:123`); ADR-125 | Estender horizonte/cenários de recuperação se preciso |
| F3.5 Survival Budget | Classificação A/B/C/D não existe. | `payables`/`cost_centers` | **EXTEND** | `cost_centers` (`db.ts:2253`); `expensesByCostCenter` (`FinancialLedgerService.ts:124`) | Camada de classificação (sugere, humano confirma) |
| F3.6 IRF 0-100 | **Índice de sobrevivência 0-100 já existe.** | `survival_index_snapshots` / `SurvivalIndexService` | **EXTEND (não CREATE)** — senão vira índice paralelo | `survival_index_snapshots` (score/faixa/confidence/components, `db.ts:6533`) | Estender componentes; **não criar 2º índice** |
| F3.7 Crise operacional×financeira | Não classifica. | `ConnectedFinancialsService` ("lucrou mas sem caixa") | **EXTEND** | `ConnectedFinancialsService` publica `financials/lucro_sem_caixa` | Regra determinística de classificação |
| F3.8 Debt Priority Matrix | Não existe (depende de F3.3). | (novo, sobre Debt Map) | **CREATE** (lógica) | — | 4 dimensões + score explicável; nunca substitui profissional |
| F3.9 Scenario Engine | Ações de caixa existem embrionárias. | `cash_actions`, `DecisionSimulatorService` | **EXTEND/COMPOSE** | `cash_actions` (kinds cobrar/postergar/reduzir/campanha, `db.ts:6502`); `DecisionSimulatorService.scenarios` | Simulador determinístico; fato×hipótese já é DNA |
| F3.10 "Quanto prometer?" | Não existe. | `CashForecastService` | **COMPOSE** | forecast 13s | Testar acordo contra projeção |
| F3.11 Negotiation Assistant | Não existe. | (novo, compõe forecast) | **CREATE** (lógica) | — | Propostas baseadas em capacidade de caixa; IA não aceita/assina |
| F3.12 Cash Generation Plan | Peças existem (Collection/SalesRecovery/Prospect/Pricing). | vários | **COMPOSE** | `SalesRecoveryPlaybook`, `ProspectService`, `QuoteService`, RIE | Consolidar potencial×aprovado×executado×realizado |
| F3.13 Recovery Plan | Não existe (consolidação). | (novo read-model) | **COMPOSE** | — | Plano consolidado sobre os acima |
| F3.14 Mission integration | **Padrão sugerir-nunca-criar existe.** | `ExecutiveMissionBridgeService`, `MissionService` | **COMPOSE** | `ExecutiveMissionBridgeService.suggest:60`; `MissionService.create:152` (source system_proposed) | Shape "recuperação financeira" |
| F3.15 Checkpoints/replan | **Existe.** | `MissionCheckpointService` | **ALREADY_DONE** | `checkpoint:46` (planejado×realizado×tempo), `proposeReplan:123` | Reusar |
| F3.16 Recovery trend | Snapshot histórico existe. | `survival_index_snapshots` | **EXTEND** | UNIQUE(org,period) permite tendência | Mostrar evolução + componentes |
| F3.17 Professional escalation | Não existe. | (novo, gatilhos) | **CREATE** (regras) | `LaborLawAdvisorService`/`LegalAdvisorView` adjacentes | Gatilhos → `professional_review_required` |
| F3.18 Tax regularization | Não existe. | infra research externa (ADR-156) | **DEFER** | — | PR separado, pós-research externo aprovado |
| F3.19 Recovery Data Room | Infra de doc/OCR existe. | Document/OCR | **COMPOSE** | `invoice_scan_drafts` etc. | Empacotar; não criar storage paralelo |

### F4–F8

| Requisito | Estado atual | Owner | Decisão | Evidência |
| --- | --- | --- | --- | --- |
| F4 Prospect 2.0 | Forte (ICP/discovery/scoring/A-B/learning). Furos: provenance não plugada, entity-resolution só dedupe, sem vertical packs. | `ProspectService`/`ProspectResearchService`/`ProspectDiscoveryService` | **EXTEND** | `twoProportionZ:135`; `computeScore:300`; provenance vive em `ExternalResearchProvider.ts:62` **não** ligada ao Prospect; merge ausente |
| F5 Sales Coach | **Zero código.** SalesRecovery ≠ coaching (fala com cliente, não com vendedor). | (novo) + SkillOS | **CREATE (greenfield)** | grep `coach/roleplay/adherence` zero; `SalesRecoveryPlaybook` é win-back |
| F6 Vendedor IA | **Zero fluxo.** Scaffolding existe (governança suggest→approval, shadow, QuoteService). | (novo) compõe `AiGovernanceService`/`QuoteService` | **COMPOSE + CREATE** | `AiGovernanceService.guardApplied:61`; `QuoteService.buildAndSave:69`; modos shadow `GrowthAutopilotService.ts:26` |
| F7 Independência operacional | Key Person fino (2 dims). Owner bandwidth/delegability não existe. | `KeyPersonDependencyService`, Mission OS, CEO Layer | **EXTEND** | `KeyPersonDependencyService.assess:66` (só revenue+appointments); comentário morto `SurvivalIndexService.ts:105` |
| F8 Hardening/golden paths/runbooks/PEL | Product Evolution Ledger existe; runbooks são padrão. | `product-evolution` ledger | **COMPOSE** | `docs/product-evolution/*`, seed do ledger |

---

## 3. Capability Ownership Matrix (F0.3)

| Capability | Canonical Owner | Allowed Facades | Forbidden |
| --- | --- | --- | --- |
| Execução externa (whatsapp/pix/email) | `CommandExecutorService` (+ `RuntimeCommandHandlers`) | Domain services via `dispatchGoverned`/`sendGovernedMessage` | Chamar `MessageProviderService`/`AsaasService`/`gmailSend` direto; 2º executor; Edge SEND_MESSAGE fora do choke-point |
| Agenda / conflito | `ClinicAgendaService` (kernel de fato; extrair fachada) | Clinic/Comigo/Beauty/Legal/Professional | 2ª impl de `findConflicts` |
| Sinais | `business_signals` (`BusinessSignalService`) | detectores publicam com `dedupe_key` | tabela de alerta paralela |
| Reação a sinal | `SignalReactionPolicy` (a criar) | Router/Mission consultam a policy | mapas de reação independentes |
| DRE | `ManagerialDreService` (único) | Fiscal/Consolidated read-only | 2º DRE |
| Fluxo de caixa / 13 semanas | `CashForecastService` (ADR-125) | Recovery compõe | 2º motor de projeção |
| Índice de saúde/sobrevivência (IRF) | `SurvivalIndexService` / `survival_index_snapshots` | Recovery estende componentes | 2º índice 0-100 |
| Identidade de transação financeira | `FinancialEventIdentity` (a criar) | `PnlReconciliation` resolve | consolidar `ambiguous` automaticamente |
| Cadastro de dívida/obrigação externa | Debt Map (a criar) | Recovery lê | confundir com FinancialEventIdentity |
| Pesquisa externa de nicho | `VerticalIntelligenceService` | brokers read-only | provider paralelo |
| Prospect | `ProspectService` + `ProspectResearchService` | — | 2º Prospect |
| Missões | `MissionService` (+ runtime/checkpoint) | Bridge/Proactive sugerem | 2º Mission Engine; auto-create |
| Capabilities de IA | SkillOS (`SkillOsRegistryService`) | resolver/execution bridge | registry paralelo |
| Visual | `VisualGenerationKernel` | Fashion/Beauty/Studio recipes | novo motor visual |
| Aprendizado | `PatternMemoryService` (motor único) | debrief/assurance alimentam | 2º learning engine |
| Entitlement | `EntitlementService` | Social/rota | 2ª fonte de entitlement |

---

## 4. Revalidação das duplicações (F0.4)

| DUP | Estado em ago/2026 | Estado atual (`da471052`) | Ação |
| --- | --- | --- | --- |
| DUP-001 External Effect | dual-path, flags DEFAULT 0 | **Inalterado** (+ bypass Edge descoberto) | F1.1 |
| DUP-002 Scheduling | Comigo escapou | **Inalterado** | F1.2 (desacoplar) |
| DUP-003 Entitlement | fallback aberto | **Inalterado** | F1.5 |
| DUP-004 Visual | NÃO EXISTIA kernel | **RESOLVIDO** — `VisualGenerationKernel.ts` existe | `ALREADY_DONE` ✅ |
| DUP-005 Signal Reaction | consumidores concorrentes | **Inalterado** | F1.3 (baixa prio) |
| DUP-006 Vertical/Competitive/Social | já era composição | composição correta | só doc |
| DUP-007 Financial Identity | detecta, não resolve | **Inalterado** | F1.4 |

---

## 5. Base confirmada — não reimplementar (F0.5 / §5 do PRD)

Todos confirmados no código; **fora do denominador de progresso**:

- CEO Operating Layer — `ADR-190`, `Executive*Service` ✅
- Mission Operating Layer — `ADR-189`, `MissionService` + runtime/checkpoint ✅
- SkillOS — `SkillOsRegistryService` + companheiros ✅
- Prospect AI — `ADR-079`, `ProspectService` ✅
- VisualGenerationKernel + recipes — `VisualGenerationKernel.ts`, `StudioVisualRecipeService.ts` ✅
- Business Skills Pack — `BusinessSkillsPackService` (Track C fechado) ✅
- Alterdata Go-Live (código) — `Alterdata*Service`; go-live é EXTERNAL ✅
- Key Person Dependency (básico) — `KeyPersonDependencyService` (2 dims) ✅

---

## 6. O que está realmente ausente (gaps legítimos de CREATE)

1. **Debt Map / cadastro de obrigações externas** (banco, tributo, judicial, juros, amortização, negociabilidade). Nenhuma tabela representa dívida hoje.
2. **FinancialEventIdentity** — identidade canônica pra reconciliar a mesma transação (PDV→…→Gateway). Detecção existe; resolução não.
3. **Sales Coach** — análise/feedback/roleplay do vendedor. Greenfield total.
4. **Vendedor IA assistido** — jornada suggest→approval→handoff. Fluxo novo (compõe governança existente).
5. **SignalReactionPolicy** — contrato central signal_type→reaction_type.
6. **Owner bandwidth / delegability** (F7) — não existe (só comentário morto).
7. **Lógica de recuperação** que compõe o existente: Debt Priority Matrix, Negotiation Assistant, classificação de crise, Recovery Plan/Data Room, escalonamento profissional.

Tudo o mais que o PRD lista como "novo" no F2/F3 já existe e é **composição/extensão** (§2).

---

## 7. Plano de PRs recomendado (contra a ordem do PRD)

Princípio: **valor barato e reuso-pesado primeiro; greenfield caro por último; desacoplar dívida técnica não-relacionada.**

**Onda 1 — Fundação da verdade financeira (pré-requisito pontual, não gate universal)**
- PR-1 (este) — **Gate F0** (doc-only). ✅
- PR-2 — **F1.1 choke-point**: migração das flags → default 1 → remover dual-path → ESLint guard → **incluir Edge SEND_MESSAGE**.
- PR-3 — **F1.4 FinancialEventIdentity** + `PnlReconciliation` resolve determinístico.
- PR-4 — **F2.1/F2.3 verificação**: confirmar dupla contagem retail→DRE + documentar Financial Source Map (verificação, não construção).

**Onda 2 — Financial Recovery como composição (entregável-bandeira)**
- PR-5 — **Debt Map** (tabela nova, aditiva) + RecoveryAssessment read-model (compõe `FinanceSnapshotAdapter`/`ExecutiveFinanceService`).
- PR-6 — **IRF estendendo `survival_index`** (não paralelo) + classificação crise operacional×financeira.
- PR-7 — **Debt Priority Matrix** + Survival Budget (sugere, humano confirma).
- PR-8 — **Scenario Engine** (estende `cash_actions`/`DecisionSimulator`) + "quanto prometer?" + Negotiation Assistant.
- PR-9 — **Recovery Plan** (consolida) + **Mission integration** (`ExecutiveMissionBridge.suggest`) + **wiring do entry point** (F3.1) + reuso do checkpoint/replan.
- PR-10 — **Professional escalation** + Recovery Data Room (compõe doc/OCR).
- PR-11 — **Golden Path GP-01** + hardening + runbook `docs/runbook/financial-recovery-operacao.md`.

**Onda 3 — Dívida técnica de convergência (ciclo próprio, fora do caminho crítico)**
- F1.2 Scheduling Kernel, F1.3 SignalReactionPolicy, F1.5 Entitlement fallback.

**Onda 4 — Inteligência comercial (greenfield caro, maior risco de governança — por último)**
- F4 Prospect 2.0 (extend) → F5 Sales Coach (create) → F6 Vendedor IA (compose+create) → F7 Independência.

**Flags:** `financial_recovery_enabled` (default 0) para toda a Onda 2. Evitar flag explosion (sub-flags só se justificadas).

---

## 8. Pendências que exigem decisão humana antes da Onda 2

1. Confirmar o desacoplamento de F1.2/F1.3/F1.5 deste PRD (Onda 3 separada).
2. Aprovar que **IRF estende `survival_index`** (não cria índice novo) e que **Debt Map ≠ FinancialEventIdentity**.
3. Confirmar que F5/F6 vão por último (maior custo/risco), contra a ordem literal do PRD.
4. Confirmar que F2.1 é verificação de dupla contagem (não recriar PR #1447).

---

## 9. Guardrails herdados (não regredir)

Isolamento multi-tenant · CREATE-then-ALTER · `business_signals` (nunca tabela de alerta paralela) · fato≠hipótese (fact/estimate/hypothesis) · LLM não calcula número financeiro crítico (determinístico primeiro) · IA sugere, humano decide · nunca parecer jurídico · nunca aceitar/assinar/renegociar dívida autonomamente · escalonamento profissional quando ultrapassar planejamento operacional · null≠0 · aprovação humana em ação financeira sensível.

---

## 10. Addendum — reconciliação pós-implementação (F3 fechado; F1.4 reclassificada)

### 10.1 Onda 2 (Financial Recovery OS / F3) — FECHADA

7 PRs em produção (todos aditivos, opt-in por `financial_recovery_enabled`, determinísticos, reversíveis): PR-5 Debt Map + Assessment (`recovery_debt_items`, único CREATE de dados) · PR-6 IRF (ESTENDE `survival_index`) + diagnóstico de crise · PR-7 Debt Priority + Survival Budget · PR-8 Scenario Engine + "quanto prometer?" + Negociação · PR-9 Recovery Plan + sugestão de Missão · PR-10 Escalonamento profissional + Data Room · PR-11 Golden path GP-01 + hardening + runbook (`docs/runbook/financial-recovery-operacao.md`). Confirmado o TL;DR §0: ~75% composição, 1 CREATE de dados.

### 10.2 F1.4 (Financial Event Identity) — RECLASSIFICADA: CREATE → ALREADY_DONE + DEFER

A investigação do código (não da narrativa do PRD) mostrou que a F1.4 **não deve virar motor novo** (violaria a própria regra "sem mecanismo paralelo"):

- **Identidade canônica de caixa JÁ EXISTE (ALREADY_DONE):** `cash_events` tem `UNIQUE(organization_id, source_type, source_id)` (`idx_cash_events_source`, `db.ts`), e `FinancialLedgerService.recordEvent` usa `INSERT OR IGNORE` só creditando o saldo quando o insert acontece — a MESMA origem (PDV/pedido/fechamento/recebível) nunca dobra o caixa. É exatamente a "chave forte `(org,source,external_id)`" que o PRD pediria criar.
- **Overlap pedido↔fechamento é irresolvível por chave (DEFER):** `retail_daily_closings` é AGREGADO diário por loja (sem transação linha-a-linha ligada aos `orders`). Casar uma venda individual a um fechamento por chave é impossível — e forçar criaria ERRO financeiro. O `PnlReconciliationService` já trata isso HONESTAMENTE (sinal advisory `overlap_risk`, `basis:hypothesis`, `impactAmount:null`, nunca dobra em silêncio). Resolver de fato exigiria fechamento linha-a-linha (mudança de modelo de dados), não um motor de match — DEFER.
- **Invariante travada (PR-12):** `test:financial-truth-invariants` codifica como regressão a chave canônica do `cash_events` e o overlap advisório — em vez de construir o motor.

### 10.3 F2.1 (retail→DRE) — verificação

Confirmado (§2): a receita de varejo já entra no DRE (`ManagerialDreService` via `ReportsService.retailPhysicalFlow`) e a detecção de dupla contagem já existe (`PnlReconciliationService.overlapRisk` + `ConsolidatedResultService.publishDoubleCountSignal`). O `test:financial-truth-invariants` também trava o "total = a+b+c, sem dedup silencioso" como invariante. Não recriar o PR #1447.

### 10.4 Pendências de F1 que permanecem ABERTAS (precisam de decisão/rollout próprio)

- **F1.1 choke-point (EXTEND, real):** flags `*_via_executor_enabled` seguem DEFAULT 0 (default = bypass) + bypass do Edge `SEND_MESSAGE`. Fechar vira o default `0→1` do envio real (WhatsApp/PIX/e-mail) em produção → exige OK explícito + rollout faseado (shadow→canary→migrar→default→remover branch→ESLint guard). NÃO fazer sob "segue" genérico.
- **F1.2/F1.3/F1.5** (SchedulingKernel, SignalReactionPolicy, Entitlement fallback): dívida técnica de convergência, desacoplada deste PRD (Onda 3).
