# Integração Alterdata / ModaUp — Fase 2: automação de VENDAS (plano)

Documento de plano para **automatizar a entrada de vendas** da TOULON no ZappFlow,
substituindo o lançamento manual (CSV / WhatsApp / digitação) por um **pull
automático** do módulo **Sales** da ModaUp — no mesmo modelo do conector já em
produção (Referencia / CodigoDeBarras / Saldo / Preco).

- **Base:** ADR-105 (`AlterdataConnectorService`, `AlterdataSyncService`,
  `AlterdataSyncRunner`, mappers). Contrato de homologação:
  `docs/integrations/alterdata-homologacao-contrato.md`.
- **Situação hoje:** a Fase 1 (produto + estoque + preço) está no ar. **Venda é
  entrada MANUAL** por três canais (todos implementados):
  - CSV "Fechamento de Caixa — Diário" (upload) → `RetailReconciliationService`;
  - WhatsApp (foto/OCR ou total em texto) → `RetailWhatsAppIntakeService`;
  - tela / scan → `RetailClosingService`.
- **Por que é manual hoje:** decisão de **escopo/LGPD**, não limitação técnica. O
  levantamento (`docs/INTEGRACAO-ALTERDATA-PERGUNTAS.md`, §"plano") registra:
  *"Cliente e vendas entram na Fase 2, com a base legal LGPD fechada."* Os specs
  OpenAPI da ModaUp **incluem o módulo Sales e o CRM (`ClienteVendaHistorico`)** —
  ou seja, a venda **existe por API**.

---

## Dois níveis (fazer nesta ordem)

### Nível A — Fechamento de caixa por API (SEM PII) ⭐ prioridade
Totais de venda **por loja/dia** (o mesmo conteúdo do CSV "Fechamento de Caixa —
Diário"): valor vendido, bruto, desconto. **Não tem cliente → não é dado
pessoal**, então **não depende de LGPD**. É o caminho mais rápido e seguro.

**Efeito:** acaba o upload de CSV; **divergência, comissão e metas** passam a
rodar sozinhas todo dia.

### Nível B — Venda por cliente / SKU (COM PII) — Fase 2 "de verdade"
Histórico de venda ligado ao cliente (`ClienteVendaHistorico`) e item a item
(sell-through por SKU). Rico para CRM / recompra / mix, mas é **PII** → exige a
**base legal LGPD fechada** (consentimento, finalidade, retenção, minimização)
antes de puxar. Fica para depois do Nível A.

---

## O que PEDIR à Alterdata (para o Nível A)

Sem estas respostas não dá para escrever o conector (aprendemos com o `404` do
CodigoDeBarras que **não se deve chutar path**):

1. **Endpoint de venda/caixa diário** no módulo **Sales**: método + path exatos.
   Segue o padrão delta `GET /api/v1/{Recurso}/versao/{...}/{versao}`? Qual o
   nome do recurso (ex.: `Venda`, `Movimento`, `FechamentoCaixa`, `CaixaDiario`)?
2. **Chaves de rota:** usa `rede` / `filial` / `data`? Em que ordem? (como
   `Saldo` usa `{filial}/{versao}`).
3. **Base URL do módulo Sales** em homologação **e** produção (o `{module}` do
   nosso padrão de URL — ex.: `toulon-fq-grande-rio-sales.apimodaup.com.br`?).
4. **Escopo do token:** o Guardian precisa de um **scope de vendas** adicional? O
   usuário de retaguarda atual já cobre, ou precisa de outra credencial/escopo?
5. **Campos do payload:** confirmar os equivalentes ao CSV — total líquido
   vendido, total bruto, desconto, nº de peças, forma de pagamento (se houver),
   data/período, código da loja.
6. **Somente-leitura** disponível para esse recurso? (mantemos o piloto read-only).
7. **Versão inicial** para o 1º backfill e se `/versao/{versao}` devolve a nova
   versão junto (mesmo contrato de cursor dos outros recursos).

> Bloqueio atual (herdado da Fase 1): os endpoints de homologação de Referência
> e Preço ainda respondem 500, e CódigoDeBarras 404. Só **Saldo** responde 200.
> A publicação/correção desses endpoints é pré-requisito para confiar em
> qualquer novo recurso de homologação — incluir o de vendas no mesmo chamado.

---

## O que o ZappFlow CONSTRÓI (Nível A)

Tudo aditivo, reusando o conector existente — **desligado por flag** até o
endpoint estar publicado:

1. **`AlterdataSalesMapper`** (novo) — traduz o payload de venda/caixa da ModaUp
   para o formato do fechamento. Casa a **loja** por código (como o
   `RetailReconciliationService` já faz) e escreve o **valor do sistema** no
   `retail_daily_closings.system_total` do dia/loja, com `divergence_status`
   calculado vs o total informado pela loja.
2. **Novo recurso no `AlterdataSyncRunner`** — uma linha no mesmo estilo dos
   outros (`syncResource({ moduleKey: "sales", resource: "...", buildPath, onItems })`),
   com cursor próprio por loja. Módulo `sales` entra em `ALTERDATA_MODULES`.
3. **Agendamento** — o `alterdataSyncPass` do Scheduler passa a puxar também as
   vendas do dia (intervalo configurável, já existe).
4. **"Testar módulos"** — o probe (`/alterdata/probe`) ganha o endpoint de vendas,
   para diagnosticar por eliminação igual aos outros.
5. **Feature flag** `alterdata_sales_sync` (opt-in por org) — nasce **desligada**;
   liga só quando a Alterdata confirmar o endpoint e a homologação passar verde.
6. **Teste** (`test:alterdata-sales`) — mock do endpoint de vendas → assert de que
   o `system_total` do fechamento é preenchido e a divergência é calculada, sem
   tocar a rede (padrão `__setAlterdataSyncHttpForTests`).

**Fronteira do Nível A:** substitui o **CSV** por pull automático. **Não** traz
cliente nem item (isso é o Nível B, com LGPD).

---

## A "ponte" que ainda falta (independente da automação)

Mesmo automatizando a entrada, hoje a venda do fechamento **alimenta só a aba
Operação da Rede** — ela **não sobe** para o cérebro financeiro central
(Diretor IA / Pareto / Motor de Caixa). Motivo técnico:
`FinancialLedgerService.syncFromSales` posta caixa só de `orders` (status `pago`)
e `comigo_orders`; `retail_daily_closings` **nunca** vira `cash_events`, e
`LossMarginService.monthlyRevenue` soma só `orders`+`comigo_orders`. Resultado: o
Diretor reporta **faturamento R$ 0** para uma loja supervisionada.

**Item de trabalho separado (Nível A.2):** bridge
`retail_daily_closings → cash_events / receita`, para o faturamento da TOULON
aparecer no Diretor/Pareto/DRE. Determinístico, idempotente por loja/dia,
opt-in. **Não depende** da Alterdata — dá para fazer já, alimentando com os
fechamentos manuais atuais.

---

## Ordem de execução proposta

1. **A.2 (bridge)** — `retail_daily_closings → cash_events`. Não depende de
   terceiros; faz o faturamento (mesmo lançado à mão hoje) aparecer no Diretor.
2. **Pedido à Alterdata** — as 7 perguntas do Nível A (junto do chamado dos
   endpoints de homologação que ainda falham).
3. **A.1 (conector de vendas)** — mapper + recurso + probe + flag + teste,
   **desligado**. Ativa quando o endpoint responder verde no "Testar módulos".
4. **B (cliente/SKU)** — só depois da base legal LGPD fechada.

## Guardas (mantidas da Fase 1)

Read-only no piloto; isolado por `organization_id`; token cifrado; delta por
cursor; idempotente (upsert por loja/dia); **flag opt-in**; **sem PII no Nível A**.
