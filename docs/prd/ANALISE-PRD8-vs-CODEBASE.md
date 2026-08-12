# Análise Comparativa — PRD 8 (Universal Closed Loop & Outcome Assurance) × Codebase

**Escopo:** entregável da **F0** do PRD 8 (ADR-165). Prova, com evidência `file:symbol`, o que já existe no `main` para que a implementação seja **predominantemente REUTILIZAR/ESTENDER/COMPOR** e só o mínimo CRIAR. **Documento sem código** — a implementação (F1+) está **bloqueada até o PRD 7 (ADR-164) encerrar**, para manter a disciplina por fatias e evitar trabalho concorrente.

**Conclusão executiva:** o ZapFlow já sabe **executar** com confiança (Action Trust — ADR-158/159) e já sabe **medir** resultado onde alguém programou a medição (`OutcomeMeasurementService` + Impact services por domínio). Quatro loops de referência — **Cobrança, Recuperação Comercial, Reputação, Fechamento de Varejo** — já distinguem "**enviado/executado**" de "**resultado confirmado**". A lacuna real do PRD 8 não é um motor novo: é uma **garantia transversal** de que **todo** processo dado como "concluído" teve o **outcome de negócio efetivamente confirmado e medido** — hoje isso é verdade *por domínio instrumentado*, não *por invariante do sistema*. **DONE ≠ RESULTADO.**

---

## 1. Os quatro conceitos do PRD 8 vs. o que o código distingue hoje

| Conceito PRD 8 | Existe no código? | Evidência |
| --- | --- | --- |
| **AÇÃO EXECUTADA** (efeito técnico disparado) | ✅ | `CommandExecutorService.ts:188` `execute` grava `action_execution_log` (`executing`→`done`/`failed`, id `randomUUID()` `:251`). |
| **EFEITO CONFIRMADO** (a contraparte externa reconheceu) | ✅ (parcial) | `ConfirmationEngine.ts:161` `confirm` marca a confirmação `confirmed` via `findByExternalRef` `:120`. |
| **OUTCOME DE NEGÓCIO CONFIRMADO** (o problema real se resolveu) | ✅ *por domínio* | `ReputationClosureService.ts:99` `close` (só `resolved` fecha); `CollectionPromiseService.ts:200` `processOne` (pago ≠ enviado). |
| **IMPACTO MEDIDO** (quanto valor/tempo) | ✅ *por domínio* | `OutcomeMeasurementService.ts:46` `record` → `action_outcomes` (`basis fact\|estimate\|influenced`). |

**Achado central:** os quatro conceitos existem, mas **colapsam numa só chamada** em vários pontos. `ConfirmationEngine.confirm` (`:161`) marca *efeito confirmado* E chama `DecisionActionService.complete` com `resultAmount`/`categoryOutcomes` no mesmo fluxo (`:197-207`), fundindo "a contraparte respondeu" com "o negócio foi medido". Não há um estado derivado, transversal, que responda **"este processo `completed` teve seu outcome de negócio confirmado, ou só executou?"**.

---

## 2. Matriz REUTILIZAR / ESTENDER / COMPOR / CRIAR

| Capacidade PRD 8 | Existe | Parcial | Não existe | Reutilizar | Estender | Compor | Criar |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Runtime/FSM de processo (`ProcessRuntimeService`) | ✅ | | | ✅ | | | |
| Avaliador de condição (`PlaybookEngine.evaluateCondition`) | ✅ | | | ✅ | | | |
| `success_conditions`/`failure_conditions` de **definição** avaliados | | ✅ | | | ✅ | | |
| Confirmação de efeito (`ConfirmationEngine`) | ✅ | | | ✅ | ✅ | | |
| Registro de métodos de confirmação (adapter/registry) | | | ✅ | | | | ✅ |
| Contrato de medição (`OutcomeMeasurementService`) | ✅ | | | ✅ | | | |
| Idempotência de outcome (UNIQUE anti-dupla-contagem) | | | ✅ | | | | ✅ |
| Ledger unificado sem double-count (`UnifiedImpactLedgerService`) | ✅ | | | ✅ | | ✅ | |
| Trace por `correlation_id` (`ExecutionTraceService`) | | ✅ | | ✅ | ✅ | | |
| Superfícies de resultado (Results/SmartInbox/Thread) | ✅ | | | ✅ | | ✅ | |
| Sinal de exceção com dedupe (`BusinessSignalService`) | ✅ | | | ✅ | | | |
| Correção via `DecisionAction`→`ApprovalPolicy`→`CommandExecutor` | ✅ | | | ✅ | | | |
| **Outcome Contract** (mapa sucesso/falha de negócio por processo) | | ✅ | | | ✅ | | |
| **OutcomeAssuranceService** (fachada read-only do estado de garantia) | | | ✅ | | | ✅ | ✅ (mínimo) |
| **Outcome Measurement Reconciler** (gaps done-sem-outcome) | | | ✅ | | | ✅ | ✅ (mínimo) |
| **BusinessOutcomeResolver registry** (pergunta ao system-of-record) | | | ✅ | | | ✅ | ✅ |

---

## 3. Evidência por área (síntese da auditoria F0)

### 3.1 Cadeia canônica execução→confirmação→outcome→impacto

1. **`ProcessRuntimeService`** — FSM completa de 13 estados (`ProcessRuntimeService.ts:51-71`), terminais `{cancelled, measured, completed, failed}` (`:50`). **Achado (a):** `success_conditions_json`/`failure_conditions_json`/`escalation_policy_json`/`sla_definition_json` da **definição** (`db.ts:7188-7208`) são **só armazenados** — gravados no `defineProcess` (`:133,139-141`), **nunca lidos/avaliados**. O único avaliador ativo é a `successCondition` de **nível de step** em `completeStep:353`. As condições de **nível de processo** são inertes. `process_instances` tem `correlation_id` (`db.ts:7265`) e `result_json` preenchido só no `$end` (`completeStep:360`).
2. **`PlaybookEngine.evaluateCondition`** — `PlaybookEngine.ts:174`, motor **puro sem I/O** (docstring `:1-8`). Forma `{op, path, value, conditions}` com `op ∈ truthy|eq|gte|lte|and|or|not` (`:49`). Reutilizável como avaliador de condição de negócio; falta o mapeamento `{source,field,operator,value}` → `{op,path,value}`.
3. **`DecisionActionService.complete`** — `:182-214`. **Achado (b) — measurement gap:** a ação vira `done` (`:199-200`) **antes** de `OutcomeMeasurementService.record` (`:204`), que roda em `try/catch` com **catch vazio silencioso** (`:212`). Se `record` lançar, a ação fica `done` **sem `action_outcome`** e sem log — loop prometido×entregue aberto sem sinal.
4. **`CommandExecutorService`** — choke-point único (`execute:188`, `dispatchGoverned:320`). Guardas G1/G2/G3 + idempotência de efeito externo (`:224-229`). Registra `action_execution_log` com id próprio (`:251`).
5. **`ConfirmationEngine`** — `expect:84`/`confirm:161`/`sweepTimeouts:233`. **Achado:** métodos são **hard-coded** (`CONFIRMATION_METHODS as const :40-51`, validados por `.includes()` `:86`) — adicionar método exige editar o array; **não há registry/adapter**. Não distingue estruturalmente "efeito confirmado" de "outcome de negócio" — colapsa ambos ao chamar `complete` num IIFE fire-and-forget (`:197-207`).
6. **`OutcomeMeasurementService.record`** — `:46`. `basis ∈ fact|estimate|influenced` (`:22`), `method ∈ self_reported|manual|attributed|derived` (`:16`). **Achado (sem UNIQUE):** `action_outcomes` (`db.ts:6261-6273`) tem só `PRIMARY KEY(id)` + índice **não-único**; sem UNIQUE por `(action_id, method, evento)`. Docstring assume "idempotência a cargo de quem chama" (`:43-44`). `complete` chamado 2× → 2 outcomes → dupla contagem. Categorias (`revenueRecovered/costAvoided/lossPrevented/timeSaved`) **nunca são somadas entre si** (`ledger:117-126`).
7. **`UnifiedImpactLedgerService`** — providers `actionLedger/comigo/retail/ric` (`:65/84/107/148`). Soma só **dentro** da categoria (`assemble:194`, disclaimer `:201`). **Achado (c) — double-count:** (i) `provenValue` é **somado** entre `comigoProvider:88` e `retailProvider:114`; (ii) `action_ledger.revenueRecovered` (`:71`) e `ric.recoveredRevenue` (`:164`) podem representar o **mesmo R$**, separados só por categoria (comentário `:137-142`), **sem dedup cruzado** — agravado pela ausência de UNIQUE em `action_outcomes`.
8. **`ExecutionTraceService.trace`** — `:36`, reconstrói **3 elos** por `correlation_id`: `business_signals`/`decision_actions`/`action_outcomes`; `closedLoop:62`. **Achado (parcial):** **não** inclui `action_confirmations` nem `action_execution_log` (ambos têm `correlation_id`, `db.ts:8362`) nem `process_instances`/`process_transitions`.
9. **`BusinessSignalService`** — `publish` exige `dedupeKey` (`:59`), idempotente por `(org, dedupe_key)` (`:68-74`); `resolveByDedupe:207`. Superfície transversal `attention()` (`:109-178`) funde sinais abertos + `decision_risks`. **Achado:** `ConfirmationEngine.sweepTimeouts` marca `timed_out` mas **não publica sinal** — SLA de confirmação estourado não flui hoje para `attention()`.

### 3.2 Loops de domínio de referência (golden references — já distinguem executado × resultado)

1. **Cobrança** — `AsaasService.ts:notifyRuntimeConfirmation` (`:210-237`) só age em `CONFIRMED|RECEIVED`; `CollectionPromiseService.ts:processOne` (`:200-218`) decide `markFulfilled` por `receivables.status='received'` OU `action_confirmations.confirmed` — **nunca infere pagamento de mensagem enviada**. Recovery medido por `decision_actions.done AND result_amount>0` (`CollectionAbMeasurementService.ts:38-84`, `basis:"fact"`).
2. **Recuperação Comercial** — `SalesRecoveryAttributionService.ts:attributeOne` (`:143-245`) dispara em `ticket_stage_logs.to_stage='ganho'`, janela default 30d (`:51`), `basis fact` (orders pagos) vs `estimate` (quotes/avg_ticket, `:250-284`), idempotência `UNIQUE` em `sales_recovery_attributions`.
3. **Reputação** — `ReputationClosureService.ts:close` (`:99-125`) separa "respondeu" de "resolveu": só `resolution:'resolved'` fecha a ação `reputation_publish_reply`; reabertura é **event-driven** (réplica nova, `syncReplies:82-87`), não janela temporal. Impacto north-star = `problems_resolved` (`ReputationImpactService.ts:kpi:54-91`).
4. **Fechamento de Varejo** — `RetailReconciliationService.ts:applyPdvTotal` (`:127-143`) confronta `system_total` (PDV/Alterdata) × `informed_total`. `RetailImpactService.ts` separa `proven`/`activity`/`estimated` que **nunca somam** (disclaimer `:249`).

### 3.3 Superfícies de resultado (já expõem o ciclo)

- `ExecutionResultsService.ts` — `executing:44` + `results:93` (consome `UnifiedImpactLedgerService.build`, dinheiro **role-gated** `restricted:true`).
- `SmartInboxService.ts:build` (`:83-116`) — categoria `resolved` (ações `done` 48h + processos `completed/measured`).
- `FalaTuThreadService.ts:thread` (`:39-82`) — timeline com os 5 estágios `entrada→sinal→decisao→execucao→resultado`; o estágio `resultado` lê `action_outcomes` por `correlation_id` mostrando `esperado→realizado` (`:71-73`).

---

## 4. Gaps que a implementação (F1+) fecha — sem motor novo

| # | Gap | Onde fecha (ESTENDER/COMPOR) |
| --- | --- | --- |
| G1 | `success/failure_conditions` de **processo** inertes | Avaliar via `PlaybookEngine.evaluateCondition` sobre um contexto de negócio derivado (mapa `{source,field,operator,value}`). |
| G2 | `complete` engole falha de medição (catch vazio `:212`) | Reconciler transversal detecta `done`-sem-`action_outcome` e publica `business_signal` com dedupe. |
| G3 | Sem estado transversal "outcome confirmado?" | `OutcomeAssuranceService.assess()` — fachada **read-only**, estado **derivado** (não muda a FSM). |
| G4 | `ExecutionTraceService` pula confirmação/execução | Estender o trace para incluir `action_confirmations` + `action_execution_log` (já têm `correlation_id`). |
| G5 | Sem UNIQUE → dupla contagem possível | UNIQUE aditivo em `action_outcomes` por evento; dedup cruzado no ledger. |
| G6 | `ConfirmationEngine` métodos hard-coded | Registry/adapter de `BusinessOutcomeResolver` (determinístico, pergunta ao system-of-record; não LLM). |
| G7 | SLA de confirmação estourado não vira sinal | `sweepTimeouts` publica `business_signal` → aparece em `attention()`. |

**Nenhum gap exige** novo Runtime, Policy Engine, Confirmation Engine, Impact Ledger, Scheduler, tabela de alerta paralela ou learning engine.

---

## 5. Guardrails que a implementação herda (não regredir)

- **null ≠ zero; ausência de evidência ≠ falha** — outcome não medido é "pendente de confirmação", não "R$ 0" nem "fracassou".
- **fact / estimate / influenced** — jamais somar bases diferentes (invariante já em `OutcomeMeasurementService` + `UnifiedImpactLedgerService`).
- **Sem dupla contagem** — RIC × `action_outcomes` × atribuição de recovery × Retail × Comigo × Reputação: o Assurance **lê e reconcilia**, nunca cria uma 5ª fonte de dinheiro.
- **Correção governada** — qualquer ação corretiva passa por `DecisionAction → ApprovalPolicy → CommandExecutor` (RBAC real, não bypass).
- **Untrusted external data** — confirmação vinda de fora (webhook/réplica) é evidência, não fato automático (padrão ADR-162 RN-CRR).
- **Determinístico antes de LLM** — o resolver pergunta ao system-of-record (SQL), não "acha" que resolveu.

---

## 6. Dependência dura (bloqueia F1)

**A implementação do PRD 8 não começa antes do PRD 7 (ADR-164) encerrar.** Motivo declarado pelo operador: manter a disciplina por fatias e evitar trabalho concorrente. O PRD 7 hoje está em **F0–F7** (baseline/headroom entregues; host/infra da F2, SLO da F3.4 e forecast F8+ dependem de dados de ambiente / baseline acumulado). Esta F0 do PRD 8 é **exclusivamente documental** — auditoria + ADR-165 + matriz de reutilização — e **não** cria nenhum serviço, rota, tabela, flag ou teste.
