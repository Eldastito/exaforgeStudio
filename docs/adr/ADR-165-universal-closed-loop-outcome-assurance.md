# ADR-165 — Universal Closed Loop & Outcome Assurance (PRD 8)

**Programa:** ZapFlow Execution Intelligence (ZEI)
**Estado:** **F0 FECHADA (auditoria + matriz de reutilização — este documento). Implementação (F1+) BLOQUEADA até o PRD 7 (ADR-164) encerrar** — disciplina por fatias, sem trabalho concorrente.
**Prioridade:** P0 — confiança no dado de resultado (pré-requisito do PRD 9 Enterprise Learning)
**Acesso:** transversal (opt-in por flag; superfícies role-gated existentes)
**Natureza:** Garantia de ciclo fechado + Outcome Assurance + Reconciliação de medição
**Estratégia:** REUTILIZAR → ESTENDER → COMPOR → **só então** CRIAR
**Dependência dura:** PRD 7 (ADR-164) **encerrado** — pré-condição **não atendida** (PRD 7 em F0–F7). Nada de código PRD 8 antes disso.
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

## 6. Plano de fatias (F0–F13) — **F1+ bloqueadas até PRD 7 encerrar**

| Fatia | Entrega | Reuso principal |
| --- | --- | --- |
| **F0** ✅ | **Auditoria + matriz + este ADR (doc-only)** | — |
| F1 | `OutcomeAssuranceService.assess()` — estado derivado read-only (executado/efeito/outcome/impacto) por `correlation_id` | `ExecutionTraceService`, `ConfirmationEngine`, `OutcomeMeasurementService` |
| F2 | Avaliar `success/failure_conditions` de **processo** via `evaluateCondition` (mapa de contexto de negócio) | `PlaybookEngine`, `ProcessRuntimeService` |
| F3 | `BusinessOutcomeResolver` registry (determinístico, system-of-record) — Cobrança primeiro | `AsaasService`, `receivables` |
| F4 | Resolvers dos demais golden loops (Comercial, Reputação, Varejo) | `SalesRecoveryAttributionService`, `ReputationClosureService`, `RetailReconciliationService` |
| F5 | UNIQUE aditivo em `action_outcomes` + dedup cruzado no ledger (anti-double-count) | `OutcomeMeasurementService`, `UnifiedImpactLedgerService` |
| F6 | Outcome Measurement Reconciler — `done`-sem-outcome → `business_signal` (fecha catch vazio) | `BusinessSignalService`, `DecisionActionService` |
| F7 | `sweepTimeouts` publica sinal de SLA de confirmação estourado → `attention()` | `ConfirmationEngine`, `BusinessSignalService` |
| F8 | Estender `ExecutionTraceService` com confirmações + execuções (trace de ciclo completo) | `ExecutionTraceService` |
| F9 | Superfícies: "garantido × só executado" em Results/Thread (role-gated) | `ExecutionResultsService`, `FalaTuThreadService` |
| F10 | Correção governada de gaps via `DecisionAction→ApprovalPolicy→CommandExecutor` | `CommandExecutorService`, `ApprovalPolicyService` |
| F11 | Métricas de assurance (cobertura de confirmação, gap-rate) — derivadas por query | `OutcomeMeasurementService` |
| F12 | Runbook de operação (`docs/runbook/outcome-assurance-operacao.md`) | — |
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
