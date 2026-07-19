# ADR-100 — Meios de pagamento do lojista: Stone (via Pagar.me) na loja virtual + maquininha

**Status:** Aprovado (aguardando implementação — faseado).

**Origem:** Item #12 do `docs/BACKLOG-CAMPO-TOULON.md` (parte de API de pagamento; a parte de relatórios já foi decidida no ADR-094). A TOULON usa **Stone** (maquininha na loja física) e precisa **receber cartão** também na loja virtual, pra não travar vendas.

> Nota: este ADR é sobre o lojista **RECEBER** dos clientes dele (adquirência). Não confundir com ASAAS (ADR-091), que é o **ZappFlow cobrando o lojista** a assinatura.

---

## Contexto (o que já existe)

`PaymentService` já é **genérico, multi-tenant e plugável**. Hoje suporta:
- **`pix_manual`** — chave PIX estática do lojista (texto de cobrança).
- **`mercadopago`** — PIX dinâmico (QR + copia-e-cola) com **confirmação automática** via webhook (`/api/webhooks/payment?secret=`), que marca o pedido `pago` e baixa estoque (`markPaid` → `OrdersService.updateStatus`).

Estrutura pronta pra reusar: `payment_charges`, `orders.payment_*`, `pay_provider`/`pay_gateway_token`/`pay_webhook_secret` em `organization_settings`, `orgByWebhookSecret`, idempotência por `external_reference` (`order`/`res:`/`sub:`). **Falta cartão** (o MP só cria PIX) e **nenhuma adquirente direta**.

## Descoberta sobre a Stone

A Stone, na camada **online**, opera pela **Pagar.me** (mesmo grupo). Opções relevantes:
- **Link de Pagamento (Pagar.me/Stone):** gera link por pedido; cliente paga **cartão, PIX, boleto, carteiras** em página **hospedada pela Stone**; webhook confirma. O cartão **não passa pelo nosso servidor** → carga de PCI mínima.
- **API Pagar.me (REST):** checkout transparente (cartão no nosso site), split, tokenização, recorrência, webhooks.
- **Connect Pagar.me (omnichannel):** integra e-commerce + **maquininha (POS)** com split e tokenização — o caminho pra integrar a maquininha física.

Fonte: páginas oficiais Stone/Pagar.me (ver seção Referências).

## Decisão

Adotar **Stone (via Pagar.me)** como adquirente do lojista no piloto, somando um provider plugável ao `PaymentService` (`provider='stone'`), sem quebrar `pix_manual`/`mercadopago`. Faseado:

### Fase 1 — Online via Link de Pagamento (destrava venda já)
- Novo provider `stone`: ao fechar pedido na loja virtual, gera um **Link de Pagamento** Pagar.me (cartão + PIX + boleto) via API, persiste em `payment_charges`, e devolve o link/QR ao cliente.
- Confirmação por **webhook** (reusa o `/api/webhooks/payment` + `markPaid`, casando `external_reference` com o pedido).
- **PCI mínimo** (checkout hospedado). É a entrega mais rápida pra "não travar vendas com cartão".
- Config na UI de pagamento: escolher provider Stone + token/credenciais Pagar.me (cifrados como o `pay_gateway_token` atual).

### Fase 2 — Checkout transparente (opcional, pós-Fase 1)
- Cartão **dentro** da loja (tokenização no cliente, sem sair pra página da Stone) pra casar com o checkout sem atrito do ADR-096.
- Só se o ganho de conversão justificar a carga de PCI (SAQ-A-EP) e o esforço. Não bloqueia a Fase 1.

### Fase 3 — Maquininha presencial (Connect Pagar.me)
- **Passo 3a — Conciliação (read):** puxar as transações da maquininha Stone (via API) pra refletir a venda presencial nos relatórios (canal **PDV** do ADR-094). Valor rápido, baixo risco.
- **Passo 3b — Acionar a maquininha (write):** ZappFlow manda o valor → maquininha cobra (Connect Pagar.me/TEF). Projeto maior: integração certificada + habilitação comercial com a Stone. Fase mais pesada, só depois do online estável.

## Consequências

**Positivas:**
- TOULON recebe cartão na loja virtual sem travar venda (Fase 1 é rápida e de baixo risco).
- Reusa toda a espinha de pagamento (webhook, `markPaid`, `payment_charges`) — Stone entra como mais um provider, não um sistema paralelo.
- Link de Pagamento tira o PCI de cima da gente no piloto.
- Conciliação da maquininha (3a) fecha o buraco do canal PDV nos relatórios.

**Trade-offs aceitos:**
- Link hospedado leva o cliente pra fora da loja por um instante (menos "sem atrito" que o ADR-096) — aceitável na Fase 1; a Fase 2 resolve se necessário.
- Acionar a maquininha (3b) é integração certificada e comercial — não é "só código"; fica explicitamente adiado.
- Amarra o piloto à Stone/Pagar.me. Mitigado: o modelo plugável permite outro provider depois sem retrabalho do núcleo.
- Credenciais Pagar.me por org — cifradas em repouso (padrão `EncryptionService`, como o token atual).

## Implementação

**Fase 1 (imediata):**
1. `PaymentService`: provider `stone` — `createStoneLink(orgId, {orderId, amount, ...})` (API Pagar.me Link de Pagamento) + persistência em `payment_charges`.
2. Webhook Pagar.me → reusa `/api/webhooks/payment` (mapear payload Pagar.me → `markPaid`).
3. UI de pagamento (Configurações da Loja): opção "Stone" + credenciais Pagar.me (cifradas).
4. Testes: `test:stone-payment-link` (cria link, webhook confirma, idempotência, pedido→pago).

**Fase 2 (opcional):** checkout transparente Pagar.me (tokenização client-side) no fluxo do ADR-096.

**Fase 3:** 3a conciliação de transações da maquininha (canal PDV nos relatórios); 3b acionar a maquininha via Connect Pagar.me (integração certificada — bloco próprio, com apoio comercial Stone).

## Referências
- Pagar.me — pagamentos online: https://www.pagar.me/
- Stone — soluções de pagamento online (Pagar.me e Mundipagg): https://www2.stone.com.br/solucoes-de-pagamento-online/
- Stone — Link de pagamento: https://conteudo.stone.com.br/link-de-pagamento/
- Stone/Pagar.me — Connect Pagar.me (omnichannel e-commerce + POS): https://www.ecommercebrasil.com.br/noticias/stone-novo-produto-connect-pagar-me
- Pagar.me — integre com os produtos: https://www.pagar.me/integre-com-nossos-produtos/

## Aprovação

Aprovado por Emerson (jul/26): cartão na loja virtual é necessário (não travar vendas); adquirente = **Stone (via Pagar.me)**, começando pelo **Link de Pagamento** (cartão+PIX+boleto hospedado); **integrar a maquininha** também, faseado (conciliação primeiro, acionamento certificado depois). Item #12 do backlog marcado `[x] decidido` (parte de pagamento; relatórios já no ADR-094).
