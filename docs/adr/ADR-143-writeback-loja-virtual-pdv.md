# ADR-143 — Write-back Loja Virtual → PDV: venda online dá baixa no estoque do ERP (e a reconciliação dos dois vendedores)

- **Status:** Proposto (plano). Escopo em 3 fases; Fase 0 é construível JÁ (sem Alterdata); Fases 1-2 dependem da API de escrita da Alterdata.
- **Data:** 2026-07
- **Origem:** Levantamento com o dono da Toulon — *"vender via WhatsApp/loja virtual direto, e como o ZappFlow comunica as vendas da loja virtual para o PDV, para ele dar baixa no estoque?"*
- **Relacionadas:** ADR-105 (conector Alterdata — hoje **read-only**), ADR-096 (checkout da loja sem atrito), ADR-083/084 (Operação da Rede / estoque por loja), ADR-137 (motor de estoque — recebimento), `docs/integrations/alterdata-fase2-vendas.md` (Fase 2 — vendas INBOUND), ADR-088 D5 (frugal), ADR-091 §6 (IA sugere, humano decide).

## Contexto / o problema dos "dois vendedores"

O ZappFlow **já vende** por dois canais (a IA no **WhatsApp** e o **checkout da loja virtual**), e os dois **dão baixa automática** — mas no **estoque core** (`inventory_items`), quando o pedido é pago. Já a Alterdata (PDV) é a **fonte da verdade do estoque por loja** (`retail_store_inventory`), puxada em mão única por **sobrescrita absoluta** a cada sync (`RetailInventoryService.setQuantity`, driver `alterdata`).

Isso cria o conflito **dois-vendedores / um-estoque**:
1. **Oversell:** entre um sync e o próximo (intervalo default 15 min), o balcão físico e a loja online podem vender **a mesma peça** — não há reserva compartilhada.
2. **Clobber:** a venda online do ZappFlow **não** toca o `retail_store_inventory`; no próximo Saldo sync, a sobrescrita absoluta **apaga** o efeito da venda online da visão por-loja. A venda online "some" do estoque da filial.
3. **PDV não sabe:** nada avisa a Alterdata que o ZappFlow vendeu → o ERP segue mostrando estoque a mais.

Além disso, o pedido nativo **não tem loja** (`orders` é por organização, não multi-loja) — pré-requisito para uma "loja virtual de uma filial".

## Decisões

### D1 — A loja online vende de um POOL RESERVADO por loja/produto (desacopla os dois vendedores)
Em vez de a loja online e o PDV disputarem o mesmo saldo em tempo real, a loja online vende de uma **reserva e-commerce** por loja/produto: `retail_online_reserve(org, store_id, product/variant, qty_reserved)`. A reserva é **abastecida a partir do Saldo da Alterdata menos um buffer** de segurança (ex.: reservar N unidades ou X% para o online). O PDV físico continua vendendo do saldo total; o online só toca a reserva. **Isso elimina o oversell** sem coordenação em tempo real — o ZappFlow nunca promete mais do que a reserva.

### D2 — `store_id` no pedido online (multi-loja) — pré-requisito
`orders.store_id` (NULL = org, como hoje). O checkout da loja virtual e a IA do WhatsApp carimbam a **filial** de origem. A venda online debita a **reserva daquela loja** (D1) e alimenta a atribuição por loja na comissão/relatórios.

### D3 — Ledger local de "vendido online, baixa pendente" + reconciliação no sync
Cada venda online paga registra uma **baixa pendente** (`retail_online_writeback(org, order_id, store_id, produto, qty, status: pending|sent|confirmed|failed)`). Na **sobrescrita do Saldo** (a cada sync), o mapper **re-aplica as baixas pendentes ainda não refletidas** pela Alterdata — assim o clobber para de apagar a venda online. Quando o write-back é confirmado (Fase 1) e a Alterdata já reflete a baixa, a pendência é **conciliada** (deixa de ser re-aplicada). Determinístico, idempotente por `order_id`.

### D4 — Write-back OUTBOUND via outbox (Fase 1 — depende da Alterdata)
No "pedido pago", **enfileira** (reusa `JobQueueService`, padrão outbox) uma escrita à Alterdata que **registra a venda / o movimento de baixa** na filial. **Idempotente por `order_id`** (a Alterdata precisa aceitar uma chave de idempotência, ou consultamos antes de escrever). Retry com backoff; falha persistente → alerta (não trava a venda). **O conector ganha, pela 1ª vez, capacidade de ESCRITA** — hoje é 100% read-only.

### D5 — Alterdata segue como fonte da verdade do estoque físico
A escrita do ZappFlow **não** vira a nova verdade — ela **informa** o ERP. O Saldo do ERP continua mandando; o ledger de pendências (D3) só cobre a **janela** entre a venda online e o ERP refletir a baixa. Sem duplo-desconto: quando o ERP já reflete, a pendência sai.

### D6 — O que PEDIR à Alterdata (bloqueante para Fase 1)
1. Existe **endpoint de escrita** (criar venda / lançar movimento de estoque de saída) por filial? Método + path + payload.
2. O token do Guardian pode ter **escopo de escrita**? Como se provisiona?
3. Aceita **chave de idempotência** (evitar baixa dobrada em retry)?
4. Existe conceito de **reserva / filial e-commerce** no ModaUp (para a reserva D1 ser espelhada no ERP)?
5. Latência esperada e limites de rate.
> Contexto: a homologação de **leitura** ainda falha (Referência 500 / CódigoDeBarras 404 / Preço 500; só Saldo 200). Escrita depende de a Alterdata primeiro estabilizar o ambiente.

### D7 — Escopo em fases (aditivo, reversível, opt-in)
- **Fase 0 (construível JÁ, sem Alterdata):** `store_id` no pedido (D2) + pool de reserva e-commerce (D1) + ledger de baixa pendente e **reconciliação no sync** (D3). Isso **elimina o oversell e o clobber** e deixa a loja virtual multi-loja segura — **mesmo antes** de qualquer escrita no ERP. A "baixa no PDV" nesta fase é **manual/relatório** (o ZappFlow mostra as baixas pendentes por loja para o operador lançar), mas o estoque online já é correto.
- **Fase 1 (depende da Alterdata):** write-back automático via outbox (D4) — o ZappFlow avisa o ERP e a baixa pendente concilia sozinha.
- **Fase 2 (se a Alterdata suportar):** reserva/baixa em **tempo real** no ERP (elimina a janela e o buffer).

## Guardas
- **Alterdata é a fonte da verdade** do estoque físico; o write-back informa, não sobrescreve (D5).
- **Sem oversell** por construção (pool reservado, D1) — o online nunca promete mais que a reserva.
- **Idempotente por `order_id`** (D3/D4) — retry não duplica baixa.
- **Outbox** (não trava a venda; falha vira alerta, não erro ao cliente).
- **Opt-in** por org/loja; **isolado** por `organization_id`; **reversível** (flags).
- **IA sugere, humano decide** (ADR-091 §6) — na Fase 0, a baixa no PDV é ação humana assistida.

## Consequências
**Positivas:** a loja virtual passa a vender **por filial** com estoque **correto e sem venda dobrada** já na Fase 0 (sem depender da Alterdata); e, quando a Alterdata liberar a escrita, a baixa no PDV vira **automática** (Fase 1). O desenho separa o problema fácil (não vender o que não tem) do difícil (escrever no ERP), entregando valor sem esperar terceiros.

**Trade-offs / limites:** a Fase 0 usa um **buffer** (reserva) — capital "preso" ao online; ajustável por loja. O write-back real depende de a Alterdata expor escrita + estabilizar a homologação (hoje quebrada na leitura). Reserva em tempo real (Fase 2) só se o ERP suportar. Comissão por vendedor no **balcão físico** continua dependente do módulo Sales (Fase 2 vendas) — fora deste ADR.

## Testes (planejados)
- **Fase 0:** venda online debita a **reserva** da loja certa (não o saldo total); reserva esgotada **bloqueia** a venda (sem oversell); baixa pendente registrada por `order_id`; o **Saldo sync não apaga** a venda online (reconciliação); idempotente; isolado por org/loja.
- **Fase 1:** pedido pago enfileira o write-back; mock do endpoint de escrita → baixa `sent→confirmed`; retry em falha; idempotente por `order_id`; pendência concilia quando o ERP reflete.
