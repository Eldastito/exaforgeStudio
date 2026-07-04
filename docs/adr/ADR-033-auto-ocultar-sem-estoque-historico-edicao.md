# ADR-033 — Auto-ocultar produto sem estoque e histórico versionado de edições

**Status:** Implementado e testado (27 verificações novas, suíte completa sem quebras — 35 scripts, `lint`/`build` limpos).
**Origem:** dois itens de um documento (PRD-E-004) trazido pelo usuário, avaliados contra o que já existe antes de implementar (ver contexto).

## Contexto

O usuário trouxe um PRD gerado por outra fonte propondo um "Virtual Store Generator". A maior parte já existia (draft comercial ao aprovar estoque, preço sugerido por margem, IA que não inventa características, SEO/slug automáticos) e um ponto contradizia uma decisão já tomada (publicação exigir painel de aprovação separado — o usuário confirmou manter a conversa do WhatsApp como a própria aprovação humana, sem painel adicional). Dois pontos, porém, eram gaps reais e o usuário pediu para implementar:

1. Esconder o produto da vitrine automaticamente quando o estoque zera, e restaurar ao repor.
2. Histórico versionado de alterações feitas depois da criação do produto.

## Decisão 1 — Auto-ocultar/restaurar por estoque

**Opt-in por loja** (`storefront_settings.auto_hide_out_of_stock`, `DEFAULT 0`) — o PRD original já sugeria isso ("conforme configuração do lojista"), e é consistente com o padrão de opt-in já usado para a foto de estúdio (ADR-032): nem toda loja quer esse comportamento automático.

**Onde vive a lógica**: `InventoryService.syncStorefrontVisibility()`, chamado ao final de TODOS os pontos que alteram estoque — `reserve`, `release`, `commit`, `restock`, `setQuantity` e `recordMovement`. Centralizar aqui (em vez de nas rotas) garante que nenhuma via de mutação de estoque escape da regra: reserva/baixa por pedido (`OrdersService`), reposição por nota fiscal, ajuste manual no painel, cadastro por WhatsApp — todas passam por um destes métodos.

**Regra**: vendável (`quantity_available - quantity_reserved`) ≤ 0 e o produto está visível → esconde e marca `out_of_stock_hidden=1`. Vendável > 0 e `out_of_stock_hidden=1` e o produto tem preço → restaura e limpa a marca.

**`out_of_stock_hidden` existe para nunca desfazer uma escolha humana**: distingue "escondido pelo mecanismo automático" de "escondido porque o lojista decidiu assim". Uma alteração manual de visibilidade (`PUT /api/storefront/products/:id`) sempre zera essa marca — então o próximo evento de estoque nunca reverte uma decisão humana explícita que acabou de acontecer. Limitação aceita e documentada: se o lojista reativar manualmente um produto ainda com estoque zerado e, depois disso, QUALQUER evento de estoque for registrado enquanto o vendável continuar em zero, o mecanismo pode escondê-lo de novo — isso é esperado quando o toggle está ligado (o lojista pediu visibilidade guiada pelo estoque), não um bug.

**Nunca publica produto sem preço**: a restauração exige `price IS NOT NULL AND price > 0` — um produto que teve a precificação recusada (ADR-032) nunca é reaberto pela reposição de estoque sozinha.

**Escopo — só produto-base, sem variação**: uma movimentação numa variação específica (`variantId` presente) não esconde/restaura o produto inteiro — cada variação já mostra "SEM ESTOQUE" individualmente na vitrine; esconder o produto todo por causa de UM tamanho/cor esgotado seria errado.

## Decisão 2 — Histórico versionado de edições

Nova tabela `product_edit_history` (id, organization_id, product_id, changed_by, changed_fields_json, created_at). `ProductEditHistoryService.record()` compara **antes vs. depois** e só grava quando algo de fato mudou — reenviar os mesmos valores não cria uma entrada vazia. Complementa (não substitui) a auditoria de eventos já existente (`auth_audit_logs`, que registra QUE algo aconteceu); este histórico registra O QUE mudou, campo a campo, com valor antes/depois.

**Hooks nas duas rotas de edição existentes**: `PATCH /api/products/:id` (nome/descrição/preço/categoria/status) e `PUT /api/storefront/products/:id` (visibilidade/destaque). Nenhuma rota nova precisou ser criada para escrever — só ler: `GET /api/products/:id/history`.

## Validação

`npm run test:store-lifecycle` (27 verificações) + suíte completa (35 scripts, zero quebras) + `lint`/`build` limpos:
- Toggle desligado (padrão): estoque zerar nunca mexe na vitrine.
- Toggle ligado: zera por `recordMovement`/`commit`/`setQuantity` → esconde; repõe por `recordMovement`/`restock` → restaura; reserva total (pedido) esconde, liberar a reserva restaura.
- Produto sem controle de estoque nunca é afetado; produto sem preço (recusa da Fase B) nunca é restaurado mesmo com estoque positivo; movimentação em variação não esconde o produto-base inteiro.
- Histórico grava exatamente os campos alterados com valor antes/depois; edição sem mudança real não grava nada; múltiplas edições aparecem em ordem (mais recente primeiro, com desempate por `rowid` quando caem no mesmo segundo); registra quem alterou.
