# Análise Comparativa — PRD "ZapFlow Decision Intelligence Fabric 2.0" × Repositório atual

**Data:** 2026-08-08
**Autor:** IA Dev (Fase 0 — análise crítica antes de código)
**PRD-fonte:** "ZapFlow Decision Intelligence Fabric 2.0 — Arquitetura unificada de inteligência, prevenção, decisão, execução e aprendizagem" (proposta consolidada anexada na tarefa).
**Objetivo deste documento:** cruzar cada bloco do PRD com o que **já existe** no `Eldastito/exaforgeStudio`, para **não duplicar função** e decidir o que é genuinamente novo antes de escrever qualquer linha.

> Convenção de status usada aqui (mesma da `docs/execution-runtime/MATRIZ-DE-COBERTURA-DO-PRD.md`):
> `EXISTE` (em produção) · `PARCIAL` (parte existe, resto é aditivo) · `NOVO` (não existe) · `BLOQUEADO` (depende de decisão do dono do produto).

---

## 0. Fontes lidas para esta análise

Serviços/ADRs inspecionados (com `file:line` no corpo): `MaestroService`, `AIOrchestratorService`, `DecisionActionService`, `DecisionSimulatorService`, `ImpactPrioritizationService`, `RuntimePilotService`, `CommandExecutorService`, `ApprovalPolicyService`, `BusinessSignalService` (+ todos os `*SignalPublisher`), `BusinessSnapshotV2Service`/`BusinessSnapshotAdapters`, `BusinessContextService`, `ExecutiveAdvisorService`, `RevenueIntelligenceService`, `SurvivalIndexService`, `BusinessHealthService`, `PatternMemoryService` (+ 7 `*PatternMemory`), `RetailPatternMemoryService`, `CustomerMemoryService`, `geminiRAG`, `FalaTuMemoryEmbeddingsService`, `ProspectDiscoveryService`, `ProspectResearchService`, `AiGovernanceService`, `AiQuotaSignalService`, `AiUsageDashboardService`, `PlanService`, `ConsumptionService`, `JobQueueService`, `Scheduler`, `TaskService`, `OutcomeMeasurementService`, `llm.ts`. ADRs: 053, 070, 073, 074, 079, 125, 126, 127, 128, 130, 132, 133, 134, 135, 136, 142, 152, 153, 154. Doc-suite completa da ADR-152 (`docs/execution-runtime/*`).

---

## 1. Veredito executivo

**O PRD tem razão no diagnóstico e está ~85% já construído.** A tese central do PRD — "não faça 3 módulos; una tudo numa camada de inteligência com Evidence Layer + memória única + tool registry + event bus + tasks reaproveitados; Pre-Mortem/Red Team/Advocate são *estratégias*, não agentes; nada de menus novos" — **é exatamente a filosofia que o repositório já adota** e, em boa parte, **já implementou** sob a ADR-135 (Enterprise Intelligence Kernel) + ADR-136 (Decision & Action Ledger) + ADR-152 (Execution Runtime).

**Descoberta mais importante:** o repositório **já fez este mesmo exercício** para um PRD quase idêntico. A **ADR-152 "ZappFlow Execution Runtime"** tem uma **Fase 0 concluída** com um pacote de 5 documentos (`ANALISE-ARQUITETURAL`, `PLANO-DE-IMPLEMENTACAO`, `STATUS-DE-EXECUCAO`, `DECISOES-E-PENDENCIAS`, `MATRIZ-DE-COBERTURA-DO-PRD`) e uma decisão explícita registrada — **D01/D11: "reusar ADR-136, não duplicar; renomeação em massa NÃO acontece"**. A Fatia 1.1 (Process Fabric: `process_definitions` + `process_instances` + FSM) **já foi entregue**.

**Consequência para esta tarefa:** o maior risco de implementar o "Decision Intelligence Fabric 2.0" **literalmente** é ironicamente o mesmo que o PRD adverte — criar um **segundo esforço paralelo** (ADR-156 concorrente) por cima de um esforço de consolidação (ADR-152) que já está em andamento. Isso seria o "Frankenstein" que o PRD quer evitar, só que no nível de arquitetura de projeto.

---

## 2. Matriz de cobertura — bloco do PRD × código existente

| # | Bloco do PRD | Onde já vive no repo | Veredito |
|---|---|---|---|
| 1 | **Maestro** (orquestrador no topo, roteia por impacto, escolhe profundidade de análise) | `MaestroService` é uma **ponte de tarefas** (handoff/visão→task), **não** um roteador. O roteamento real de mensagens está em `AIOrchestratorService` (intenção/persona, não decisão). `CommandExecutorService` é o "Maestro 2.0" executor governado. | **PARCIAL** — falta o roteador que classifica impacto e escolhe profundidade. |
| 2 | **Impact Classifier L0–L4** | `ImpactPrioritizationService` — score Pareto **determinístico, zero-token** (`impact·0.40 + urgency·0.20 + confidence·0.15 + strategic·0.15 + actionability·0.10`), urgência `critical/risk/attention/info`, `ACTION_MAP` sinal→ação. `process_instances.risk_level` low/med/high. | **PARCIAL** — existe score + urgência; faltam os **5 níveis L0–L4** e o seletor de profundidade que decorre deles. |
| 3 | **Decision Engine** ("cérebro decisório") | Espinha `business_signals → decision_actions → action_approvals → action_outcomes` + `ImpactPrioritizationService` + `ApprovalPolicyService`. | **EXISTE** — é o Decision Engine, sob outro nome (ADR-136 Epic 2 completo). |
| 4 | **Decision Record** (context snapshot, opções, status, resultado esperado) | `decision_actions` (`baseline_json`=snapshot, `expected_impact`+`impact_unit`, `basis`, `confidence`, FSM `proposed→…→done`, `success_condition_json`, `command_type`). | **PARCIAL** — falta o array de **opções/alternativas** e o conjunto de cenários ligado. |
| 5 | **Evidence Layer / Evidence Package** (interno+externo+histórico, `confidence`/`freshness`/`sources`, cacheado, multi-consumidor) | `BusinessSnapshotV2Service`+adapters (JSON estruturado, cada métrica com `source`/`basis`, finance com `confidence`) · `BusinessSignalService` (único lugar com campo `evidence` + `confidence` + `basis`) · `BusinessContextService` (texto, compartilhado) · histórico em `ric_daily_snapshots`, `survival_index_snapshots`, `cash_forecast_weeks`. | **PARCIAL** — o interno estruturado existe; faltam **cache**, **evidência externa**, **`freshness`** e o **bundle único multi-consumidor**. |
| 6 | **Advocate / Red Team / Pre-Mortem** como *estratégias* | Não existe nenhum (grep zero para `premortem`/`red.team`/`advocate`). | **NOVO** — mas deve nascer como **modo** do Decision Engine, não como agente/serviço/tabela (o PRD concorda). |
| 7 | **Scenario Simulator** (conservador/base/agressivo) | `DecisionSimulatorService` faz what-if **de ponto único** (hire/buyStock/withdraw/payback) + verdito calibrado; `RevenueSimulatorService`. | **PARCIAL** — falta a **banda de 3 cenários**. |
| 8 | **Decision Score** | `decision_actions.priority_score` (via `ImpactPrioritizationService`); `salesIntelligence.purchaseProbability` (LLM). | **PARCIAL** — existe score de prioridade; falta o score composto de decisão. |
| 9 | **Decision Gate** (autonomia + consulta RBAC) | `ApprovalPolicyService` (matriz `action_type` + `max_auto_amount` + role RBAC) + `agent_policies.autonomy_level` (`observe|suggest|prepare|execute`) + `execution_mode` (`shadow|assisted|approved_execution|autonomous`, ADR-152 D7) + `AiGovernanceService.guardApplied` (`human_decision_required`). | **EXISTE** — porém o gate é por **tipo de ação/valor/RBAC**, não por nível L0–L4. |
| 10 | **Execute → Monitor → Outcome** (loop fechado) | `decision_actions.complete` → `OutcomeMeasurementService` → `action_outcomes` (expected×realized, `basis`) + Impact Ledger (ADR-125/085) + `tasks.result_*` (ADR-134) + `process_instances` (ADR-152). | **EXISTE.** |
| 11 | **Post-Mortem / prediction accuracy / loss avoided** | `action_outcomes` guarda esperado×realizado; ADR-152 planeja aditivos `cost_avoided`/`loss_prevented`. Não há métrica de **acurácia de previsão** nem painel de **valor protegido**. | **PARCIAL/NOVO** — aditivo sobre `action_outcomes`. |
| 12 | **Unified Memory** (tipada: fact/event/decision/hypothesis/risk/recommendation/outcome/research/lesson/preference) | **Fragmentado** em ≥8 tabelas: `business_patterns` (`PatternMemoryService`+7 domínios), `retail_store_patterns` (progenitor não migrado), `knowledge_chunks` (RAG), `falatu_memory_embeddings` (RAG), `contacts.memory_*`, `prospect_learning_memory`. Sem tipagem unificada. | **PARCIAL** — unificar seria refactor grande e arriscado (ver §5/§6). |
| 13 | **Decision Memory** | Não há silo próprio; vive em `decision_actions`/`action_outcomes`. | **PARCIAL** — não criar silo; é *view* sobre `decision_actions`. |
| 14 | **RAG** | `geminiRAG` (`knowledge_chunks`, JSON) + `FalaTuMemoryEmbeddings` (`falatu_memory_embeddings`, BLOB) — **duas** impls cosine-in-JS, mesmo modelo `text-embedding-3-small` via `llm.embed()`. | **EXISTE** (duplicado; consolidável). |
| 15 | **External Intelligence / Agent-Reach** como `ExternalResearchProvider` + Research Broker | Só `ProspectDiscoveryService` (HTTP público: Nominatim/Overpass/Google Places) + `ProspectResearchService` (A/B interno, **não** é pesquisa externa). **Não há `web_search`.** Template de provider existe (`TryOnProvider`). | **NOVO.** |
| 16 | **Cache de pesquisa por vertical** + dedup `fingerprint(vertical+topic+geo+timeframe)` + freshness | Não existe. Dedup só por conta (`dedupe_key`/`external_ref`), throttle por `discovery_last_run`. **ADR-079 D4 proíbe** compartilhamento cross-tenant sem ADR novo. | **NOVO + BLOQUEADO** (decisão do dono). |
| 17 | **Technical Intelligence / Code Search** (`technical.github`, `code_search`) | Não existe. | **NOVO** — fora da experiência empresarial (o PRD concorda: não é módulo). |
| 18 | **Tool Registry** (agente pede *capacidade*, não ferramenta) | Não existe. Seleção de provider/ferramenta é **hardcoded** (regex/if-else no orquestrador + `llm.ts` fixo). | **NOVO** (avaliar se compensa — ver §6). |
| 19 | **Event Bus** (tópicos `sale.completed`, `invoice.overdue`, …) | `business_signals` + `BusinessSignalService`: ledger idempotente por `(org, dedupe_key)`, ranqueado por severidade, com auto-resolve. É **pull**, não broker push. `ConfirmationEngine` (push) é **proposto** na ADR-152 D4. | **EXISTE-como-ledger** — reusar; mapear eventos do PRD para `domain`+`signal_type`. |
| 20 | **Early Warning** (`risk_condition` → alerta) | Severidade `risk`/`critical` + thresholds ADR-132 ("gatilhos": `conversao_caiu`, `concentracao_cliente`, `estoque_parado`) + sinais preditivos de forecast (`cash_break_risk`). | **EXISTE** — reusar; **não** criar `PremortemAlertService`. |
| 21 | **Tasks/automações para mitigação** | `TaskService` (ADR-134, com `result_*`+evidência) + `decision_actions` + `CommandExecutorService`. | **EXISTE** — reusar. |
| 22 | **Scheduler de pesquisas/riscos** | `Scheduler` (ADR-074, polling slow 1h/fast 5min, opt-in por flag) + `JobQueueService` (ADR-073, reativo, não-bloqueante, retry, sweepStale). | **EXISTE** — reusar; **não** criar scheduler próprio (o PRD concorda). |
| 23 | **Cache L1/L2/L3** | Só `orgCache` in-memory de embeddings (`geminiRAG`). | **PARCIAL/NOVO.** |
| 24 | **AI Compute Budget** (daily_token / research / deep_analysis / external_api + priority) | Metering real (`ai_usage_log`, `recordUsage` em `llm.ts`) + gate por **contagem** (`PlanService.aiAllowed`, bloqueante) + teto de **custo** `ai_monthly_limit_cents` (só alerta, `AiQuotaSignalService`). | **PARCIAL** — metering existe; **sub-budgets e prioridade não**. |
| 25 | **Observability** (decision_latency, cache_hit_rate, prediction_accuracy, recommendation_acceptance, risk_materialization_rate, loss_avoided) | `AiUsageDashboardService` (tokens/custo/latência/chamadas por módulo/modelo/usuário) + `action_outcomes` (esperado×realizado). | **PARCIAL** — só custo/token/latência; faltam as métricas de **decisão**. |
| 26 | **Determinístico antes de LLM; regras antes de IA** | Princípio **vivo**: ADR-130 "LLM só na borda"; `ImpactPrioritization`/`BusinessHealth`/simuladores são zero-token. | **EXISTE** (como princípio arquitetural). |
| 27 | **Sem menus novos** (só Cockpit / Diretor IA) | Sidebar já tem "Central de Saúde", "Diretor IA" (`ExecutiveView`), "Revenue Intelligence", "Insights". ADR-152 D8 já decidiu "**aba** no `ExecutiveView`, não tela nova". | **EXISTE** (princípio já adotado). |
| 28 | **Política de autonomia L0–L4** (auto / regras / reco+confirma / humano) | `agent_policies.autonomy_level` + `execution_mode` (ADR-152 D7) + `AiGovernanceService` (`human_decision_required` p/ ações que afetam pessoas). | **EXISTE** — mapeável aos níveis do PRD. |

**Placar:** de 28 blocos → **~8 EXISTE**, **~12 PARCIAL** (aditivo), **~6 NOVO**, **~2 BLOQUEADO/decisão do dono**.

---

## 3. O que é genuinamente novo (não duplica nada)

1. **N1 — Classificador de impacto L0–L4 + roteador de profundidade.** Aditivo sobre `ImpactPrioritizationService` (o score já existe; falta derivar 5 faixas e decidir "análise simples vs profunda"). É o "Maestro" do PRD — que hoje **não** existe como roteador.
2. **N2 — Estratégias de raciocínio Advocate / Red Team / Pre-Mortem.** Genuinamente novas, **mas como *modos*** (`DecisionEngine.analyze(mode)`) sobre a evidência já existente — **não** agentes residentes, **não** tabelas próprias. É a parte de maior valor e menor pegada.
3. **N3 — Banda de cenários (conservador/base/agressivo).** Aditivo sobre `DecisionSimulatorService` (hoje ponto único).
4. **N4 — Evidence Package unificado + cache + freshness (+ gancho para evidência externa).** Aditivo sobre `BusinessSnapshotV2Service` (dar-lhe `expires_at`/`freshness`, cache L2, e um slot `external_evidence[]`).
5. **N5 — `ExternalResearchProvider` + Research Broker.** Novo, modelado no template `TryOnProvider`. **Depende da decisão N-BLOQ-1 (cache por vertical / cross-tenant).**
6. **N6 — Métricas de decisão** (`prediction_accuracy`, `risk_materialization_rate`, `financial_loss_avoided`, `cache_hit_rate`). Aditivo sobre `action_outcomes` + `AiUsageDashboardService`.
7. **N7 — Sub-budgets de IA + prioridade** (research/deep_analysis/external_api). Aditivo sobre `AiQuotaSignalService`/`PlanService`.
8. **N8 (opcional) — Tool Registry / capability dispatch** e **N9 (opcional) — Unified Memory tipada**: valor real, mas alto custo/risco — ver §5/§6.

---

## 4. O que NÃO construir — construiria duplicidade

Seguindo o próprio "CAPABILITY RESOLVER" do PRD (Existe → reutilizar) e o precedente ADR-152 D01/D11:

- ❌ **Sistema de alertas novo** → usar `business_signals` (mapear eventos do PRD para `signal_type`).
- ❌ **Motor de tarefas/automações novo** → usar `decision_actions` / `TaskService` / `CommandExecutorService`.
- ❌ **Scheduler novo** (de pesquisa/risco) → usar `Scheduler` + `JobQueueService`.
- ❌ **Silo "Decision Memory"** → é *view* sobre `decision_actions`/`action_outcomes`.
- ❌ **Menus novos** (Pre-Mortem/Red Team/Agent-Reach/Code Search/Early Warning) → cards no "Central de Saúde"/"Diretor IA", como ADR-152 D8 já fez.
- ❌ **Tabelas paralelas `decision_records`/`decision_risks`/`decision_outcomes` com nomes do PRD** → estender `decision_actions`/`action_outcomes` (a `decision_risks` é o único candidato a tabela nova real; ver §6). Isto é literalmente a decisão ADR-152 D1/D11.
- ❌ **Agentes residentes** Advocate/RedTeam/PreMortem → estratégias/modos.
- ❌ **Segundo motor de decisão** ("Pre-Mortem Engine") → strategy do Decision Engine existente (o PRD concorda no §3).

---

## 5. Riscos / pontos que exigem decisão do dono do produto

- **N-BLOQ-1 — Cache de pesquisa compartilhado por vertical (cross-tenant).** O PRD (§7, §24, §29) quer "pesquisar 1× por vertical e contextualizar N vezes". **A ADR-079 D4 vetou explicitamente** agregação cross-tenant sem ADR próprio (fronteira de isolamento multi-tenant, convenção crítica nº 1 do `CLAUDE.md`). É uma decisão de produto+jurídico, não técnica. Opções: (a) só por-tenant no MVP; (b) compartilhado-anonimizado com ADR novo; (c) adiar.
- **N-BLOQ-2 — Fork de governança do projeto:** este PRD deve **entrar como extensão da ADR-152** (mesma doc-suite/matriz) ou abrir **ADR-156 paralela**? Abrir paralela recria o risco de duplicação de esforço que o PRD combate.
- **Refactor de Unified Memory (N9):** consolidar 8 tabelas de memória exigiria migrar `PatternMemory` (+7 domínios), `retail_store_patterns`, 2 RAGs e `prospect_learning_memory`, com dados vivos. Alto risco de regressão, ganho marginal incerto. A própria regra de frugalidade do PRD (§43) argumenta **contra** fazer isso agora.
- **Tool Registry (N8):** o roteamento hardcoded funciona e é auditável. Um registry de capacidades é elegante para trocar provider no futuro, mas é infra sem valor imediato ao empresário — candidato a adiar.

---

## 6. Recomendação de caminho

**Não abrir um "terceiro módulo", nem uma ADR-156 concorrente.** Em vez disso:

1. **Adotar este documento como Fase 0** de um incremento **"Decision Intelligence"** que é **aditivo à ADR-136/152** (mesma filosofia, mesma doc-suite, sem renomeação em massa).
2. **Construir só os slivers genuinamente novos e de maior valor**, na ordem de menor risco:
   - **Fatia DI-1 (fundação leve):** L0–L4 no `ImpactPrioritizationService` + `freshness`/cache no `BusinessSnapshotV2Service` (→ Evidence Package v1, **interno**). Nenhuma UI nova.
   - **Fatia DI-2 (o cérebro):** `DecisionEngine.analyze({ mode: premortem|red_team|advocate })` como **estratégias** sobre o Evidence Package, gravando riscos previstos em **uma** tabela nova `decision_risks` (ligada a `decision_actions`, condição monitorável → publica em `business_signals`, sem alert engine novo). Banda de cenários no simulador.
   - **Fatia DI-3 (loop fechado):** métricas de decisão (`prediction_accuracy`, `loss_avoided`) aditivas em `action_outcomes` + card no Diretor IA. Sub-budgets de IA.
   - **Fatia DI-4 (externo, se aprovado N-BLOQ-1):** `ExternalResearchProvider` + broker + cache por vertical.
3. **Adiar** Tool Registry (N8) e Unified Memory refactor (N9) até haver necessidade concreta (frugalidade do PRD §43).

Cada fatia = 1 PR draft → CI verde → merge, com teste `scripts/test-*.ts` isolado por org, seguindo o fluxo padrão do `CLAUDE.md`.

---

## 7. Próximo passo

Aguardando decisão do dono sobre **N-BLOQ-2** (extensão da ADR-152 vs ADR nova) e **N-BLOQ-1** (cache cross-tenant) antes de escrever código — porque ambas mudam o desenho das fatias DI-2 e DI-4. Sem essa confirmação, o único trabalho seguro e sem duplicação é **esta análise** + o esqueleto de fatias acima.
