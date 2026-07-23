# ADR-136 — Decision & Action Ledger (sinais → decisões → resultados)

- **Status:** Epic 2 / Fatia C1 implementada (Ledger de Sinais + FinanceSignalPublisher). Decisões/ações, aprovações, outcomes, Pareto e o executor governado nas fatias seguintes.
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

## Consequências
**Positivas:** cria o contrato único sobre o qual o Pareto (C3) prioriza e as decisões/ações (C2) se apoiam; reusa os motores existentes; idempotente e auditável. Aditivo — nada dos fluxos atuais muda.

**Trade-offs / escopo:** C1 entrega só **sinais** (nenhuma ação/execução). `decision_actions`/`action_approvals`/`action_outcomes`/`agent_policies`, o `ImpactPrioritizationService` (Pareto) e o executor governado (`CommandExecutorService`/Maestro 2.0) vêm nas fatias seguintes — começando em observar/sugerir/preparar, sem `execute` automático. Só o publisher financeiro nesta fatia; os demais domínios entram como novos publishers.

## Guardas
- Determinístico (zero-token); IA não publica sinal por conta própria nesta fatia. Idempotência por `dedupe_key`. Isolado por `organization_id`. Sem execução.

## Testes
`test:business-signals` — o publisher deriva ≥2 sinais dos motores (caixa negativo = critical/fato/impacto −1000 com evidência JSON; recebível vencido = attention/700); lista ordenada por severidade; **re-rodar no mesmo dia não duplica** (idempotente) e o mesmo `dedupe_key` reusa o id; validação de severidade/campos obrigatórios; acknowledge/dismiss mudam o status; isolamento (sinais de uma org não vazam para outra).
