# ADR-024 — Backlog Smart Inventory: matching aproximado, fornecedor vinculado, lote de XMLs, dedupe por chave e markup configurável

**Status:** Implementado e testado (tudo determinístico — parser, matcher, banco; sem chamada de IA nova, sem ressalva de API externa).
**Origem:** levantamento completo das pendências deixadas pelas ADRs 009–023 (39 itens catalogados). O usuário aprovou implementar os itens de escopo claro; este pacote fecha os 5 do Smart Inventory — itens 25, 26, 27, 28 e 35 do levantamento, todos "deixados de fora" com registro explícito nas ADRs 021/022/023.

## Item 25 — Matching aproximado de nome de produto (`src/server/productMatcher.ts`)

Problema real deixado na ADR-021: o nome do item na nota quase nunca é idêntico ao do catálogo ("FEIJAO PRETO KICALDO 1KG" vs. "Feijão Preto Kicaldo 1kg") — a tela de revisão pré-selecionava "novo produto" e o lojista distraído duplicava o cadastro a cada recompra.

Solução deliberadamente simples: similaridade por tokens (coeficiente de Dice) sobre texto normalizado (sem acento/caixa/pontuação), com bônus de contenção para abreviações típicas de nota ("FEIJAO PRETO 1KG" ⊂ "Feijão Preto Kicaldo 1kg" → ≥0,85). **Nada de embedding/IA**: é uma pré-seleção que o humano sempre revê na tela — um algoritmo determinístico e explicável basta, custa zero chamada de IA, e o limiar (0,6) é conservador de propósito: o custo de um falso positivo (somar estoque no produto errado) é maior que o de um falso negativo (lojista seleciona manualmente no dropdown, como antes). O servidor agora devolve `matchedProductId`/`matchedProductName`/`matchScore` por item nas duas rotas de extração (foto e XML), e o frontend usa isso na pré-seleção, mantendo o match exato local como fallback.

## Item 26 — Fornecedor da nota vinculado ao CRM (`stock_movements.supplier_contact_id`)

A ADR-021 deixou `supplierName` como texto livre na `note` da movimentação. Agora, na extração, o nome do emitente é casado (mesma similaridade, limiar 0,7) contra os contatos já marcados como fornecedor (`contacts.is_supplier = 1`); quando casa, o `supplier_contact_id` é gravado no rascunho e propagado para **todas** as movimentações de estoque da confirmação (coluna nova em `stock_movements`, aditiva). Decisão importante: **vincula, nunca cria** — um contato exige canal/identificador que a nota não tem; inventar um contato fantasma para cada nota poluiria o CRM. Sem match, o comportamento antigo (texto livre na note) permanece intacto. A UI mostra "vinculado ao contato X do CRM" quando o vínculo acontece.

## Item 27 — Lote de XMLs (até 20 por importação)

`POST /invoice-scan/xml` agora aceita múltiplos arquivos (`multer .array`, campo `file` — o mesmo nome de campo aceita 1 ou N). Cada arquivo válido vira um rascunho independente; arquivos com problema (não é NF-e, nota duplicada, sem itens) entram numa lista `skipped` com o motivo por arquivo — **nunca derrubam o lote inteiro nem falham em silêncio**. Contrato de resposta mudou de objeto único para `{ drafts, skipped }` (o único consumidor, `CatalogView`, foi atualizado no mesmo PR). No frontend, a revisão continua sendo uma nota por vez: a primeira abre imediatamente e as demais ficam numa fila visível ("+N nota(s) na fila"), avançando a cada confirmação; "Pular para a próxima nota" avança sem confirmar (a pulada continua `pending` no banco — nada se perde, padrão de rascunho da ADR-020).

## Item 28 — Dedupe por chave de acesso da NF-e

A ADR-022 registrou: nada impedia importar o mesmo XML duas vezes. A chave de acesso (44 dígitos, única por NF-e no Brasil) mora no atributo `Id="NFe<chave>"` de `<infNFe>` — o parser agora lê atributos (`ignoreAttributes: false`) e extrai a chave para `invoice_scan_drafts.access_key` (coluna nova). Na importação, uma nota cuja chave já existe na organização com status `pending` ou `confirmed` é pulada com mensagem específica ("já foi importada e confirmada" vs. "já tem uma importação pendente de revisão"); rascunhos `discarded` não bloqueiam; a repetição dentro do próprio lote também é detectada. XML sem o atributo (fora do padrão) importa normalmente, só sem dedupe — a chave é proteção, não pré-requisito. O dedupe é por organização (outra org pode legitimamente importar a mesma nota, ex.: consultoria multiempresa).

## Item 35 — Markup padrão configurável

A ADR-023 fixou o markup da sugestão de preço em 40% e registrou: "vira configuração de verdade se pedirem". O backlog aprovado é esse pedido. `storefront_settings.default_markup_percent` (coluna nova, aditiva), editável em Loja Virtual › Configurações ("Margem padrão do preço sugerido (%)", com a explicação de que é só sugestão); `PUT /api/storefront/settings` valida 1–500 e aceita null/vazio para voltar ao padrão. A leitura (`orgMarkup()` em `routes/products.ts`) clampa valores corrompidos e usa 40 como fallback — uma configuração torta nunca gera sugestão absurda. Aplicado nos três pontos que sugerem preço: extração por foto, extração por XML e `GET /api/products` (dica no modal de edição).

## Fora deste pacote (continuam no backlog, decisão pendente do usuário)

Validação de assinatura/Sefaz do XML (item 29, precisa de decisão — exige certificado e integração externa); os demais itens de decisão e os recusados do levantamento seguem como estão.

## Validação

`npm run test:backlog-inventory` (21 verificações novas) + suíte completa (17 scripts, 318 verificações, zero quebras):
- Matcher: normalização, nome idêntico (1,0), abreviação de nota (≥0,85), sem relação (0), escolha correta entre candidatos, e null quando nenhum candidato é razoável.
- Parser: chave de 44 dígitos extraída do atributo Id; itens/fornecedor continuam lendo igual com atributos ligados; XML sem Id → `accessKey null` sem bloquear.
- Dedupe: nota confirmada detectada; isolamento por organização; `discarded` não bloqueia.
- Fornecedor: emitente casa com contato `is_supplier=1` (acento ignorado); contato comum nunca é candidato; `recordMovement` persiste `supplier_contact_id`; movimentação sem fornecedor segue com coluna nula.
- Markup: padrão 40 sem configuração; valor configurado respeitado (60% → custo 10 = R$15,99); clamp em 500; NULL volta ao padrão.
- `npm run lint` e `npm run build` limpos.
