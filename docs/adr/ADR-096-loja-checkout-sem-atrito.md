# ADR-096 — Loja virtual: checkout sem atrito (reaproveita dados do WhatsApp)

**Status:** Aprovado (aguardando implementação).

**Origem:** Item #6 do `docs/BACKLOG-CAMPO-TOULON.md`. O cliente da loja quase sempre chega **vindo do WhatsApp** — a IA já tem nome e telefone. Pedir esses dados de novo no checkout é atrito que derruba conversão. O e-mail pode vir da conversa; a NF-e não é emitida pela loja no piloto (a TOULON usa a impressora fiscal dela).

---

## Contexto

Estado atual (`src/server/routes/storefrontPublic.ts`):
- Cliente vindo do WhatsApp acessa a loja por link com token (`?c=xxx`) que carrega o `contactId`. O checkout já não exige nome quando há `contactId` — reaproveita parcialmente.
- Mas o formulário de dados ainda aparece (mesmo pré-preenchido), e o e-mail é pedido na loja.
- Cliente anônimo (entrou direto na URL) preenche nome + telefone + e-mail do zero.
- Fashion Studio (provador) exige cadastro completo (nome + e-mail + 18+ + consentimento de imagem) — necessário por LGPD.

O AIOrchestrator já captura `customer_email` na conversa (extraído do JSON que a IA retorna — sem custo de chamada extra).

## Decisão

### 1. Checkout invisível para quem vem do WhatsApp

Cliente com token de contato (`?c=xxx`) NÃO vê formulário de dados no checkout. Vê apenas: itens + total + botão **"Confirmar pedido"**. Nome e telefone vêm do contato automaticamente. Zero campos a preencher.

Cliente anônimo (sem token) continua preenchendo nome + telefone (mínimo pra criar o pedido e o contato).

### 2. E-mail vem da conversa, não do formulário

- O e-mail é capturado pela IA na conversa quando faz sentido (confirmação de pedido, etc.) via o `customer_email` já existente — grátis (extraído do JSON de resposta, sem chamada de IA extra).
- A loja NÃO pede e-mail no fluxo com token. Se a IA já capturou, está no contato; se não, o pedido fecha sem e-mail (não é obrigatório).
- Fallback: cliente anônimo pode informar e-mail opcionalmente (campo único, não obrigatório).

### 3. Sem emissão de NF-e pela loja no piloto — cupom fiscal da impressora

- A TOULON emite o **cupom fiscal pela impressora fiscal dela** (SAT/NFC-e/ECF — solução própria do lojista, fora do ZappFlow).
- Portanto o checkout da loja NÃO precisa de CPF/CNPJ nem endereço fiscal no piloto.
- O ZappFlow registra a venda (orders/order_items); a parte fiscal é responsabilidade da impressora do lojista.
- **Campo "CPF na nota" opcional** pode existir, mas não é bloqueante nem obrigatório.
- Integração de NF-e/NFC-e eletrônica fica como item futuro (não no piloto).

## Consequências

**Positivas:**
- Menos atrito = mais conversão. Cliente do WhatsApp confirma em 1 clique.
- E-mail via conversa é natural (a IA já conversa) e não custa nada a mais.
- Sem NF-e eletrônica no piloto = menos complexidade fiscal, menos superfície de bug. A impressora fiscal do lojista já resolve a obrigação.

**Trade-offs aceitos:**
- Pedido pode fechar sem e-mail — aceitável (telefone já identifica o cliente; e-mail é só pra confirmação/marketing).
- Sem NF-e eletrônica, o ZappFlow não é a "fonte fiscal" — o lojista concilia manualmente com a impressora dele. Aceitável no piloto; revisitar quando NFC-e virar demanda.
- Fashion Studio mantém cadastro completo (exigência LGPD do provador) — atrito maior só nesse fluxo específico, justificado pelo consentimento de imagem 18+. Pré-preenche nome/telefone do contato se veio do WhatsApp.

## Implementação (item independente)

1. `storefrontPublic.ts`: checkout com token pula o formulário; renderiza só "Confirmar pedido" com itens + total
2. Remover e-mail obrigatório do fluxo com token; ler do contato se existir
3. Frontend da loja: detecta `?c=xxx` → modo "confirmação rápida"; sem token → modo "dados mínimos" (nome + telefone)
4. Campo "CPF na nota" opcional (não bloqueante), sem endereço/CNPJ
5. Fashion Studio: pré-preencher nome/telefone quando houver contactId
6. Teste: `test:store-checkout-frictionless` — com token pula formulário; anônimo pede mínimo; e-mail nunca obrigatório

## Notas de implementação (jul/26)

Entregue: no fluxo com token (`?c=`) o checkout não pede nome/telefone (já era) **e agora também não pede e-mail** — quem vem do WhatsApp confirma em 1 clique ("Confirmar pedido"). O e-mail só aparece para o cliente **anônimo** (opcional). Campo **"CPF na nota" opcional** (não bloqueante) em ambos os fluxos, gravado nas notas do pedido só com dígitos; sem CPF/CNPJ/endereço fiscal. Teste `test:store-checkout-frictionless` (9 checks).

Follow-up menor: pré-preencher nome/telefone no Fashion Studio a partir do contato quando houver `?c=` (o cadastro do provador continua exigido por LGPD — só reduz digitação). Não bloqueia o piloto.

## Aprovação

Aprovado por Emerson (jul/26): checkout invisível pra quem vem do WhatsApp; e-mail pela conversa (sem custo); sem NF-e eletrônica no piloto (cupom fiscal da impressora do lojista). Item #6 do backlog marcado `[x] decidido`.
