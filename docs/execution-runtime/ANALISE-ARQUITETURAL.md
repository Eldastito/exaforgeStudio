# Análise Arquitetural — ZappFlow Execution Runtime (Fase 0 do PRD)

**PRD‑fonte:** `docs/prd/PRD-ZAPPFLOW-EXECUTION-RUNTIME.md`
**ADR:** `docs/adr/ADR-152-zappflow-execution-runtime.md`
**Companion:** `PLANO-DE-IMPLEMENTACAO.md`, `MATRIZ-DE-COBERTURA-DO-PRD.md`, `DECISOES-E-PENDENCIAS.md`, `STATUS-DE-EXECUCAO.md`
**Data:** 2026-08-03
**Autor:** IA Dev (Claude Opus 4.7)

---

## 0. TL;DR (para o dono do produto)

O PRD reformula problemas que o Epic 2 do ADR-136 (Decision & Action Ledger) e o ADR-085 (Impact Ledger) **já resolveram** em produção. A nomenclatura é diferente; o núcleo é o mesmo. **O verdadeiro gap é o PROCESSO** (contêiner multi‑etapa persistido) — hoje a unidade é ação única. Escopo real: **4 fases, não 8**. Recomendação: reusar o que existe, adicionar `process_definitions`+`process_instances`+Playbook JSON+Confirmation Engine, subir o teto do `CommandExecutorService` de `prepare` para `execute` governado, e rodar os 3 pilotos na ordem de menor risco. Detalhe fase‑a‑fase em `PLANO-DE-IMPLEMENTACAO.md`.

## 1. Método

Inventário direto no repositório (sem depender do PRD): globs de `src/server/*Service.ts` (232 arquivos), `docs/adr/*.md` (152 ADRs), `src/features/**`, `src/server/routes/**`; leitura completa dos serviços que aparecem na §11 do PRD (`ApprovalPolicyService`, `DecisionActionService`, `JobQueueService`, `CashActionService`, `OutcomeMeasurementService`, `CommandExecutorService`); leitura das ADRs‑âncora (**136** Decision‑Action Ledger, **085** Impact Ledger, **073** JobQueue, **074** Scheduler, **091** Grade de planos/dunning, **095** RBAC, **058** webhook processor, **150** Retail Floor, **046** OpportunityRadar); grep de padrões (`idempot`, `retry`, `max_attempts`, `state_machine`, `billing_dunning`, `reactivation`).

## 2. Componentes do PRD × realidade do codebase

Referências file:line são do commit atual da main (`c7fb83c`).

### 2.1 Detectores e Business Signals (§ arquitetura + §7.1 do PRD antigo)
- **Existe.** `BusinessSignalService.publish/list/acknowledge/dismiss/resolve/resolveByDedupe` (`src/server/BusinessSignalService.ts:33-91`).
- Tabela `business_signals` com `UNIQUE(organization_id, dedupe_key)`.
- Publishers em produção: `FinanceSignalPublisher`, `ClinicRenewalTaskService`, `FalaTuBriefingTaskService`, `RetailFloorSignalPublisher`.
- Todos seguem o mesmo padrão: sweep no `Scheduler` → `publish` (idempotente) → sinais fecham por `resolveByDedupe` quando o fato deixa de valer.
- **Gap:** nenhum. O contrato universal do §7.1 do PRD antigo (Epic 2) está pronto. Ver ADR-136 D1/D2.

### 2.2 Motor de decisão e priorização (Pareto)
- **Existe.** `ImpactPrioritizationService.prioritize` — score determinístico `impact*0.40 + urgency*0.20 + confidence*0.15 + strategic*0.15 + actionability*0.10` (ADR‑136 D7). BRL tem preferência, crítico de segurança/compliance override, agrupa por `domínio:tipo`. Rota `GET /api/business/priorities`.
- **Gap parcial:** hoje prioriza **sinais**, não **processos**. Fase 1 do plano adiciona uma view "processos por prioridade" (query nova, sem lógica nova).

### 2.3 Process Definition / Process Instance (§11.1 / §11.2)
- **NÃO existe.** Este é o gap central do PRD. A unidade atual é `decision_actions` — ação única, não processo multi‑etapa. Fluxos como o dunning do billing (`billingDunningPass` em `src/server/Scheduler.ts:494-580+`) rodam hard‑coded em `if/else` por dias de atraso; cadências (`cadences` + `cadence_steps` + `contact_cadences` em `db.ts:992-1024`) rodam multi‑passo mas só de mensagem, sem decisão/ação/estado de processo.
- **Fase 1 do plano:** tabelas `process_definitions` (com `steps_json` versionado) e `process_instances` (FSM do §11.4), aditivos ao `decision_actions`.

### 2.4 Action Contract (§11.3)
- **Existe (≈70%).** `decision_actions` já tem: `domain`, `action_type`, `title`, `description`, `expected_impact`, `basis` (fact|estimate), `confidence`, `command_type`, `command_payload_json`, `approval_policy`, `approval_role`, `assigned_to`, `due_at`, `executed_at`, `status`, `result_amount`, `baseline_json` (`src/server/DecisionActionService.ts:41-49`). Tabelas irmãs: `action_approvals`, `action_execution_log`, `action_outcomes`.
- **Gap aditivo:** falta `process_instance_id`, `subject_type/id`, `deadline_at`, `attempt_count`, `max_attempts`, `success_condition`, `fallback_action_type`, `evidence_json`. **CREATE‑then‑ALTER** (convenção nº 2 do CLAUDE.md) resolve sem quebrar contratos existentes.

### 2.5 Máquina de estados (§11.4)
- **Existe parcialmente.** FSM de **ação**: `awaiting_approval → approved → done | rejected | cancelled` (com `executed_at` marcando prepare). FSM de **sinal**: `open | acknowledged | resolved | dismissed`. FSM de **billing**: `active → past_due → suspended` (dunning D‑5/D‑1/D+1/D+7/D+10/D+30 em `Scheduler.ts:544-587`).
- **Gap:** FSM unificada de **processo** cobrindo `detected → planned → awaiting_approval → queued → executing → waiting_external_response → retry_scheduled → escalated → completed | failed | cancelled → measured`. Fase 1 do plano entrega essa FSM em `ProcessRuntimeService` com transições validadas em código + auditoria em cada transição.

### 2.6 Executor Registry (§11.5)
- **Existe.** `CommandExecutorService` é registry `Map<command_type, Handler>` com 5 handlers tipados (`src/server/CommandExecutorService.ts:32-82`): `TaskCommandHandler`, `CollectionCommandHandler`, `CampaignCommandHandler`, `ProcurementCommandHandler`, `RetailOpsCommandHandler`. Cada tentativa auditada em `action_execution_log`. Comando sem handler → recusa auditada `no_handler`. **Teto: `prepare`** (rascunho, zero efeito externo — decisão explícita da ADR-136 D9).
- **Gap:** subir o teto para `execute` governado, e adicionar executores concretos (`WhatsAppSendCommandHandler`, `AsaasPixCommandHandler`, `AsaasChargeCommandHandler`, `AlterdataFetchCommandHandler`, `SchedulerActionCommandHandler`), cada um declarando `timeout_seconds`, `retry_policy`, `confirmation_method`, `reversibility`, `risk_classification` (§11.5).

### 2.7 Policy Engine + Níveis de autonomia (§11.6 / §11.7)
- **Existe.** `ApprovalPolicyService.resolve` (`src/server/ApprovalPolicyService.ts:31-56`) — matriz padrão + tabela `agent_policies` por `(org, domain, action_type)` com `autonomy_level ∈ {observe, suggest, prepare, execute}` (linha 6243 do `db.ts`), `approval_role`, `max_auto_amount`, `active`. Autonomia baixa endurece política; valor > teto exige aprovação; `two_step` exige 2 aprovadores distintos.
- **Gap:** valor `execute` já é aceito na coluna, mas nenhum handler o consome (teto ADR‑136 D9). Nível 5 do PRD ("Gerenciar o processo") é o Runtime executando o playbook — Fase 1+2 entregam isso. Aditivo: coluna `execution_mode ∈ {shadow, assisted, approved_execution, autonomous}` (ADR-152 D7).

### 2.8 Playbook Engine (§11.8)
- **NÃO existe.** É o segundo gap central. Único multi‑etapa hoje é o dunning do billing (hard‑coded) e cadências de mensagem (`cadences`/`cadence_steps`). Não há orquestração declarativa de "condição → ação → sucesso → fallback → próxima".
- **Fase 1 do plano:** `steps_json` em `process_definitions` — JSON tipado com Zod (ADR‑152 D3), avaliação por `PlaybookEngine` puro. Sem DSL própria (custo alto, ganho baixo).

### 2.9 Retry, timeout, compensação (§11.9)
- **Existe (≈70%).** `JobQueueService.enqueue/runJob/sweepStale` (`src/server/JobQueueService.ts:23-92`) — retry automático até `max_attempts` (default 3), `sweepStale` reprocessa `pending` órfão e `processing` travado (rede do Scheduler `fastPass` a cada 5 min), idempotência via `runJob` conferindo `status='completed'` na entrada. `MessageDeliveryService` também tem retry.
- **Gap:** backoff **imediato** hoje (falta `backoff_seconds` calculado por tentativa); classificação de erro (`retryable | non_retryable | permission | external_unavailable`); dead‑letter formal (linhas `status='failed'` existem, falta expor no painel de exceções). Compensação por processo (não por ação) — vem junto com o Playbook.

### 2.10 Confirmation Engine (§11.10)
- **Existe distribuído**, não centralizado. Webhook do Asaas atualiza `payables/receivables`, `webhookProcessor` roteia mensagens (ADR-058), `resolveByDedupe` fecha sinais quando o fato deixa de valer, `RetailFloorReconciliationService` cruza declarado × PDV Alterdata (ADR‑150).
- **Gap:** peça `ConfirmationEngine` fina que amarra `action.expected_confirmation → subscriber externo` e fecha a ação com `evidence_json`. Não substitui o webhook/reconciliador — cola em cima. Fase 2 do plano.

### 2.11 Outcome Ledger (§11.11)
- **Existe (≈90%).** `OutcomeMeasurementService.record/forAction/ledger` (`src/server/OutcomeMeasurementService.ts:28-98`) + `action_outcomes` — `expected_value × realized_value`, `basis ∈ {fact, estimate}` **SEPARADOS** (nunca somados — ADR-085 D4), `measurement_method ∈ {self_reported, manual, attributed, derived}`, `attribution_window_days`, `evidence_json`. `ledger()` agrega esperado/realizado com fato ≠ estimativa por unidade. **Ponte pro caixa legado** feita (`CashActionService.complete` → `OutcomeMeasurementService.record`, `src/server/CashActionService.ts:81-97`). Impact Ledger operacional (ADR-085) mede categorias além do comercial (capital parado, divergências, tempo devolvido, adoção).
- **Gap aditivo:** campos explícitos `time_saved_minutes`, `cost_avoided`, `revenue_recovered`, `loss_prevented` para o painel de Operações Autônomas (hoje tudo cabe em `realized_value + evidence_json`, mas separar melhora a UI e a agregação).

### 2.12 Exception Center (§11.12)
- **Existe parcialmente.** `ExecutiveView.tsx` tem aba "Plano de Ação" com "Aguardando aprovação" + "Aprovadas prontas para concluir" + Impact Ledger (ADR‑136 D8).
- **Gap:** categorização (aprovação/decisão/dado faltante/integração falhou/conflito/risco/divergência/SLA em risco) + "consequência de não decidir" + prazo por exceção. Extensão da view atual, não peça nova (ADR-152 D8).

## 3. Cobertura por processo‑piloto

### 3.1 Cobrança e recuperação financeira (§13) — **~65% pronto**

**Existe:**
- **Dunning do BILLING (assinatura ZappFlow → lojista)** com estados D‑5/D‑1/D+1/D+3/D+5/D+7/D+10/D+30 (`Scheduler.ts:544-587`, ADR‑091 §8 Bloco B). `billing_dunning_stage` só avança quando MUDA (idempotente).
- `AsaasService` (PIX + assinatura + webhook), `PaymentService`, `ComigoPixService`.
- `CashActionService` sugere ações concretas ancoradas em dado real (cobrar receber, postergar pagar, campanha), com Impact Ledger (`src/server/CashActionService.ts:23-114`).
- `CollectionCommandHandler` no CommandExecutor prepara mensagem de cobrança com valor esperado.
- `webhookProcessor` interpreta resposta do canal (ADR‑058). `FinancialLedgerService` tem `aReceber`, `vencidos`.

**Falta:**
- **Dunning LOJISTA → CLIENTE FINAL** — o dunning atual é ZappFlow → lojista. Precisa nascer aditivo, no mesmo molde.
- Máquina de estados formal de "processo cobrança" ligando as peças.
- Confirmation Engine que fecha `decision_action` quando o webhook do Asaas confirma pagamento (hoje o webhook atualiza `receivables`, mas não amarra na ação).
- Interpretação de intenção do cliente ("vou pagar amanhã", "posso parcelar?") virando estado do processo — hoje o `AIOrchestrator` responde, mas não altera FSM de nenhum processo.

### 3.2 Recuperação automática de oportunidades comerciais (§14) — **~55% pronto**

**Existe:**
- `OpportunityRadarService` (ADR-046) — detecta 5 categorias (stock_out, product_gap, service_complaint, cancellation_reason, delay_pattern), dedupe 90 dias.
- `RecoveryRadarService` — detecção de recuperação.
- `Scheduler.reactivationPass` — passe automático.
- `cadences + cadence_steps + contact_cadences` — padrão de cadência multi‑passo (mensagens).
- `CustomerMemoryService` (ADR-071), `CustomerProfileService`.
- RIC (Revenue Intelligence) já atribui receita recuperada por regra hard‑coded.

**Falta:**
- Botão "Recuperar agora" iniciar um **processo real** persistido por oportunidade (hoje cadências rodam mas o vínculo com "instância de processo" não existe).
- Interpretação de resposta → próximo passo da cadência (hoje cadência é linear).
- Atribuição de ganho/perda ao processo, não à cadência solta.
- Respeitar opt‑out e limites de contato dentro do executor (hoje é responsabilidade de cada envio individual).

### 3.3 Fechamento e conciliação diária de lojas (§15) — **~75% pronto**

**Existe:**
- 8 serviços `RetailFloor*`: `RetailFloorService`, `RetailFloorAttendanceService`, `RetailFloorPilotService`, `RetailFloorReconciliationService` (ADR‑150 Fatia 6 — cruza declarado × PDV Alterdata, tolerância 5%, idempotente e conservador), `RetailFloorSignalPublisher`, `RetailFloorScanService`, `RetailFloorShiftService`, `RetailFloorDigestService` (WhatsApp).
- `AlterdataSyncRunner` + `AlterdataConnectorService` + 3 mappers (price/stock/supply) — integração de leitura.
- `RetailFloorSignalPublisher` publica sinais quando algo requer atenção.
- Fluxo do fechamento diário roda no Scheduler.

**Falta:**
- Aprovação **automática** por política quando "diferença abaixo da tolerância + PDV sincronizado + adquirente conciliado + doc completa" (§15.4). Hoje reconcilia mas quem aprova é humano.
- Vínculo do fechamento a um **processo** com SLA (até 9h — §15.6) e escalonamento formal quando estoura o SLA.
- Fonte **Sicredi** (adquirente) — mencionada no PRD (§15.3), não vi no repo. Bloqueio externo em `DECISOES-E-PENDENCIAS.md`.
- Cálculo de comissão vinculado ao processo (existe `RetailFloorAnalyticsService`, falta o "quando concluído, calcular").

## 4. Achados principais

### 4.1 O Epic 2 do ADR‑136 já é um "mini‑Runtime v0"
O que o PRD chama de "Action Contract + Policy Engine + Executor Registry + Outcome Ledger" o ADR-136 chamou de "Decision-Action Ledger + ApprovalPolicy + CommandExecutor + OutcomeMeasurement". A nomenclatura é diferente; o núcleo é o mesmo. **Reescrever seria duplicação grande** e criaria risco de regressão em ~30 rotas que já consomem `decision_actions`. Decisão: reusar (ADR-152 D1).

### 4.2 O verdadeiro gap é o **PROCESSO** (multi‑etapa persistido)
Hoje a unidade é **ação única** (`decision_actions`). Não há "processo com N etapas encadeadas por regras". Playbook Engine + Process Definition/Instance é o gap mais importante. Resolvendo isso, todo o resto vem por reuso.

### 4.3 O teto de `prepare` foi decisão INTENCIONAL (ADR-136 D9)
Não é acidente — foi contrato de confiança do produto ("a IA nunca escreve na base de negócio"). Subir para `execute` precisa ser fatiado com muito cuidado: feature flag por org + shadow mode antes + revisão de segurança. A IA **continua** não escrevendo — quem escreve são os handlers determinísticos, mas passam a chamar Asaas/WhatsApp/Alterdata de verdade.

### 4.4 A Confirmation Engine é 100% reuso
Webhook do Asaas já existe (ADR‑058), reconciliação Alterdata já existe (ADR‑150), `resolveByDedupe` do signal já é o padrão de "fato deixou de valer". Precisa só de uma peça fina que amarra "action.expected_confirmation → callback do webhook → action.complete".

### 4.5 Várias afirmações do PRD são **falsas** com base no repo atual
Ver `MATRIZ-DE-COBERTURA-DO-PRD.md`. Exemplos: "Job Queue: existe" (`JobQueueService` está lá, ADR-073); "Approval/Policy: existe" (`ApprovalPolicyService` + `agent_policies`); "Outcome Ledger: existe" (`OutcomeMeasurementService` + `action_outcomes`); "Scheduler maduro: existe" (múltiplos passes coordenados); "RBAC granular: existe" (ADR‑095); "auditoria: existe" (`auth_audit_logs` + `logAuthEvent`); "feature flags: existe" (`organization_settings.<modulo>_enabled`); "LGPD: existe" (ADR‑056); "Impact Ledger unificado: existe" (ADR‑085 + `action_outcomes`); "MessageDeliveryService com retry: existe". O PRD assume ponto de partida mais raso do que o repo real.

## 5. Riscos técnicos

| # | Risco | Mitigação |
|---|---|---|
| R1 | Regressão em rotas que consomem `decision_actions` | Aditivo puro (CREATE-then-ALTER, colunas nullable), `assisted` como default de `execution_mode`, testes de regressão obrigatórios em cada fatia |
| R2 | `JobQueueService` é single‑process — Runtime demanda mais concorrência | Aceito neste escopo (D6 do ADR). Se virar gargalo, fatia futura considera Redis/BullMQ ou queue distribuída. Playbook duradouro é OK porque o timer bate no Scheduler |
| R3 | LLM inventando conclusão de processo | Confirmation Engine só fecha por evidência externa determinística. LLM só narra e classifica intenção — ambíguo cai em exceção humana |
| R4 | Loop automático (Runtime enfileirando a si mesmo) | Guard `max_attempts` por ação, `sweepStale` só reprocessa órfão, playbook Zod-validado no boot (impossível referenciar step inexistente) |
| R5 | Ações irreversíveis (pagamento, envio) executadas por engano | 3 camadas: (a) autonomy `execute` na política, (b) política de aprovação satisfeita, (c) `execution_mode ≥ approved_execution` na org. Padrão `assisted` mantém comportamento atual |
| R6 | Concorrência: mudança manual + Runtime na mesma ação | FSM com transições validadas; cancelamento manual bloqueia próxima ação; leitura otimista com validação de versão em cada transição |
| R7 | Reprocessamento de webhook duplicado | Idempotência já é padrão do repo (unique index + `SQLITE_CONSTRAINT_UNIQUE`); Confirmation Engine reusa. `action_execution_log.attempt` deduplica retries |
| R8 | Rollback sem perda de trabalho | Feature flag `execution_runtime_enabled` desliga o gate central; `assisted` como intermediário permite rollback progressivo sem breaking |
| R9 | Credencial externa expira/some (Asaas, Alterdata) | Ação vira exceção com categoria `integração falhou`; handler não retenta indefinidamente (max_attempts=3 default); painel de exceções lista pra reação humana |
| R10 | LGPD em recuperação comercial (mensagem proativa) | Piloto 3 (recuperação comercial) só sai de `assisted` para `execute` após revisão jurídica; opt‑out do contato consultado antes de cada envio pelo executor |

## 6. Dívida técnica que **não** faz parte deste escopo

- Fila distribuída (Redis/BullMQ) — aceito o single‑process (D6 ADR‑152).
- Migração de SQLite para Postgres — fora do escopo.
- Refatoração dos publishers de sinal (padronização) — cada publisher já segue o mesmo contrato, refatoração cosmética.
- Renomeação `decision_actions → Action Contract` — não haverá (D1 ADR‑152).

## 7. Perguntas do PRD §24 — respondidas

1. **Qual serviço mais se aproxima do Runtime?** `DecisionActionService + CommandExecutorService + ApprovalPolicyService + OutcomeMeasurementService` — juntos são o Runtime v0 (teto `prepare`).
2. **Action Service pode ser estendido?** Sim — `decision_actions` recebe colunas aditivas; nenhuma reescrita.
3. **JobQueueService é suficiente?** Para este escopo, sim. Ver R2.
4. **Scheduler atual suporta processos duradouros?** Sim — passe rápido (5min) + tick horário + integração best‑effort por‑org já é o padrão. Playbook duradouro reusa esse relógio.
5. **Como o Plano de Ação se conecta ao Runtime?** Aba `ExecutiveView` estende (não substitui) — reusa consumo de `decision_actions` + adiciona view de `process_instances` (ADR‑152 D8).
6. **Como Business Signals dispara processos?** `BusinessSignalService.publish` continua sendo o trigger; um novo `ProcessRuntimeService.startFromSignal(signalId)` faz a ponte pra `process_instances`.
7. **Impact Ledger ↔ Outcome Ledger?** `action_outcomes` (ADR‑136 D6) é o Outcome Ledger unificado. Impact Ledger operacional (ADR‑085) já compartilha a mesma tabela via ponte `decision_action_id`.
8. **Quais ações já são idempotentes?** Todas as que publicam sinal (`resolveByDedupe`); todas as que enfileiram job (`runJob` checa status='completed'); a reconciliação Alterdata (só promove, nunca rebaixa auto — ADR-150 Fatia 6).
9. **Quais integrações suportam escrita?** Asaas (PIX + cobrança), WhatsApp via `MessageProviderService`, Alterdata (leitura hoje — escrita a validar), Instagram DM (ADR‑098), Google (Calendar/Sheets).
10. **Quais só leem?** Alterdata (por padrão), Meta Ads (leitura).
11. **Quais processos já têm confirmação?** Cobrança de billing (webhook Asaas), reconciliação retail (ADR‑150), agenda clínica (paciente confirma), FalaTu (confirmação humana).
12. **Quais terminam no envio?** Cadências de reativação atuais (não fecham loop), mensagens do Diretor IA (recomendação sem execução), notificações do RetailFloorDigest.
13. **Onde estão as políticas atuais?** `agent_policies` (por action_type), `PermissionService` (por perfil, ADR‑095), `PlanService` (limites por plano, ADR‑091), flags em `organization_settings`.
14. **Como preservar RBAC?** Continua enforced na rota (`requireRole`, `enforceModulePermission` global do `protectedApi`). Runtime não bypassa — o executor roda com escopo do sistema, mas ações precisam de política aprovada.
15. **Como implementar rollback?** Feature flag `execution_runtime_enabled` (kill switch); `execution_mode` volta pra `assisted`; ações no `Plano de Ação` continuam manuais.
16. **Como evitar loops automáticos?** Playbook Zod‑validado (sem step inexistente); `max_attempts` por ação; `sweepStale` só reprocessa órfão; `resolveByDedupe` fecha sinal que gerou o processo.
17. **Como impedir mensagens repetidas?** Idempotência de envio (unique index em `message_deliveries` — padrão do repo); `contact_cadences` já dedupe por contato+cadência; Confirmation Engine fecha a ação antes do próximo passo disparar.
18. **Como interromper processos manualmente?** `process_instances.status = 'cancelled'` (endpoint dedicado + auditoria); cancela as ações filhas em `awaiting_approval`.
19. **Como lidar com mudanças concorrentes?** Transação ao transicionar (leitura otimista + revalidação de estado); webhook chega e reconcilia com o que a UI mudou (padrão da reconciliação Retail F6).
20. **Riscos LGPD?** Piloto de recuperação comercial exige consulta de opt‑out antes de cada envio (contato pode ter revogado); dados sensíveis fora do `evidence_json`; `logAuthEvent` com identificador mascarado.
21. **Qual o MVP real do Runtime?** Fase 1 (Process Fabric) + Fase 2 (Execute + Confirmation) + **UM piloto** (recomendo Retail Closing).
22. **Qual processo é o primeiro piloto?** Retail Closing (75% pronto, política clara, escopo por loja, baixo risco financeiro).
23. **Qual vertical recebe o primeiro rollout?** TOULON (já é piloto do ADR‑150). Ver `DECISOES-E-PENDENCIAS.md`.
24. **Quais itens dependem de credenciais externas?** Asaas (escrita PIX), Alterdata (verificar), Sicredi (ausente), WhatsApp Business (existe).
25. **Quais podem ser implementados agora?** Toda a Fase 1 (Process Fabric) — 100% em cima de código existente, sem dependência externa.

## 8. O que esta análise NÃO cobriu (limites honestos)

- Volumetria real de produção — não medi throughput de `JobQueueService` sob carga; a suposição de que single‑process é suficiente vale para o escopo, mas deve ser revisada com métricas reais após a Fase 2.
- Latência aceitável de confirmação externa — assumi minutos, não segundos. Se algum processo exigir sub‑segundo (raro), a arquitetura muda.
- Custo de LLM em interpretação de intenção — assumi que o motor atual do `AIOrchestrator` cobre; se o volume da cobrança escalar, precisa medir.
- Análise de segurança adversarial do modo `autonomous` — feita superficialmente; recomendo revisão dedicada antes de sair de `assisted`.

## 9. Recomendação final para a Fase 1

Começar por: (a) tabelas `process_definitions` + `process_instances` (aditivas, migration em `db.ts`), (b) `ProcessRuntimeService` mínimo com FSM + `startFromSignal(signalId)` + `advance(instanceId)`, (c) uma primeira `process_definition` do processo mais simples do Retail Closing (a fatia que **só** conclui o "casos regulares aprovados automaticamente" quando tudo está dentro da tolerância — deixando exceções manuais como já são hoje). Teste `scripts/test-runtime-process-fabric.ts` cobre FSM, isolamento multi‑tenant, versionamento, auditoria.

Fatia 1 estimada: aditivos em 4 arquivos, 1 service novo, 1 rota, 1 teste. Sem UI (esta fatia é fundação). Feature flag `execution_runtime_enabled=0` por default — nenhuma org existente muda de comportamento.
