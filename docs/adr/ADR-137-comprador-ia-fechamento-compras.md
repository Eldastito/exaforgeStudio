# ADR-137 — Comprador IA: fechamento do ciclo de compras (cotação → ordem → recebimento → conta a pagar)

- **Status:** Epic 5 / Fatias E5.1 (cotação aceita → **ordem de compra imutável**), E5.2 (**recebimento** completo/parcial/divergência) e E5.3 (**conta a pagar** idempotente) implementadas. Performance de fornecedor (E5.4) na fatia seguinte.
- **Data:** 2026-07
- **Origem:** PRD "ZappFlow Enterprise Intelligence" (Epic 5, §16). Hoje o fluxo de compras **termina na escolha do fornecedor** — não fecha pedido, recebimento, conciliação e conta a pagar (§4, item 6). O módulo ajuda a decidir, mas não garante que a compra **aconteceu corretamente**. Fechar o ciclo transforma Supply em resultado operacional mensurável.
- **Relacionadas:** ADR-099 (cotação multicanal WhatsApp/e-mail), ADR-136 (Decision & Action Ledger — sinais/ações), ADR-085 (Impact Ledger — economia em compras). PRD §16.

## Decisões

### D1 — Contrato de `sendQuotes` corrigido (preserva `sent`/`network`/`emailed`/`failed`)
O early-return de requisição vazia devolvia `{ sent, network }` sem `emailed` (contrato quebrado, erro de tipo). Corrigido para o contrato completo `{ sent, network, emailed, failed }`, e **falhas passam a ser contadas** (WhatsApp e rede) — nada de erro engolido em silêncio (PRD §16, item 1).

### D2 — `purchase_orders` / `purchase_order_items` (snapshot imutável)
Ao aceitar a cotação vencedora, cria-se uma **ordem de compra imutável** com **snapshot** dos itens (nome, quantidade pedida, preço unitário, total **congelados** no momento do aceite). A quantidade pedida é `min(solicitado na requisição, disponível informado)`. `received_qty` nasce 0 (preenchido no recebimento — E5.2). Alterar a cotação depois **não** muda a ordem.

### D3 — Uma cotação aceita gera **exatamente uma** ordem (idempotência)
Guarda central do PRD (§16, aceite): `UNIQUE(organization_id, quote_id)` + verificação prévia em `PurchaseOrderService.createFromQuote`. Aceitar a mesma cotação de novo devolve a **mesma** ordem (`deduped`), nunca uma segunda. `accept` passou a devolver `{ ok, orderId }` para a UI.

### D4 — Sem envio automático ao fornecedor
A ordem é criada **internamente** (status `open`); o envio ao fornecedor só ocorre após aprovação adequada (fatia posterior). Coerente com o princípio "a IA prepara; o humano decide" (ADR-136). Nenhum efeito externo nesta fatia.

### D5 — Recebimento com divergência auditada (E5.2)
`goods_receipts` / `goods_receipt_items` (PRD §16). `GoodsReceiptService.receive` registra o recebimento contra a ordem e:
- **estoque entra só pela quantidade CONFIRMADA boa** (`condition = ok`) — avaria/item errado/faltante **não** entram (item 7), via `InventoryService.recordMovement('entrada')` com o `unit_price` da ordem como custo;
- **recebimento parcial NÃO encerra o saldo pendente** — a ordem fica `receiving` enquanto algum item não foi plenamente recebido; só vira `received` quando todos os `received_qty ≥ ordered_qty` (aceite §16);
- **toda divergência gera SINAL + TAREFA** (nunca baixa silenciosa): avaria/item errado/faltante e **entrega a mais** publicam um `business_signals` (`goods_receipt_divergence`, fato, reusa o Ledger de Sinais da ADR-136 C1) e criam uma tarefa (`TaskService`); **nota ausente** (`invoice_present=0`) idem (`goods_receipt_no_invoice`). Sub-entrega em boas condições é **parcial normal**, não divergência.

Rotas: `POST /api/procurement/order/:id/receive`, `GET /api/procurement/order/:id/receipts`.

### D6 — Conta a pagar idempotente (E5.3)
`PurchasePayableService.createFromOrder` fecha compras no **financeiro**: gera a conta a pagar a partir da ordem, no mesmo `payables` que caixa/DRE já enxergam (via `FinancialLedgerService.addPayable`, reusado). Guardas:
- **não é criada duas vezes** (aceite §16): coluna `payables.source_purchase_order_id` + **índice UNIQUE parcial** `(org, source_purchase_order_id)` + verificação prévia; a segunda chamada devolve a MESMA conta (`deduped`);
- **valor pelo RECEBIDO** por padrão (`Σ received_qty × unit_price`) — honesto com as divergências da E5.2 (paga-se o que chegou, não o que se pediu); `basis: 'ordered'` usa o total do pedido quando fizer sentido;
- **vencimento é decisão do gestor** (não inferido); a rota exige perfil owner/admin (§10.2 "registrar conta a pagar" é ação sensível). Não paga nada — o pagamento (saída de caixa) continua sendo ação humana separada (`payPayable`).

Rota: `POST /api/procurement/order/:id/payable`.

## Consequências
**Positivas:** o ciclo de compras chega ao **financeiro** — cotação → ordem imutável → recebimento auditável → **conta a pagar única** no caixa/DRE. Corrige um contrato quebrado (erro de tipo pré-existente). Aditivo: reusa cotações/requisições/estoque/sinais/tarefas/`payables` existentes; nenhum fluxo atual muda de comportamento.

**Trade-offs / escopo:** E5.1 entrega só a **ordem** (nenhum recebimento/financeiro). `goods_receipts`/`goods_receipt_items` (recebimento completo/parcial/divergência, entrada no estoque só da quantidade confirmada), a **conta a pagar** idempotente e o `supplier_performance_snapshots` (preço escolhido × média, prazo prometido × realizado, completude, taxa de resposta) vêm nas próximas fatias.

## Guardas
- Determinístico (zero-token). Idempotência por `UNIQUE(org, quote_id)`. Snapshot imutável. Estoque só do confirmado bom; divergência nunca silenciosa (sinal+tarefa). Isolado por `organization_id`. Sem efeito externo (não envia ao fornecedor).

## Testes
`test:purchase-orders` (E5.1) — aceitar gera a ordem (requisição→`ordered`, cotação→`accepted`); ordem é **snapshot** dos itens com `qty = min(pedido, disponível)`, preço e total congelados; **alterar a cotação depois não muda a ordem**; **idempotência** (aceitar de novo / `createFromQuote` devolvem a MESMA ordem; só 1 ordem por requisição); cotação não aceita não gera ordem; isolamento por org. Regressão: `test:quote-email-channel` 10/10 (contrato de `sendQuotes`).

`test:goods-receipt` (E5.2) — recebimento parcial (6 confirmados entram no estoque) + avaria (avariado NÃO entra); ordem fica `receiving`; **divergência gera sinal + tarefa**; **parcial não encerra saldo** (`received_qty` preservado, avaria não conta); completar o restante → ordem `received` (recebimento `complete`); ordem finalizada não recebe mais; **entrega a mais = divergência `over`** (entra no estoque); **nota ausente** gera sinal e marca `has_divergence`; isolamento por org.

`test:purchase-payable` (E5.3) — sem recebimento não gera conta (valor devido 0); **valor pelo recebido** (130, não o pedido 150); conta vinculada à ordem, categoria `compras`, fornecedor no snapshot; **entra no `a pagar`** do FinancialLedger; **idempotência** (segunda chamada → MESMA conta; só 1 por ordem); `basis: 'ordered'` fatura o total do pedido; ordem inexistente/cancelada não gera; isolamento por org. Regressão: `test:cash-ledger` 18/18.
