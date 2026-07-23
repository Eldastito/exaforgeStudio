# ADR-136 — Decision & Action Ledger (sinais → decisões → resultados)

- **Status:** Epic 2 **COMPLETO** — C1 (Ledger de Sinais), C2a (Ações + Aprovações + Políticas de autonomia), C2b (Outcomes / Impact Ledger unificado), C3 (Pareto / priorização por impacto), C4 (UI — Plano de Ação no Diretor Executivo IA) e C5 (executor governado / Maestro 2.0, prepare-only) implementadas.
- **Data:** 2026-07
- **Origem:** PRD "ZappFlow Enterprise Intelligence" (Epic 2). Hoje cada módulo mede valor e reage de forma diferente; falta um **contrato comum** para publicar um sinal, priorizar por impacto e transformar em ação medida. Esta ADR abre essa camada, começando pelo **ledger de sinais** (read/write, sem execução) sobre a fundação do Snapshot V2 (ADR-135).
- **Relacionadas:** ADR-135 (Snapshot V2/adapters), ADR-126 (Central de Saúde), ADR-085 (Impact Ledger), ADR-130 (Governança de IA). PRD §7.1, §24.

## Decisões

### D1 — Contrato comum de sinal (`business_signals`)
Tabela conforme PRD §7.1: `domain`, `signal_type`, `severity` (info|attention|risk|critical), `basis` (fact|estimate), `confidence` (0..1), `impact_amount`/`impact_unit`, `evidence_json`, `premises_json`, `source_service`, `dedupe_key`, `status` (open|acknowledged|resolved|dismissed). **`UNIQUE(organization_id, dedupe_key)`**. Isolado por `organization_id`.

### D2 — `BusinessSignalService` idempotente
`publish(orgId, signal)` valida (severidade/basis/confiança) e é **idempotente por `(org, dedupe_key)`**: republicar o mesmo sinal **atualiza** a linha (severidade/impacto/evidência/`detected_at`) em vez de criar outra — nunca duplica (PRD §7.1, caso crítico §25.2.1). `list`/`acknowledge`/`dismiss`/`resolve` completam o ciclo de vida. Não executa nada.

### D3 — `FinanceSignalPublisher` (deriva do que já existe, sob demanda)
Deriva sinais financeiros tipados a partir dos motores determinísticos existentes — `FinancialLedgerService` (caixa, a receber/vencido, a pagar), `CashForecastService` (ruptura), `OwnerDrawService` (retiradas), `BusinessHealthService` (qualidade dos dados) — sem novo cálculo: `cash_below_minimum`, `cash_break_risk`, `receivable_overdue`, `payable_due_soon`, `owner_draw_excess`, `data_quality_low`. **Dedupe por `tipo:dia`** → rodar duas vezes no mesmo dia não duplica. **Sob demanda** (rota `POST /api/signals/refresh`), sem passe no Scheduler nesta fatia — sem efeito colateral no agendador.

### D4 — API read/write
`GET /api/signals` (lista, ordenada por severidade), `POST /api/signals/refresh` (deriva+publica), `POST /api/signals/:id/acknowledge|dismiss`.

### D5 — Ações + Aprovações + Políticas de autonomia (C2a)
`decision_actions`/`action_approvals`/`agent_policies` (PRD §7.2/7.3/7.6). `DecisionActionService`: **propor** (a IA/regra propõe) → a política decide se nasce `approved` (baixo risco) ou `awaiting_approval` → **aprovar/rejeitar** (auditado em `action_approvals`) → **concluir/cancelar**. `ApprovalPolicyService.resolve` usa a política da organização (`agent_policies`) quando existe, senão a **matriz padrão do PRD §10.2** (`create_task`=none; `collection`=single; `change_price`=role owner; `choose_supplier`/`create_purchase_order`=two_step). `two_step` exige **2 aprovadores distintos**. Autonomia baixa (observe/suggest) e valor acima do `max_auto_amount` **endurecem** a política. RBAC de perfil na rota. **Nada de `execute` automático** — o mais alto é preparar+aprovar+concluir manualmente; a execução governada (comandos tipados) é a fatia C5.

### D6 — Outcomes + Impact Ledger unificado (C2b)
`action_outcomes` (PRD §7.5): `expected_value`/`realized_value`, `basis` (fact|estimate), `measurement_method` (self_reported|manual|attributed|derived), `attribution_window_days`, `evidence_json`. `OutcomeMeasurementService`: `record` (valida ação do tenant), `forAction`, `ledger` (esperado×realizado agregado, **fato e estimativa SEPARADOS** — ADR-085 D4, nunca somados num número inflado; junta metadados da ação: origem/domínio/título). `DecisionActionService.complete` **registra o outcome automaticamente** (esperado = `expected_impact` da ação, realizado = `resultAmount`, herdando a `basis`). **Ponte do caixa legado** (PRD §7.7 — "`decision_action_id` quando útil"): `cash_actions.decision_action_id` (nulo por padrão); quando presente, `CashActionService.complete` espelha o outcome no ledger unificado — **sem alterar o comportamento quando não há vínculo**. A medição é aditiva: nunca bloqueia a conclusão (try/catch). Rotas: `GET /api/actions/ledger`, `GET/POST /api/actions/:id/outcomes`.

### D7 — Pareto / priorização por impacto (C3)
`ImpactPrioritizationService.prioritize` ranqueia os sinais **abertos** por um score DETERMINÍSTICO (PRD §9.2): `normalized_impact*0.40 + urgency*0.20 + confidence*0.15 + strategic_weight*0.15 + actionability*0.10`. Regras do PRD: **impacto normalizado dentro da mesma unidade** (máx por unidade), **BRL tem preferência** (fator de unidade), **crítico de segurança/compliance ultrapassa o financeiro** (override que rankeia acima mesmo com score menor), **sinais do mesmo tipo/evento agrupados** (por `domínio:tipo`, mantém o de maior score com `groupedCount`). Retorna **até 3 prioridades globais e 3 por domínio**, cada uma com a **saída obrigatória do §9.3** (fato, interpretação, impacto, fato/estimativa, confiança, evidência/origem, ação recomendada, responsável sugerido, prazo, aprovação necessária — reusa `ApprovalPolicyService` da C2a — e como será medido) e um `reason` explicando o ranking. **Reproduzível sem LLM.** Rota: `GET /api/business/priorities`.

### D8 — UI: Plano de Ação no Diretor Executivo IA (C4)
Primeira tela do Epic 2. Uma aba **"Plano de Ação"** dentro do **Diretor Executivo IA** (`ExecutiveView`), ao lado da conversa existente — sem novo item de menu. Junta num só lugar: (1) o **Impact Ledger** (esperado × realizado, com **comprovado e estimado separados**, nunca somados) da C2b; (2) as **Prioridades de hoje** (Pareto — C3) com impacto, confiança, motivo do ranking, aprovação necessária e "como medir"; (3) as ações **Aguardando aprovação** (C2a) com Aprovar/Rejeitar (motivo obrigatório para rejeitar); (4) as **Aprovadas** prontas para concluir com registro do resultado (fecha o outcome da C2b). Consome só rotas já testadas (`GET /api/business/priorities`, `GET /api/actions?status=…`, `GET /api/actions/ledger`, `POST /api/actions/:id/approve|reject|complete`); RBAC e política são validados no backend. Read-first, sem quebrar a conversa do Diretor.

### D9 — Executor governado / Maestro 2.0 (C5)
`action_execution_log` (PRD §7.4) + `CommandExecutorService`: transforma uma ação **aprovada** num **artefato preparado** por **handlers TIPADOS por domínio** (`TaskCommandHandler`, `CollectionCommandHandler`, `CampaignCommandHandler`, `ProcurementCommandHandler`, `RetailOpsCommandHandler`), com cada tentativa **auditada**. Guardas: **só comandos registrados** (comando sem handler → recusa auditada `failed/no_handler`, nada roda); **só ação aprovada**; **teto em `prepare`** — produz rascunho (mensagem de cobrança, brief de campanha, cotação, tarefa) **sem efeito externo** (nada é enviado/pago/baixado); a IA **nunca escreve em tabela de negócio** (quem prepara é o handler determinístico). Ao preparar com sucesso, marca `executed_at`; o status segue `approved` até o humano concluir (→ outcome C2b). `execute` externo automático é fatia futura (fora do MVP). Rotas: `POST /api/actions/:id/prepare` (gestor), `GET /api/actions/:id/executions`. UI: botão **Preparar** nas ações aprovadas do Plano de Ação.

## Consequências
**Positivas:** o Epic 2 fica **completo** — contrato único de sinais → Pareto → ação governada (propor→aprovar→**preparar**→concluir) → Impact Ledger unificado (esperado×realizado, fato≠estimativa) → tela onde o Diretor vê e age. Tudo determinístico, auditável, reusando os motores existentes; a IA nunca executa efeito externo por conta própria (teto em `prepare`). Aditivo — nada dos fluxos atuais muda.

**Trade-offs / escopo:** C1 entrega só **sinais** (nenhuma ação/execução). `decision_actions`/`action_approvals`/`action_outcomes`/`agent_policies`, o `ImpactPrioritizationService` (Pareto) e o executor governado (`CommandExecutorService`/Maestro 2.0) vêm nas fatias seguintes — começando em observar/sugerir/preparar, sem `execute` automático. Só o publisher financeiro nesta fatia; os demais domínios entram como novos publishers.

## Guardas
- Determinístico (zero-token); IA não publica sinal por conta própria nesta fatia. Idempotência por `dedupe_key`. Isolado por `organization_id`. Sem execução.

## Testes
`test:business-signals` (C1) — o publisher deriva ≥2 sinais dos motores (caixa negativo = critical/fato/impacto −1000 com evidência JSON; recebível vencido = attention/700); lista ordenada por severidade; **re-rodar no mesmo dia não duplica** (idempotente) e o mesmo `dedupe_key` reusa o id; validação; acknowledge/dismiss; isolamento.

`test:decision-actions` (C2a) — matriz padrão (create_task=none, collection=single, change_price=role owner, choose_supplier=two_step); baixo risco nasce aprovado, demais aguardam; 1 aprovação fecha single; **two_step exige 2 aprovadores distintos** (o mesmo não conta duas vezes); só conclui aprovada (com resultado); rejeitar/cancelar; política da org (autonomia observe) endurece none→single; isolamento por org.

`test:outcome-measurement` (C2b) — concluir gera 1 outcome (esperado 4200 × realizado 3800, herda a basis); `forAction` lista; `record` em ação inexistente/cross-org lança erro; ledger soma esperado/realizado/gap e **separa fato de estimativa**; junta metadados da ação; **ponte do caixa**: `cash_action` vinculada espelha o outcome (com evidência de origem) e sem vínculo **não** cria outcome (legado intacto); isolamento por org.

`test:impact-prioritization` (C3) — sem sinais → vazio; ranqueia por impacto financeiro (mesma unidade), maior 4200 em 1º; traz score/componentes/`reason` e a saída §9.3 (ação, como medir, aprovação single); **ranking reproduzível** (mesmo input → mesma ordem, sem LLM); **crítico de segurança ultrapassa o financeiro** mesmo com score menor; **sinais do mesmo tipo agrupam** (mantém o de maior impacto, `groupedCount=2`); **até 3 por domínio** ordenadas por score; isolamento por org.

C4 é **UI** (aba Plano de Ação): consome apenas rotas já cobertas pelos testes de C1–C3; a garantia é o gate de build (`vite build` + `esbuild`) verde e nenhum novo erro de typecheck no arquivo. Sem teste de backend novo.

`test:command-executor` (C5) — handlers registrados (create_task/collection); prepara `create_task` (artefato `task_draft`, `executed_at` marcado, log `done`, modo `prepare`); `collection` gera mensagem ancorada no valor e **canal manual** (sem envio); **só prepara ação aprovada** (aguardando → recusa); **comando sem handler → recusa auditada** `failed/no_handler` e ação **não** marcada como preparada; ação sem `command_type` rejeitada; re-preparar **incrementa attempt**; isolamento por org.
