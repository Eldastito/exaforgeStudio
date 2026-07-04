# ADR-038 — Fashion AI Studio, FAS-4: carrinho do look completo, atribuição e compartilhamento

**Status:** Implementado e testado (23 verificações novas, suíte completa sem quebras — 37 scripts, `lint`/`build` limpos). Fase 100% determinística (nenhuma IA).
**Origem:** PRD-E-006, quinta entrega (FAS-4).

## O que o FAS-4 entrega

O fechamento comercial do provador: **"Comprar este look"** adiciona todas as peças disponíveis ao carrinho da vitrine em uma ação, o pedido carrega a atribuição look→pedido para as métricas de valor, e a cliente compartilha o look por link expirable (WhatsApp).

### 1. "Comprar este look" (seção 10 do PRD)

O carrinho da vitrine é client-side (decisão pré-existente da Loja Virtual); a transação do FAS-4 acontece em duas camadas de validação server-side:
- **`prepareCart`** no clique: revalida cada peça contra o estado ATUAL do catálogo — disponível (ativo + visível + preço + estoque vendável) e preço atual vs. `price_snapshot`. Cenários 10.2 cobertos: peça esgotada vem marcada com motivo legível e as demais seguem compráveis (nunca derruba o look inteiro); **preço alterado é sinalizado, nunca cobrado em silêncio** — o carrinho recebe o preço atual e a cliente vê o aviso.
- **O checkout existente revalida tudo de novo** ao criar o pedido (caminho da loja que já valida estoque atomicamente) — o snapshot do look é exibição, nunca fonte de cobrança.
- Peças entram **mescladas** ao carrinho existente (cenário 10.2/4: nunca apaga o que já estava).
- Evento `FashionLookAddedToCart` (seção 10.3) com contagens e total.

### 2. Atribuição comercial pedido↔look (RF-027)

`orders.fashion_look_id` (nullable): o checkout aceita `fashionLookId` no body, mas **valida por organização antes de gravar** (`lookIdForOrder`) — um id forjado nunca vira atribuição. Pedido atribuído também gera o evento `FashionOrderPlaced` com `correlation_id` do look. É a base das métricas `fashion_look_to_order_rate`/ticket médio da seção 20 (e do futuro Value Dashboard), sem tabela de junção.

### 3. Link de compartilhamento (RF-028, com RF-029 conservador)

- Token **stateless HMAC** (lookId + expiração de 7 dias, segredo derivado) — nada gravado em banco, nada para vazar; mesmo padrão das URLs assinadas do FAS-1.
- O link (`/loja/:slug?look=token`) abre o look em **modo leitura, sem login**: peças, preços ATUAIS, disponibilidade e explicação — **nunca avatar, foto gerada ou qualquer dado da cliente** (RF-029, padrão conservador; compartilhar a prévia gerada pode ser reavaliado depois com consentimento próprio).
- Quem recebe pode "Adicionar tudo ao carrinho" — com a mesma atribuição do look (a compra do amigo também conta para a métrica).
- **Kill switch respeitado**: desligar o módulo na loja invalida links antigos na hora; religar reativa os ainda no prazo.
- UI: botão "Compartilhar" copia o link e abre o compose do WhatsApp (`wa.me`).

### 4. J-003 (WhatsApp → landing) — como fica

O caminho WhatsApp→vitrine **já existe** no produto (links de vitrine com token de contato que a IA de atendimento envia); com o provador na landing (FAS-1) e o link de look compartilhável deste FAS, o ciclo se fecha sem mexer na IA de atendimento — mudá-la para "pré-qualificar e oferecer o provador ativamente" fica como melhoria futura deliberada (tocar o fluxo que atende clientes reais pede o mesmo cuidado da ADR-011/029).

## Fora desta fase

- FAS-5: memória de estilo (sinais observados: looks salvos/recusados/comprados alimentando as próximas recomendações).

## Validação

`npm run test:fashion-cart` (23 verificações) + suíte completa (37 scripts, zero quebras) + `lint`/`build` limpos. Destaques: cenários 10.2 (esgotado com motivo, preço alterado sinalizado, look parcial); ownership; atribuição recusa id forjado/de outra org; token válido/adulterado/expirado/lixo; resposta compartilhada auditada por regex contra vazamento de dados da cliente; kill switch invalida e religa links.
