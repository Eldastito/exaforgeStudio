# Status de Execução — ZappFlow Execution Runtime

**Instrução obrigatória** (PRD §3): a próxima sessão de trabalho da IA Dev DEVE começar lendo, em ordem:
1. `docs/prd/PRD-ZAPPFLOW-EXECUTION-RUNTIME.md` (fonte imutável)
2. `docs/adr/ADR-152-zappflow-execution-runtime.md` (decisões arquiteturais)
3. `docs/execution-runtime/ANALISE-ARQUITETURAL.md` (o que já existe no repo)
4. `docs/execution-runtime/DECISOES-E-PENDENCIAS.md` (bloqueios ativos)
5. `docs/execution-runtime/PLANO-DE-IMPLEMENTACAO.md` (o "como")
6. Este arquivo (o "onde parou")
7. `docs/execution-runtime/MATRIZ-DE-COBERTURA-DO-PRD.md` (rastreabilidade item‑a‑item)

**Não iniciar código sem antes atualizar este arquivo** com "sessão em andamento".

---

## Legenda
- `[ ]` Não iniciado
- `[~]` Em andamento
- `[x]` Concluído
- `[!]` Bloqueado (ver `DECISOES-E-PENDENCIAS.md §C`)
- `[-]` Removido após decisão (ver `DECISOES-E-PENDENCIAS.md §B`)

Cada atualização deve registrar: data, fase, item, arquivos alterados, testes executados, resultado, pendências, próximo passo.

---

## Fase 0 — Análise crítica

- [x] Ler PRD por completo
- [x] Analisar repositório atual (232 services, 152 ADRs, rotas, DB)
- [x] Identificar componentes reutilizáveis (ADR-136 Epic 2, ADR-085, ADR-073, ADR-074, ADR-091, ADR-095, ADR-058, ADR-150, ADR-046)
- [x] Comparar arquitetura proposta × real (`ANALISE-ARQUITETURAL.md §2`)
- [x] Apontar riscos/inconsistências (`ANALISE-ARQUITETURAL.md §5`)
- [x] Registrar ponderações técnicas (`ADR-152` + `ANALISE`)
- [x] Propor ajustes ao PRD (`DECISOES-E-PENDENCIAS.md §B`)
- [x] Plano em fases pequenas testáveis reversíveis (`PLANO-DE-IMPLEMENTACAO.md`)
- [x] Salvar 5 documentos + PRD + ADR (este PR)

**Fase 0 concluída.**

## Fase 1 — Process Fabric (Runtime v1)

### Fatia 1.1 — schema aditivo + `ProcessRuntimeService` mínimo — **ENTREGUE**
- [x] `db.ts` — CREATE `process_definitions`, `process_instances`, `process_transitions`; ALTER `decision_actions` (9 aditivos nullable); ALTER `organization_settings` (`execution_runtime_enabled`)
- [x] `ProcessRuntimeService.ts` — `defineProcess` (versionamento auto), `startForSubject` (dedupe por subject vivo), `startFromSignal` (carrega evidência), `advance` (detected→planned + retorna nextStep), `completeStep` (roteia por condição, `onFailure` fallback|escalate|fail, successCondition), `cancel`, `getInstance`, `listInstances`, `listTransitions`, `transition` (FSM validada com 13 estados + 27 transições)
- [x] `PlaybookEngine.ts` puro — `validateDefinition` (Zod-like manual, bloqueia refs quebradas / ids duplicados / commandType ausente / onFailure=fallback sem fallbackStep), `evaluateCondition` (truthy/eq/gte/lte/and/or/not), `chooseNextStep` (string direto, array de `{when, next}` com default, `$end`)
- [x] `routes/runtime.ts` — `runtimeGate` (flag `execution_runtime_enabled`, master bypass) + CRUD de definitions/instances + advance/complete-step/cancel/transition
- [x] `PermissionService.ts` — módulo `runtime` em `RBAC_MODULES` + `ROUTE_MODULE` + `RBAC_MODULE_LABELS`
- [x] `server.ts` — `protectedApi.use("/runtime", runtimeRoutes)`
- [x] `scripts/test-runtime-process-fabric.ts` — **42/42 checks PASS** (PlaybookEngine puro, defineProcess, startForSubject dedupe, FSM válida × inválida, roteamento por condição, successCondition, onFailure=escalate, cancel terminal, startFromSignal, isolamento multi-tenant, flag default 0, auditoria)
- [x] `package.json` — script `test:runtime-process-fabric`
- [x] Regressão: `test:decision-actions` (16/16), `test:outcome-measurement` (17/17), `test:command-executor` (17/17), `test:business-signals` (12/12), `test:impact-prioritization` (14/14), suítes do FalaTu (35+24+21+24+26+14) — zero regressão
- [x] `tsc --noEmit` limpo

**Critérios de aceite Fase 1 — todos cumpridos:**
1. Regressão zero em suítes existentes ✓
2. `test-runtime-process-fabric.ts` verde ✓
3. `tsc --noEmit` limpo ✓
4. Sem alteração de comportamento com `execution_runtime_enabled=0` (default) ✓
5. Zero regressão em `decision_actions` (todos aditivos nullable) ✓

**Rollback:** `execution_runtime_enabled=0` (default) bloqueia o `/api/runtime/*` via `runtimeGate` (403). Se necessário reverter o schema, revert do commit — nenhum dado de produção populou as tabelas novas ainda.

## Fase 2 — Execute + Confirmation

### Fatia 2.1 — Fundação (execution_mode + ConfirmationEngine + backoff) — **ENTREGUE**
- [x] `db.ts` — ALTER `agent_policies` ADD `execution_mode` (default `assisted`, retrocompat); ALTER `background_jobs` ADD `backoff_seconds/next_attempt_at/error_class` + índice; CREATE `action_confirmations` com `UNIQUE(org, action_id)` + índices por status/method
- [x] `ConfirmationEngine.ts` — 5 métodos registrados (`asaas_payment_webhook | retail_reconciliation | channel_reply | alterdata_sync | manual`); `expect` idempotente por (org, action); `confirm` fecha via `DecisionActionService.complete` (loop ADR-136 D6); idempotência webhook duplicado (já `confirmed` → devolve; ação `done/rejected/cancelled` → `dismissed` sem reabrir); `dismiss` humano; `sweepTimeouts` com `datetime()` parse (aceita ISO + formato SQLite)
- [x] `JobQueueService.ts` — `JobQueueError` com `errorClass ∈ {retryable | external_unavailable | permission | non_retryable}`; `computeBackoffSeconds` (30s base retryable, 60s external_unavailable, teto 30min, exponencial por tentativa); `permission/non_retryable` NÃO retentam (dead-letter imediato); `sweepStale` respeita `next_attempt_at`; `retry(manual)` reseta backoff; `deadLetters(orgId, limit)` pra Fase 3
- [x] `scripts/test-runtime-confirmation.ts` — **32/32 checks PASS**: execution_mode default; backoff correto por classe + teto; sweep respeitando backoff; permission → dead-letter imediato; dead-letter isolado por org; external_unavailable com backoff maior; confirm sem expect → 400; expect idempotente; confirm fecha ação + registra outcome; webhook duplicado NÃO reabre; race com rollback humano → `dismissed`; cross-tenant recusado; dismiss humano; sweepTimeouts fecha vencidas; listPending isolado
- [x] Regressão zero: 5 suítes ADR-136 (76/76) + `runtime-process-fabric` (42/42); `tsc --noEmit` limpo
- [x] `package.json` — script `test:runtime-confirmation`

**Critérios de aceite Fatia 2.1 — todos cumpridos:**
1. Nenhum executor externo dispara efeito real (Fatia 2.1 é fundação) ✓
2. `execute` na policy ainda não é consumido — teto continua em `prepare` (Fatia 2.2) ✓
3. Idempotência crítica (webhook 2x) testada ✓
4. Retrocompat total: default de `execution_mode = 'assisted'` mantém comportamento atual ✓

**Rollback:** `execution_runtime_enabled=0` desliga `/api/runtime/*` (nenhuma peça da 2.1 é chamada de fora do runtime); revert do commit reverte schema. Nada em produção usa Confirmation Engine ainda (subscribers plugam na 2.3).

### Fatia 2.2 — Modo `execute` no CommandExecutorService (guardas triplas) — **ENTREGUE**
- [x] `CommandExecutorService.ts` — método `execute(orgId, actionId)` async. Interface `CommandHandler.execute` (opcional) + `defaultExecute` fallback que retorna `{effect:'noop-2.2'}`. `registerHandler` público pra 2.3 plugar handlers concretos (WhatsApp/Asaas/Alterdata) sem tocar aqui.
- [x] 3 guardas em série, cada rejeição AUDITADA com `error_code` explícito em `action_execution_log`:
  - **G3 (primária)** — `action.status='approved'`; terminal (`done|rejected|cancelled`) → `action_terminal`; awaiting → `action_not_approved`
  - **G1** — `agent_policies.autonomy_level='execute'` (ativa) → falta = `policy_missing`; abaixo = `autonomy_below_execute`
  - **G2** — `execution_mode ∈ {approved_execution, autonomous}` (`shadow`/`assisted` = `execution_mode_blocked`)
- [x] `no_handler` auditado antes das guardas (falha estrutural precede decisão de política)
- [x] `routes/actions.ts` — `POST /api/actions/:id/execute` (só owner/admin) chama `CommandExecutorService.execute`
- [x] `scripts/test-runtime-executor-execute.ts` — **22/22 checks PASS**: cada `error_code` testado com `errorCodeOfLast()`; ordem correta de recusa (`action_not_approved` precede `policy_missing`); ambos `approved_execution` e `autonomous` executam; NO-OP com `effect='noop-2.2'`; `executed_at` populado; log separa `mode='prepare'` de `mode='execute'`; regressão do `prepare` intacta; `registerHandler` custom plugável; isolamento cross-tenant
- [x] Regressão zero: 5 suítes ADR-136 (76/76) + `runtime-process-fabric` (42/42) + `runtime-confirmation` (32/32); `tsc --noEmit` limpo
- [x] `package.json` — script `test:runtime-executor-execute`

**Contrato de confiança preservado.** Mesmo com `execute` no ar, nenhum handler nesta fatia dispara efeito externo — `defaultExecute` só retorna o mesmo `artifact` do `prepare` + `effect:'noop-2.2'`. A 2.3 sobe cada handler concreto individualmente, com `ConfirmationEngine.expect` amarrado. A mudança de "IA nunca escreve na base de negócio" fica auditável passo a passo.

### Fatia 2.3 — Handlers concretos + webhook Asaas → ConfirmationEngine — **ENTREGUE**
- [x] `RuntimeCommandHandlers.ts` — 3 handlers concretos auto-registrados via side-effect import no `server.ts`:
  - **WhatsAppSendCommandHandler** — via `MessageProviderService.sendMessage`; fire-and-forget (SEM `expect`); valida channel pertence à org (isolamento).
  - **AsaasPixChargeCommandHandler** — cria payment via `AsaasService._req('POST', '/payments')` e IMEDIATAMENTE chama `ConfirmationEngine.expect(action, 'asaas_payment_webhook', externalRef=paymentId, deadline=dueDate+30d)`. Guarda: se `expect` falhar após criar o payment, log WARN + devolve externalRef mesmo assim (`sweepTimeouts` fecha depois).
  - **AlterdataFetchCommandHandler** — leitura idempotente via `AlterdataConnectorService`; sem `expect`; classifica erros como `permission | external_unavailable | retryable`.
- [x] `throwHandler(class, msg)` + classificação por status HTTP (Asaas) / mensagem (Alterdata) → `JobQueueError`-ready
- [x] `ConfirmationEngine.expect` aceita `externalRef` (fixa retroativamente numa pending SEM sobrescrever ref já definida)
- [x] `ConfirmationEngine.findByExternalRef(method, ref)` — subscriber recebe só o id externo (webhook Asaas conhece `payment.id`, não org)
- [x] `db.ts` — aditivo `action_confirmations.external_ref` + índice UNIQUE parcial `(org, method, external_ref)`
- [x] `AsaasService.handleWebhook` — passo aditivo `notifyRuntimeConfirmation(payment, confirmed)` fecha `action_confirmations` viva quando `payment.id` casa. **Aditivo puro:** fluxo billing intacto (asaas-billing 16/16, billing-dunning 10/10). Best-effort: erro no hook Runtime NÃO afeta resposta do webhook.
- [x] `Scheduler.confirmationTimeoutPass` chama `ConfirmationEngine.sweepTimeouts()` a cada tick
- [x] `server.ts` — side-effect import de `RuntimeCommandHandlers` no boot
- [x] `scripts/test-runtime-execute-e2e.ts` — **27/27 checks PASS** (E2E com mocks de MessageProvider + AsaasService._req + AsaasService.getPayment): WhatsApp end-to-end; AsaasPix cria payment + expect com externalRef; `findByExternalRef`; webhook Asaas fecha ação com evidência; webhook duplicado NO-OP; payment desconhecido NO-OP silencioso; `Scheduler.confirmationTimeoutPass` fecha vencidas; validações de payload; Alterdata sem connector → recusa OK; regressão do `prepare`; registry com 8 handlers; isolamento cross-tenant.
- [x] Regressão zero: 5 suítes ADR-136 (76/76) + runtime-process-fabric (42/42) + runtime-confirmation (32/32) + runtime-executor-execute (22/22) + **asaas-billing (16/16) + billing-dunning (10/10)** (críticos porque tocam o webhook Asaas); `tsc --noEmit` limpo
- [x] `package.json` — script `test:runtime-execute-e2e`

**Fase 2 CONCLUÍDA.** Execute + Confirmation Engine no ar, ponta a ponta. Handlers concretos disparam efeito externo real (WhatsApp, PIX) atrás das 3 guardas + `execution_runtime_enabled` da org. Nada muda em produção com defaults: `execution_runtime_enabled=0` + `execution_mode='assisted'`.

### Fatia 2.3 — Handlers concretos + webhook Asaas → ConfirmationEngine — **ENTREGUE**
- [x] `RuntimeCommandHandlers.ts` — 3 handlers concretos auto-registrados via side-effect import no `server.ts`:
  - **WhatsAppSendCommandHandler** — via `MessageProviderService.sendMessage`; fire-and-forget (SEM `expect`); valida channel pertence à org (isolamento).
  - **AsaasPixChargeCommandHandler** — cria payment via `AsaasService._req('POST', '/payments')` e IMEDIATAMENTE chama `ConfirmationEngine.expect(action, 'asaas_payment_webhook', externalRef=paymentId, deadline=dueDate+30d)`. Guarda: se `expect` falhar após criar o payment, log WARN + devolve externalRef mesmo assim (`sweepTimeouts` fecha depois).
  - **AlterdataFetchCommandHandler** — leitura idempotente via `AlterdataConnectorService`; sem `expect`; classifica erros como `permission | external_unavailable | retryable`.
- [x] `throwHandler(class, msg)` + classificação por status HTTP (Asaas) / mensagem (Alterdata) → `JobQueueError`-ready
- [x] `ConfirmationEngine.expect` aceita `externalRef` (fixa retroativamente numa pending SEM sobrescrever ref já definida)
- [x] `ConfirmationEngine.findByExternalRef(method, ref)` — subscriber recebe só o id externo (webhook Asaas conhece `payment.id`, não org)
- [x] `db.ts` — aditivo `action_confirmations.external_ref` + índice UNIQUE parcial `(org, method, external_ref)`
- [x] `AsaasService.handleWebhook` — passo aditivo `notifyRuntimeConfirmation(payment, confirmed)` fecha `action_confirmations` viva quando `payment.id` casa. **Aditivo puro:** fluxo billing intacto (asaas-billing 16/16, billing-dunning 10/10). Best-effort: erro no hook Runtime NÃO afeta resposta do webhook.
- [x] `Scheduler.confirmationTimeoutPass` chama `ConfirmationEngine.sweepTimeouts()` a cada tick
- [x] `server.ts` — side-effect import de `RuntimeCommandHandlers` no boot
- [x] `scripts/test-runtime-execute-e2e.ts` — **27/27 checks PASS** (E2E com mocks de MessageProvider + AsaasService._req + AsaasService.getPayment): WhatsApp end-to-end; AsaasPix cria payment + expect com externalRef; `findByExternalRef`; webhook Asaas fecha ação com evidência; webhook duplicado NO-OP; payment desconhecido NO-OP silencioso; `Scheduler.confirmationTimeoutPass` fecha vencidas; validações de payload; Alterdata sem connector → recusa OK; regressão do `prepare`; registry com 8 handlers; isolamento cross-tenant.
- [x] Regressão zero: 5 suítes ADR-136 (76/76) + runtime-process-fabric (42/42) + runtime-confirmation (32/32) + runtime-executor-execute (22/22) + **asaas-billing (16/16) + billing-dunning (10/10)** (críticos porque tocam o webhook Asaas); `tsc --noEmit` limpo
- [x] `package.json` — script `test:runtime-execute-e2e`

**Fase 2 CONCLUÍDA.** Execute + Confirmation Engine no ar, ponta a ponta. Handlers concretos disparam efeito externo real (WhatsApp, PIX) atrás das 3 guardas + `execution_runtime_enabled` da org. Nada muda em produção com defaults: `execution_runtime_enabled=0` + `execution_mode='assisted'`.

## Fase 3 — Outcomes estendidos + UI Operações

### Fatia 3.1 — Backend (outcomes estendidos + RuntimeExceptionsService + rotas) — **ENTREGUE**
- [x] `db.ts` — ALTER `action_outcomes` ADD `time_saved_minutes`, `cost_avoided`, `revenue_recovered`, `loss_prevented` (aditivos nullable, ADR-085 D4 preservado — categorias NÃO somadas entre si)
- [x] `OutcomeMeasurementService.record` aceita as 4 categorias; `ledger()` agrega em `totals.categories.{timeSavedMinutes, costAvoided, revenueRecovered, lossPrevented}` — fact × estimate ainda separados (regressão do ADR-136 D6 intacta)
- [x] `RuntimeExceptionsService.ts` — DERIVA exceções de 4 fontes: (a) `process_instances.status IN (escalated, failed)`; (b) `decision_actions.status='approved' AND deadline_at < now` (SLA); (c) `background_jobs.status='failed'` classificado por `error_class` (permission → credential_missing; external_unavailable → integration_failed; non_retryable → conflict); (d) `action_confirmations.status='timed_out'`. Categorias PRD §11.12; ordem por severidade (credential_missing → sla_at_risk → integration_failed → ...). NUNCA cria tabela — só lê.
- [x] `RuntimeExceptionsService.overview` — running/completedToday/exceptionsCount/slaBreached. Escalated NÃO conta em running (já aparece como exceção `decision_needed`).
- [x] `RuntimeExceptionsService.indicators` — contadores por status pra cards do painel.
- [x] `routes/runtime.ts` — 4 GETs novos: `/operations/overview`, `/operations/exceptions`, `/operations/indicators`, `/operations/ledger` (com categorias). Atrás do `runtimeGate` (flag opt-in da org) + RBAC granular do módulo `runtime`.
- [x] `scripts/test-runtime-operations.ts` — **31/31 checks PASS**: campos aditivos gravados/lidos; record antigo (sem categorias) grava null; ledger agrega por CATEGORIA sem somar entre si; fact × estimate separados (regressão); 4 fontes de exceção (process escalated, deadline vencido, job dead-letter com error_class, confirmation timed_out); ordem por severidade; count agrega por categoria; overview (running exclui escalated, completedToday agrega categorias, slaBreached); indicators; isolamento cross-tenant em todos os métodos.
- [x] Regressão zero: 5 suítes ADR-136 (76/76) + runtime-process-fabric (42/42) + runtime-confirmation (32/32) + runtime-executor-execute (22/22) + runtime-execute-e2e (27/27) + asaas-billing (16/16) + billing-dunning (10/10); `tsc --noEmit` limpo
- [x] `package.json` — script `test:runtime-operations`

### Fatia 3.2 — Aba "Operações" no ExecutiveView — **ENTREGUE**
- [x] `src/features/ExecutiveView.tsx` — aba `Operações` paralela à "Plano de Ação". Gateada por `isMasterAdmin || canAccessModule('runtime')` (cosmético; segurança real é `runtimeGate + enforceModulePermission` no backend).
- [x] `OperacoesTab` consome as 4 rotas de F3.1 em paralelo:
  - **Bloco 1 "Em execução":** `overview.running.{processes, awaitingApproval, awaitingConfirmation}` + `exceptionsCount`.
  - **Bloco 2 "Concluído hoje":** `overview.completedToday.{processes, actions, outcomes.count, outcomes.realized}` + 4 cards SEPARADOS pra categorias explícitas (`timeSavedMinutes | revenueRecovered | costAvoided | lossPrevented`) — com nota explicando "nunca somamos entre elas" (ADR-085 D4).
  - **Bloco 3 "Exceções categorizadas":** lista com badge colorido por categoria (`credential_missing` vermelho, `sla_at_risk` amarelo, `integration_failed` laranja, `conflict` fúcsia), label humano-legível da fonte (`process_escalated | action_overdue | job_dead_letter | confirmation_timeout`), tempo relativo ("há 5 min"), `recommendedAction` como legenda itálica.
  - **Bloco 4 "Indicadores":** 8 cards de contadores (processes total/failed/escalated, actions awaiting, confirmations pending/timed_out, jobs pending/failed) — destaques em amarelo quando > 0.
- [x] 403 do backend → tela dedicada "Execution Runtime desligado" com instruções pro operador ligar a flag e configurar `agent_policies` — não deixa a UI travada com erro genérico.
- [x] Helpers puros: `relativeTime(iso)`, `minutesLabel(m)`, `sourceLabel(source)`, `exceptionColor(category)`. Reusa `<Metric>` e `<EmptyHint>` existentes da aba Plano de Ação (regressão zero).
- [x] `tsc --noEmit` limpo; regressão zero (nenhuma alteração de comportamento nas outras abas — só adicionou tab condicional).

**Fase 3 CONCLUÍDA.** Backend + UI no ar. Nenhum efeito externo novo (todas as rotas são GET). Nada muda em produção sem `execution_runtime_enabled=1` na org.

## Fase 4a — Piloto Retail Closing — **ENTREGUE**
- [x] `RetailClosingPlaybook.ts` — 3 handlers concretos + definição do playbook + `RetailClosingPlaybookService.seed/start`:
  - `retail_reconcile_day` — chama `RetailFloorReconciliationService.runDay` (ADR-150 F6, idempotente só-promove).
  - `retail_post_closing` — `FinancialLedgerService.recordEvent(direction=in, sourceType=retail_closing, sourceId=storeId:date)`. Idempotência via `UNIQUE(org, source_type, source_id)` do cash_events. Registra outcome F3.1 com `time_saved_minutes=15`.
  - `retail_closing_dispatch` — decide auto_post × escalate × skipped a partir de `context.results.reconcile`. Regra: `absGap <= tolerancePct * erpTotal + R$ 0.01` E `unmatched == 0` → auto; senão → cria DecisionAction awaiting_approval; `erpTotal=0 && declaredCount=0` → skipped_no_sales.
- [x] `RETAIL_DAILY_CLOSING_V1` (playbook JSON tipado — ADR-152 D3): `reconcile → post_dispatch → $end`. Decisão aritmética fica no handler porque o subset JSON-Logic do PlaybookEngine ainda não faz `mul/abs` (F5 futura pode enriquecer).
- [x] `ProcessRuntimeService.runStep` + `runToCompletion` (novo — peça faltante da F1). Amarra `advance → propose+approve → execute → completeStep` em loop. Import dinâmico pra quebrar ciclos; guard anti-loop com `maxSteps`.
- [x] `TERMINAL` do FSM expandido pra `{cancelled, measured, completed, failed}` (bug: o runner continuava em `completed` — regressão validada pelo teste antigo passando).
- [x] Rotas: `POST /api/runtime/retail-closing/seed` (idempotente), `POST /api/runtime/retail-closing/start` (deduplica por subject vivo), `POST /api/runtime/instances/:id/run` (runner).
- [x] `server.ts` — side-effect import do playbook.
- [x] `scripts/test-piloto-fechamento-retail.ts` — **26/26 checks PASS**: seed idempotente; contexto persistido; runToCompletion auto-post (cash_event lançado com valor ERP, source_id correto, outcome F3.1); idempotência (UNIQUE bloqueia 2ª run); escalate (fora da tolerância → DecisionAction awaiting_approval, ZERO cash_event); no_sales (skipped, sem cash_event); isolamento cross-tenant; execução com policy faltando (dispatch falha, nada lançado).
- [x] Regressão zero: 5 suítes ADR-136 (76/76) + 5 suítes runtime anteriores (154/154) + asaas-billing (16/16) + billing-dunning (10/10); `tsc --noEmit` limpo.

**Decisões pendentes 1, 2, 5, 8, 9, 10 do §F — RESOLVIDAS 2026-08-03** (ver DECISOES-E-PENDENCIAS.md §F atualizada). Decisões 3 (nome UI) resolvida na F3.2. Decisões 4 (LGPD), 6 (Nível 5) e 7 (Sicredi) travam etapas futuras (F4c, escopo pós-piloto).

**Régua operacional (D9):** o Runtime já pode rodar em produção com `execution_runtime_enabled=1` + policies `execute` + `execution_mode=shadow` — o operador monitora pelo painel Operações e compara com decisão humana. Só promove pra `assisted → approved_execution → autonomous` conforme concordância ≥95%/2 semanas.

## Fase 4a.1 — Refinamentos pós-piloto (adiado)
- [ ] Comissão retail: reusar `PerformanceFeeService` no `retail_post_closing` (mencionado no §15.7 do PRD; fora do MVP da F4a por escopo).
- [ ] Conector Sicredi (§15.3 PRD, decisão pendente #7 resolvida como "escopo futuro").
- [ ] Enriquecer PlaybookEngine com `mul`/`abs` pra o `dispatch` voltar pra dentro do JSON.

## Fase 4b — Piloto Cobrança
- [ ] Depende de F4a estável

## Fase 4c — Piloto Recuperação Comercial
- [!] BLOQUEADO em decisão 4 do `DECISOES-E-PENDENCIAS.md §F` (revisão LGPD)

---

## Log de sessões

### Sessão 2026-08-03 (Fase 0)
- **Fase:** 0
- **Itens executados:** todos os 9 itens acima da Fase 0
- **Arquivos criados:**
  - `docs/prd/PRD-ZAPPFLOW-EXECUTION-RUNTIME.md`
  - `docs/adr/ADR-152-zappflow-execution-runtime.md`
  - `docs/execution-runtime/ANALISE-ARQUITETURAL.md`
  - `docs/execution-runtime/PLANO-DE-IMPLEMENTACAO.md`
  - `docs/execution-runtime/STATUS-DE-EXECUCAO.md` (este)
  - `docs/execution-runtime/DECISOES-E-PENDENCIAS.md`
  - `docs/execution-runtime/MATRIZ-DE-COBERTURA-DO-PRD.md`
- **Arquivos alterados:** nenhum em `src/**` (Fase 0 = só documentação, conforme PRD §20)
- **Testes executados:** nenhum (Fase 0 não altera código executável)
- **Resultado:** Fase 0 concluída; 6 documentos + 1 ADR + 1 PRD persistidos no repo
- **Pendências criadas:** 10 decisões do dono do produto em `DECISOES-E-PENDENCIAS.md §F` (destaques: escolha de piloto, Sicredi, LGPD, nome da aba)
- **Próximo passo:** aguardar aprovação para iniciar Fase 1 / Fatia 1.1. **Antes do primeiro código, revisitar as decisões pendentes 5 (ordem dos pilotos) e 8 (org piloto).**

### Sessão 2026-08-03 (Fatia 1.1 do ADR-152 — Process Fabric)
- **Fase:** 1
- **Itens executados:** todos os 10 itens da Fatia 1.1 (schema, PlaybookEngine, ProcessRuntimeService, rotas, RBAC, server.ts wiring, teste, package.json, regressão, tsc)
- **Arquivos criados:**
  - `src/server/PlaybookEngine.ts` (motor puro)
  - `src/server/ProcessRuntimeService.ts` (FSM + Process Fabric)
  - `src/server/routes/runtime.ts`
  - `scripts/test-runtime-process-fabric.ts`
- **Arquivos alterados:**
  - `src/server/db.ts` (aditivos: 3 tabelas novas + 9 colunas em decision_actions + `execution_runtime_enabled`)
  - `src/server/PermissionService.ts` (módulo `runtime` em RBAC_MODULES + ROUTE_MODULE + labels)
  - `server.ts` (import + `protectedApi.use("/runtime", ...)`)
  - `package.json` (`test:runtime-process-fabric`)
  - `docs/execution-runtime/STATUS-DE-EXECUCAO.md` (esta atualização)
  - `docs/execution-runtime/MATRIZ-DE-COBERTURA-DO-PRD.md` (status atualizado dos itens F1)
- **Testes executados:**
  - `npm run test:runtime-process-fabric` → **42/42 PASS**
  - Regressão ADR-136: decision-actions 16/16, outcome-measurement 17/17, command-executor 17/17, business-signals 12/12, impact-prioritization 14/14
  - Regressão FalaTu: 6 suítes (35+24+21+24+26+14 = 144/144)
  - `npx tsc --noEmit` → limpo (exit 0)
- **Resultado:** Fatia 1.1 concluída — Process Fabric no ar, com feature flag desligada. Nenhuma quebra em produção.
- **Pendências criadas:** nenhuma nova; as 10 decisões pendentes do dono (§F) continuam bloqueando F4a/F4c mas não afetam F1.2 ou F2.
- **Próximo passo:** aguardar aprovação para iniciar **Fatia 1.2** (opcional — se dividirmos) ou pular direto pra **Fase 2 (Execute + Confirmation)**. Recomendo Fase 2 direto: F1 já entrega o Process Fabric completo em uma fatia. F1.2 se torna desnecessária.

### Sessão 2026-08-03 (Fatia 2.1 do ADR-152 — Confirmation Engine + JobQueue backoff)
- **Fase:** 2
- **Itens executados:** todos os 5 da Fatia 2.1 (schema aditivo, ConfirmationEngine com 5 métodos, JobQueue backoff+error_class+dead-letter, teste, package.json)
- **Arquivos criados:**
  - `src/server/ConfirmationEngine.ts` (peça fina; subscribers vazios — Fatia 2.3 pluga)
  - `scripts/test-runtime-confirmation.ts` (32/32 checks)
- **Arquivos alterados:**
  - `src/server/db.ts` (aditivos: execution_mode + 3 colunas em background_jobs + tabela action_confirmations)
  - `src/server/JobQueueService.ts` (JobQueueError + computeBackoffSeconds + retry reseta + deadLetters)
  - `package.json` (`test:runtime-confirmation`)
  - `docs/execution-runtime/STATUS-DE-EXECUCAO.md` (esta atualização)
- **Testes executados:**
  - `npm run test:runtime-confirmation` → **32/32 OK**
  - Regressão: `test:decision-actions` 16/16, `test:outcome-measurement` 17/17, `test:command-executor` 17/17, `test:business-signals` 12/12, `test:impact-prioritization` 14/14, `test:runtime-process-fabric` 42/42
  - `npx tsc --noEmit` → limpo (exit 0)
- **Resultado:** Fatia 2.1 concluída — fundação da Fase 2 no ar. Nenhum efeito externo novo. Feature flag `execution_runtime_enabled=0` continua sendo o gate; nada muda em produção.
- **Pendências criadas:** nenhuma nova. As 10 decisões pendentes do dono (§F) continuam bloqueando F4a/F4c.
- **Próximo passo:** Fatia 2.2 (subir teto do CommandExecutorService pra `execute` governado, sem handlers externos novos — só guardas triplas), aguardando aprovação. Alternativa: passar direto pra Fatia 2.3 (handlers concretos) se o dono julgar que 2.2 é overhead — mas separar torna a mudança de contrato de confiança do produto explicitamente auditável.

### Sessão 2026-08-03 (Fatia 2.2 do ADR-152 — execute governado no CommandExecutorService)
- **Fase:** 2
- **Itens executados:** todos os 6 da Fatia 2.2 (método execute + 3 guardas + auditoria com error_code + rota /api/actions/:id/execute + handler custom via registerHandler + teste)
- **Arquivos criados:**
  - `scripts/test-runtime-executor-execute.ts` (22/22 checks)
- **Arquivos alterados:**
  - `src/server/CommandExecutorService.ts` (adicionou execute + defaultExecute + registerHandler; prepare intacto)
  - `src/server/routes/actions.ts` (POST /:id/execute)
  - `package.json` (test:runtime-executor-execute)
  - `docs/execution-runtime/STATUS-DE-EXECUCAO.md` (esta atualização)
  - `docs/execution-runtime/MATRIZ-DE-COBERTURA-DO-PRD.md` (§11.5 executor completo + §11.7 nível 4)
- **Testes executados:**
  - `npm run test:runtime-executor-execute` → **22/22 OK**
  - Regressão ADR-136: 76/76 (decision-actions 16, outcome 17, command-executor 17, signals 12, priority 14) — o `command-executor` original passou intacto, confirmando que o `prepare` não regride
  - `runtime-process-fabric` 42/42, `runtime-confirmation` 32/32
  - `npx tsc --noEmit` → limpo
- **Resultado:** Fatia 2.2 concluída — teto do executor subido pra `execute`. **Nenhum efeito externo real ainda** — handlers rodam NO-OP (`effect:'noop-2.2'`). O contrato "IA não escreve na base de negócio" continua valendo até a 2.3.
- **Pendências criadas:** nenhuma nova. As 10 decisões pendentes do dono (§F) seguem bloqueando F4a/F4c mas não afetam a 2.3.
- **Próximo passo:** **Fatia 2.3** — handlers concretos (WhatsAppSend/AsaasPix/AsaasCharge/AlterdataFetch/SchedulerAction) + `webhookProcessor` chamando `ConfirmationEngine.confirm` + `Scheduler.confirmationTimeoutPass`. Aguardando aprovação.

### Sessão 2026-08-03 (Fatia 2.3 do ADR-152 — handlers concretos + webhook Asaas)
- **Fase:** 2 (última fatia — Fase 2 CONCLUÍDA)
- **Itens executados:** todos os 10 da Fatia 2.3 (3 handlers concretos, ConfirmationEngine.externalRef + findByExternalRef, aditivo action_confirmations.external_ref + UNIQUE parcial, AsaasService.handleWebhook estendido, Scheduler.confirmationTimeoutPass, server.ts side-effect, teste E2E)
- **Arquivos criados:**
  - `src/server/RuntimeCommandHandlers.ts` (WhatsAppSend + AsaasPixCharge + AlterdataFetch, auto-registrados)
  - `scripts/test-runtime-execute-e2e.ts` (27/27 checks)
- **Arquivos alterados:**
  - `src/server/db.ts` (ALTER action_confirmations ADD external_ref + índice UNIQUE parcial)
  - `src/server/ConfirmationEngine.ts` (expect aceita externalRef; findByExternalRef novo)
  - `src/server/AsaasService.ts` (notifyRuntimeConfirmation dentro do handleWebhook — aditivo puro)
  - `src/server/Scheduler.ts` (import ConfirmationEngine + confirmationTimeoutPass no tick)
  - `server.ts` (side-effect import de RuntimeCommandHandlers)
  - `package.json` (test:runtime-execute-e2e)
  - `docs/execution-runtime/STATUS-DE-EXECUCAO.md`
- **Testes executados:**
  - `npm run test:runtime-execute-e2e` → **27/27 OK**
  - Regressão ADR-136 (76/76); runtime-process-fabric (42/42); runtime-confirmation (32/32); runtime-executor-execute (22/22)
  - Regressão CRÍTICA (tocamos webhook Asaas): asaas-billing 16/16; billing-dunning 10/10
  - `npx tsc --noEmit` → limpo
- **Resultado:** Fase 2 CONCLUÍDA. Runtime dispara efeito externo real ponta-a-ponta atrás de 4 gates (execution_runtime_enabled + policy + autonomy=execute + execution_mode≥approved_execution). Nenhuma org existente afetada (todos os defaults bloqueiam).
- **Pendências criadas:** nenhuma nova.
- **Próximo passo:** **Fase 3 — Outcomes estendidos + UI Operações** (aba no ExecutiveView + Exception Center categorizado + campos aditivos em action_outcomes). É lógica read-mostly + UI; não sobe efeito externo novo. As 10 decisões pendentes do dono (§F) seguem bloqueando F4a/F4c mas não afetam F3.

### Sessão 2026-08-03 (Fatia 3.1 do ADR-152 — outcomes estendidos + RuntimeExceptionsService)
- **Fase:** 3
- **Itens executados:** todos os 7 da Fatia 3.1 (aditivos action_outcomes, OutcomeMeasurementService estendido, RuntimeExceptionsService com 4 fontes categorizadas, 4 GETs em /operations, teste, package.json)
- **Arquivos criados:**
  - `src/server/RuntimeExceptionsService.ts` (list + count + overview + indicators)
  - `scripts/test-runtime-operations.ts` (31/31 checks)
- **Arquivos alterados:**
  - `src/server/db.ts` (4 aditivos em action_outcomes)
  - `src/server/OutcomeMeasurementService.ts` (RecordOutcomeInput + record + ledger com categorias)
  - `src/server/routes/runtime.ts` (4 GETs em /operations/*)
  - `package.json` (test:runtime-operations)
  - `docs/execution-runtime/STATUS-DE-EXECUCAO.md`
  - `docs/execution-runtime/MATRIZ-DE-COBERTURA-DO-PRD.md`
- **Testes executados:**
  - `npm run test:runtime-operations` → **31/31 OK**
  - Regressão: 5 suítes ADR-136 (76/76); runtime-process-fabric (42/42); runtime-confirmation (32/32); runtime-executor-execute (22/22); runtime-execute-e2e (27/27); asaas-billing (16/16); billing-dunning (10/10)
  - `npx tsc --noEmit` → limpo
- **Resultado:** Fatia 3.1 concluída — backend do Exception Center + campos categorizados no outcomes. Sem UI ainda (Fatia 3.2). Nenhum efeito externo novo — só queries de leitura sobre estado existente.
- **Pendências criadas:** nenhuma nova.
- **Próximo passo:** **Fatia 3.2** — aba "Operações" no ExecutiveView consumindo as 4 rotas de /operations. Cosmético + guardado por RBAC. Aguardando aprovação.

### Sessão 2026-08-03 (Fatia 3.2 do ADR-152 — aba "Operações" no ExecutiveView)
- **Fase:** 3 (última fatia — Fase 3 CONCLUÍDA)
- **Itens executados:** todos os 5 da Fatia 3.2 (aba condicional gateada por RBAC frontend, OperacoesTab com 4 blocos consumindo as 4 rotas da F3.1, tela dedicada pra 403 do runtimeGate, helpers puros, regressão via tsc)
- **Arquivos criados:** nenhum novo
- **Arquivos alterados:**
  - `src/features/ExecutiveView.tsx` (+~180 linhas — imports, tab type, tab condicional, OperacoesTab, helpers)
  - `docs/execution-runtime/STATUS-DE-EXECUCAO.md`
  - `docs/execution-runtime/MATRIZ-DE-COBERTURA-DO-PRD.md`
- **Testes executados:**
  - Regressão runtime + ADR-136: 8 suítes (31+42+32+22+27+16+17+17 = 204/204)
  - `npx tsc --noEmit` → limpo (exit 0)
- **Resultado:** Fatia 3.2 concluída — aba Operações no ar, guardada por 3 camadas (RBAC frontend cosmético + RBAC backend + runtimeGate flag). Nada muda em produção sem `execution_runtime_enabled=1`. Fase 3 CONCLUÍDA.
- **Pendências criadas:** nenhuma nova.
- **Próximo passo:** **Fase 4 — pilotos**. Retail Closing (4a) → Cobrança (4b) → Recuperação Comercial (4c). BLOQUEADAS nas 10 decisões pendentes do dono do produto (§F do DECISOES-E-PENDENCIAS.md — Sicredi, LGPD, org piloto, régua do shadow, etc). Sem essas decisões, F4 não sai.

### Sessão 2026-08-03 (Fatia 4a do ADR-152 — Piloto Retail Closing)
- **Fase:** 4a (Piloto 1 dos 3)
- **Itens executados:** todos os 8 da Fatia 4a (3 handlers concretos, playbook JSON, runner runStep/runToCompletion, TERMINAL expandido, 3 rotas, seed helper, teste E2E, docs)
- **Arquivos criados:**
  - `src/server/RetailClosingPlaybook.ts` (handlers + definição + seed service)
  - `scripts/test-piloto-fechamento-retail.ts` (26/26 checks)
- **Arquivos alterados:**
  - `src/server/ProcessRuntimeService.ts` (TERMINAL expandido + runStep + runToCompletion)
  - `src/server/routes/runtime.ts` (3 rotas: seed, start, run)
  - `server.ts` (side-effect import)
  - `package.json` (test:piloto-fechamento-retail)
  - `docs/execution-runtime/DECISOES-E-PENDENCIAS.md` (6 decisões marcadas RESOLVIDAS)
  - `docs/execution-runtime/STATUS-DE-EXECUCAO.md`
- **Testes executados:**
  - `npm run test:piloto-fechamento-retail` → **26/26 OK**
  - Regressão: 5 suítes ADR-136 (76/76); 5 suítes runtime anteriores (154/154); asaas-billing 16/16; billing-dunning 10/10
  - `npx tsc --noEmit` → limpo
- **Bug encontrado e corrigido:** `TERMINAL` do FSM só tinha `cancelled` e `measured`, então o runner continuava tentando `completeStep` numa instance já `completed` (que transiciona só pra `measured`). Fix: expandir pra `{cancelled, measured, completed, failed}` — teste antigo `runtime-process-fabric` 42/42 continua verde.
- **Resultado:** Fatia 4a concluída — piloto Retail Closing pronto. Runtime dispara efeito real (`FinancialLedgerService.recordEvent`) atrás de 4 camadas: `execution_runtime_enabled=1` + 3 policies `execute+approved_execution` (steps runtime + retail_post_closing). Sem essas camadas, nada muda. Régua operacional shadow → assisted → approved_execution → autonomous fica com o dono (não codificada; monitorada pela aba Operações F3.2 comparando decisão Runtime × humana).
- **Pendências criadas:** F4a.1 opcional (comissão retail + Sicredi + PlaybookEngine mul/abs) — adiadas pós-piloto.
- **Próximo passo:** **Fatia 4b** (Piloto 2 — Cobrança lojista→cliente). Reusa `AsaasPixChargeCommandHandler` + `ConfirmationEngine.expect(asaas_payment_webhook)` da F2.3 + intent classifier pra respostas do cliente (via `AIOrchestratorService`). Playbook `receivable_collection_v1` com steps: `detect_due → send_reminder → wait_reply → interpret_intent → (promise|dispute|pay|escalate|next_reminder)`. Aguardando aprovação.

### Sessão 2026-08-03 (Fatia 4b do ADR-152 — Piloto Cobrança MVP)
- **Fase:** 4b (Piloto 2 dos 3)
- **Itens executados:** MVP conservador da Cobrança — playbook `receivable_collection_v1` de 1 step composto (`collection_send_reminder`) que faz PIX+expect+WhatsApp num handler só; F4b.2 (intent classifier via AIOrchestrator) e F4b.3 (cadência multi-tentativa) ficaram para fatias subsequentes por não bloquearem o loop de ponta-a-ponta do piloto.
- **Arquivos criados:**
  - `src/server/CollectionPlaybook.ts` (CollectionSendReminderHandler async + RECEIVABLE_COLLECTION_V1 + CollectionPlaybookService.seed/start + guardas G-4b-1..5)
  - `scripts/test-piloto-cobranca.ts` (38/38 checks E2E)
- **Arquivos alterados:**
  - `src/server/DecisionActionService.ts` — `complete` aceita opcional `categoryOutcomes` (F3.1) e propaga a `OutcomeMeasurementService.record`. Aditivo puro (opcional; comportamento anterior preservado quando `undefined`).
  - `src/server/ConfirmationEngine.ts` — `ConfirmInput.categoryOutcomes` opcional; `confirm` propaga a `DecisionActionService.complete`.
  - `src/server/AsaasService.ts` — `notifyRuntimeConfirmation` categoriza como `revenueRecovered = paidValue` quando a ação amarrada é `collection_send_reminder` ou `asaas_pix_charge` (heurística conservadora — futuras integrações Asaas passam sem categoria até serem listadas).
  - `src/server/routes/runtime.ts` — 2 rotas: `POST /collection/seed`, `POST /collection/start`.
  - `server.ts` — side-effect import de `CollectionPlaybook.js`.
  - `package.json` — script `test:piloto-cobranca`.
  - `docs/execution-runtime/MATRIZ-DE-COBERTURA-DO-PRD.md` — §13 Piloto Cobrança MVP marcado.
  - `docs/execution-runtime/STATUS-DE-EXECUCAO.md` (esta seção).
- **Testes executados:**
  - `npm run test:piloto-cobranca` → **38/38 OK**
  - Regressão relevante: `test:runtime-process-fabric` (42/42), `test:runtime-executor-execute` (22/22), `test:runtime-execute-e2e` (27/27), `test:runtime-operations` (31/31), `test:piloto-fechamento-retail` (26/26), `test:asaas-billing` (16/16), `test:runtime-confirmation` (32/32), `test:outcome-measurement` (17/17), `test:decision-actions` (16/16), `test:retail-insight-action` (8/8)
  - `npx tsc --noEmit` → limpo
- **Decisões micro:** o step composto (1 handler = PIX + expect + WhatsApp) foi escolhido em vez de 2 steps (`asaas_pix_charge → whatsapp_send`) porque a mensagem de cobrança precisa do `paymentId` do PIX E de um template específico com PIX embutido — combinar deixa a intent clara e evita que o handler WhatsApp genérico "conheça" formato de cobrança. Se F4b.2 quebrar em stages `wait_reply → interpret_intent`, o `send_reminder` continua atômico.
- **Cross-service change auditada:** a extensão de `DecisionActionService.complete` com `categoryOutcomes` opcional é usada hoje só pela Cobrança via `ConfirmationEngine`. Retail (F4a) grava categoria direto no handler (`OutcomeMeasurementService.record` in-band) — não passa por essa via — logo continua funcionando idêntico.
- **Resultado:** Fatia 4b concluída — piloto Cobrança MVP pronto. Fluxo E2E: `POST /collection/start` → `runToCompletion` → PIX criado no Asaas → WhatsApp enviado com QR/link → `ConfirmationEngine.expect(asaas_payment_webhook, paymentId)` amarrado com deadline `dueDate+30d` → webhook Asaas casa `payment.id` → `DecisionActionService.complete(result_amount=paidValue)` + outcome F3.1 com `revenueRecovered=paidValue`. Timeout: `Scheduler.confirmationTimeoutPass` fecha como `timed_out` → aparece na aba Operações (F3.2) como exceção `integration_failed` (dono decide reenviar/escalar/dispensar). Runtime dispara efeito real (PIX + msg WhatsApp) atrás das mesmas 4 camadas: `execution_runtime_enabled=1` + policies `execute+approved_execution` (runtime_step_send_reminder + collection_send_reminder).
- **Pendências criadas:**
  - F4b.2 — intent classifier via `AIOrchestratorService` interpreta 10 respostas do cliente (§13.4 do PRD: "vou pagar", "manda o pix", "já paguei", "posso parcelar?", "não reconheço", etc). Adiciona steps `wait_reply → interpret_intent → (promise/dispute/escalate/pay/pause)`.
  - F4b.3 — cadência multi-tentativa: se não pagou em N dias, envia 2ª lembrança (mais firme) e 3ª (com aviso de negativação). Cada tentativa é um novo step / nova instância.
- **Próximo passo:** **Fatia 4c** (Piloto 3 — Recuperação Comercial). BLOQUEADA na decisão #4 (§F/§L do DECISOES-E-PENDENCIAS.md) — jurídico precisa validar contato proativo em massa a leads sob LGPD (mesmo em base de cadastro próprio). Cobrança (F4b) é diferente: cliente já é dono do crédito no ZappFlow, LGPD é sobre relacionamento comercial pré-existente.

### Sessão 2026-08-03 (Fatia 4b.2 do ADR-152 — Intent Classifier + Reply Router de Cobrança)
- **Fase:** 4b.2 (extensão do Piloto 2)
- **Itens executados:** classifier via `AIOrchestratorService`-adjacent (`chat` do `llm.ts`) + reply router hookado no `webhookProcessor` antes da IA + sinais publicados via `BusinessSignalService` (padrão ADR-136 C1) + reply canned por intent + teste E2E com mock.
- **Arquivos criados:**
  - `src/server/CollectionIntentClassifier.ts` — 10 intents PT-BR (§13.4 PRD) + `unknown` fallback. JSON mode + whitelist estrita. Setter `__setClassifierChatForTests` isolado ao módulo pra mock (ESM modules frozen).
  - `src/server/CollectionReplyService.ts` — `tryHandle` correlaciona reply→cobrança viva (join `action_confirmations` pending × `decision_actions` command_type=`collection_send_reminder` approved), classifica, publica sinal, retorna reply canned. Guardas G-4b.2-1..5.
  - `scripts/test-cobranca-intent-classifier.ts` — **35/35 checks** (10 intents, 4 fallbacks unknown, isolamento cross-tenant, correlação por contactId+phone, dedupe, audit log).
- **Arquivos alterados:**
  - `src/server/webhookProcessor.ts` — insere hook após `ClinicReminderReplyService.tryHandle` (linha 405) e antes do `AIOrchestratorService.processMessage` (linha 407). Best-effort com try/catch.
  - `package.json` — script `test:cobranca-intent-classifier`.
  - `docs/execution-runtime/MATRIZ-DE-COBERTURA-DO-PRD.md` — §13 atualiza 4 critérios que estavam BLOQUEADOS na F4b.2.
- **Testes executados:**
  - `npm run test:cobranca-intent-classifier` → **35/35 OK**
  - Regressão: `test:piloto-cobranca` (38/38), `test:runtime-execute-e2e` (27/27), `test:runtime-confirmation` (32/32), `test:runtime-operations` (31/31), `test:business-snapshot` (18/18), `test:clinic-reminder-reply` (37/37), `test:business-signals` (12/12), `test:decision-actions` (16/16)
  - `npx tsc --noEmit` → limpo
- **Decisões micro:** (i) intents `resend_pix|promise|dispute|claims_paid|installment|partial|hardship|callback_later|escalate_human|churn` viram sinal + reply canned; classifier NUNCA age direto (G-4b.2-1) — o dono decide na aba Operações / painel de sinais. (ii) correlação prioriza cobrança MAIS RECENTE quando contato tem 2+ abertas (tiebreaker `created_at DESC, rowid DESC` pra sobreviver ao SQLite `CURRENT_TIMESTAMP` de precisão-segundo). (iii) `resend_pix` MVP só sinaliza; a re-emissão automática do PIX fica pra F4b.3 (precisa integrar `AsaasService.getPayment` pra recuperar QR/link). (iv) dedupe unknown inclui hash da mensagem — sinais consecutivos "unclassified" do mesmo contato não somem num único.
- **Cross-service change auditada:** hook no `webhookProcessor` é ADITIVO PURO — se import falhar ou `tryHandle` retornar `{handled:false}`, o fluxo AI segue inalterado. Nenhum caller pré-existente muda comportamento.
- **Resultado:** Fatia 4b.2 fecha as 4 lacunas do §13.7 do PRD que a F4b (MVP) tinha deixado abertas: "Respostas alteram fluxo", "Promessa agenda nova verificação" (via sinal → dono decide), "Cadência executada" (parcial — MVP + reply router), "Testes cobrem positivo e negativo" agora com 10 intents cobertas. Sem OPENAI_API_KEY, tudo cai pra `unknown` — nenhuma resposta é mal-interpretada.
- **Pendências criadas:**
  - F4b.3 — cadência multi-tentativa (2ª/3ª lembrança) + re-emissão automática de PIX no intent `resend_pix` (integração `AsaasService.getPayment` pra recuperar QR/link).
  - F4b.4 (nova) — agendar re-check automático quando intent=`promise` (via `SchedulerActionCommandHandler` ou `ScheduleWakeup`-equivalente). Hoje o sinal é publicado mas o dono precisa lembrar de conferir na data prometida.
- **Próximo passo:** decidir com o dono se F4b.3 (mais automação de cobrança) ou F4c (Recuperação Comercial — que segue bloqueada em decisão #4 LGPD) vem primeiro.

### Sessão 2026-08-03 (Fatia 4b.3 do ADR-152 — Cadência multi-tentativa + Resend PIX)
- **Fase:** 4b.3 (extensão da F4b/F4b.2 — Piloto Cobrança)
- **Itens executados:** 2 subsistemas independentes na mesma fatia:
  - (A) **Cadência multi-tentativa** — Scheduler.collectionCadencePass roda a cada tick, envia T2 (firme) aos D+3 dias e T3 (aviso de negativação) aos D+7 dias se cliente não respondeu e cobrança segue viva.
  - (B) **Resend PIX automático** — CollectionReplyService quando intent=`resend_pix` chama AsaasService.getPayment + envia WhatsApp com invoiceUrl (não gera PIX novo — reusa o pending).
- **Arquivos criados:**
  - `src/server/CollectionCadenceService.ts` — `tickAll` + `runForOrg` + guardas G-4b.3-1..10.
  - `src/server/CollectionResendPixService.ts` — `sendNow` + fail-loud via BusinessSignal.
  - `scripts/test-cobranca-cadencia-multitentativa.ts` — **38/38 checks** (18 cadência + 6 resend + 14 misc/isolamento).
- **Arquivos alterados:**
  - `src/server/db.ts` — nova tabela `collection_followup_attempts` (UNIQUE(org, action, attempt_number)) + 3 aditivos org_settings (`collection_cadence_enabled INTEGER DEFAULT 0`, `collection_reminder_2_days_after_due INTEGER DEFAULT 3`, `collection_reminder_3_days_after_due INTEGER DEFAULT 7`). Aditivos posicionados após F3.1 (linha 7302), antes de `initDb();`.
  - `src/server/Scheduler.ts` — nova `collectionCadencePass()` (import dinâmico) chamada no tick após `confirmationTimeoutPass` (ordem importa: T2/T3 usa o estado atualizado das confirmações).
  - `src/server/CollectionReplyService.ts` — expõe `channelId` no LiveCollection + chama `CollectionResendPixService.sendNow` quando intent=`resend_pix` (fallback pra reply canned genérica se resend falha).
  - `package.json` — script `test:cobranca-cadencia-multitentativa`.
  - `docs/execution-runtime/MATRIZ-DE-COBERTURA-DO-PRD.md` — §13 atualiza "Cadência executada pelo Runtime" pra [x].
- **Testes executados:**
  - `npm run test:cobranca-cadencia-multitentativa` → **38/38 OK**
  - Regressão sem quebras: `test:cobranca-intent-classifier` (35/35), `test:piloto-cobranca` (38/38), `test:runtime-execute-e2e` (27/27), `test:runtime-confirmation` (32/32), `test:runtime-operations` (31/31), `test:asaas-billing` (16/16), `test:business-signals` (12/12), `test:clinic-reminder-reply` (37/37), `test:runtime-process-fabric` (42/42)
  - `npx tsc --noEmit` → limpo
- **Decisões micro:**
  - (i) **Cadência opt-in por org** via `collection_cadence_enabled=0` default. Orgs pré-existentes NÃO ganham cadência automática sem o dono ativar (evita spam pós-deploy).
  - (ii) **T3 apenas informativa** ("vamos precisar informar as agências de proteção ao crédito", não "vou negativar amanhã") — CDC §42/§71. Publica sinal severity=`risk` pro dono acompanhar; NÃO negativa de fato.
  - (iii) **Idempotência por INSERT-first**: reservamos a linha de attempt ANTES de enviar; se UNIQUE colide, outro tick pegou. Se envio falha, DELETE + BusinessSignal + próximo tick retenta.
  - (iv) **Cliente respondeu pausa cadência** — busca em `auth_audit_logs` por `RUNTIME_COLLECTION_REPLY_INTERPRETED` (F4b.2). Qualquer intent (inclusive `unknown`) pausa; o dono decide próximo passo via aba Operações.
  - (v) **Resend PIX reusa paymentId existente** (não cria novo no Asaas) — evita confusão pro cliente e polução no dashboard Asaas.
  - (vi) **invoiceUrl** em vez de PIX copia-cola bruto — página do Asaas dá QR + copia-cola + boleto + cartão num link único, UX melhor.
- **Cross-service change:** hook `CollectionReplyService` → `CollectionResendPixService.sendNow` é ADITIVO — se sendNow retorna `sent:false`, o reply canned original continua sendo devolvido. Nenhum caller pré-existente muda comportamento.
- **Resultado:** F4b.3 fecha os últimos gaps do §13.7 do PRD ("Cadência executada pelo Runtime"). Runtime agora COBRA sozinho (T1 inicial + T2 firme + T3 aviso) atrás de 4 camadas: `execution_runtime_enabled=1` + policies `execute+approved_execution` + `collection_cadence_enabled=1` + resposta do cliente pausa. E responde `resend_pix` reenviando o link real — não apenas prometendo.
- **Pendências criadas:**
  - F4b.4 (nova) — agendar re-check automático quando intent=`promise` via `SchedulerActionCommandHandler`. Hoje o sinal é publicado mas o dono precisa lembrar de conferir na data prometida.
- **Próximo passo:** decidir com o dono se F4b.4 (automação restante do promise) ou F4c (Recuperação Comercial — bloqueada em decisão #4 LGPD) vem primeiro.

### Sessão 2026-08-04 (Fatia 4b.4 do ADR-152 — Re-check automático de promessa de pagamento)
- **Fase:** 4b.4 (fecha o loop de cobrança autônoma iniciado no F4b/4b.2/4b.3)
- **Itens executados:** classifier estendido pra extrair `promiseDate` do LLM quando intent=promise + nova tabela `collection_payment_promises` (UNIQUE parcial por status='pending') + service `CollectionPromiseService.create/tickAll/runForOrg` + `Scheduler.collectionPromiseCheckPass` no tick (após F4b.3 pra ver estado atualizado). Ao promise chegar a data: cliente pagou → mark fulfilled + resolve o sinal reply_promise; ainda open → mark broken + envia WhatsApp follow-up + sinal risk.
- **Arquivos criados:**
  - `src/server/CollectionPromiseService.ts` — create + tickAll + guardas G-4b.4-1..9.
  - `scripts/test-cobranca-promise-recheck.ts` — **33/33 checks** (4 classifier + 8 create + 21 checkPass/tick).
- **Arquivos alterados:**
  - `src/server/db.ts` — nova tabela `collection_payment_promises` + aditivo `collection_promise_grace_days INTEGER DEFAULT 0`. Aditivos posicionados após F4b.3 (final do initDb).
  - `src/server/CollectionIntentClassifier.ts` — `ClassificationResult.promiseDate?: string | null`. Prompt estendido pra pedir data (com `{TODAY}` substituído). Validação estrita YYYY-MM-DD + rejeita valores fora do padrão (fallback null).
  - `src/server/CollectionReplyService.ts` — quando intent=promise, chama `CollectionPromiseService.create` best-effort. Só cria se `channelId + phone + dueDate` disponíveis (senão follow-up automático não conseguiria enviar).
  - `src/server/Scheduler.ts` — nova `collectionPromiseCheckPass()` chamada no tick após `collectionCadencePass` (ordem importa: F4b.3 e F4b.4 dividem `collection_cadence_enabled` opt-in).
  - `package.json` — script `test:cobranca-promise-recheck`.
  - `docs/execution-runtime/MATRIZ-DE-COBERTURA-DO-PRD.md` — §13 "Promessa agenda nova verificação" vira [x].
- **Testes executados:**
  - `npm run test:cobranca-promise-recheck` → **33/33 OK**
  - Regressão sem quebras: `test:cobranca-intent-classifier` (35/35), `test:cobranca-cadencia-multitentativa` (38/38), `test:piloto-cobranca` (38/38), `test:runtime-execute-e2e` (27/27), `test:runtime-confirmation` (32/32), `test:runtime-operations` (31/31), `test:business-signals` (12/12), `test:clinic-reminder-reply` (37/37), `test:asaas-billing` (16/16)
  - `npx tsc --noEmit` → limpo
- **Decisões micro:**
  - (i) **`SchedulerActionCommandHandler` genérico (mencionado no ADR/PLANO) fica aspiracional** — pro caso pontual da F4b.4 (re-check de promessa) o padrão `Scheduler.*Pass` já vem funcionando (F4b.3). Um handler genérico só se justifica se ≥2 domínios precisarem agendar comandos futuros — hoje só cobrança precisa. Nota adicionada em PLANO-DE-IMPLEMENTACAO.md pra revisar em F4c.
  - (ii) **Opt-in compartilhado** com F4b.3 (`collection_cadence_enabled`). Quem opta por cadência autônoma opta pelo re-check.
  - (iii) **G-4b.4-2**: promiseDate no passado (LLM confuso ou "amanhã" enquanto hoje já é depois de amanhã) → fallback pra `hoje+1`. Nunca cria promise com data já vencida.
  - (iv) **UNIQUE parcial** (só `pending`) permite: cliente promete, quebra, promete de novo (adiou). A anterior fica `broken`/`cancelled` no histórico; só há 1 pending por vez.
  - (v) **WA falha preserva PENDING** — não avança `checked_at`, próximo tick retenta (mesmo padrão F4b.3).
  - (vi) **Fulfilled resolve reply_promise via resolveByDedupe** — o sinal atention do painel some quando o loop fecha; o dono não fica revisando promessa já cumprida.
- **Cross-service change:** hook em CollectionReplyService é ADITIVO — só cria promise se `intent=promise` + campos disponíveis; caller pré-existente não muda. Ordem no Scheduler.tick preserva chain existente (confirmationTimeoutPass → collectionCadencePass → collectionPromiseCheckPass).
- **Resultado:** Loop de cobrança autônoma FECHADO. Runtime hoje:
  1. Envia lembrete inicial + PIX (F4b).
  2. Interpreta 10 tipos de resposta (F4b.2).
  3. Re-envia PIX quando cliente pede (F4b.3).
  4. Cadência automática de 2ª/3ª tentativa se cliente não responde (F4b.3).
  5. Agenda re-check da data prometida quando cliente diz "vou pagar" e cobra follow-up se não pagou (F4b.4).
  6. Marca revenue_recovered no ledger F3.1 quando webhook Asaas confirma.
  Tudo atrás de guardrails opt-in por-org + policies + audit log completo.
- **Pendências criadas:** nenhuma nova. Todas as fatias F4b* estão fechadas.
- **Próximo passo:** F4c (Piloto Recuperação Comercial) — segue BLOQUEADA em decisão #4 LGPD do dono (§F do DECISOES-E-PENDENCIAS.md — contato proativo em massa a leads exige revisão jurídica). Alternativas: (a) refactor genérico do SchedulerActionCommandHandler pra reuso em F4c; (b) fechar Piloto Cobrança com CLI de setup/rollout (padrão do TOULON no ADR-150).

### Sessão 2026-08-04 (Fatia 4c do ADR-152 — Piloto Recuperação Comercial MVP)
- **Fase:** 4c (Piloto 3 dos 3, MVP em modo `approved_execution`)
- **Escopo escolhido:** F4c MVP **PROPÕE, NÃO ENVIA autonomamente** — respeita a decisão pendente #4 (LGPD signoff pra modo `autonomous`) e a R10 (F4c permanece em assisted/approved até revisão jurídica). Runtime detecta deals parados, gera mensagem via LLM, publica sinal — dono aprova/edita/dispensa via UI. G-4c-1 é a guarda-mãe: nenhuma mensagem sai do Runtime sem batida explícita do dono na rota `POST /api/runtime/sales-recovery/proposals/:id/approve`.
- **Arquivos criados:**
  - `src/server/SalesStalledDealDetectorService.ts` — detecta `tickets` no funil (`stage ∈ {qualificado, proposta, negociacao, orcamento}`) + `status='open'` + `updated_at < now - stalledDays` + sem msg inbound recente do contato. Puro/read-only.
  - `src/server/SalesRecoveryMessageGenerator.ts` — gera texto via `chat()` do llm.ts. Fallback pra template estático (source='template') quando LLM ausente/erro. Sanitiza nome contra prompt injection. Setter `__setGeneratorChatForTests` isolado.
  - `src/server/SalesRecoveryPlaybook.ts` — handler `sales_recovery_propose_message` (registra sinal, NÃO envia) + playbook `sales_recovery_v1` de 1 step + `SalesRecoveryPlaybookService.seed/proposeForTicket/detectAndProposeAll/approve/dismiss/listOpenProposals`. Aprovação/dispensa registram audit + `resolveByDedupe` do sinal.
  - `scripts/test-piloto-sales-recovery.ts` — **41/41 checks** (9 detector + 5 generator + 27 playbook/rotas incluindo isolamento cross-tenant, dedupe, WA-fail, ticket-saiu-do-funil).
- **Arquivos alterados:**
  - `src/server/db.ts` — aditivos `sales_recovery_enabled INTEGER DEFAULT 0` + `sales_recovery_stalled_days INTEGER DEFAULT 10`. Nenhuma tabela nova (reusa `business_signals` pra proposta, `tickets` pra fonte).
  - `server.ts` — side-effect import de `SalesRecoveryPlaybook.js`.
  - `src/server/routes/runtime.ts` — 5 rotas F4c: `/sales-recovery/{seed,detect,proposals,proposals/:id/approve,proposals/:id/dismiss}`.
  - `src/server/Scheduler.ts` — nova `salesRecoveryDetectionPass()` chamada após `collectionPromiseCheckPass` no tick. Opt-in por-org.
  - `package.json` — script `test:piloto-sales-recovery`.
  - `docs/execution-runtime/MATRIZ-DE-COBERTURA-DO-PRD.md` — §14 atualiza 5 critérios.
- **Testes executados:**
  - `npm run test:piloto-sales-recovery` → **41/41 OK**
  - Regressão sem quebras: `test:piloto-cobranca` (38/38), `test:cobranca-intent-classifier` (35/35), `test:cobranca-cadencia-multitentativa` (38/38), `test:cobranca-promise-recheck` (33/33), `test:runtime-execute-e2e` (27/27), `test:runtime-confirmation` (32/32), `test:runtime-operations` (31/31), `test:business-signals` (12/12), `test:piloto-fechamento-retail` (26/26), `test:runtime-process-fabric` (42/42)
  - `npx tsc --noEmit` → limpo
- **Decisões micro:**
  - (i) **`SchedulerActionCommandHandler` genérico continua aspiracional** — F4c não precisou (padrão `Scheduler.*Pass` já cobre). Só se ≥2 domínios precisarem no futuro.
  - (ii) **Nenhuma tabela nova pra propostas** — reusa `business_signals` (severity=attention, signal_type=`sales_recovery_proposed`, dedupe por ticket+dia). A UI já sabe listar sinais (`listOpenProposals` é conveniência sobre `BusinessSignalService.list`).
  - (iii) **Approval-first**: `approve()` reconfirma ticket ainda open+stage-válido ANTES de enviar (o dono pode ter deixado a proposta na fila por dias; o ticket pode ter fechado no meio-tempo). E toca `tickets.updated_at` no envio pra o detector NÃO re-propor amanhã.
  - (iv) **`messageOverride` no approve()** — fluxo padrão: dono revisa proposta, edita texto se quiser, aprova. Sem obrigar edição.
  - (v) **Dedupe do sinal por dia** (`sales_recovery:proposed:${ticketId}:${todayIso}`) — se o detector varrer 2× num dia antes do dono decidir, atualiza a mesma linha em vez de spam.
  - (vi) **Detector filtra msg inbound recente do CONTATO** (não bot/agent) — se o cliente respondeu em qualquer canal, o dono do funil está ativo e não precisa de "recuperação".
- **Cross-service:** rotas usam mesmo `runtimeGate` do resto (flag `execution_runtime_enabled=1` + RBAC do módulo `runtime`). Ordem no Scheduler.tick preserva chain existente e coloca F4c depois de F4b (cobrança tem SLA mais duro, recuperação é discovery). ADITIVO PURO — nenhum caller pré-existente muda.
- **Resultado:** Loop de Recuperação Comercial em produção HOJE em modo `approved_execution`. Runtime detecta oportunidades comerciais paradas (via `tickets.stage + updated_at + messages`) + propõe mensagem de reengajamento (LLM ou template) + aguarda decisão humana. Aprovar → envia via WhatsApp + resolve sinal + registra outcome F3.1. Dispensar → resolve sem enviar + registra motivo. Sem OPENAI_API_KEY, F4c continua funcionando (template estático).
- **Pendências criadas:**
  - **F4c.2** — reply router (`SalesRecoveryReplyService`, padrão F4b.2) pra interpretar resposta do cliente após reengajamento (intents: `interested`, `not_now`, `remove_me` → LGPD opt-out).
  - **F4c.3** — cadência multi-tentativa (padrão F4b.3): se dono aprovou mas não veio resposta em N dias, propõe 2ª msg. **Depende de decisão #4 LGPD ainda.**
  - **F4c.4** — medição `revenueRecovered` real: quando `ticket.stage` vira `ganho` após recovery approval, atualiza outcome F3.1 com valor real (hoje registra `revenue_recovered=0`).
  - **F4c.5** — UI dedicada (`SalesRecoveryPanel` no ExecutiveView) — MVP usa aba Operações genérica.
- **Próximo passo:** **Piloto Cobrança está 100% completo (F4b + 4b.2 + 4b.3 + 4b.4)**; **Piloto Recuperação Comercial MVP 100% completo (F4c)** em modo approved_execution. Ambos os pilotos autoconsistentes. Decidir com o dono: (a) CLI de rollout (`zappflow-collection-tenant-setup.ts`) pra ativar piloto Cobrança numa org piloto; (b) F4c.4 (medição revenueRecovered real do sales recovery); (c) F4c.2 (reply router de recuperação); (d) agendar revisão LGPD pra desbloquear modo autonomous.

### Sessão 2026-08-04 (Fatia 4c.2 do ADR-152 — Reply Router de Recuperação Comercial + opt-out LGPD)
- **Fase:** 4c.2 (fecha o loop de recuperação comercial iniciado no F4c MVP)
- **Escopo:** interceptar RESPOSTAS de recuperação (após F4c MVP enviar), classificar em 7 intents (`interested`, `meeting_request`, `not_now`, `objection`, `remove_me`, `already_bought`, `unknown`), publicar sinal categorizado + reply canned. Formalizar opt-out LGPD via `contacts.marketing_opt_out=1` (F4c detector já filtra por essa flag na próxima varredura).
- **Arquivos criados:**
  - `src/server/SalesRecoveryReplyClassifier.ts` — 7 intents PT-BR. JSON mode + enum whitelist. Prompt prioriza `remove_me` (interpretação protetiva LGPD). Setter `__setSalesReplyChatForTests`.
  - `src/server/SalesRecoveryReplyService.ts` — `tryHandle(orgId, contactId, phone, text)` correlaciona reply → touch recente (janela `sales_recovery_reply_window_days` default 14) via query `sales_recovery_touches`, classifica, publica sinal, atualiza touch com `reply_intent + reply_signal_id`. `remove_me` seta `marketing_opt_out=1` ATOMICAMENTE. `recordTouch(...)` chamado pelo F4c.approve() após envio bem-sucedido.
  - `scripts/test-sales-recovery-reply.ts` — **44/44 checks** (10 classifier + 14 tryHandle intents/janela/isolamento + 20 integração F4c+F4c.2/LGPD/edge).
- **Arquivos alterados:**
  - `src/server/db.ts` — nova tabela `sales_recovery_touches` (id, org, ticket, contact, phone, channel, proposed_signal_id, approved_by, message_id, sent_at, reply_received_at, reply_intent, reply_signal_id) + índices por contact/phone/ticket. Aditivo `sales_recovery_reply_window_days INTEGER DEFAULT 14`.
  - `src/server/SalesRecoveryPlaybook.ts` — approve() agora (a) BLOQUEIA envio se `contacts.marketing_opt_out=1` (LGPD Art.8 §5) — throw + `RUNTIME_SALES_RECOVERY_BLOCKED_OPT_OUT` + descarta sinal; (b) chama `SalesRecoveryReplyService.recordTouch` após envio bem-sucedido (import dinâmico pra quebrar ciclo).
  - `src/server/SalesStalledDealDetectorService.ts` — JOIN com contacts filtra `COALESCE(c.marketing_opt_out, 0) = 0` (LGPD: contato opted-out nunca entra na fila).
  - `src/server/webhookProcessor.ts` — hook `SalesRecoveryReplyService.tryHandle` após `CollectionReplyService` (F4b.2) e antes da IA. Ordem: clinic → collection → sales_recovery → AI (cobrança tem SLA mais duro que recuperação).
  - `package.json` — script `test:sales-recovery-reply`.
  - `docs/execution-runtime/MATRIZ-DE-COBERTURA-DO-PRD.md` — §14 atualiza 5 critérios (respostas interpretadas, reuniões, objeções, opt-out formalizado, CRM atualizado).
- **Testes executados:**
  - `npm run test:sales-recovery-reply` → **44/44 OK**
  - Regressão sem quebras: `test:piloto-sales-recovery` (41/41), `test:piloto-cobranca` (38/38), `test:cobranca-intent-classifier` (35/35), `test:cobranca-cadencia-multitentativa` (38/38), `test:cobranca-promise-recheck` (33/33), `test:runtime-execute-e2e` (27/27), `test:runtime-confirmation` (32/32), `test:runtime-operations` (31/31), `test:business-signals` (12/12), `test:clinic-reminder-reply` (37/37), `test:runtime-process-fabric` (42/42)
  - `npx tsc --noEmit` → limpo
- **Decisões micro:**
  - (i) **Reusa `contacts.marketing_opt_out`** (bandeira nativa) em vez de nova tabela `sales_recovery_optouts`. Sem duplicação — LGPD Art.8 §5 respeitado por single-flag.
  - (ii) **Query do touch não filtra por `reply_intent IS NULL`** — LGPD requer que `remove_me` seja honrado MESMO se o cliente já respondeu antes com outro intent (edge case: "muito caro" → "para de me mandar msg"). Dedupe por (touch, intent) do BusinessSignal evita spam.
  - (iii) **`remove_me` severity=`risk`** (não info) — LGPD é evento noticiável, não rotina.
  - (iv) **`recordTouch` só é chamado após envio bem-sucedido** — WA falha não cria touch (não haveria correlação real com reply do cliente).
  - (v) **`approve()` BLOQUEIA envio se opt-out** — descarta sinal automaticamente pra não poluir painel + audit `BLOCKED_OPT_OUT`. Dono não precisa aprovar/dispensar; sistema decide sozinho porque LGPD é decisão dura.
  - (vi) **Ordem no webhookProcessor**: cobrança > recuperação. Cobrança tem SLA duro; recuperação é conversa aberta.
- **Cross-service audit:** hook no webhookProcessor é ADITIVO PURO — sem touch, retorna `{handled:false}` e fluxo AI segue. Bloqueio LGPD no approve() é BREAKING intencional (contatos opt-out não recebem — comportamento pré-existente da main permitia; agora rejeita). Nenhuma outra chamada mudou.
- **Resultado:** Loop de recuperação comercial autônomo COMPLETO. Runtime detecta deals parados → propõe msg → dono aprova (com LGPD guard) → envia → cliente responde → classifica intent → publica sinal + reply canned + (se remove_me) opt-out formalizado + detector nunca mais propõe pra esse contato. Ciclo fechado com LGPD compliance.
- **Pendências criadas:**
  - **F4c.3** — cadência multi-tentativa de recuperação. Ainda BLOQUEADA em decisão #4 LGPD (envios múltiplos sem approval humano exigem signoff jurídico).
  - **F4c.4** — medição `revenueRecovered` real (ticket→`ganho` após approval — hook em `ticket_stage_logs`).
  - **F4c.5** — UI dedicada `SalesRecoveryPanel`.
- **Próximo passo:** decidir com o dono se: (a) F4c.4 (medição revenue real quando ticket ganho); (b) CLI de rollout dos pilotos (padrão TOULON); (c) agendar revisão LGPD pra desbloquear F4c.3 (cadência multi-tentativa autônoma).

### Sessão AAAA-MM-DD (template para próxima)
- **Fase:** …
- **Itens executados:** …
- **Arquivos criados:** …
- **Arquivos alterados:** …
- **Testes executados:** … (comando + resultado)
- **Resultado:** …
- **Pendências criadas:** …
- **Próximo passo:** …

---

## Como marcar item como concluído
Um item **NÃO** é `[x]` só por ter código. Precisa (do PRD §22):
- Implementação backend + persistência + validação + autorização + auditoria
- Interface (quando aplicável) + estados vazios + loading + tratamento de erro
- Teste automatizado verde na CI
- Documentação atualizada
- Feature flag + migração + rollback documentado
- **Linha correspondente na `MATRIZ-DE-COBERTURA-DO-PRD.md` marcada `[x]` com evidência**
- Evidência (script, comando, screenshot ou commit hash) registrada aqui neste STATUS
