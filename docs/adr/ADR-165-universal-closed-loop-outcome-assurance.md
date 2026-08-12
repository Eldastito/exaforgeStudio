# ADR-165 — Universal Closed Loop & Outcome Assurance (PRD 8)

**Programa:** ZapFlow Execution Intelligence (ZEI)
**Estado:** **F0–F12 FECHADAS. F12 = runbook `docs/runbook/outcome-assurance-operacao.md` (mapa dos serviços, rotas, fluxo do gap, guardrails RN-OA, como adicionar domínio ao resolver). F11 = `OutcomeAssuranceMetricsService` — KPIs de garantia (outcomeCoverage/effectConfirmed/assured/gapRate) DERIVADOS por query; DONE≠RESULTADO virou número. Rota `GET /assurance/metrics`. F10 = `OutcomeCorrectionService` — propõe correções GOVERNADAS pros gaps abertos (via `DecisionActionService.propose`→ApprovalPolicy; nunca executa direto — RN-OA-9); Reconciler F6 exclui as próprias correções (anti-recursão). F9 = superfície de garantia — cada objetivo do "Executando" (`ExecutionResultsService.executing`) mostra `assurance` (`assured` × só `executed`/`planned`), fato sempre visível (só o R$ é role-gated). F8 = `ExecutionTraceService.trace` estendido com `executions` (por correlation_id) + `confirmations` (por action_id) — o fio agora atravessa execução e confirmação entre decisão e outcome (antes pulava). F7 = `ConfirmationEngine.sweepTimeouts` passa a publicar `business_signal` (`confirmation_timed_out`) quando o SLA de confirmação estoura → aparece em `attention()` (fecha o gap de integração da auditoria). F5 = anti-dupla-contagem (achado (c)). F6 = `OutcomeReconcilerService` — varre `done`-sem-outcome (após graça) e publica sinal em `business_signals`/`attention()`, resolve quando a medição atrasada chega; fecha o achado (b) (o catch vazio silencioso do `complete`). F1 = `OutcomeAssuranceService.assess()` read-only. F2 = `ProcessOutcomeContractService.evaluate()` (achado (a)). F3 = `BusinessOutcomeResolverRegistry` (Cobrança). F4 = resolvers dos outros 3 golden loops (Comercial→`sales_recovery_attributions`, Reputação→`business_signals.status='resolved'`, Varejo→`retail_daily_closings.status`). Pré-condição atendida: metade de código do PRD 7 (ADR-164 F0–F14) encerrou.**
**Prioridade:** P0 — confiança no dado de resultado (pré-requisito do PRD 9 Enterprise Learning)
**Acesso:** transversal (opt-in por flag; superfícies role-gated existentes)
**Natureza:** Garantia de ciclo fechado + Outcome Assurance + Reconciliação de medição
**Estratégia:** REUTILIZAR → ESTENDER → COMPOR → **só então** CRIAR
**Dependência dura:** PRD 7 (ADR-164) **encerrado** — pré-condição **ATENDIDA** (metade de código do PRD 7 em F0–F14 na produção; restam só as fatias de ambiente, que não bloqueiam o PRD 8).
**Não é:** novo Runtime, novo Policy Engine, novo Confirmation Engine, novo Impact Ledger, novo Scheduler, nova tabela de alerta, nem learning engine.

> **Regra de ouro (PRD 8):** *`DONE` não é `RESULTADO`. Um processo só está encerrado quando o **outcome de negócio** que ele prometia foi **confirmado e medido** — não quando a ação foi disparada.*

---

## 1. Contexto e objetivo

O ZapFlow já executa com confiança (**Action Trust** — ADR-158 espinha única, ADR-159 governança) e já mede impacto onde alguém instrumentou a medição (`OutcomeMeasurementService` + Impact services por domínio). Quatro loops de referência — **Cobrança, Recuperação Comercial, Reputação, Fechamento de Varejo** — já distinguem "**executado/enviado**" de "**resultado confirmado**".

A lacuna que o PRD 8 fecha **não é um motor**: é uma **invariante transversal**. Hoje "todo processo `completed` teve seu outcome de negócio confirmado" é verdade **por domínio instrumentado**, não **por garantia do sistema**. Um processo pode chegar a `completed` porque a ação foi disparada — sem que o dinheiro tenha entrado, sem que o problema tenha se resolvido, sem que ninguém tenha medido. O PRD 8 torna essa garantia **primeira classe e observável**, sobre os mecanismos que já existem.

Quatro conceitos que hoje colapsam e que o PRD 8 separa: **AÇÃO EXECUTADA** → **EFEITO CONFIRMADO** → **OUTCOME DE NEGÓCIO CONFIRMADO** → **IMPACTO MEDIDO**.

---

## 2. F0 — Auditoria do `main` (evidência `file:symbol`)

**Conclusão: a cadeia execução→confirmação→outcome→impacto existe peça a peça; falta a garantia transversal que prova que cada `completed` percorreu a cadeia inteira.** As peças são reusadas, não recriadas.

| # | Superfície | `file:symbol` | Veredito | Papel / achado |
| --- | --- | --- | --- | --- |
| 1 | **Runtime/FSM de processo** | `ProcessRuntimeService.ts:51-71` (13 estados); terminais `:50` | EXISTE | FSM completa. **Condições de PROCESSO (`success/failure/escalation/sla_json`, `db.ts:7188-7208`) só armazenadas** (`defineProcess:139-141`), nunca avaliadas. Só `successCondition` de **step** é avaliada (`completeStep:353`). |
| 2 | **Avaliador de condição** | `PlaybookEngine.ts:174` `evaluateCondition` | EXISTE (puro) | `{op,path,value}`, sem I/O (`:1-8`). Reutilizável p/ condição de negócio; falta mapa `{source,field,operator,value}`→`{op,path,value}`. |
| 3 | **Conclusão de ação + medição** | `DecisionActionService.ts:182-214` `complete` | PARCIAL | Ação vira `done` (`:199-200`) antes do `record` (`:204`), em `try/catch` com **catch vazio** (`:212`). Falha de medição fica **silenciosa**. |
| 4 | **Executor governado** | `CommandExecutorService.ts:188` `execute` | EXISTE | Choke-point único; G1/G2/G3 + idempotência de efeito (`:224-229`); `action_execution_log` id próprio (`:251`). |
| 5 | **Confirmação de efeito** | `ConfirmationEngine.ts:161` `confirm`; `:120` `findByExternalRef` | EXISTE (não extensível) | Métodos **hard-coded** (`CONFIRMATION_METHODS as const :40-51`). **Não distingue** efeito × outcome de negócio — colapsa via `complete` fire-and-forget (`:197-207`). `sweepTimeouts:233` marca `timed_out` mas **não publica sinal**. |
| 6 | **Contrato de medição** | `OutcomeMeasurementService.ts:46` `record` | EXISTE (sem UNIQUE) | `basis fact\|estimate\|influenced` (`:22`); categorias nunca somadas (`ledger:117-126`). `action_outcomes` **sem UNIQUE** (`db.ts:6261-6273`) → dupla contagem possível; idempotência "a cargo do chamador" (`:43-44`). |
| 7 | **Ledger unificado** | `UnifiedImpactLedgerService.ts` (providers `:65/84/107/148`) | EXISTE (double-count parcial) | Soma só dentro da categoria (`assemble:194`). `provenValue` **somado** Comigo+Retail (`:88/:114`); `action_ledger.revenueRecovered` × `ric.recoveredRevenue` mesmo R$ sem dedup cruzado (`:137-142`). |
| 8 | **Trace por correlação** | `ExecutionTraceService.ts:36` `trace` | PARCIAL | 3 elos (`business_signals`/`decision_actions`/`action_outcomes`); `closedLoop:62`. **Não inclui** `action_confirmations`/`action_execution_log`/`process_instances`. |
| 9 | **Sinal de exceção** | `BusinessSignalService.ts:59` `publish`; `:109-178` `attention` | EXISTE | `dedupeKey` obrigatório, idempotente; `attention()` funde sinais+riscos. Canal canônico de exceção (sem tabela de alerta própria). |
| 10 | **Loops golden** | Cobrança `AsaasService.ts:210`/`CollectionPromiseService.ts:200`; Comercial `SalesRecoveryAttributionService.ts:143`; Reputação `ReputationClosureService.ts:99`; Varejo `RetailReconciliationService.ts:127`/`RetailImpactService.ts` | EXISTE | Referências que **já** distinguem executado × confirmado × medido. O Assurance generaliza o padrão deles. |
| 11 | **Superfícies de resultado** | `ExecutionResultsService.ts:93`; `SmartInboxService.ts:83`; `FalaTuThreadService.ts:39` | EXISTE | Thread já tem os 5 estágios (`entrada→sinal→decisao→execucao→resultado`); dinheiro role-gated. Estender, não recriar. |

*(auditoria completa e narrativa em `docs/prd/ANALISE-PRD8-vs-CODEBASE.md`)*

---

## 3. Matriz de Reutilização (entregável obrigatório da F0)

| Capacidade PRD 8 | Veredito | Base / ação concreta |
| --- | --- | --- |
| Avaliar condições de sucesso/falha de negócio | **REUTILIZAR** | `PlaybookEngine.evaluateCondition` sobre contexto de negócio derivado (mapa aditivo `{source,field,operator,value}`→`{op,path,value}`). |
| **Outcome Contract** (o que "resultado" significa por processo) | **ESTENDER** | Usar as colunas **já existentes** `success_conditions_json`/`failure_conditions_json` de `process_definitions` — hoje subutilizadas. Sem tabela nova. |
| Fachada do estado de garantia | **CRIAR (mínimo, read-only)** | `OutcomeAssuranceService.assess()` — estado **derivado** por query (executado/efeito-confirmado/outcome-confirmado/impacto-medido). **Não** muda a FSM (RN-OA-3). |
| Detectar `done`-sem-outcome | **COMPOR + CRIAR (mínimo)** | Reconciler transversal lê `decision_actions.done` sem `action_outcomes` correspondente e publica `business_signal` com dedupe. Fecha o gap do catch vazio (`complete:212`). |
| Resolver "o problema se resolveu?" por domínio | **ESTENDER (registry)** | `BusinessOutcomeResolver` registry — determinístico, pergunta ao **system-of-record** (SQL: `receivables`/`orders`/reputation status), nunca LLM. Substitui o array hard-coded do `ConfirmationEngine`. |
| Anti-dupla-contagem | **ESTENDER (DB aditivo)** | UNIQUE aditivo em `action_outcomes` por evento + dedup cruzado no `UnifiedImpactLedgerService`. |
| Trace de ciclo completo | **ESTENDER** | `ExecutionTraceService` passa a incluir `action_confirmations` + `action_execution_log` (já têm `correlation_id`). |
| SLA de confirmação estourado | **ESTENDER** | `ConfirmationEngine.sweepTimeouts` publica `business_signal` → aparece em `attention()`. |
| Correção de gap detectado | **REUTILIZAR** | `DecisionAction → ApprovalPolicy → CommandExecutor` (governança real; nunca bypass). |
| Exibir "garantido × só executado" | **COMPOR** | Estender `ExecutionResultsService`/`FalaTuThreadService` com o estado de assurance; role-gating de valor preservado. |

---

## 4. Decisões (D)

- **D1 — Assurance é DERIVADO, não um novo estado de FSM.** `OutcomeAssuranceService.assess()` é fachada **read-only** que classifica um processo/ação percorrendo peças existentes. Não adiciona estado a `ProcessRuntimeService` (RN-OA-3). Evita motor concorrente.
- **D2 — Outcome Contract vive nas colunas existentes.** `success_conditions_json`/`failure_conditions_json` de `process_definitions` (hoje inertes) passam a ser **avaliadas** — não se cria tabela `outcome_contracts`.
- **D3 — Resolver determinístico por system-of-record.** `BusinessOutcomeResolver` pergunta ao dado canônico (`receivables.status`, `orders`, reputation status). LLM só entra depois do determinístico (padrão ADR-164 §56/§57), nunca para "achar" que resolveu.
- **D4 — Reconciliação, não 5ª fonte de dinheiro.** O Assurance **lê e reconcilia** `action_outcomes`/RIC/Retail/Comigo/Reputação; jamais grava um novo valor de impacto que possa ser somado aos existentes (anti-double-count).
- **D5 — Exceção é `business_signal`, não tabela nova.** Todo gap (done-sem-outcome, SLA de confirmação estourado, outcome negativo) publica em `business_signals` com `dedupeKey` e aparece em `attention()` — convenção ADR-136.
- **D6 — Correção é governada.** Ação corretiva disparada pelo Assurance passa por `DecisionAction → ApprovalPolicy → CommandExecutor`. O Assurance **detecta e recomenda**; não executa por fora do RBAC.
- **D7 — Opt-in e reversível.** Toda superfície nova é `organization_settings.*_enabled DEFAULT 0` (flag), atômica com o silo, removível sem quebrar dados.

---

## 5. Guardrails duros (RN-OA — no header dos services + testados)

- **RN-OA-1 — `DONE ≠ RESULTADO`.** `completed` sem outcome confirmado é "**pendente de confirmação**", nunca "concluído com sucesso".
- **RN-OA-2 — null ≠ zero; ausência de evidência ≠ falha.** Outcome não medido não é R$ 0 nem fracasso — é *desconhecido*, e isso é declarado.
- **RN-OA-3 — Assurance não muda estado.** Fachada read-only; não escreve na FSM, não força transição, não "conclui" processo. Estado derivado por query (RN-004).
- **RN-OA-4 — fact/estimate/influenced nunca somados** entre si (herda `OutcomeMeasurementService`).
- **RN-OA-5 — sem dupla contagem.** Um R$ aparece uma vez; o Assurance reconcilia origens, não cria uma nova.
- **RN-OA-6 — determinístico antes de LLM.** Resolver pergunta ao system-of-record; sem chave de IA na CI.
- **RN-OA-7 — untrusted external data.** Confirmação externa (webhook/réplica) é evidência, não fato automático; alto risco = conservador (herda ADR-162).
- **RN-OA-8 — não inventa dinheiro.** Se o system-of-record não confirma valor, o Assurance declara ausência — jamais estima para "fechar o loop".
- **RN-OA-9 — correção governada.** Nada de ação corretiva fora de `DecisionAction→ApprovalPolicy→CommandExecutor`.

---

## 6. Plano de fatias (F0–F13)

| Fatia | Entrega | Reuso principal |
| --- | --- | --- |
| **F0** ✅ | **Auditoria + matriz + este ADR (doc-only)** | — |
| **F1** ✅ | **`OutcomeAssuranceService.assess()` — estado derivado read-only (executado→efeito→outcome→impacto) por ação e por `correlation_id`. Escada `planned→executed→effect_confirmed→impact_measured→assured`; gaps (`done_without_outcome`, `confirmation_pending/timed_out`); business outcome fica `resolver_pending` (F3). RN-OA-3 (não escreve/não muda FSM), RN-OA-1 (DONE≠assured), RN-OA-2 (null≠zero). Rotas `/assurance/action/:id` + `/assurance/correlation/:cid`. `test:outcome-assurance` (23 checks).** | `decision_actions`, `action_execution_log`, `action_confirmations`, `action_outcomes` |
| **F2** ✅ | **`ProcessOutcomeContractService.evaluate()` — avalia `success/failure_conditions` de PROCESSO (antes só ARMAZENADAS, achado (a)) via `PlaybookEngine.evaluateCondition` sobre contexto de negócio derivado da instância. `toCondition` normaliza nativo `{op,path,value}` E clausal `{field,operator,value}`/`all`/`any` (Outcome Contract, D2 — sem tabela nova). Falha tem precedência (RN-OA-1); sem contrato → `no_contract` (RN-OA-2); read-only não muda FSM (RN-OA-3). Rota `/assurance/process/:instanceId`. `test:process-outcome-contract` (13 checks).** | `PlaybookEngine`, `process_definitions`, `process_instances` |
| **F3** ✅ | **`BusinessOutcomeResolverRegistry` + `CollectionOutcomeResolver` — pergunta ao SYSTEM-OF-RECORD (`receivables.status='received'`) se o problema se resolveu, nunca à IA (D3/RN-OA-6). Registry substitui o array hard-coded do `ConfirmationEngine` (adicionar domínio = registrar resolver). Integrado no `OutcomeAssuranceService.assessAction` (o `resolver_pending` da F1 agora é resolvido). Sem prova → `unknown` (RN-OA-2); enviado ≠ pago. `test:business-outcome-resolver` (11 checks).** | `receivables`, `OutcomeAssuranceService` |
| **F4** ✅ | **`SalesRecoveryOutcomeResolver` (SoR `sales_recovery_attributions` por `action_id` → ganho atribuído), `ReputationOutcomeResolver` (SoR `business_signals.status='resolved'` via signal_id/correlation_id → resolvido ≠ respondido), `RetailClosingOutcomeResolver` (SoR `retail_daily_closings.status` reconciled/approved → confirmed; divergent → not_confirmed). Todos registrados no registry (agora 4 golden loops). `test:outcome-resolvers-golden` (13 checks).** | `sales_recovery_attributions`, `business_signals`, `retail_daily_closings` |
| **F5** ✅ | **Anti-dupla-contagem (achado (c)): coluna `event_key` + índice UNIQUE PARCIAL `(org, event_key) WHERE event_key IS NOT NULL` (aditivo, nunca falha em dado legado). `OutcomeMeasurementService.record(eventKey)` vira IDEMPOTENTE — medir 2× o mesmo evento devolve o outcome existente em vez de gravar outro; sem `eventKey` o comportamento legado é preservado. `ledger` deduplica por `event_key` no read (backstop). `test:outcome-dedup` (8 checks).** | `OutcomeMeasurementService`, `action_outcomes` |
| **F6** ✅ | **`OutcomeReconcilerService.reconcile()` — varre ações `done` SEM `action_outcome` (fora da janela de graça `graceMinutes`, RN-OA-2) e publica `business_signal` (domain `outcome_assurance`, type `done_without_outcome`) que aparece em `attention()`; quando a medição atrasada chega, RESOLVE o sinal (`resolveByDedupe`). Fecha o achado (b) — o gap silencioso do catch vazio. Idempotente por dedupeKey; não muda a FSM (RN-OA-3); Scheduler pass horário per-org; rota `POST /assurance/reconcile`. `test:outcome-reconciler` (11 checks).** | `BusinessSignalService`, `attention()` |
| **F7** ✅ | **`ConfirmationEngine.sweepTimeouts` — antes de fechar por timeout, captura as pendentes vencidas e publica `business_signal` (domain `outcome_assurance`, type `confirmation_timed_out`, severity `risk`) com `correlationId`/`actionId` → aparece em `attention()`. Fecha o gap de integração (timeout marcado mas não fluía pra atenção). Best-effort, idempotente por dedupeKey, isolado por org. `test:confirmation-timeout-signal` (11 checks); regressão `runtime-confirmation` 32/32.** | `ConfirmationEngine`, `BusinessSignalService` |
| **F8** ✅ | **`ExecutionTraceService.trace` ganha `executions` (`action_execution_log` por `correlation_id`) + `confirmations` (`action_confirmations` por `action_id`, pois não têm correlation_id). O fio sinal→decisão→**execução→confirmação**→outcome fica completo (antes pulava esses dois elos — achado da auditoria). `summary` conta os novos elos; `closedLoop` mantém a semântica pré-F8 (não regride). Aditivo. `test:execution-trace-fullcycle` (9 checks); regressão `execution-trace` 19/19.** | `ExecutionTraceService` |
| **F9** ✅ | **`ExecutionResultsService.executing` — cada objetivo (grupo por `correlation_id`) ganha `assurance: { state, hasGaps, gaps }` derivado de `OutcomeAssuranceService.assessCorrelation` (F1). Mostra "garantido (`assured`) × só executado/planejado" — DONE ≠ RESULTADO na tela que o lojista já usa. O FATO da garantia é SEMPRE visível (RN-OA-2/§73 — só o valor em R$ segue role-gated). Composição pura (não muda a FSM). `test:ux-execution-results` estendido (20 checks, +3 F9); a Thread já expõe o ciclo via trace F8.** | `ExecutionResultsService`, `OutcomeAssuranceService` |
| **F10** ✅ | **`OutcomeCorrectionService.proposeCorrections` — lê os `business_signals` abertos de `outcome_assurance` (F6/F7) e PROPÕE uma ação corretiva por gap via `DecisionActionService.propose` (→ ApprovalPolicy/Autonomy Contract): nasce `awaiting_approval`, NUNCA executa (RN-OA-9); `actionType` prefixado `outcome_correction:` faz o Reconciler F6 ignorá-la (anti-recursão); idempotente por correlação+tipo. Rota `POST /assurance/correct`. `test:outcome-correction` (10 checks).** | `DecisionActionService`, `ApprovalPolicyService` |
| **F11** ✅ | **`OutcomeAssuranceMetricsService.metrics` — KPIs DERIVADOS por query (RN-004) sobre done × outcome × confirmação × sinais: `outcomeCoveragePct`, `effectConfirmedPct`, `assuredPct`, `openGaps` por tipo, `gapRatePct`. Janela configurável; percentuais `null` quando não há done (RN-OA-2 — não inventa 0%). DONE≠RESULTADO vira número. Rota `GET /assurance/metrics`. `test:outcome-assurance-metrics` (11 checks).** | `decision_actions`/`action_outcomes`/`action_confirmations`/`business_signals` |
| **F12** ✅ | **Runbook `docs/runbook/outcome-assurance-operacao.md` — tese DONE≠RESULTADO, mapa dos 10 serviços, todas as rotas `/assurance/*`, o fluxo detectar→sinalizar→corrigir→resolver, como ler as métricas, como adicionar um domínio ao resolver, os 9 guardrails RN-OA e a relação com o PRD 9.** | — |
| F13 | Endurecimento + rate-limit + auditoria transversal | padrões existentes |

---

## 7. Fronteiras (o que **não** fazer)

- **Não** criar Runtime, Policy Engine, Confirmation Engine, Impact Ledger, Scheduler, tabela de alerta ou learning engine paralelos (mandato explícito do operador).
- **Não** transformar Assurance em executor: ele detecta/recomenda; execução segue governada.
- **Não** somar bases (fact/estimate/influenced) nem contar o mesmo R$ duas vezes.
- **Não** inventar valor/confirmação quando o system-of-record não confirma (declara ausência).
- **Não** iniciar F1+ antes do PRD 7 (ADR-164) encerrar.

---

## 8. Relação com o PRD 9

O PRD 9 (Enterprise Learning) depende de dado de resultado **confiável**. O PRD 8 é o pré-requisito: garante que "resultado" no ZapFlow significa **outcome de negócio confirmado e medido**, não "ação disparada". Sem o PRD 8, o PRD 9 aprenderia sobre `DONE` — não sobre `RESULTADO`.
