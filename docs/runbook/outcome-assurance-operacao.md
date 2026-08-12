# Runbook — Operar Universal Closed Loop & Outcome Assurance (PRD 8 / ADR-165)

Referência única de operação da garantia de ciclo fechado: o que cada serviço faz, quais
rotas responder, como um gap flui até a correção, e os guardrails que **não se regridem**.
Tudo é **aditivo/reversível**, determinístico (roda em CI sem chave de IA), isolado por
`organization_id` e **read-only sobre a FSM** (a garantia deriva estado, nunca o muda —
RN-OA-3). Nenhum engine canônico foi duplicado.

## 1. A tese (mapa mental)

**`DONE ≠ RESULTADO`.** Uma `decision_action` chega a `done` porque a AÇÃO foi disparada —
não porque o dinheiro entrou, o problema se resolveu ou alguém mediu. O PRD 8 torna a
distinção de quatro conceitos observável, sobre a espinha que já existe:

```
AÇÃO EXECUTADA → EFEITO CONFIRMADO → OUTCOME DE NEGÓCIO CONFIRMADO → IMPACTO MEDIDO
(execution_log)   (confirmations)     (resolver por system-of-record)   (action_outcomes)
```

| Camada | Service | Papel |
| --- | --- | --- |
| Estado de garantia (derivado) | `OutcomeAssuranceService` | Escada `planned→executed→effect_confirmed→impact_measured→assured` por ação e por `correlation_id` (F1) |
| Contrato de processo | `ProcessOutcomeContractService` | Avalia `success/failure_conditions` de `process_definitions` via `PlaybookEngine.evaluateCondition` (F2) |
| Resolver de outcome | `BusinessOutcomeResolverRegistry` | Pergunta ao **system-of-record** se o problema se resolveu — Cobrança/Comercial/Reputação/Varejo (F3/F4) |
| Anti-dupla-contagem | `OutcomeMeasurementService` (`event_key`) | `record(eventKey)` idempotente + dedup no ledger (F5) |
| Reconciler de medição | `OutcomeReconcilerService` | `done`-sem-outcome → `business_signal` em `attention()` (F6) |
| Exceção de SLA | `ConfirmationEngine.sweepTimeouts` | Confirmação vencida → `business_signal` `confirmation_timed_out` (F7) |
| Trace de ciclo completo | `ExecutionTraceService` | Fio com execuções + confirmações + outcomes (F8) |
| Superfície | `ExecutionResultsService.executing` | Badge `assurance` por objetivo — garantido × só executado (F9) |
| Correção governada | `OutcomeCorrectionService` | Propõe `DecisionAction` corretiva; nunca executa (F10) |
| Métricas | `OutcomeAssuranceMetricsService` | KPIs de cobertura/confirmação/assured/gap-rate derivados por query (F11) |

## 2. Rotas (tenant-scoped, `/api/decision-intelligence/*`)

Todas herdam `AuthRequest` + escopo por org. Read-only, salvo as duas que só PROPÕEM.

| Rota | Responde |
| --- | --- |
| `GET /assurance/action/:actionId` | Estado de garantia de uma ação (escada + gaps + outcome de negócio) |
| `GET /assurance/correlation/:correlationId` | Garantia do fio inteiro (`overall` = pior estado) |
| `GET /assurance/process/:instanceId` | Veredito do Outcome Contract de um processo (success/failure) |
| `POST /assurance/reconcile` | Roda o Reconciler on-demand (sinaliza done-sem-outcome, resolve os medidos) |
| `POST /assurance/correct` | Propõe correções **governadas** pros gaps abertos (nunca executa) |
| `GET /assurance/metrics?days=` | KPIs de garantia (coverage/confirmed/assured/gap-rate) |
| `GET /trace/:correlationId` | Fio completo (F8): sinal→decisão→execução→confirmação→outcome |

## 3. Como um gap flui (detectar → sinalizar → corrigir → resolver)

1. **Detecção** é passiva e derivada — ninguém precisa "ligar" nada:
   - `OutcomeReconcilerService` (Scheduler horário, per-org) acha ações `done` sem
     `action_outcome` após a **janela de graça** (`graceMinutes`, default 15min — a medição
     é assíncrona, não se acusa o recém-concluído).
   - `ConfirmationEngine.sweepTimeouts` (Scheduler) acha confirmações vencidas.
2. **Sinalização** — cada gap vira um `business_signal` no domínio `outcome_assurance`
   (`done_without_outcome` / `confirmation_timed_out`) e aparece em `attention()`. É o canal
   canônico de exceção (ADR-136); **não há tabela de alerta paralela**.
3. **Correção** — `OutcomeCorrectionService.proposeCorrections` (ou `POST /assurance/correct`)
   lê os gaps abertos e **propõe** uma `DecisionAction` corretiva (`outcome_correction:*`),
   que nasce `awaiting_approval` e passa pela ApprovalPolicy/Autonomy Contract. **Nunca
   executa direto** (RN-OA-9).
4. **Resolução** — quando a medição atrasada chega (ou o efeito é confirmado), o Reconciler
   RESOLVE o sinal (`resolveByDedupe`); o sinal fica `resolved` (histórico preservado).

## 4. Ler as métricas

`GET /assurance/metrics` responde, na janela pedida:
- `outcomeCoveragePct` — das ações `done`, quantas foram medidas (o alvo do PRD 8);
- `effectConfirmedPct` / `assuredPct` — confirmação e garantia plena;
- `openGaps` por tipo + `gapRatePct`.

**Percentual `null` = não há ações concluídas na janela** — é honesto, não 0% (RN-OA-2). Um
`assuredPct` baixo com `openGaps` alto é o retrato de "muito DONE, pouco RESULTADO": a fila de
correções (`/assurance/correct`) é a resposta.

## 5. Adicionar um domínio ao resolver (system-of-record)

O `BusinessOutcomeResolverRegistry` é um **registry, não um enum**. Para um novo domínio:
1. Implementar `BusinessOutcomeResolver` (`domain`, `appliesTo(action)`, `resolve(orgId, action)`);
2. `resolve` **pergunta ao system-of-record** (SQL), nunca à IA (D3/RN-OA-6);
3. Sem prova no dado → `unknown` (RN-OA-2 — não inventa "resolveu" nem "falhou");
4. `BusinessOutcomeResolverRegistry.register(...)`. Pronto — o `assessAction` já consome.

Golden references já implementadas: Cobrança (`receivables.status='received'`), Comercial
(`sales_recovery_attributions`), Reputação (`business_signals.status='resolved'`), Varejo
(`retail_daily_closings.status`).

## 6. Guardrails que NÃO se regridem (RN-OA — codificados como regressão transversal na F13)

1. **`DONE ≠ RESULTADO`** (RN-OA-1) — `done` sem outcome confirmado é gap, nunca "sucesso"/`assured`.
2. **null ≠ zero; ausência ≠ falha** (RN-OA-2) — outcome/percentual não medido é `unknown`/`null`, nunca 0/fracasso.
3. **Assurance não muda estado** (RN-OA-3) — read-only; deriva por query, não escreve na FSM.
4. **fact/estimate/influenced nunca somados** (RN-OA-4) — herda `OutcomeMeasurementService`.
5. **Sem dupla contagem** (RN-OA-5) — `event_key` idempotente + dedup no ledger; um R$ conta uma vez.
6. **Determinístico antes de LLM** (RN-OA-6) — resolver pergunta ao system-of-record (SQL).
7. **Untrusted external data** (RN-OA-7) — confirmação externa é evidência, não fato automático.
8. **Não inventa dinheiro** (RN-OA-8) — sem prova, declara ausência.
9. **Correção governada** (RN-OA-9) — nada de correção fora de `DecisionAction→ApprovalPolicy→CommandExecutor`.

## 7. O que NÃO fazer

- **Não** criar Runtime/Policy/Confirmation/Impact-Ledger/Scheduler/tabela-de-alerta/learning-engine paralelos (mandato do operador).
- **Não** transformar o Assurance em executor: ele detecta/recomenda; execução segue governada.
- **Não** somar bases nem contar o mesmo R$ duas vezes.
- **Não** inventar valor/confirmação quando o system-of-record não confirma.

## 8. Relação com o PRD 9

O PRD 9 (Enterprise Learning) aprende sobre dado de resultado **confiável**. O PRD 8 é o
pré-requisito: garante que "resultado" no ZapFlow significa **outcome de negócio confirmado
e medido** — não "ação disparada". Sem ele, o PRD 9 aprenderia sobre `DONE`, não sobre
`RESULTADO`.
