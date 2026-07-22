# ADR-125 — Central de Sobrevivência e Decisão + Motor de Caixa (global)

- **Status:** Motor de Caixa implementado (Fatias 1–3). Fatia 1 livro-caixa; Fatia 2 projeção de 13 semanas + alerta de ruptura; Fatia 3 alerta → ação → medição (Impact Ledger: sugestões ancoradas em dado real, aprovação humana, esperado × realizado). Próximos ADRs consomem esta base: Central de Saúde (síntese top-3), Índice de Sobrevivência 0-100, DRE gerencial, Empresa × Proprietário.
- **Data:** 2026-07
- **Origem:** PRD "Central de Sobrevivência e Decisão Empresarial". Tese: o ZappFlow deve evoluir de central de execução para um **sistema operacional de sobrevivência**: entender → decidir → executar → medir → aprender. Dados Sebrae: comércio lidera mortalidade (30,2% em 5 anos); **22% dos fechamentos citam falta de capital de giro** e 20% baixo volume de vendas.
- **Relacionadas:** RIE/IQR (RevenueIntelligenceService — vazamentos e receita recuperada), ADR-114 (margem de perda), ADR-116 (termômetro de saúde do Comigo), Diretor Executivo IA (ExecutiveAdvisorService), Caderneta/fiado (BalcaoService), AnalyticsService (métricas core). ADR-091 §6 (IA sugere, humano decide). ADR-088 D5 (frugalidade de token).

## Contexto

O ZappFlow já ataca causas de fechamento em peças isoladas: RIE mostra **onde vaza receita**, ADR-114 mostra **onde há perda**, a Caderneta cobra fiado, o Diretor IA narra o negócio. Duas lacunas impedem que isso vire **sobrevivência**:

1. **Não existe visão de caixa.** Não há contas a pagar/receber gerais, nem fluxo realizado, nem **projeção de caixa**. O sistema hoje não sabe dizer "em 3 semanas seu caixa fica negativo" — que é o motivo nº 1 de morte (capital de giro). Faturamento, lucro e caixa são tratados como a mesma coisa.
2. **Falta a camada de síntese.** O dono tem dashboards, mas não uma tela que diga **o que mudou, por que importa e o que fazer primeiro** — e que **meça o resultado** de cada ação.

Este ADR define a **arquitetura da Central de Sobrevivência** e entrega, como primeira construção concreta, o **Motor de Caixa** (o dado que falta). A Central de Saúde (síntese) e o Índice de Sobrevivência vêm em ADRs seguintes, consumindo esta base.

## Decisões

### D1 — Venda ≠ Lucro ≠ Caixa (separação inegociável)
O núcleo financeiro modela **fatos de caixa** (dinheiro que entrou/saiu de fato) separados de **receita** (venda reconhecida) e de **recebíveis** (venda a receber: fiado, boleto/PIX pendente, parcela). **Fiado/recebível NUNCA infla o caixa até ser quitado** (guarda-corpo testável). Essa separação é a lição educativa central do PRD (§9, §26.2) e a base de qualquer projeção honesta.

### D2 — Modelo de dados (global, isolado por organization_id)
Cinco entidades, todas com `organization_id`:
- `cash_accounts` — contas/carteiras: `id, organization_id, name, type (caixa|banco|carteira_digital), opening_balance, current_balance, active`.
- `payables` — contas a pagar: `id, org, description, category, supplier_name, amount, due_date, recurrence (none|weekly|monthly), status (open|paid|overdue|canceled), paid_at`.
- `receivables` — contas a receber gerais: `id, org, contact_id, description, amount, due_date, probability, status (open|received|overdue|canceled), received_at, source_type, source_id`. **Reaproveita** o fiado do Comigo e pedidos em aberto como *fontes* (sem duplicar: ver D5).
- `cash_events` — fatos de caixa: `id, org, direction (in|out), amount, event_date, account_id, source_type, source_id, confidence (confirmed|likely|estimated), note`.
- `cash_forecast_weeks` — snapshot da projeção: `org, week_start, opening, inflow, outflow, ending, risk_level (ok|tight|negative)` (recalculável; persistido para tendência/histórico).

### D3 — Projeção de 13 semanas com confiança explícita
`CashForecastService.build13Weeks(orgId)` projeta 13 semanas a partir de: saldo atual das contas + `payables` (saídas por vencimento, recorrentes geram futuras) + `receivables` ponderados por `probability` + recorrências. Cada semana traz `opening/inflow/outflow/ending` e um `risk_level`. Aponta a **primeira semana abaixo do caixa mínimo** e os **dias de sobrevivência**. Três cenários (**pessimista/provável/otimista**) variando a probabilidade de recebimento. **Toda projeção exibe premissas e nível de confiança** (§26.2.4) — nunca um número "seco".

### D4 — Frugalidade (zero-token no núcleo)
Todo o cálculo (fluxo, projeção, risco, dias de caixa) é **determinístico**, sem LLM — igual a RIE/ADR-114. O LLM (Diretor IA) só **narra** a projeção quando acionado, a partir dos números já calculados. Barato por design e testável sem chave de IA.

### D5 — Reuso, sem digitação dupla (ganchos)
O Motor de Caixa **integra** o que já existe em vez de recriar:
- Pedido pago (`orders` status pago / `comigo_orders` paid) → `cash_event` de entrada (confirmed).
- Fiado lançado (Comigo) → `receivable` (open); quitação do fiado → `receivable` received + `cash_event` in. O saldo do fiado continua vindo do ledger do Comigo (fonte da verdade); o Motor só o **reflete** como recebível.
- Perda/baixa (ADR-114) e assinaturas (`subscription_invoices`) entram como fontes quando fizer sentido.
Ganchos idempotentes por `source_type:source_id` (mesmo padrão do `recordLossUnique` da ADR-114).

### D6 — Todo alerta termina em ação (medida)
Um alerta de ruptura de caixa oferece ações executáveis (cobrar recebível vencido, postergar conta, reduzir compra, ativar campanha) — reusando tarefas, Caderneta e RIE. Cada ação recomendada **exige aprovação humana** (D7 abaixo) e é **rastreável** (antes/depois) — semente do "Impact Ledger" do PRD (§20), detalhado num ADR de Central de Saúde.

### D7 — Guardrails da IA (PRD §21, já são o nosso DNA)
Nunca inventar número financeiro (só dados do sistema ou premissas explícitas); nunca afirmar causalidade quando há correlação; **nunca executar ação financeira sensível sem aprovação humana**; sempre indicar confiança; sempre auditar (recomendação, dados usados, decisão, resultado); tom firme e claro, **nunca assustar/humilhar** o empreendedor.

## Escopo (faseamento)

- **Fatia 1 — Livro-caixa (fundação):** `cash_accounts` + `payables` + `receivables` + `cash_events`; `FinancialLedgerService` (recordEvent, realizedCash, classify) com a separação venda/lucro/caixa; ganchos de pedido pago → entrada (D5); rota `/api/cash` + UI mínima (contas a pagar/receber + caixa realizado do dia/semana). `test:cash-ledger` (venda no fiado não vira caixa; isolamento por org; idempotência dos ganchos).
- **Fatia 2 — Projeção de 13 semanas + alertas:** `CashForecastService.build13Weeks/scenario/firstRiskWeek`; caixa mínimo configurável; primeira semana no vermelho + dias de sobrevivência; snapshot `cash_forecast_weeks`. UI: gráfico das 13 semanas com premissas/confiança e cenários. `test:cash-forecast`.
- **Fatia 3 — Alerta → ação → medida:** o alerta de ruptura gera ações (cobrar/postergar/reduzir/campanha) com aprovação humana e vínculo ao resultado. Liga com RIE, Caderneta e tarefas.
- **Próximos ADRs (não neste):** Central de Saúde (síntese top-3 + Impact Ledger), Índice de Sobrevivência 0-100, DRE gerencial, Empresa × Proprietário / pró-labore.

## Modelo de cálculo (inicial)
- **Caixa realizado** = Σ `cash_events(in)` − Σ `cash_events(out)` na janela (nunca inclui recebível em aberto).
- **Dias de sobrevivência** = caixa disponível / média diária de saídas (janela móvel configurável).
- **Semana em risco** = `ending < caixa_mínimo`; `negative` se `ending < 0`.
- **Inflow provável da semana** = Σ `receivables(due nessa semana)` × `probability` (cenário provável; pessimista/otimista ajustam o fator).

## Consequências
**Positivas:** entrega o dado que falta para prevenir o motivo nº 1 de fechamento; separa venda/lucro/caixa (educa o dono); reusa RIE, Caderneta, perdas e pedidos sem digitação dupla; determinístico e testável; base para Central de Saúde e Índice de Sobrevivência.

**Trade-offs / riscos:** dados incompletos enfraquecem a projeção → mitigado com **nível de confiança + checklist de dados faltantes** (nunca fingir certeza); risco de virar "ERP complexo" → **modo simples por padrão**, entrada manual mínima e ganchos automáticos; promessa comercial exagerada → posicionar como **redução de risco e clareza**, nunca "garantia de sobrevivência" (PRD §22).

## Guardas
- Venda/recebível **não** vira caixa até quitar (D1) — coberto por teste.
- Determinístico e frugal (D4); LLM só narra, nunca calcula.
- Aprovação humana em toda ação financeira sensível; auditoria completa (D7).
- Isolamento por `organization_id` em todas as entidades e cálculos.

## Testes
- `test:cash-ledger` — separação venda/lucro/caixa; ganchos idempotentes; isolamento.
- `test:cash-forecast` — projeção 13 semanas; primeira semana negativa; cenários; premissas/confiança presentes; org vazia sem falso-positivo.
