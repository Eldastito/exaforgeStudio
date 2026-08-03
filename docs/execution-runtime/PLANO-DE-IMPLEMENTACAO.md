# Plano de Implementação — ZappFlow Execution Runtime

**PRD:** `docs/prd/PRD-ZAPPFLOW-EXECUTION-RUNTIME.md`
**ADR:** `docs/adr/ADR-152-zappflow-execution-runtime.md`
**Analise:** `ANALISE-ARQUITETURAL.md`
**Data:** 2026-08-03

Escopo revisado pela Fase 0: **4 fases + 3 pilotos**, não 8 (ver ADR-152 D1). Cada fase é um PR draft → CI verde → merge → próxima fase, seguindo o fluxo de fatias do repo (`CLAUDE.md`). Nenhuma quebra de comportamento em orgs existentes — `execution_runtime_enabled=0` e `execution_mode='assisted'` como default.

## Índice de fases

| Fase | Nome | Escopo | Pré‑req | Feature flag |
|---|---|---|---|---|
| 0 | Análise crítica | Este documento + 4 companions + ADR + PRD persistido | — | — |
| 1 | Process Fabric | `process_definitions`, `process_instances`, FSM, `ProcessRuntimeService`, aditivos em `decision_actions` | 0 | `execution_runtime_enabled` |
| 2 | Execute + Confirmation | Modo `execute` no `CommandExecutorService`; executores concretos (Asaas, WhatsApp, Alterdata, Scheduler); `ConfirmationEngine`; backoff+dead‑letter no JobQueue | 1 | `execution_runtime_enabled` + `execution_mode` |
| 3 | Outcomes estendidos + UI | Campos aditivos no `action_outcomes`; aba "Operações" no `ExecutiveView`; Exception Center categorizado | 1 | `autonomous_operations_ui_enabled` |
| 4a | **Piloto Retail Closing** | Playbook do fechamento; aprovação automática por política; SLA 9h | 1, 2, 3 | `retail_closing_runtime_enabled` |
| 4b | **Piloto Cobrança** | Playbook dunning lojista→cliente; interpretação de intenção; PIX; conciliação | 4a estável | `autonomous_collections_enabled` |
| 4c | **Piloto Recuperação Comercial** | Playbook do "Recuperar agora"; opt‑out; distribuição de responsável | 4b estável + revisão LGPD | `commercial_recovery_runtime_enabled` |

## Fase 0 — Análise crítica (esta fase)

**Entregáveis** (todos neste PR):
- [x] `docs/prd/PRD-ZAPPFLOW-EXECUTION-RUNTIME.md` (PRD verbatim)
- [x] `docs/adr/ADR-152-zappflow-execution-runtime.md`
- [x] `docs/execution-runtime/ANALISE-ARQUITETURAL.md`
- [x] `docs/execution-runtime/PLANO-DE-IMPLEMENTACAO.md` (este arquivo)
- [x] `docs/execution-runtime/STATUS-DE-EXECUCAO.md`
- [x] `docs/execution-runtime/DECISOES-E-PENDENCIAS.md`
- [x] `docs/execution-runtime/MATRIZ-DE-COBERTURA-DO-PRD.md`

**Critérios de aceite:** os 7 arquivos existem, referenciam entre si, e não há **nenhum** aditivo em `src/**` (só documentação).

**Rollback:** revert do commit; nada muda no runtime.

---

## Fase 1 — Process Fabric (Runtime v1)

**Objetivo:** transformar "ação única" em "processo com N etapas encadeadas por regras". Nenhum efeito externo novo — o teto continua em `prepare`. Esta fase habilita a Fase 2.

### Arquivos afetados

- `src/server/db.ts` — CREATE-then-ALTER estrito (convenção nº 2):
  - CREATE TABLE `process_definitions (id, organization_id, process_type, name, description, version, trigger_type, objective, autonomy_level_default, sla_definition, entry_conditions_json, success_conditions_json, failure_conditions_json, escalation_policy_json, steps_json, active, created_at, updated_at)` + `UNIQUE(organization_id, process_type, version)`.
  - CREATE TABLE `process_instances (id, organization_id, process_definition_id, process_type, subject_type, subject_id, status, priority, risk_level, expected_value, current_step, context_json, result_json, started_at, deadline_at, completed_at, failed_at, created_by, created_at, updated_at)` + índices por `(organization_id, status)`, `(organization_id, process_type)`, `(subject_type, subject_id)`.
  - CREATE TABLE `process_transitions (id, organization_id, process_instance_id, from_state, to_state, actor, reason, evidence_json, occurred_at)` — auditoria de FSM.
  - ALTER TABLE `decision_actions` ADD `process_instance_id TEXT` (nullable — retrocompatível).
  - ALTER TABLE `decision_actions` ADD `subject_type TEXT`, `subject_id TEXT`, `deadline_at DATETIME`, `attempt_count INTEGER DEFAULT 0`, `max_attempts INTEGER DEFAULT 3`, `success_condition_json TEXT`, `fallback_action_type TEXT`, `evidence_json TEXT`.
  - ALTER TABLE `organization_settings` ADD `execution_runtime_enabled INTEGER DEFAULT 0`.

- `src/server/ProcessRuntimeService.ts` — **novo**. Métodos: `defineProcess(orgId, def)`, `activateVersion(orgId, defId)`, `startFromSignal(orgId, signalId, opts)`, `startForSubject(orgId, processType, subject, ctx)`, `advance(orgId, instanceId)`, `cancel(orgId, instanceId, reason)`, `getInstance(orgId, instanceId)`, `listInstances(orgId, filters)`, `transition(orgId, instanceId, toState, evidence)` (privado, valida FSM). Isolado por org, auditado em `process_transitions`.

- `src/server/PlaybookEngine.ts` — **novo**. Puro (sem I/O). Métodos: `validateDefinition(def)` (Zod schema), `evaluateCondition(expr, ctx)` (JSON‑Logic subset), `chooseNextStep(def, current, ctx, result)`. Testável em isolamento.

- `src/server/routes/runtime.ts` — **novo**. `POST /api/runtime/definitions`, `GET /api/runtime/definitions`, `POST /api/runtime/instances`, `GET /api/runtime/instances/:id`, `POST /api/runtime/instances/:id/advance`, `POST /api/runtime/instances/:id/cancel`. RBAC granular (módulo `runtime` no ADR‑095).

- `src/server/routes/index.ts` — montar `/api/runtime` atrás de `enforceModulePermission`.

- `src/server/PermissionService.ts` — registrar módulo `runtime` em `RBAC_MODULES` + `ROUTE_MODULE` (segmento `/runtime`).

- `scripts/test-runtime-process-fabric.ts` — **novo**. Cobre: definir processo (validação Zod recusa `steps_json` inválido); versionar (v2 coexiste com v1 na mesma org, versão default = ativa); `startFromSignal` cria instância com `context_json` populado do sinal; transições válidas passam, inválidas viola; `advance` roda 1 passo determinístico; `cancel` transiciona pra `cancelled` sem executar próximos passos; isolamento multi‑tenant (org B não vê instância de A); auditoria (`process_transitions` grava cada transição).

- `package.json` — adicionar `"test:runtime-process-fabric": "tsx scripts/test-runtime-process-fabric.ts"`.

- CI (`.github/workflows/ci.yml`) — descobre automaticamente via `test:*` na matrix; **nada a mudar**.

### Critérios de aceite Fase 1
1. Todos os testes existentes continuam passando.
2. `test-runtime-process-fabric.ts` verde na CI.
3. `tsc --noEmit` limpo.
4. Nenhuma alteração de comportamento com `execution_runtime_enabled=0` (default).
5. Zero regressão em `decision_actions` (aditivos nullable).

### Rollback Fase 1
Feature flag `execution_runtime_enabled=0` desabilita as rotas `/api/runtime/*` (o `falatuGate`‑padrão retorna 403). Se necessário reverter o schema: revert do commit — nenhum dado de produção populou as tabelas novas ainda.

### Risco de regressão Fase 1
Baixo. Colunas aditivas em `decision_actions` são todas nullable; código existente ignora. FSM só é aplicada dentro do `ProcessRuntimeService` (nada legado passa por ela).

---

## Fase 2 — Execute + Confirmation Engine

**Objetivo:** subir o teto do `CommandExecutorService` de `prepare` para `execute` **governado**, adicionar executores concretos, e centralizar confirmação externa.

### Arquivos afetados

- `src/server/db.ts` — aditivos:
  - ALTER TABLE `agent_policies` ADD `execution_mode TEXT DEFAULT 'assisted'` (valores: `shadow | assisted | approved_execution | autonomous`).
  - CREATE TABLE `action_confirmations (id, organization_id, action_id, expected_at, confirmed_at, confirmation_method, evidence_json, status)` + `UNIQUE(organization_id, action_id)`.
  - Coluna `background_jobs.backoff_seconds INTEGER` + `background_jobs.error_class TEXT` (`retryable | non_retryable | permission | external_unavailable`).

- `src/server/CommandExecutorService.ts` — estender:
  - Novo `mode: 'execute'` no método (paralelo ao `prepare`).
  - Guardas: só quando `agent_policies.autonomy_level='execute'` E `execution_mode ∈ {approved_execution, autonomous}` E política de aprovação satisfeita.
  - Sub‑handler declarativo `{ timeoutSeconds, retryPolicy, confirmationMethod, reversibility, riskClassification }` por handler.
  - Toda tentativa auditada em `action_execution_log.mode='execute'`.

- `src/server/WhatsAppSendCommandHandler.ts` — **novo** (via `MessageProviderService.sendMessage`).
- `src/server/AsaasPixCommandHandler.ts` — **novo** (gera cobrança PIX + salva `qr_code_payload`).
- `src/server/AsaasChargeCommandHandler.ts` — **novo** (registra cobrança recorrente).
- `src/server/AlterdataFetchCommandHandler.ts` — **novo** (leitura; escrita fica adiada — ver `DECISOES-E-PENDENCIAS.md`).
- `src/server/SchedulerActionCommandHandler.ts` — **novo** (agenda próxima ação por `next_attempt_at`).

- `src/server/ConfirmationEngine.ts` — **novo**. Registry `Map<confirmationMethod, subscriber>` com subscribers para: `asaas_payment_webhook`, `retail_reconciliation_pass`, `channel_message_reply`, `alterdata_sync_pass`, `manual_completion`. Método `expect(orgId, actionId, method, deadline)` cria row em `action_confirmations`; método `confirm(orgId, actionId, evidence)` fecha a ação (chama `DecisionActionService.complete`) e avança o processo.

- `src/server/webhookProcessor.ts` — hook do Asaas passa a chamar `ConfirmationEngine.confirm(action_id, evidence)` além de atualizar `receivables`.

- `src/server/JobQueueService.ts` — adicionar backoff exponencial por tentativa (`2^attempt * 30s`), classificação de erro na captura do catch, exposição de dead‑letter (`listRecent(status='failed')`).

- `scripts/test-runtime-executor-execute.ts` — **novo**. Cobre: modo `execute` só roda com autonomy=execute + mode≥approved + policy=approved; `WhatsAppSendCommandHandler` chama `MessageProviderService.sendMessage` (mockado); auditoria da tentativa; erro externo classificado; backoff calculado; dead‑letter após max_attempts.

- `scripts/test-runtime-confirmation.ts` — **novo**. Cobre: `expect+confirm` fecha ação; webhook Asaas mockado dispara `confirm`; sem evidência esperada, ação NÃO fecha automaticamente; timeout de confirmação gera exceção; isolamento por org.

- `package.json`, CI — dois scripts novos.

### Critérios de aceite Fase 2
1. Regressão zero.
2. Ambos testes novos verdes.
3. Nenhum handler `execute` roda com `execution_mode='assisted'` (default).
4. Idempotência: reprocessar o mesmo webhook Asaas NÃO gera segundo `confirm` (retorna 200 sem efeito).
5. Dead‑letter aparece em `/api/runtime/instances?status=failed` (rota da Fase 1 ganha filtro).

### Rollback Fase 2
Volta `execution_mode` para `assisted` em todas as orgs (SQL simples). Handlers `execute` deixam de rodar; `prepare` continua funcionando como antes. Ou revert do commit inteiro.

---

## Fase 3 — Outcomes estendidos + UI

**Objetivo:** enriquecer `action_outcomes` com categorias explícitas do §11.11 e entregar a aba **Operações** no `ExecutiveView` com Exception Center categorizado.

### Arquivos afetados

- `src/server/db.ts` — aditivos:
  - ALTER TABLE `action_outcomes` ADD `time_saved_minutes INTEGER`, `cost_avoided REAL`, `revenue_recovered REAL`, `loss_prevented REAL`.

- `src/server/OutcomeMeasurementService.ts` — aceitar os 4 campos novos em `record()`; `ledger()` agrega por categoria.

- `src/server/RuntimeExceptionsService.ts` — **novo**. Deriva exceções de: (a) `process_instances.status IN (escalated, failed)`; (b) `decision_actions.status='approved' AND deadline_at < now`; (c) `background_jobs.status='failed'`; (d) `action_confirmations.expected_at + timeout < now AND status='pending'`. Categoriza (aprovação/decisão/dado faltante/integração/conflito/risco/divergência/SLA).

- `src/server/routes/runtime.ts` — `GET /api/runtime/operations/overview`, `GET /api/runtime/operations/exceptions`, `GET /api/runtime/operations/indicators`.

- `src/features/ExecutiveView.tsx` — aba **Operações** (paralela à "Plano de Ação"). Blocos: Em execução (contagem por processo_type), Concluído hoje (agregado do `ledger`), Exceções (lista categorizada com "consequência de não decidir"), Indicadores (contadores por estado, taxa de conclusão, SLA cumprido).

- `scripts/test-runtime-outcomes-extended.ts` + `scripts/test-runtime-exceptions.ts`.

### Critérios de aceite Fase 3
1. Regressão zero na aba "Plano de Ação" existente.
2. Aba nova respeita RBAC (usuário sem permissão do módulo `runtime` não vê).
3. Testes novos verdes.
4. Contagens da UI batem com queries SQL diretas (teste de integração).

### Rollback Fase 3
Feature flag `autonomous_operations_ui_enabled=0` esconde a aba (cosmético). Backend continua expondo — não quebra outros consumidores.

---

## Fase 4a — Piloto Retail Closing

**Por que primeiro:** 75% pronto; política clara; escopo por loja; baixo risco financeiro.

### Playbook `retail_daily_closing_v1`

```
steps:
  - id: fetch_erp_data
    executor: AlterdataFetchCommandHandler
    success_condition: erp_data_present
    timeout: 300s
    on_failure: retry(3) | escalate
    next: reconcile

  - id: reconcile
    executor: (delegate to RetailFloorReconciliationService.reconcileDay)
    success_condition: reconciled = true
    next: {
      if variance_within_tolerance AND documentation_complete: auto_approve
      else: escalate_to_manager
    }

  - id: auto_approve
    condition: variance_within_tolerance AND documentation_complete AND no_manual_change
    executor: (writes to financial_ledger + retail_commission_items)
    success_condition: financial_posted AND commission_calculated
    next: complete

  - id: escalate_to_manager
    executor: (create decision_action awaiting_approval, notify via WhatsApp digest)
    success_condition: (manager decision recorded)
    next: complete

  - id: complete
    executor: (record outcome: time_saved_minutes, evidence: reconciliation summary)
```

### Arquivos afetados

- `src/server/routes/runtime.ts` — endpoint para seed do playbook (só master admin ou dono).
- `src/server/RetailFloorReconciliationService.ts` — expor `reconcileDay(orgId, date)` idempotente (já é, só formalizar como command handler).
- `scripts/test-piloto-fechamento-retail.ts` — cenário completo: dados vindos do PDV → auto_approve → outcome; cenário divergência → escalate → decisão manual → complete; idempotência (2 execuções do processo no mesmo dia não duplicam commission).

### Critérios de aceite Fase 4a
1. Todos os itens §15.7 do PRD com evidência na `MATRIZ-DE-COBERTURA-DO-PRD.md`.
2. Rodar em `shadow` por 2 semanas em 1 org piloto (TOULON) — comparar decisão do Runtime × decisão humana.
3. Sair de `shadow` só quando concordância ≥ 95%.
4. `assisted` → `approved_execution` só quando o piloto conclui 20 fechamentos sem escalação inesperada.

### Rollback Fase 4a
`retail_closing_runtime_enabled=0` — os fechamentos voltam ao fluxo manual/atual. `process_definition` fica no banco mas sem instâncias novas.

---

## Fase 4b — Piloto Cobrança lojista→cliente

**Depende de:** Fase 4a estabilizada em produção.

### Playbook `receivable_collection_v1`

```
steps:
  - id: detect_due
    trigger: signal receivable_overdue
    executor: (start process)
    next: send_reminder_1

  - id: send_reminder_1
    executor: WhatsAppSendCommandHandler (with PIX QR from AsaasPixCommandHandler)
    success_condition: message_delivered
    timeout: 24h (waiting reply)
    next: {
      if payment_confirmed: complete_paid
      if reply_intent=promise_pay: wait_promised_date
      if reply_intent=dispute: escalate_to_manager
      if reply_intent=impossibility: escalate_to_manager
      if no_reply after 3d: send_reminder_2
    }

  - id: send_reminder_2, wait_promised_date, ... (similar structure)

  - id: complete_paid
    executor: (record outcome: revenue_recovered, evidence: payment_id)
```

### Arquivos afetados
- Novos handlers: já vieram na Fase 2.
- `AIOrchestratorService` gateway para `classify_intent` de resposta de cobrança (motor determinístico com fallback humano em ambiguidade — ver R3 da análise).
- `scripts/test-piloto-cobranca.ts` — cenários das 10 intenções do §13.4.

### Critérios de aceite Fase 4b
1. Todos os itens §13.7 do PRD.
2. `test-piloto-cobranca` com as 10 intenções, isolamento por org, dedupe de mensagem, idempotência de retentativa.
3. Piloto em `shadow` em 1 org por 2 semanas antes de `assisted`.

### Rollback Fase 4b
`autonomous_collections_enabled=0` + política volta pra `prepare`.

---

## Fase 4c — Piloto Recuperação Comercial

**Depende de:** Fase 4b estabilizada + **revisão jurídica/LGPD**.

### Playbook `commercial_opportunity_recovery_v1`

Análogo aos anteriores. Guardas específicos: (a) opt‑out do contato consultado ANTES de cada envio, (b) limite de contato/dia por contato, (c) horário permitido, (d) LGPD compliance com `logAuthEvent(..., maskIdentifier())`.

### Arquivos afetados
- `src/server/OpportunityRadarService.ts` — expor `startRecoveryProcess(orgId, opportunityId)`.
- `src/server/CustomerMemoryService.ts` — consulta rápida antes de cada envio.
- `scripts/test-piloto-recuperacao-comercial.ts`.
- **Botão "Recuperar agora"** na UI (`OpportunityRadarView`) passa a chamar `POST /api/runtime/instances` com preview antes de confirmar.

### Critérios de aceite Fase 4c
1. Todos os itens §14.6 do PRD.
2. LGPD signoff registrado em `DECISOES-E-PENDENCIAS.md`.
3. Piloto em `assisted` (não `autonomous`) enquanto opt‑out não passar por auditoria completa.

### Rollback Fase 4c
`commercial_recovery_runtime_enabled=0`; botão "Recuperar agora" volta ao comportamento atual.

---

## Feature flags — resumo

| Flag | Escopo | Default | Uso |
|---|---|---|---|
| `execution_runtime_enabled` | Org | 0 | Gate geral do `/api/runtime/*` |
| `execution_mode` (em `agent_policies`) | Por (org, action_type) | `assisted` | shadow/assisted/approved_execution/autonomous |
| `retail_closing_runtime_enabled` | Org | 0 | Piloto 1 |
| `autonomous_collections_enabled` | Org | 0 | Piloto 2 |
| `commercial_recovery_runtime_enabled` | Org | 0 | Piloto 3 |
| `autonomous_operations_ui_enabled` | Org | 0 | Aba "Operações" no ExecutiveView |

## Convenções obrigatórias em cada fase (do CLAUDE.md)

1. `organization_id` em TODA query. Cross‑tenant é bug de segurança.
2. CREATE‑then‑ALTER estrito em `db.ts` — nunca reordenar; aditivos no fim.
3. Snapshot canônico + hash para docs emitidos (não se aplica no Runtime).
4. HMAC signed URLs para artefatos externos.
5. Best‑effort services (deliveries) nunca throw pro caller.
6. Transação atômica com SELECT COUNT dentro para evitar race (padrão AC‑012).
7. Nunca DELETE — status='cancelled' preserva histórico.
8. Feature flags opt‑in em `organization_settings`.
9. Import dinâmico para quebrar ciclos.
10. Ao publicar sinal do Runtime, usar `BusinessSignalService` com `dedupe_key` — nunca tabela própria.

## Estimativa (grosseira)

| Fase | Fatias sugeridas | Complexidade |
|---|---|---|
| 0 | 1 (esta) | Baixa |
| 1 | 2–3 (schema+FSM, PlaybookEngine, rotas) | Média |
| 2 | 3–4 (execute+handlers, confirmation, backoff) | Alta |
| 3 | 2 (backend outcomes, UI aba) | Média |
| 4a | 2 (playbook, teste E2E) | Média |
| 4b | 3 (playbook, intent classifier, teste E2E) | Alta |
| 4c | 2 (playbook, LGPD hooks) | Média (pós‑jurídico) |

Total: **15–17 fatias / PRs**. Muito próximo do que o ADR-145 (Clínica) fez (15 fatias).
