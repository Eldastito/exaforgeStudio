# Análise: Jornada do Cliente & Funil de Vendas

> Diagnóstico de como o app conduz (ou não) o cliente pela jornada até o
> fechamento, e o roadmap de melhorias. Objetivo do produto: **não só atender de
> forma humanizada, mas conduzir o cliente numa jornada até finalizar a venda.**

## Veredito

A **estrutura** do funil existe e é boa, mas o app era mais um **assistente
reativo que acompanha a jornada** do que um **vendedor que conduz até o
fechamento**. Faltava (1) a IA *empurrar* a venda, (2) tapar *vazamentos* de
funil e (3) corrigir *bugs* que quebravam o fluxo.

## O que já estava alinhado à jornada (base sólida)

- 12 estágios `novo_lead → pos_venda` no kanban (`useStore.ts`).
- Lead score (0-100) + temperatura (frio/morno/quente) injetados no prompt da IA (`CustomerProfileService.ts`).
- Cadências de follow-up por estágio-gatilho, com mínimo de score e cancelamento ao responder (`CadenceService.ts`).
- Negociador estruturado de desconto com margem/preço mínimo (`AIOrchestratorService.ts`).
- Cobrança automática (PIX manual + Mercado Pago dinâmico que confirma por webhook), lembrete de PIX, reativação de inativos, campanhas segmentadas, assinaturas, transição invisível.

---

## Lacunas identificadas (lista para implementar)

### Grupo A — Bugs que quebram o funil
- **A1. Kanban não persistia o arraste** — `moveTicket` só mudava estado local; sem rota de stage. → **FEITO** (lote 1).
- **A2. Pedido pendente "infinito" travava estoque** — sem TTL/cancelamento. → **FEITO** (lote 1, opt-in).
- **A3. Lembrete de PIX só 1x e só Mercado Pago** — sem retentativa progressiva nem PIX manual. → roadmap (fase 2).

### Grupo B — Fazer a IA CONDUZIR (não só responder)
- **B1. Sem qualificação ativa** (perguntas de descoberta). → **FEITO** (prompt, lote 1).
- **B2. Cross-sell/upsell genérico.** → **FEITO** (prompt: 1 complemento ao confirmar pedido).
- **B3. CTA passivo** (esperava o cliente pedir para comprar). → **FEITO** (prompt: fechamento proativo).
- **B4. Objeções só de preço.** → **FEITO** (prompt: playbook de objeções — preço/hesitação/receio/timing).
- **B5. Sem pós-venda da IA** (indicação/recompra/satisfação). → **FEITO parcial** (prompt: agradecer + próximo passo + indicação). NPS estruturado → fase 2.

### Grupo C — Recuperar vazamentos de funil
- **C1. Sem cadência para `aguardando_pagamento`/`perdido`.** → **FEITO** (pedido criado move ticket p/ `aguardando_pagamento` e dispara cadência).
- **C2. Coluna `pos_venda` "morta".** → **FEITO** (pagamento confirmado move ticket p/ `pos_venda` + dispara cadência de pós-venda).
- **C3. Carrinho abandonado** (interesse sem pedido). → roadmap (fase 2).
- **C4. Reativação genérica** (1x/semana, sem sequência, sem priorizar LTV). → roadmap (fase 2).

### Grupo D — Medir o funil
- **D1. Motivo de perda não estruturado.** → **FEITO** (motivos padronizados no fechamento + agregação no analytics + card "Por que perdemos" no dashboard).
- **D2. Sem conversão por etapa / drop-off.** → **FEITO** (`funnelByStage` a partir de `ticket_stage_logs`).
- **D3. Sem ticket médio (AOV).** → **FEITO** (`averageOrderValue`/`paidRevenue` no analytics + KPI no dashboard).
- **D4. Tempo no estágio / velocidade do funil.** → roadmap (fase 2).

---

## O que entrou no LOTE 1 (este PR)

| Item | Onde |
|---|---|
| Persistência do kanban (rota + reverte se falhar) | `routes/tickets.ts` (`POST /:id/stage`), `useStore.ts` (`moveTicket`) |
| Expiração de pedido não pago (opt-in, libera estoque, marca `perdido`) | `Scheduler.ts` (`orderExpiryPass`), `db.ts` (settings) |
| IA condutora (qualificação, CTA, objeções, cross-sell, pós-venda) | `AIOrchestratorService.ts` (regras 12-17) |
| Pedido → `aguardando_pagamento` (+cadência); pago → `pos_venda` (+cadência) | `webhookProcessor.ts`, `PaymentService.ts` |
| Métricas de funil: AOV, conversão por etapa, motivos de perda | `AnalyticsService.ts`, `DashboardPanel.tsx`, `ChatPanel.tsx` (motivos padronizados) |

## Roadmap — FASE 2 (próximos PRs)

1. **Retentativa progressiva de PIX** (1h/6h/24h, incluindo PIX manual) — coluna `reminder_count` + lógica no `Scheduler.pixReminderPass`.
2. **Carrinho abandonado** — detectar lead com intenção de compra que sumiu antes do pedido e disparar cadência de re-engajamento.
3. **Reativação em sequência** priorizando maior LTV (em vez de 1 disparo semanal).
4. **NPS / pesquisa de satisfação** pós-entrega + tratamento de detratores.
5. **Programa de indicação** (incentivo/cashback) como ação rastreável.
6. **Velocidade do funil** — tempo médio por estágio e maior ponto de drop-off (já temos `ticket_stage_logs`).
7. **Configuração na UI** dos novos toggles (expiração de pedido) e visualização de funil por etapa.
