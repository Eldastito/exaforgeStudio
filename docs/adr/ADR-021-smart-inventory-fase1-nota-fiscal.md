# ADR-021 — Smart Inventory Fase 1: cadastro por nota fiscal (foto)

**Status:** Implementado e testado (checagens automáticas de dados/estoque/auditoria via a lógica real de `InventoryService`, mais suíte de regressão completa; a chamada de visão da IA em si continua não exercitada de ponta a ponta neste sandbox — mesma ressalva das ADR-019/ADR-020).
**Origem:** próximo passo do PRD original "ZappFlow Smart Inventory", já identificado como "passo natural seguinte" na ADR-019 — o usuário confirmou explicitamente essa opção entre as implementações planejadas.

## O que muda em relação à Fase 0

A Fase 0 (ADR-019/ADR-020) cadastra **um produto por vez**, a partir da foto do próprio produto, e **nunca sabe o custo** (por isso nunca sugere preço). A Fase 1 fotografa a **nota fiscal de uma compra** e extrai **vários itens de uma vez**, cada um já com o **custo de compra real** — o que abre duas possibilidades que a Fase 0 não tinha:
1. **Reposição de estoque** de um produto que já existe no catálogo (em vez de forçar um cadastro novo para toda recompra).
2. **Custo médio ponderado** atualizado de verdade (`inventory_items.avg_cost`), que passa a refletir compras reais em vez de ficar zerado.

## O que já existia (reaproveitado, não duplicado)

- `InventoryService.recordMovement()` — já fazia exatamente "somar quantidade + recalcular custo médio ponderado + registrar em `stock_movements`" para o fluxo manual (`POST /:id/movements`). A Fase 1 chama esse MESMO método, item por item, dentro de uma transação — não existe um segundo caminho de escrita de estoque.
- `sharp` + rate limit + rejeição de HEIC/HEIF + `MEDIA_DIR` — toda a infraestrutura de upload da ADR-019/ADR-020 é reaproveitada integralmente.
- O padrão de rascunho-antes-de-confirmar (ADR-020: `product_scan_drafts`) — replicado para `invoice_scan_drafts`, mesma filosofia (nada se perde se o usuário fechar o modal, nada é criado sem confirmação humana explícita).

## O que é novo nesta rodada

### `llm.ts: extractInvoiceItems()`

Variação do mesmo padrão de `extractProductFromImage()` (JSON estruturado, `response_format: json_object`, "nunca invente"), mas devolvendo uma **lista de itens** em vez de um produto único: `{ supplierName, items: [{ name, quantity, unit, unitCost, confidence }], confidence }`. Regra explícita no prompt: ignora frete/impostos/desconto/linha de total, lista só mercadoria; confidence é por item (não só geral), porque numa nota real é comum algumas linhas ficarem nítidas e outras não. Continua **nunca sugerindo preço de venda** — só o custo de compra, que é o que de fato está escrito na nota.

### `invoice_scan_drafts` (tabela nova) + `POST /api/products/invoice-scan`

Mesmo padrão do rascunho da Fase 0: a extração é gravada (`status='pending'`) antes de qualquer produto/estoque ser tocado. Resolução de upload maior que a Fase 0 (2000px vs. 1600px) — nota fiscal tem bem mais texto miúdo por linha que uma embalagem de produto único.

### `POST /api/products/invoice-scan/:draftId/confirm`

O endpoint que de fato mexe em produtos/estoque, item por item, conforme a ação escolhida pelo humano para cada linha:
- **`create`** — cria um produto novo (`stock_control_enabled=1`) e chama `InventoryService.recordMovement(..., type: 'entrada', unitCost, origin: 'invoice_scan')` — a quantidade da nota já entra como estoque inicial, com o custo médio corretamente inicializado.
- **`restock`** — NÃO cria produto novo; chama `recordMovement` diretamente sobre o `productId` já existente escolhido pelo humano. É aqui que o custo médio pondera corretamente uma segunda compra do mesmo item.
- **`skip`** — item da nota que não deve virar produto (ex.: sacola plástica de uso interno, item já lançado manualmente) — ignorado sem gerar erro nem exigir preenchimento.

Idempotente por rascunho (mesmo padrão da Fase 0): confirmar um rascunho que já saiu de `pending` retorna 400 e não duplica nada — nem produto, nem estoque, nem movimento.

### Combinar com um produto existente — decisão deliberada de escopo

O `matchedProductId` é escolhido pelo **humano** num `<select>` com a lista de produtos já cadastrados. O frontend pré-seleciona automaticamente `restock` quando o nome extraído bate **exatamente** (case-insensitive) com um produto já existente — mas não tenta nenhum matching aproximado/fuzzy (ex.: "Feijão Preto 1kg" não bate sozinho com "Feijão Preto Kicaldo 1kg" cadastrado). Fazer isso bem exigiria normalização de texto e/ou busca por similaridade (embedding contra `products_services.name`), que não existe hoje em lugar nenhum do código — construir isso especificamente para uma tela de revisão onde o humano já está olhando a lista inteira seria complexidade desproporcional ao problema. Fica documentado como possível melhoria futura, não como lacuna escondida.

### Frontend (`CatalogView.tsx`)

Botão "Nota Fiscal" ao lado de "Cadastro Inteligente" — abre a foto, mostra "Lendo a nota fiscal com IA...", e devolve uma **tabela editável** (uma linha por item: nome, quantidade, custo unitário, seletor de produto — novo ou repor um existente —, preço de venda quando é produto novo). Linhas com confiança abaixo de 80 mostram um aviso inline pedindo mais atenção àquela linha especificamente (mais granular que o banner único da Fase 0, porque aqui há várias linhas com confiança independente). "Aprovar e Publicar" processa tudo de uma vez no confirm.

## Não incluído nesta rodada (deliberado)

- **Matching aproximado de nome de produto** — ver seção acima.
- **XML de NF-e** — dado estruturado (mais confiável que OCR de foto), mas é uma fonte de entrada diferente (upload de arquivo XML, não foto) — fica como possível próxima fase, não incluída aqui.
- **Cálculo de preço de venda sugerido a partir da margem** — a Fase 1 já sabe o custo real, mas sugerir um preço de venda exigiria uma margem-alvo configurada (por categoria ou geral) que não existe em lugar nenhum do sistema hoje. Continua sendo o humano a decidir o preço final em toda linha nova — mesma disciplina de "nunca inventar preço" da Fase 0.
- **Suppliers como entidade própria** — a nota extrai `supplierName` como texto livre (guardado só na `note` da movimentação de estoque, não normalizado contra `contacts.is_supplier`); vincular automaticamente ao fornecedor certo do CRM é trabalho futuro.

## Validação

**O que foi testado**, via `npm run test:invoice-scan` (29 verificações novas) + suíte de regressão completa (14 scripts agora, 238 verificações pré-existentes, sem nenhuma quebra):
- Schema de `invoice_scan_drafts` correto; rascunho gravado com `status='pending'` e itens extraídos.
- Confirmação cross-org é rejeitada (404) e um produto de outra organização não é sequer visível para reposição.
- Confirmação legítima processa corretamente as 3 ações na mesma nota: 1 produto novo criado com o estoque inicial da nota, 1 produto existente reposto (sem duplicar cadastro), 1 item ignorado.
- Custo médio ponderado corretamente recalculado (`avg_cost`: 10un a R$15 + 10un a R$17 → R$16, exatamente a fórmula de `InventoryService.recordMovement`).
- 2 movimentações de estoque (`stock_movements`) registradas com `origin='invoice_scan'`, uma por item processado (não por linha ignorada).
- Confirmar um rascunho de nota já confirmado é idempotente: 400, sem duplicar produto nem repetir a reposição de estoque.
- Auditoria `INVOICE_SCAN_EXTRACTED`/`INVOICE_SCAN_CONFIRMED`/`PRODUCT_CREATED` (com `source: "invoice_scan"`) gravadas corretamente, incluindo as contagens created/restocked/skipped.
- `npm run lint` e `npm run build` passam sem erros nos arquivos tocados (mesmos erros pré-existentes e não relacionados em `ProspectView.tsx`/`VisionVmsView.tsx`/`rie/*`, herdados de antes desta mudança).

**O que NÃO foi testado**: a chamada de visão em si (`extractInvoiceItems` batendo na API de verdade da OpenAI com uma foto real de nota fiscal, lendo múltiplas linhas com formatação variada) — este sandbox não tem `OPENAI_API_KEY`. A lógica de confirmação/estoque/auditoria foi validada chamando o `InventoryService` real (não uma cópia da lógica), então o risco isolado dessa parte é baixo; o risco real pendente é exclusivamente na qualidade da extração via IA com fotos reais de notas fiscais variadas (letra pequena, papel térmico desbotado, etc.), que só pode ser avaliado com uma chave de API ativa.
