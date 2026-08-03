# ADR-152 — ZappFlow Execution Runtime (aditivo sobre ADR-136 / ADR-085 / ADR-091)

- **Status:** Proposto — Fase 0 do PRD concluída (esta ADR + `docs/prd/PRD-ZAPPFLOW-EXECUTION-RUNTIME.md` + `docs/execution-runtime/*`); Fases 1–4 aguardando aprovação para começar.
- **Data:** 2026-08-03
- **PRD‑fonte:** `docs/prd/PRD-ZAPPFLOW-EXECUTION-RUNTIME.md`
- **Documentos de continuidade:** `docs/execution-runtime/ANALISE-ARQUITETURAL.md`, `PLANO-DE-IMPLEMENTACAO.md`, `STATUS-DE-EXECUCAO.md`, `DECISOES-E-PENDENCIAS.md`, `MATRIZ-DE-COBERTURA-DO-PRD.md`.
- **Relacionadas:** **ADR-136** (Decision & Action Ledger — Epic 2 completo: `business_signals`, `decision_actions`, `action_approvals`, `agent_policies`, `action_execution_log`, `action_outcomes`, `ImpactPrioritizationService`, `CommandExecutorService` prepare-only), **ADR-085** (Impact Ledger — separação fato ≠ estimativa), **ADR-091** (Grade de planos e dunning D-5..D+30), **ADR-073** (JobQueue), **ADR-074** (Scheduler), **ADR-095** (RBAC granular), **ADR-058** (webhook processor), **ADR-150** (Retail Floor + reconciliação Alterdata), **ADR-046** (OpportunityRadar), **ADR-056** (LGPD).

## Contexto

O PRD "ZappFlow Execution Runtime" propõe transformar o ZappFlow em um sistema que **executa** processos empresariais ponta a ponta, e não apenas recomenda. Ao mapear o codebase (ver `ANALISE-ARQUITETURAL.md`), a Fase 0 concluiu que **grande parte da camada proposta já existe** sob outros nomes (ADR-136 Epic 2 é, na prática, um mini‑Runtime v0 com teto em `prepare`). A escolha central desta ADR é **reusar essa fundação** em vez de duplicá‑la.

## Decisões

### D1 — Reuso sobre reescrita
O Runtime NÃO reintroduz `Action Contract` / `ApprovalPolicy` / `ExecutorRegistry` / `OutcomeLedger` como tabelas paralelas. Ele **estende** o que existe:
- `decision_actions` recebe colunas aditivas (`process_instance_id`, `subject_type/id`, `deadline_at`, `attempt_count`, `max_attempts`, `success_condition`, `fallback_action_type`, `evidence_json`).
- `agent_policies.autonomy_level` ganha o valor `execute` (hoje aceita `observe|suggest|prepare`).
- `CommandExecutorService` ganha um modo `execute` governado por autonomy (mantendo o `prepare` como padrão).
- `action_outcomes` já cobre §11.11 — só ganha campos aditivos `time_saved_minutes`, `cost_avoided`, `revenue_recovered`, `loss_prevented` para o painel de Operações Autônomas.

### D2 — O verdadeiro gap é o **PROCESSO** (multi‑etapa persistido)
Hoje a unidade é **ação única** (`decision_actions`). Falta um contêiner "processo com N etapas encadeadas por regras" — sem ele, "recuperar a fatura 4587" continua sendo uma sequência solta de ações. Duas tabelas novas resolvem:
- `process_definitions` — playbook versionado por `(organization_id, process_type, version)` com `steps_json` (schema Zod), `autonomy_level` default, `sla_definition`, `entry/success/failure_conditions`, `escalation_policy`, `active`.
- `process_instances` — instância viva: `process_definition_id`, `subject_type/id`, `status` (FSM do §11.4), `current_step`, `context_json`, `result_json`, `priority`, `risk_level`, `expected_value`, `started_at`, `deadline_at`, `completed_at`, `failed_at`.

`decision_actions.process_instance_id` amarra ação↔processo (nullable — ações avulsas legadas continuam funcionando).

### D3 — Playbook em **JSON tipado (Zod)**, não DSL própria
Formato de `steps_json`: array de nós declarativos com `id`, `condition` (JSON‑Logic subset), `command_type` (do CommandExecutorService), `success_condition` (mesma linguagem de `condition`, avaliada contra `context_json` + evidência), `timeout_seconds`, `max_attempts`, `on_failure` (`fallback_step`|`escalate`|`fail`), `next` (id do próximo passo — ou map `{condition → next}`). Nenhum código dentro do JSON; toda expressão passa por validador Zod no boot da definição. DSL própria fica adiada — o custo é alto e o ganho de expressividade não compensa nesta versão.

### D4 — Confirmation Engine é **fina, cola em cima do que já confirma**
Não substitui webhook do Asaas, `resolveByDedupe` de sinal, ou `RetailFloorReconciliationService`. Um `ConfirmationEngine` fino mapeia `(command_type, expected_confirmation) → subscriber` e, quando o evento externo chega (webhook Asaas / reconciliação / resposta em canal), fecha a ação correspondente com `evidence_json` populado. Sem `expected_confirmation`, o teto continua sendo `execute → complete manual` (comportamento atual).

### D5 — Executores concretos são handlers do `CommandExecutorService`
Nada de "Registry paralelo". Os handlers atuais (`Task/Collection/Campaign/Procurement/RetailOps`) recebem irmãos: `WhatsAppSendCommandHandler` (via `MessageProviderService.sendMessage`), `AsaasPixCommandHandler`, `AsaasChargeCommandHandler`, `AlterdataFetchCommandHandler`, `SchedulerActionCommandHandler`. Cada um declara `timeout_seconds`, `retry_policy`, `confirmation_method`, `reversibility`, `risk_classification`. O `execute` só é chamado quando: (a) autonomy `execute` na política, (b) política de aprovação satisfeita, (c) modo de rollout da org permite (ver D7).

### D6 — Fila = `JobQueueService` estendido, não fila nova
`JobQueueService` (ADR-073) já cobre: enqueue não‑bloqueante, retry até `max_attempts`, `sweepStale()` como rede de segurança do Scheduler, isolamento por org. Aditivos: **backoff exponencial** por tentativa, **classificação de erro** (`retryable|non_retryable|permission|external_unavailable`), **dead‑letter** (linhas `status='failed'` já existem — falta expô‑las no painel de exceções). Sem Redis/BullMQ nesta versão (o repo é single‑process por design).

### D7 — Rollout em 4 modos por org × processo
Coluna aditiva `agent_policies.execution_mode` com `shadow | assisted | approved_execution | autonomous`. **`shadow`** roda o playbook mas grava apenas o plano previsto — nenhum `execute` externo. **`assisted`** materializa ações no `Plano de Ação` (comportamento atual do C4). **`approved_execution`** executa após aprovação humana (comportamento do C5 + execute governado). **`autonomous`** executa dentro da política sem parar em aprovações — só as ações classificadas como `automatic` no playbook. Default de qualquer org existente: `assisted` (mantém o comportamento atual — nenhuma quebra).

### D8 — Central "Operações Autônomas" **estende** o Plano de Ação, não substitui
Aba adicional no `ExecutiveView` (`Operações` ou `Runtime`), reusando o layout já testado do C4. Blocos: "Em execução" (queries de `process_instances`), "Concluído hoje" (join com `action_outcomes` de hoje), "Exceções" (categorização derivada de `process_instances.status IN (escalated, failed) OR action.error_json != NULL`), "Indicadores" (view materializada por passe do Scheduler). Não é tela nova.

### D9 — 3 pilotos, um por vez, na ordem de menor risco
**Retail Floor closing** (75% pronto — política de aprovação clara, escopo por loja) → **Cobrança** (dunning ADR‑091 já existe, escala com política de valor) → **Recuperação comercial** (mais aberto; LGPD/opt‑out mais delicados). Cada piloto começa em `shadow` por 2 semanas de sinal‑vs‑decisão, depois `assisted`, depois `approved_execution` por org com opt‑in explícito. `autonomous` só depois de 30 dias sem incidente naquela org.

### D10 — Feature flags de compatibilidade
`organization_settings.execution_runtime_enabled` (gate geral, default 0). Por piloto: `autonomous_collections_enabled`, `commercial_recovery_runtime_enabled`, `retail_closing_runtime_enabled`, `autonomous_operations_ui_enabled`. Padrão de configuração em `PLANO-DE-IMPLEMENTACAO.md`.

## Consequências

**Positivas.** O escopo real cai para 4 fases (não 8) — reusar ADR-136/085/091 remove ~60% do trabalho previsto no PRD. A FSM de processo, o Playbook JSON tipado, o modo `execute` do executor e a Confirmation Engine são as 4 peças novas. Os 3 pilotos ganham runtime sem reescrever nenhum motor. Retrocompatibilidade 100% via `assisted` como default.

**Trade‑offs / escopo removido.**
- DSL própria de playbook — substituída por JSON+Zod (ver D3).
- Tela nova "Operações Autônomas" — substituída por aba no `ExecutiveView` (ver D8).
- Renomeação em massa (`decision_actions` → `Action Contract`, etc.) — não haverá. O `MATRIZ-DE-COBERTURA-DO-PRD.md` mapeia nomes do PRD para os nomes reais do codebase.
- Nível 5 de autonomia ("Gerenciar o processo") só depois de Nível 4 estabilizado em produção — não faz parte do MVP.

**Riscos aceitos.**
- `JobQueueService` continua single‑process. Ver `DECISOES-E-PENDENCIAS.md` — o Runtime não precisa de fila distribuída neste escopo.
- Interpretação de intenção do cliente (§13.4) usa o motor de LLM existente (`AIOrchestrator`) — respostas ambíguas caem em exceção humana, nunca chutam.
- Modo `autonomous` do piloto de recuperação comercial exige revisão jurídica/LGPD antes de sair de `assisted`.

## Guardas
- Determinístico onde possível (FSM, políticas, playbook); IA só narra e classifica intenção com fallback humano em ambiguidade.
- Isolamento por `organization_id` em toda query (convenção nº 1 do CLAUDE.md).
- CREATE‑then‑ALTER estrito em `db.ts` (convenção nº 2) — nenhum aditivo do Runtime reordena tabela existente.
- Auditoria obrigatória em toda transição de estado, execução e outcome.
- Nenhum handler dispara efeito externo sem autonomy `execute` + política aprovada + `execution_mode ≥ approved_execution` na org.

## Testes (a serem entregues por fase — plano em `PLANO-DE-IMPLEMENTACAO.md`)
Cada fatia entrega seu `scripts/test-*.ts` no padrão do repo (tmpDir isolado, `check()` helper), rodando na CI matrix. As categorias do §18 do PRD viram scripts nomeados: `test-runtime-fsm`, `test-runtime-playbook`, `test-runtime-executor-execute`, `test-runtime-confirmation`, `test-runtime-outcomes-extended`, `test-piloto-fechamento-retail`, `test-piloto-cobranca`, `test-piloto-recuperacao-comercial`.

## O que esta ADR NÃO decide (aberto em `DECISOES-E-PENDENCIAS.md`)
- Nome final da aba UI (Design System).
- Se `steps_json` fica em `process_definitions` OU em arquivo TypeScript versionado no repo (revisar antes da Fase 1).
- Ordem final dos pilotos se surgir bloqueio externo (Alterdata down, credencial Asaas insuficiente, etc.).
