# ADR-159 — Choke-point único de execução externa + hardening de governança e Autonomy Contract (evolui ADR-136/152; RBAC ADR-138)

- **Status:** **EM ANDAMENTO** — Onda 0 do programa ZEI (trilha paralela à ADR-158). **F1 (D2 — two-step + RBAC granular) ENTREGUE**; **F2.1 (D1 — endurecimento do choke-point) ENTREGUE**; **F2.2 (D1 — reroute do CollectionCadence) ENTREGUE**; **F2.3 (D1 — família cobrança: promise + resend-pix) ENTREGUE**; **F2.4 (D1 — SalesRecovery) ENTREGUE**; **F2.5 (D1 — Prospect + handler `gmail_send`) ENTREGUE — reroutes do D1 COMPLETOS**; F3..F6 planejadas.
- **Data:** 2026-08-09
- **Origem:** `PRD 0 — ZapFlow Execution Intelligence` (§16-19, §29-32, §49) + `ZAPFLOW — ESTADO FINAL ESPERADO` (§16-19, §52, §64-66); auditoria em `docs/prd/ANALISE-ESTADO-FINAL-vs-REPO.md` §4-5.
- **Relacionadas:** ADR-136 (Decision & Action Ledger, `agent_policies`), ADR-152 (Runtime, CommandExecutor), ADR-138 (RBAC financeiro), ADR-130 (Governança de IA), ADR-056 (LGPD). CLAUDE.md convenções nº 1, nº 7, nº 8, nº 10.

---

## Contexto

O programa vai **subir a autonomia** da IA (rumo ao Nível 4 — executar dentro de política). O Estado Final §16 é explícito: **"quanto maior a autonomia, maior deve ser o controle."** A auditoria encontrou buracos concretos na base de governança que precisam fechar **antes** de ampliar execução autônoma:

1. **Não há choke-point único de execução externa.** Existem ≥3 caminhos para efeito externo: `CommandExecutor.execute` (governado), `CollectionCadenceService` (envia cobrança fora do runner) e handlers chamando `MessageProvider`/`Asaas` direto. Efeito externo que não passa por um ponto governado é risco não-auditado.
2. **RBAC granular é opt-in** — só age com `role_profile_id` atribuído; o parque legado passa sem gating (privilege-por-omissão).
3. **Bug no two-step approval** — `routes/actions.ts` conta `DISTINCT COALESCE(approver_user_id,'?')`: aprovadores sem id colapsam num só, permitindo burlar a exigência de 2 pessoas. Além disso a rota usa `req.user.role` legado, não o RBAC granular.
4. **Policy só tem teto único** (`max_auto_amount`); faltam **bandas valor→papel** (desconto/compra/reembolso) e o estado **"escalonar"**.
5. **Progressive autonomy inexiste** — nada realimenta `agent_policies` por evidência.
6. **Sem `correlationId`, sem step-up MFA em ação crítica, sem detecção de anomalia.** (O correlationId é entregue na ADR-158 F1.)

Evolui o que existe (`agent_policies`, `ApprovalPolicyService`, `CommandExecutorService`) para um **modelo único de governança** — sem engine paralelo (PRD 0 §6, §54).

---

## Decisões (propostas, a fatiar)

### D1 — Choke-point único de execução externa

Todo efeito externo (mensagem, cobrança, escrita em sistema de terceiro) passa **obrigatoriamente** por `CommandExecutor.execute` (guardas G1-G3 + policy + idempotência + `action_execution_log`). `CollectionCadenceService` e handlers que hoje chamam providers direto são reencaminhados para o executor. Meta: **um** ponto de auditoria/idempotência/rate-limit, carregando o `correlationId` (ADR-158) em cada tentativa.

**F2.1 — ENTREGUE (2026-08-09) — endurecimento do choke-point** (pré-requisito dos reroutes). Antes de reencaminhar bypasses, o próprio ponto único tinha dois furos:
- **Idempotência real do efeito externo.** No sucesso, `execute` gravava `executed_at` mas mantinha `status='approved'` (a ação só vira terminal no complete/outcome C2b) — e `executed_at` também é setado pelo `prepare`. Logo NENHUM dos dois travava um 2º `execute`, que **reprocessaria o handler e duplicaria o efeito** (2 PIX, 2 WhatsApp). Agora um `execute` já concluído com sucesso (linha `mode='execute' status='done'`) bloqueia o reprocesso (`action_already_executed`); **retry pós-FALHA segue liberado** (`status='failed'` não trava); `prepare` não bloqueia.
- **RN-159-3 (correlationId no audit).** `action_execution_log` ganhou `correlation_id` (aditivo) populado de `decision_actions.correlation_id` em TODA tentativa (execute/prepare/rejeição) — o fio do ciclo ADR-158 agora atravessa também a ponta de execução.
- **Números:** 1 coluna + 1 índice aditivos + guard de idempotência + correlationId em todas as INSERTs do log + 1 suíte (`test:choke-point-hardening`, 16 checks). 0 breaking changes.

**F2.2 — ENTREGUE (2026-08-10) — reroute do CollectionCadence (headline bypass).** O envio T2/T3 da cadência de cobrança (hoje `MessageProviderService.sendMessage` DIRETO, fora do executor) passa a rodar PELO choke-point sob a flag opt-in `collection_cadence_via_executor_enabled` (default 0, em cima de `collection_cadence_enabled`). Com a flag, `sendAttempt` — depois de reservar a linha idempotente (`collection_followup_attempts`) — cunha uma **ação de follow-up distinta** (`command_type='whatsapp_send'`, reusa o handler governado existente), herda o `correlationId` da ação âncora, semeia a política idempotente (`agent_policies` collection/collection_followup, execute/approved_execution) e chama `CommandExecutorService.execute`. Ação NOVA (não reexecuta a âncora, que o guard F2.1 recusaria). Rotear **não amplia autonomia** — a cadência já envia autonomamente hoje; só adiciona audit (`action_execution_log` com correlationId)/idempotência/guardas. Flag OFF = envio direto de hoje (0 regressão). Falha reverte a reserva + publica sinal + retry no tick seguinte, igual ao pré-F2.2. **Números:** 1 flag aditiva + reroute em `CollectionCadenceService` (reuso do handler `whatsapp_send`) + 1 suíte (`test:collection-cadence-choke-point`, 19 checks). 0 breaking changes.

**F2.3 — ENTREGUE (2026-08-10) — reroute da FAMÍLIA COBRANÇA.** Estende a F2.2 aos outros dois bypasses de dunning, sob a MESMA flag `collection_cadence_via_executor_enabled`: `CollectionPromiseService.markBroken` (follow-up de promessa quebrada) e `CollectionResendPixService.sendNow` (reenvio de PIX). A costura foi **extraída** para `CommandExecutorService.sendGovernedMessage` — helper ÚNICO no ponto de choke que cunha a ação `whatsapp_send`, semeia a política, herda o correlationId e executa; a F2.2 (cadência) foi refatorada pra delegar a ele (0 mudança de comportamento, 19 checks intactos). Cada fluxo preserva a própria idempotência/rollback/sinais: promise segue `pending` na falha (retry); resend nunca lança (cai no `fail()`/sinal). **Números:** 1 helper compartilhado + reroute em 2 services + refactor da cadência + `db` import + 1 suíte (`test:collection-family-choke-point`, 16 checks). 0 breaking changes.

**F2.4 — ENTREGUE (2026-08-10) — reroute do SalesRecoveryPlaybook.** O envio da mensagem de recuperação comercial (`approve`, hoje `MessageProviderService.sendMessage` direto) passa PELO choke-point via `CommandExecutorService.sendGovernedMessage` sob a flag `sales_recovery_via_executor_enabled` (default 0 = envio direto, 0 regressão). Herda o correlationId da âncora `evidence.actionId` (quando existe). **Swap cirúrgico de uma linha** — os guards (opt-out LGPD Art.8 §5, ticket-state/funil) e side-effects (touch de `tickets.updated_at`, `recordTouch`, `OutcomeMeasurement`, audit) ficam INTACTOS em volta; o `catch` existente trata a exceção do executor idêntico ao envio direto (publica `sales_recovery_send_failed` + `kept_open`). **Números:** 1 flag aditiva + swap em `approve` + 1 suíte (`test:sales-recovery-choke-point`, 15 checks). 0 breaking changes.

**F2.5 — ENTREGUE (2026-08-10) — reroute do ProspectExecution (fecha os reroutes do D1).** `sendOutreach` tem DOIS sinks diretos (WhatsApp + Gmail) e nenhuma ação âncora. Sob a flag `prospect_via_executor_enabled` ambos passam PELO choke-point: WhatsApp via `sendGovernedMessage`; e-mail via `dispatchGoverned` + o **handler NOVO `gmail_send`** (embrulha `GoogleOAuthService.gmailSend`, payload `{to, subject, body}`, `externalRef=id`; erro `{error}` vira JobQueueError classificado). O helper foi **generalizado**: `dispatchGoverned(commandType, commandPayload)` é a costura genérica; `sendGovernedMessage` virou açúcar pra `whatsapp_send` (callers F2.2–F2.4 inalterados). Sem âncora → correlationId enraíza cadeia nova. A ordenação "provedor confirma ANTES de status='sent'" é preservada (executor lança na falha → status não avança). **Números:** 1 flag + 1 handler novo (`gmail_send`) + generalização do helper + reroute dos 2 sinks + 1 suíte (`test:prospect-choke-point`, 12 checks). 0 breaking changes.

**D1 — reroutes dos bypasses nomeados na §Contexto: COMPLETOS** (CollectionCadence, CollectionPromise, ResendPix, SalesRecovery, ProspectExecution). Todos governados via o helper único `CommandExecutorService.dispatchGoverned`, sob flags opt-in, auditados com correlationId.

**Falta no D1 (polimento):** extrair `AsaasService.createPixCharge` público (hoje duplicado em 2 handlers); rate-limit no ponto único (greenfield). Podem virar F2.6 ou entrar noutra onda.

### D2 — Correção dos riscos de aprovação (prioridade de segurança)

- Two-step passa a exigir **2 aprovadores com `user_id` não-nulo e distintos** (rejeita aprovação sem identidade); nunca colapsar via `COALESCE`.
- Aprovação valida **RBAC granular** (perfil/permissão de módulo), não `users.role` legado.

**F1 — ENTREGUE (2026-08-09).** Concretização:
- `DecisionActionService.approve` agora **rejeita `actorId` nulo** e conta `COUNT(DISTINCT approver_user_id) … WHERE approver_user_id IS NOT NULL` (fim do `COALESCE(…, '?')` que colapsava nulos num só). Índice **UNIQUE parcial** `action_approvals(action_id, approver_user_id) WHERE decision='approved' AND approver_user_id IS NOT NULL` fecha o double-vote no storage; re-voto do mesmo usuário é idempotente (catch de `SQLITE_CONSTRAINT_UNIQUE`). `reject` idem exige identidade.
- Rotas `POST /actions/:id/{approve,reject}` trocam o claim legado `req.user.role` por **`PermissionService.can(orgId, user, "execucao", write|delete)`** (perfil vence o claim cru; fallback legado preserva owner/admin). Política que nomeia papel → nível gestor (`full`); `approval_role='owner'` → `PermissionService.isOwner` (preserva o caso owner-only do `change_price`). Conjuntos de autorização do parque legado inalterados.
- **Números:** 1 índice aditivo + guard de identidade em approve/reject + count corrigido + `PermissionService.isOwner` + RBAC granular em 2 rotas + 1 suíte (`test:two-step-approval-security`, 28 checks). 0 breaking changes.

### D3 — RBAC deixa de ser silenciosamente opt-in

Caminho de migração para **default-deny** em ações sensíveis quando não há perfil resolvido (em vez de passar livre). Faseado e observável para não quebrar orgs legadas (feature flag + relatório de impacto antes de virar a chave).

### D4 — Políticas contextuais com bandas valor→papel + estado "escalonar"

`agent_policies` ganha faixas parametrizadas (ex.: desconto 0-5% automático / 5-10% gerente / >10% proprietário; compra até R$2k automática / R$2k-5k gerente / >R$5k diretor). Os **4 estados** do Autonomy Contract passam a existir de fato: **permitido / requer aprovação / bloqueado / escalonar**. Ações financeiras/destrutivas: **default deny** (PRD 0 §49).

### D5 — Progressive autonomy por evidência

`DecisionMetrics` + `action_outcomes` alimentam uma **proposta** de elevação de autonomia ("aprovou 97% em 90 dias, 0 reversões → liberar execução automática até R$500?"). A IA **nunca** eleva a própria autonomia silenciosamente (PRD 0 §42) — só **propõe**; o humano confirma; a mudança é auditada.

### D6 — Step-up MFA + detecção de anomalia (posterior)

MFA (TOTP já existe) exigido em ações críticas/financeiras acima de limiar; detector de comportamento anômalo publica em `business_signals` (convenção nº 12), sem tabela própria.

---

## Guardrails (RN-159)

- **RN-159-1** — Default-deny para ação financeira/destrutiva sem policy resolvida.
- **RN-159-2** — Nenhuma elevação de autonomia automática/silenciosa (só proposta governada).
- **RN-159-3** — Todo efeito externo auditado no `action_execution_log`, com `correlationId`; nenhuma baixa silenciosa (convenção nº 7/nº 8).
- **RN-159-4** — Sem engine de governança paralelo: estende `agent_policies`/`ApprovalPolicyService`/`CommandExecutor`.

## Fatias sugeridas (ordem)

| Fatia | Escopo | Prioridade |
| --- | --- | --- |
| **F1** | D2 — correção do two-step + aprovação via RBAC granular | **ENTREGUE (segurança)** |
| **F2.1** | D1 — endurecimento do choke-point (idempotência real anti-duplo-efeito + correlationId no `action_execution_log`) | **ENTREGUE** |
| **F2.2** | D1 — reroute do `CollectionCadence` T2/T3 pelo executor (flag `collection_cadence_via_executor_enabled`; follow-up governado herda correlationId) | **ENTREGUE** |
| **F2.3** | D1 — reroute da família cobrança (`CollectionPromise` + `ResendPix`) via helper compartilhado `CommandExecutorService.sendGovernedMessage`; refactor da cadência pra delegar | **ENTREGUE** |
| **F2.4** | D1 — reroute do `SalesRecoveryPlaybook.approve` (WhatsApp, guard-heavy) via `sendGovernedMessage`; guards LGPD + side-effects intactos | **ENTREGUE** |
| **F2.5** | D1 — reroute do `ProspectExecution` (2 sinks) + handler `gmail_send` novo + generalização do helper (`dispatchGoverned`) | **ENTREGUE — fecha os reroutes do D1** |
| F2.6? | D1 (polimento) — `AsaasService.createPixCharge` público; rate-limit no ponto único | média |
| F3 | D4 — bandas valor→papel + estado "escalonar" | média |
| F4 | D3 — RBAC default-deny faseado | média |
| F5 | D5 — progressive autonomy (proposta por evidência) | média |
| F6 | D6 — step-up MFA + detecção de anomalia | posterior |

> Nota: a F1 (correção do two-step) é um risco de segurança concreto e independente do resto — pode ser destacada e priorizada isoladamente.
