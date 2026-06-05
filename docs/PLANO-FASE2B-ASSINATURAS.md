# Plano de Implementação — Fase 2B: Cobrança Recorrente / Assinaturas

> Objetivo: o tenant cobrar seus clientes de forma **recorrente** (mensalidade,
> plano, clube). Destrava escolas, cursos, academias, clubes, planos de
> manutenção e "clube de assinatura".
>
> Encaixa no gating da Fase 1 como o módulo opcional `assinaturas` (vertical
> Educação liga; serviços/saúde opcional). Reaproveita o motor de PIX e o
> Scheduler já existentes.

## 0. Realidade do recorrente no Brasil (decisão de arquitetura)

Débito automático "de verdade" exige cartão (preapproval do Mercado Pago) ou PIX
Automático (novo e complexo). Para o MVP, o modelo pragmático e confiável:

- **Assinatura** = um plano recorrente atribuído a um cliente.
- A cada ciclo, o sistema **gera uma cobrança** (fatura) e **envia o PIX** pelo
  WhatsApp/e-mail + **lembrete** antes do vencimento.
- O pagamento confirma pelo **webhook que já existe** (prefixo novo `sub:<fatura>`).
- (Fase futura) auto-débito real via cartão (MP preapproval).

Ou seja: reaproveita 100% o motor de PIX (`PaymentService._mpPix`) e o `Scheduler`.

## 1. Modelo de dados (migrações idempotentes)

### `subscription_plans` (planos recorrentes do tenant)
```
id, organization_id, name, description, amount REAL, interval TEXT,        -- monthly | weekly | yearly
interval_count INTEGER DEFAULT 1, active INTEGER DEFAULT 1, created_at
```

### `subscriptions` (assinatura de um cliente a um plano)
```
id, organization_id, plan_id, contact_id, status TEXT DEFAULT 'active',     -- active | paused | past_due | cancelled
amount REAL, interval TEXT, interval_count INTEGER,                          -- snapshot do plano
start_date DATE, next_charge_at DATETIME, last_charge_at DATETIME,
created_by, created_at
```
Índice: `(organization_id, status, next_charge_at)`.

### `subscription_invoices` (faturas por ciclo)
```
id, organization_id, subscription_id, contact_id, amount REAL,
due_date DATETIME, period_start DATE, period_end DATE,
status TEXT DEFAULT 'pending',                                               -- pending | paid | overdue | cancelled
charge_ref TEXT,                                                             -- "sub:<invoiceId>" (payment_charges)
paid_at DATETIME, reminder_status TEXT, created_at
```

## 2. SubscriptionService (`src/server/SubscriptionService.ts`)
- Planos: `listPlans`, `createPlan`, `updatePlan`, `deactivatePlan`.
- Assinaturas: `subscribe(planId, contactId, startDate)` (cria subscription +
  calcula `next_charge_at`), `pause`, `resume`, `cancel`, `list`.
- Faturamento: `generateInvoice(subscriptionId)` (cria a fatura do ciclo,
  avança `next_charge_at` pelo intervalo), `markInvoicePaid(invoiceId)` (marca
  paga + reativa se estava past_due), `listInvoices(filtros)`.
- Helper `addInterval(date, interval, count)`.

## 3. Motor de cobrança (Scheduler)
Reaproveita o padrão de `reminderPass`/`pixReminderPass` (já existem).
- **`subscriptionBillingPass`** (1x/dia): para cada assinatura `active` com
  `next_charge_at <= agora (+ lead opcional)`: gera a fatura, cria a cobrança PIX
  (`PaymentService.chargeForSubscription` → reference `sub:<invoiceId>`), envia
  ao cliente pelo WhatsApp (`MessageProviderService`) e/ou e-mail (Gmail), e
  avança `next_charge_at`.
- **`subscriptionReminderPass`**: fatura `pending` vencendo em X dias → lembrete;
  vencida → marca `overdue`/assinatura `past_due` + mensagem de cobrança (dunning).
- Registrar no `start()` junto dos outros timers.

## 4. Pagamento (PaymentService)
- Add `chargeForSubscription(orgId, {invoiceId, amount, contactName, contactId})`
  — wrapper sobre o `_mpPix` privado com reference `sub:<invoiceId>` (manual e
  dinâmico), igual ao que já fizemos para reservas.
- `syncMercadoPagoPayment`: tratar o prefixo `sub:` → `SubscriptionService.markInvoicePaid`.

## 5. Gating (Fase 1)
- Novo módulo `assinaturas` em `OPTIONAL_MODULES` e no mapa `MODULE_BY_ROUTE`
  (`subscriptions → assinaturas`).
- Preset: **educacao** liga; **servicos** e **saude** opcionais. Rótulo no
  `ModulesPanel`. ViewMode `assinaturas` + Sidebar + render no App.

## 6. UI do app — aba "Assinaturas" (módulo)
- **Planos**: criar/editar (nome, valor, intervalo).
- **Assinantes**: criar assinatura (plano + contato + início); lista com status,
  próximo vencimento; ações: cobrar agora, marcar paga, pausar, cancelar.
- **Faturas**: histórico por assinatura (pago/pendente/vencido).

## 7. IA (chat) — MVP read-only, depois ativo
- MVP: contexto read-only para a IA responder "quanto é minha mensalidade?",
  "está em dia?" com dados reais (próxima fatura/status).
- Fase seguinte: a IA cria/renova assinatura (`subscription_request`) e reenvia
  a fatura/PIX, espelhando o que fizemos em reservas.

## 8. Fora de escopo desta fase
- Auto-débito real por cartão (MP preapproval/PIX Automático).
- Autoatendimento de assinatura na loja virtual (pode vir depois).
- Proração e mudança de plano no meio do ciclo.

## 9. Ordem de entrega (PRs pequenos e empilhados)
1. **MVP engine**: migrações + `SubscriptionService` + rotas + gating
   (`assinaturas`) + aba Assinaturas (planos, assinantes, faturas, ações manuais).
2. **Automação**: `subscriptionBillingPass` + `subscriptionReminderPass` no
   Scheduler + `chargeForSubscription` + confirmação via webhook (`sub:`) + envio
   pelo WhatsApp/e-mail.
3. **IA**: status de mensalidade read-only (+ criação assistida depois).

Cada passo fecha com `npx tsc --noEmit` + `npm run build`.
