# ADR-028 — Loja Virtual: URL própria por produto com SEO, e visibilidade unificada entre vitrine e WhatsApp

**Status:** Implementado e testado (determinístico; a prévia de link real em crawlers externos depende de `APP_URL` público configurado em produção).
**Origem:** itens 32, 33 e 34 do backlog — os três aprovados por decisão explícita do usuário depois de terem sido deixados de fora na ADR-023 (SEO sem consumidor real; mudança de comportamento do WhatsApp sem decisão de produto).

## Itens 32+33 — URL por produto + SEO (o desbloqueio prometido)

A ADR-023 recusou SEO por produto porque "seriam colunas que nada lê": a vitrine é SPA sem rota por produto. A decisão do usuário destravou o pré-requisito — e o desenho escolhido cria o consumidor real **sem SSR e sem framework novo**:

1. **`products_services.slug`** (coluna nova) — único por organização (índice parcial), gerado do nome na criação (todos os 4 caminhos: manual, foto, nota fiscal, CSV), com backfill idempotente para o catálogo existente e fallback preguiçoso na vitrine (produto legado ganha slug na primeira renderização). Decisão deliberada: **o slug não muda quando o nome muda** — URL compartilhada não pode quebrar por correção de digitação.
2. **`/loja/:slug/produto/:productSlug`** — o servidor (produção) intercepta essa URL antes do catch-all da SPA e devolve o mesmo `index.html` com `<title>`, `meta description` e OpenGraph (`og:title/description/image/url`) **injetados por substituição de string** — é exatamente o que crawlers e prévias de link (WhatsApp, redes sociais) leem; o React assume normalmente no navegador. Conteúdo escapado (produto com aspas/tags no nome nunca injeta markup). Qualquer falha cai no catch-all normal.
3. **Deep-link na SPA**: a vitrine lê o `productSlug` do path e abre o produto direto; abrir/fechar o modal sincroniza a URL via `replaceState` (compartilhável, sem poluir o histórico).

O que NÃO entrou (mesma disciplina de sempre): campos editáveis de SEO (meta title/keywords customizados por produto) — o título/descrição derivam do nome/descrição já existentes; um campo editável só se justifica quando alguém pedir para sobrescrever o derivado. Sem sitemap.xml, sem dados estruturados schema.org — extensões naturais quando houver sinal.

## Item 34 — WhatsApp respeita "Oculto" (decisão de produto explícita)

A ADR-023 encontrou a divergência (vitrine filtra `storefront_visible`, IA do WhatsApp não) e recusou mudar sem decisão explícita — que agora foi tomada pelo usuário: **ocultar da vitrine = ocultar de todos os canais de venda**. As 5 consultas de produto do `AIOrchestratorService` (contexto de produtos no prompt, resolução de item de pedido por nome exato e aproximado, regras de negociação por preço mínimo) passaram a aplicar `COALESCE(storefront_visible, 1) = 1`. Produto legado com a coluna NULL continua visível (COALESCE) — nenhum produto some por engano na migração. Tirar de circulação de vez continua sendo `active = 0`, semântica intocada.

## Validação

`npm run test:backlog-loja` (15 verificações novas) + suíte completa (21 scripts, 391 verificações, zero quebras):
- Slugify (acentos/caixa/pontuação), colisão com sufixo, unicidade POR organização (mesmo nome em orgs diferentes usa o slug base), índice único bloqueando duplicata direta, fallback preguiçoso persistente e idempotente.
- Injeção de meta presente e com escape de HTML; payload da vitrine com slug.
- IA do WhatsApp: produto oculto fora do contexto e da resolução de pedido; visível continua; NULL legado continua visível; os 5 pontos de consulta filtrando (contados no fonte).
- `npm run lint` e `npm run build` limpos.
