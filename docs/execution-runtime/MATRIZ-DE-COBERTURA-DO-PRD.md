# Matriz de Cobertura do PRD — ZappFlow Execution Runtime

**PRD:** `docs/prd/PRD-ZAPPFLOW-EXECUTION-RUNTIME.md`
**ADR:** `docs/adr/ADR-152-zappflow-execution-runtime.md`
**Data:** 2026-08-03

Cada requisito do PRD ligado a **fase, serviço/tabela, rota, UI, teste, status e evidência**. Um item **NÃO** está concluído apenas por ter código escrito — precisa também de evidência (teste verde ou uso comprovado).

**Legenda de status:**
- `[x]` **DONE** — já existe em produção (evidência abaixo)
- `[~]` **PARCIAL** — parte existe, resto vem por fatia mapeada
- `[ ]` **TODO** — planejado para uma fase
- `[-]` **REMOVIDO** — decidido não implementar (justificativa em `DECISOES-E-PENDENCIAS.md`)
- `[!]` **BLOQUEADO** — depende de decisão externa (ver Decisões)

**Legenda de fase:** F0 (esta), F1 (Process Fabric), F2 (Execute+Confirmation), F3 (Outcomes+UI), F4a (Piloto Retail), F4b (Piloto Cobrança), F4c (Piloto Recuperação).

---

## §1–3 — Instruções de processo (Fase 0)

| Item | Status | Fase | Evidência / plano |
|---|---|---|---|
| §1 Análise crítica antes de código | [x] DONE | F0 | `ANALISE-ARQUITETURAL.md` |
| §2 PRD persistido no repo | [x] DONE | F0 | `docs/prd/PRD-ZAPPFLOW-EXECUTION-RUNTIME.md` |
| §2 ANALISE-ARQUITETURAL.md | [x] DONE | F0 | Este PR |
| §2 PLANO-DE-IMPLEMENTACAO.md | [x] DONE | F0 | Este PR |
| §2 STATUS-DE-EXECUCAO.md | [x] DONE | F0 | Este PR |
| §2 DECISOES-E-PENDENCIAS.md | [x] DONE | F0 | Este PR |
| §2 MATRIZ-DE-COBERTURA-DO-PRD.md | [x] DONE | F0 | Este arquivo |
| §2 ADR próprio | [x] DONE | F0 | `docs/adr/ADR-152-zappflow-execution-runtime.md` |
| §3 STATUS atualizado ao fim de cada sessão | [~] PARCIAL | contínuo | Regra do repo — cada PR do Runtime atualiza `STATUS-DE-EXECUCAO.md` |

## §4–6 — Contexto e problema (informativo, não gera item)

## §7 — Objetivos

| Item | Status | Fase | Evidência / plano |
|---|---|---|---|
| §7.1 Criar Execution Runtime universal | [ ] TODO | F1+F2 | `ProcessRuntimeService` + modo `execute` no `CommandExecutorService` |
| §7.2 Padronizar ações executáveis | [x] DONE | — | `decision_actions` unificado (ADR-136 D5); registry em `CommandExecutorService` |
| §7.2 Máquina de estados universal | [~] PARCIAL | F1 | Existem FSMs por domínio; falta FSM unificada de PROCESSO |
| §7.2 Agentes, conectores, executores | [~] PARCIAL | F2 | Registry existe (5 handlers `prepare`); F2 adiciona 5 `execute` handlers |
| §7.2 Políticas de autonomia | [x] DONE | — | `ApprovalPolicyService`, `agent_policies.autonomy_level` |
| §7.2 Playbooks completos | [ ] TODO | F1 | `PlaybookEngine` + `process_definitions.steps_json` |
| §7.2 Filas, tentativas, falhas | [~] PARCIAL | F2 | `JobQueueService` (ADR-073) faz retry; F2 adiciona backoff + dead-letter + classificação de erro |
| §7.2 Confirmar por evidências externas | [~] PARCIAL | F2 | Existe por domínio (webhook Asaas, reconciliação); F2 centraliza em `ConfirmationEngine` |
| §7.2 Medir impacto real | [x] DONE | — | `OutcomeMeasurementService` + `action_outcomes` (ADR-136 D6), ADR-085 |
| §7.2 Separar automático / supervisionado / exceção | [~] PARCIAL | F3 | Aba "Operações" no `ExecutiveView` |
| §7.2 Reduzir dependência do gestor | [ ] TODO | F4a–c | Pilotos |
| §7.2 Módulos existentes em operações gerenciadas | [ ] TODO | F4a–c | 3 pilotos |
| §7.2 Central de Operações Autônomas | [ ] TODO | F3 | Aba "Operações" no `ExecutiveView` (D8 do ADR) |
| §7.2 Três processos ponta a ponta | [ ] TODO | F4a–c | Retail closing, cobrança, recuperação comercial |

## §8 — Não objetivos iniciais (informativo)

## §9 — Conceito de trabalho pronto

| Item | Status | Fase | Evidência / plano |
|---|---|---|---|
| Evento claro de início | [x] DONE | — | `BusinessSignalService.publish` + triggers de cadence |
| Objetivo mensurável | [x] DONE | — | `decision_actions.expected_impact` |
| Entradas identificadas | [~] PARCIAL | F1 | `process_instances.context_json` + `entry_conditions_json` |
| Regras de decisão | [ ] TODO | F1 | `steps_json.condition` (JSON-Logic) |
| Ações executáveis | [x] DONE | — | `decision_actions.command_type` + `CommandExecutorService` |
| Executor disponível | [~] PARCIAL | F2 | Executores `execute` na F2 |
| Permissões definidas | [x] DONE | — | `agent_policies` + `PermissionService` |
| Prazo/SLA | [~] PARCIAL | F1 | `process_definitions.sla_definition` + `deadline_at` |
| Política de repetição | [x] DONE | — | `JobQueueService.max_attempts` |
| Tratamento de falhas | [~] PARCIAL | F2 | `on_failure` no playbook |
| Condição objetiva de sucesso | [ ] TODO | F1 | `success_condition_json` |
| Confirmação externa | [~] PARCIAL | F2 | `ConfirmationEngine` |
| Escalação de exceções | [~] PARCIAL | F3 | `RuntimeExceptionsService` categorizado |
| Evidência auditável | [x] DONE | — | `action_execution_log` + `process_transitions` (F1) |
| Medição de impacto | [x] DONE | — | `OutcomeMeasurementService` |
| Responsabilidade quando não conclui | [~] PARCIAL | F1 | `decision_actions.assigned_to` + escalação do playbook |

## §10 — Arquitetura conceitual (bloco por bloco)

| Bloco | Status | Onde |
|---|---|---|
| Fontes de dados e eventos | [x] DONE | Módulos existentes (Retail, Clínica, Fashion, Comigo, etc.) |
| Detectores e Business Signals | [x] DONE | `BusinessSignalService` + publishers (ADR-136 D1/D2) |
| Motor de decisão e priorização | [x] DONE | `ImpactPrioritizationService` (ADR-136 D7) |
| Process Definition / Playbook | [ ] TODO | F1 |
| Policy Engine | [x] DONE | `ApprovalPolicyService` |
| Execution Plan | [ ] TODO | F1 (`process_instances.current_step + context_json`) |
| Execution Runtime | [~] PARCIAL | F1+F2 (`ProcessRuntimeService` + `CommandExecutorService.execute`) |
| Agents / Connectors / Human Tasks | [~] PARCIAL | F2 (executores concretos) |
| Confirmation Engine | [~] PARCIAL | F2 |
| Outcome Ledger | [x] DONE | `OutcomeMeasurementService` (ADR-136 D6) + `action_outcomes` |
| Aprendizado e otimização | [-] REMOVIDO | Não neste escopo; ver `DECISOES-E-PENDENCIAS.md` |

## §11 — Componentes obrigatórios

### §11.1 Process Definition
`[x] DONE` (F1.1 — PR desta fatia). Tabela `process_definitions` com `steps_json` validado, versionamento automático por (org, processType), `active` toggle. Service `ProcessRuntimeService.defineProcess/getDefinition/listDefinitions/setActive/latestActiveDefinition`. **Nome no codebase:** `process_definitions`.

### §11.2 Process Instance
`[x] DONE` (F1.1). Tabela `process_instances` com FSM validada, `context_json` acumulando resultados por step, `subject_type/id` para dedupe conservador, `result_json` populado ao concluir. Service `startForSubject`, `startFromSignal`, `getInstance`, `listInstances`, `cancel`.

### §11.3 Action Contract
`[~] PARCIAL` — F1 adiciona campos aditivos em `decision_actions`. **Nome no codebase:** `decision_actions` (não "Action Contract") — decisão ADR-152 D1.

Campos:
| Campo do PRD | Status | Onde |
|---|---|---|
| id, organization_id, action_type, subject_type, subject_id | [x]/[~] | `decision_actions.id/organization_id/action_type`; subject_* a adicionar em F1 |
| process_instance_id | [ ] | F1 |
| objective, executor_type, executor_id | [~] | `title`+`command_type` (executor_type derivado do handler); F1 formaliza |
| status | [x] | `decision_actions.status` |
| risk_level | [ ] | F1 aditivo |
| approval_policy, approval_status | [x] | `decision_actions.approval_policy` + `action_approvals` |
| scheduled_at, started_at, completed_at, deadline_at | [~] | scheduled/started/completed OK; deadline em F1 |
| attempt_count, max_attempts | [ ] | F1 aditivo |
| success_condition, fallback_action | [ ] | F1 aditivo |
| input_json, output_json, error_json | [~] | `command_payload_json`, `action_execution_log.response_json`; error em F1/F2 |
| evidence_json | [ ] | F1 aditivo |

### §11.4 Máquina de estados
`[x] DONE` (F1.1). FSM unificada de PROCESSO em `ProcessRuntimeService.transition` com 13 estados e 27 transições válidas. Transições inválidas 400. Cada transição auditada em `process_transitions` (ator, motivo, evidência). Estados atuais mapeiam para: `detected` (novo do PRD) / `planned` (novo) / `awaiting_approval` (=existe) / `authorized` (=`approved`) / `queued` (novo — `background_jobs.pending`) / `executing` (`background_jobs.processing`) / `waiting_external_response` (novo — `action_confirmations.pending`) / `retry_scheduled` (novo) / `escalated` (novo) / `completed` (=`done`) / `failed` (=existe) / `cancelled` (=existe) / `measured` (novo — outcome recorded).

### §11.5 Executor Registry
`[~] PARCIAL` — Registry + modo `execute` (F2.2) prontos; handlers concretos vêm na F2.3. `CommandExecutorService.execute(orgId, actionId)` corre com 3 guardas em série (`policy_missing → autonomy_below_execute → execution_mode_blocked → action_not_approved/action_terminal → no_handler`) — cada rejeição AUDITADA com `error_code` explícito em `action_execution_log`. Handlers desta fatia (2.2) são NO-OP (`effect:'noop-2.2'`); a 2.3 pluga efeito real.
| Executor do PRD | Status | Onde |
|---|---|---|
| WhatsApp Agent | [x] F2.3 | `WhatsAppSendCommandHandler` (via MessageProviderService.sendMessage) |
| Financial Agent (Asaas PIX) | [x] F2.3 | `AsaasPixChargeCommandHandler` (cria payment + expect(asaas_payment_webhook) com externalRef) |
| ERP Connector (Alterdata read) | [x] F2.3 | `AlterdataFetchCommandHandler` (leitura via AlterdataConnectorService) |
| CRM Agent | [~] parcial via handlers | Reusa services existentes |
| Financial Agent | [ ] F2 | `AsaasPixCommandHandler`, `AsaasChargeCommandHandler` |
| Retail Agent | [~] existe como service | Formalizado como handler em F2 |
| Calendar Agent | [~] existe (`AppointmentService`) | Formaliza como handler quando necessário |
| Procurement Agent | [x] | `ProcurementCommandHandler` já existe |
| Email Agent | [ ] | Fora do escopo desta versão |
| ERP Connector | [ ] F2 | `AlterdataFetchCommandHandler` (leitura) |
| Scheduler | [x] | `Scheduler.ts` |
| Human Operator | [x] | Ação `assigned_to` + Plano de Ação |

### §11.6 Policy Engine
`[x] DONE` — `ApprovalPolicyService` + `agent_policies`. F2 adiciona `execution_mode`.

### §11.7 Níveis de autonomia
`[~] PARCIAL` — Níveis 0–3 existem (`observe|suggest|prepare` + aprovação humana). F2 adiciona nível 4 (`execute`). Nível 5 é o Runtime executando o playbook (F1+F2 juntos).

### §11.8 Playbook Engine
`[x] DONE` (F1.1). `PlaybookEngine.ts` puro (zero I/O): `validateDefinition` bloqueia playbook inválido no cadastro (refs quebradas, ids duplicados, commandType ausente, onFailure=fallback sem fallbackStep); `evaluateCondition` (truthy/eq/gte/lte/and/or/not); `chooseNextStep` (string direto, array de `{when, next}` com regra default por último). Testado em isolamento (10 checks no `test-runtime-process-fabric`).

### §11.9 Retry, timeout, compensação
`[x] DONE` (F1.1 + F2.1). Retry em `JobQueueService` (ADR-073) + backoff exponencial (30s base retryable, 60s external_unavailable, teto 30min); classificação de erro (`retryable | external_unavailable | permission | non_retryable` via `JobQueueError`); dead-letter formal (`status='failed'` + `deadLetters(orgId)`); `sweepStale` respeita `next_attempt_at`. Compensação por processo em F1.1 (`on_failure: fallback_step` do playbook).

### §11.10 Confirmation Engine
`[x] DONE` (F2.1). `ConfirmationEngine` centralizado com 5 métodos (`asaas_payment_webhook | retail_reconciliation | channel_reply | alterdata_sync | manual`). `expect` idempotente por (org, action). `confirm` fecha a ação via `DecisionActionService.complete` (loop ADR-136 D6). Idempotência crítica: webhook 2x devolve a linha; ação já `done/rejected/cancelled` → `dismissed` sem reabrir; cross-tenant recusado. `sweepTimeouts` fecha as pendentes vencidas. **Subscribers ficam plugados na F2.3** (webhook Asaas → `confirm`; reconciliação Alterdata → `confirm`).

### §11.11 Outcome Ledger
`[x] DONE` — `OutcomeMeasurementService` + `action_outcomes` (ADR-136 D6). F3 adiciona campos aditivos (`time_saved_minutes`, `cost_avoided`, `revenue_recovered`, `loss_prevented`).

### §11.12 Exception Center
`[~] PARCIAL` — Aba "Plano de Ação" existe (ADR-136 D8). F3 entrega categorização.

## §12 — Interface Operações Autônomas

| Bloco | Status | Onde |
|---|---|---|
| Em execução | [ ] F3 | Aba "Operações" |
| Concluído hoje | [~] F3 | Ledger existe; agregação por hoje é F3 |
| Exceções | [ ] F3 | `RuntimeExceptionsService` |
| Indicadores | [ ] F3 | `GET /api/runtime/operations/indicators` |
| Transparência (linha do tempo por processo) | [ ] F3 | Detalhe do `process_instance` na UI |

## §13 — Processo prioritário 1 (Cobrança)

| §13.7 Critério de aceite | Status | Fase | Evidência / plano |
|---|---|---|---|
| Cobrança gera instância | [ ] | F4b | `receivable_collection_v1` |
| Cadência executada pelo Runtime | [ ] | F4b | Playbook |
| Respostas alteram fluxo | [ ] | F4b | `next: {condition→step}` |
| Promessa agenda nova verificação | [ ] | F4b | `SchedulerActionCommandHandler` |
| PIX enviado corretamente | [x] | — | `AsaasService` já envia PIX (usado hoje) |
| Pagamento encerra cobrança | [~] | F4b | Webhook Asaas + `ConfirmationEngine` |
| Ações idempotentes | [x] | — | Padrão do repo |
| Tentativas auditadas | [x] | — | `action_execution_log` |
| Exceções chegam ao gestor | [~] | F3 | Exception Center |
| Valor recuperado medido | [x] | — | `OutcomeMeasurementService` |
| Testes cobrem positivo e negativo | [ ] | F4b | `test-piloto-cobranca.ts` (10 intenções) |

## §14 — Processo prioritário 2 (Recuperação comercial)

| §14.6 Critério | Status | Fase |
|---|---|---|
| Oportunidades paradas detectadas | [x] | — (`OpportunityRadarService`) |
| Prioridade explicável | [x] | — (`ImpactPrioritizationService`) |
| Cadência criada | [x] | — (`cadences`) |
| Responsável definido | [~] | F4c |
| Mensagens enviadas | [x] | — (`MessageProviderService`) |
| Respostas interpretadas | [~] | F4c |
| CRM atualizado | [x] | — (services do CRM) |
| Reuniões agendadas | [~] | F4c |
| Nova tentativa programada | [ ] | F4c |
| Objeções escaladas | [ ] | F4c |
| Receita com evidência | [x] | — (`revenue_recovered` do RIC) |
| Opt-out e limites respeitados | [!] BLOQUEADO | F4c | Depende de revisão LGPD |
| Testes cobrem fluxo completo | [ ] | F4c |

## §15 — Processo prioritário 3 (Fechamento retail)

| §15.7 Critério | Status | Fase |
|---|---|---|
| Fechamento cria processo | [ ] | F4a |
| Múltiplas fontes suportadas | [~] | F4a | PDV+Alterdata OK (ADR-150); Sicredi bloqueado (ver Decisões) |
| Dados comparados | [x] | — (`RetailFloorReconciliationService`) |
| Tolerâncias configuráveis | [~] | F4a | Hoje hard-coded 5%; F4a torna config |
| Regulares concluídos automaticamente | [ ] | F4a |
| Risco escalado | [~] | F4a |
| Comissão gerada | [~] | F4a | `retail_commission_items` existe; F4a amarra no processo |
| Financeiro atualizado | [x] | — (`FinancialLedgerService`) |
| Sicredi manual + API futura mesmo contrato | [!] | — | Bloqueado (Sicredi) |
| Evidências auditadas | [x] | — |
| Testes cobrem divergências e idempotência | [x] | — parcial na `test-retail-floor-*`; F4a adiciona E2E |

## §16 — Segurança e governança

| Item | Status | Evidência |
|---|---|---|
| Isolamento multi-tenant | [x] | Convenção nº 1 do CLAUDE.md; TODA query filtra `organization_id` |
| RBAC | [x] | ADR-095 |
| Políticas por organização | [x] | `agent_policies`, `organization_settings` |
| Auditoria | [x] | `auth_audit_logs`, `logAuthEvent` |
| Idempotência | [x] | Padrão do repo (unique + `SQLITE_CONSTRAINT_UNIQUE`) |
| Proteção contra duplicidade | [x] | `dedupe_key` em signals; `background_jobs` idempotente |
| Criptografia | [x] | `EncryptionService` (ADR-054) |
| Proteção de credenciais | [x] | `ADR-078` rotação de segredos |
| LGPD | [x] | ADR-056 |
| Opt-out | [~] | F4c formaliza para recuperação comercial |
| Horário permitido | [~] | Existe em `TeacherDigestService`; F2 generaliza no policy |
| Limites financeiros | [x] | `max_auto_amount` em `agent_policies` |
| Aprovação de ações sensíveis | [x] | `ApprovalPolicyService.two_step` |
| Menor privilégio | [x] | `PermissionService` |
| Logs sem exposição indevida | [x] | `maskIdentifier` (convenção) |
| Rastreabilidade de decisões da IA | [x] | `decision_actions.created_by`, `command_payload_json`, `action_execution_log` |
| Separação fato ≠ estimativa | [x] | ADR-085 D4 + `basis` |
| Nenhuma IA inventa (§16 fim) | [x] | Guardrails RN em cada módulo; teto `prepare` até F2 |

## §17 — Observabilidade

| Métrica | Status | Onde |
|---|---|---|
| Qtd de processos | [ ] F3 | `runtime/operations/indicators` |
| Processos por estado | [ ] F3 | idem |
| Duração | [ ] F3 | idem |
| SLA cumprido | [ ] F3 | idem |
| Taxa de falha | [ ] F3 | idem |
| Retries | [x] parcial | `background_jobs.attempts` |
| Tempo em espera | [ ] F3 | idem |
| Integrações indisponíveis | [~] F3 | `background_jobs.error_class='external_unavailable'` |
| Executor com erro | [~] F3 | `action_execution_log.status='failed'` |
| Intervenção humana | [ ] F3 | Contagem de aprovações |
| Conclusão automática | [ ] F3 | idem |
| Valor esperado/realizado | [x] | `OutcomeMeasurementService.ledger` |
| Discrepâncias | [x] parcial | `RetailFloorReconciliationService` |
| Processos presos | [ ] F3 | Exception Center |
| Dead letters | [~] F2 | `background_jobs.status='failed'` — F3 expõe |
| Alertas §17 | [~] F3 | Publica sinal em `business_signals` |

## §18 — Testes

| Categoria | Status | Fase | Script |
|---|---|---|---|
| §18.1 Unitários FSM | [ ] | F1 | `test-runtime-process-fabric.ts` |
| §18.1 Unitários políticas/retry/timeout | [x] | — | `test-decision-actions`, `test-outcome-measurement` já cobrem |
| §18.2 Integração Runtime × WhatsApp | [ ] | F2 | `test-runtime-executor-execute.ts` |
| §18.2 Integração Runtime × CRM | [ ] | F4c | `test-piloto-recuperacao-comercial.ts` |
| §18.2 Integração Runtime × Financeiro | [ ] | F4b | `test-piloto-cobranca.ts` |
| §18.2 Integração Runtime × Retail | [ ] | F4a | `test-piloto-fechamento-retail.ts` |
| §18.3 E2E cobrança | [ ] | F4b | idem |
| §18.3 E2E recuperação | [ ] | F4c | idem |
| §18.3 E2E fechamento | [ ] | F4a | idem |
| §18.4 Falha (API/timeout/webhook) | [ ] | F2+F4* | `test-runtime-executor-execute.ts`, `test-runtime-confirmation.ts` |
| §18.5 Isolamento (multi-tenant) | [x] parcial | contínuo | Todo teste do repo já isola; formalizado em cada `test-runtime-*` |

## §19 — Migração/compatibilidade

| Item | Status | Onde |
|---|---|---|
| Aditivo | [x] | ADR-152 D1 |
| Feature flags | [~] | F1 (`execution_runtime_enabled`), F2 (`execution_mode`), F4a–c (por piloto) |
| Modo shadow | [ ] F2 | `execution_mode='shadow'` no `agent_policies` |
| Modo assisted (default) | [~] | F1 default |
| Modo approved_execution | [ ] F2 | idem |
| Modo autonomous | [ ] F4* | Só depois de 30d sem incidente |

## §20 — Roadmap (revisado em ADR-152)

| Fase PRD | Fase revisada | Onde |
|---|---|---|
| Fase 0 (análise) | F0 | Este PR |
| Fase 1 (fundação) | F1 | Ver plano |
| Fase 2 (execução) | F2 | Ver plano |
| Fase 3 (Outcome Ledger) | F3 (extensão do existente) | ADR-136 D6 já entregou; F3 adiciona campos + UI |
| Fase 4 (cobrança) | F4b | Após F4a estável |
| Fase 5 (recuperação) | F4c | Após F4b estável + LGPD |
| Fase 6 (fechamento) | **F4a** | Primeiro piloto (menor risco) |
| Fase 7 (Operações UI) | F3 | Antes dos pilotos |
| Fase 8 (Shadow + rollout) | Transversal | `execution_mode` em cada piloto |

## §21 — Critérios globais de aceite (validado ao FIM do projeto)

Cada linha volta a ser marcada `[x]` só quando a evidência estiver no repo.

- [ ] Runtime reutilizado pelos 3 processos
- [ ] Sem 3 motores paralelos independentes
- [ ] Processos persistidos
- [ ] Estados auditados
- [ ] Ações com executores
- [ ] Políticas aplicadas
- [ ] Aprovações respeitadas
- [ ] Ações automáticas configuráveis
- [ ] Falhas tratadas
- [ ] Tentativas idempotentes
- [ ] Resultados confirmados
- [ ] Evidências armazenadas
- [ ] Impacto medido
- [ ] Exceções apresentadas
- [ ] UI mostra resultados e não apenas tarefas
- [ ] Orgs existentes protegidas por flags
- [ ] Testes completos verdes
- [ ] Documentação atualizada
- [ ] Esta matriz preenchida (100% dos itens em estado formal)
- [ ] Todos os itens do PRD com status formal (esta matriz é a evidência disso)

## §24 — Perguntas obrigatórias

Respondidas em `ANALISE-ARQUITETURAL.md` §7. Cada resposta liga a um item desta matriz.
