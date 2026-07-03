# ADR-023 — Loja Virtual: preço sugerido por margem (e por que o ZES-004 completo não foi construído)

**Status:** Implementado e testado (função pura + integração via banco real, sem chamada de IA envolvida — mesma categoria de confiança das ADR-021/022, sem ressalva de "não testado com API real").
**Origem:** o usuário trouxe um PRD completo e muito detalhado, "ZES-004 — Virtual Store Generator", propondo transformar automaticamente todo produto do Smart Inventory num "produto comercial" via um pipeline com evento (`InventoryApproved`), um serviço novo ("Motor Comercial IA"), uma tabela nova (`StoreProductDraft`) com state machine de 5 estados (DRAFT → WAITING_APPROVAL → APPROVED → PUBLISHED → ARCHIVED), SEO automático, variações de imagem e preço sugerido por margem. Antes de implementar, investiguei o que já existia — e o resultado mudou o escopo bastante.

## O que a investigação encontrou (fatos, não opinião)

### 1. A premissa central do PRD já não existe como problema

`products_services.storefront_visible` nasce em `1` por padrão (`db.ts:928`) e não existe hoje nenhum estado de aprovação/rascunho para produtos — todo produto criado (inclusive pelas Fases 0/1/2 do Smart Inventory, ADR-019 a 022) já é vendável e visível na vitrine no mesmo instante em que o humano confirma o cadastro. A frase do PRD "sem vitrine, o cadastro vira só controle interno" descreve um problema que a ADR-019 já resolveu há vários incrementos: **zero cliques** entre confirmar o cadastro e o produto estar à venda, não "um clique" como o PRD propunha como meta.

### 2. SEO por produto seria decoração morta

Investigação confirmou: a vitrine pública é uma **SPA client-side pura** — servida sempre pelo mesmo `index.html` estático (`server.ts`, `app.get('*', ...)`), sem SSR, sem `react-helmet` ou qualquer manipulação de `<head>`, e **sem rota própria por produto** (o card do produto abre um modal em `ProductModal.tsx`, a URL do navegador nunca muda — `react-router-dom` está no `package.json` mas não é usado em lugar nenhum do `src/`). Adicionar `slug`/`meta_title`/`meta_description`/`keywords` na tabela hoje seria adicionar colunas que **nenhum código lê** — o mesmo tipo de problema que a ADR-019 apontou quando descobriu que `category` existia na tabela mas nunca era escrita por nenhuma rota. Fica deliberadamente de fora até existir uma rota própria de produto na vitrine (pré-requisito de infraestrutura maior, fora do escopo deste incremento).

### 3. O "gap" do WhatsApp reconsiderado — não é claramente um bug

A investigação inicial encontrou que a IA de vendas do WhatsApp (`AIOrchestratorService`) filtra produtos só por `active = 1`, ignorando `storefront_visible` — ao contrário da vitrine pública, que respeita as duas. Isso foi levantado como possível inconsistência. Mas uma checagem adicional encontrou um toggle dedicado no frontend (`StorefrontSettingsView.tsx`, ícone Eye/EyeOff, rótulo "Visível"/"Oculto") especificamente para essa flag — sinal de que `storefront_visible` foi desenhado como **flag de vitrine**, não como uma flag geral de venda. Um lojista pode legitimamente querer esconder um produto da navegação pública enquanto ainda deixa a IA do WhatsApp negociar/vender por conversa direta. Mudar esse comportamento seria uma mudança de produto em cima de comportamento já em produção, não a correção de um defeito óbvio — por isso **não foi alterado**. Fica registrado aqui como observação para uma decisão de produto explícita no futuro, não como algo "corrigido" silenciosamente.

### 4. Motor Comercial IA como serviço formal — mesmo critério da ADR-020

Criar um "Motor Comercial IA" como serviço independente do estoque, do jeito que o PRD propõe (ADR-004 do documento original), repete o padrão já avaliado e recusado na ADR-020: não há hoje um segundo consumidor real que justifique a abstração — o único lugar que gera texto comercial por IA é `POST /api/products/ai/describe`, que já existe, já funciona, e é chamado sob demanda (clique manual), não por evento.

## O que sobrou como incremento real: preço sugerido por margem

Com SEO fora (sem consumidor) e a mudança de WhatsApp descartada (mudança de comportamento não confirmada), o único pedaço do PRD que é genuinamente novo, útil e imediatamente consumível hoje é o cálculo de preço sugerido — porque agora, graças às Fases 1/2 do Smart Inventory, `inventory_items.avg_cost` é preenchido com custo real de compra (antes só existia a coluna, sempre zerada).

### `src/server/pricing.ts` — `suggestSalePrice(cost, markupPercent = 40)`

Função pura: `preço = custo × (1 + markup%)`, com arredondamento "psicológico" para o primeiro `.99` acima (bate exatamente com o exemplo do PRD original: custo R$6,35 → sugestão R$8,99). Markup fixo em 40% **sem tela de configuração** — como é sempre só uma sugestão que o humano revisa e pode sobrescrever livremente, uma UI de configuração para isso ainda não se paga; se vários lojistas pedirem ajuste, vira uma configuração de verdade depois.

### Onde a sugestão aparece

- **Revisão de nota fiscal (Fases 1/2, foto ou XML)**: o campo "Preço venda" de cada item novo já vem pré-preenchido com a sugestão calculada a partir do `unitCost` daquela linha — continua 100% editável, o lojista pode zerar e digitar outro valor livremente. É exatamente o ponto onde o custo é conhecido com mais precisão (acabou de vir da nota).
- **Edição de um produto existente** (`CatalogView.tsx`, modal "Editar Item"): quando o produto tem `avg_cost > 0` (ou seja, já recebeu ao menos uma entrada de estoque com custo), aparece uma linha informativa abaixo do campo de preço — "Custo médio: R$X — sugestão de venda: R$Y" — só como referência, não altera o campo automaticamente.
- `GET /api/products` agora devolve `avg_cost` e `suggested_price` (`null` quando não há custo conhecido — nunca inventa uma sugestão sem base real).

## Não incluído (deliberado, com razão específica cada um)

- **SEO por produto** (slug/meta/keywords) — sem consumidor real hoje (seção 2 acima). Pré-requisito: rota própria de produto na vitrine.
- **Variações de imagem** (thumbnail/banner/quadrada/webp) — nenhuma evidência de necessidade hoje; `sharp` já normaliza para JPEG nas fotos do Smart Inventory, mas gerar múltiplos formatos por imagem é trabalho novo sem um consumidor esperando por ele.
- **Categoria > subcategoria > departamento** — a vitrine hoje nem agrupa produtos por `category` (usa "coleções" com regras como `best_sellers`/`newest`); construir uma hierarquia de categoria sem a vitrine consumi-la seria o mesmo problema da seção 2.
- **Motor Comercial IA como serviço formal + evento `InventoryApproved` + `StoreProductDraft` com state machine de 5 estados** — duplicaria a mecânica de publish-imediato que a ADR-019 já implementou, e recuaria a UX (reintroduziria um gate manual onde hoje é zero cliques). Ver seções 1 e 4.
- **Ajuste do filtro do WhatsApp para respeitar `storefront_visible`** — comportamento existente possivelmente intencional (seção 3); não alterado sem uma decisão de produto explícita.

## Sobre a proposta de pausar tudo para escrever "ZES-001 — Arquitetura do ZappFlow OS"

Recomendei não seguir com essa pausa. Evidência concreta a favor de continuar como está: cada uma das últimas 4 ADRs (019 a 022) — e esta também — encontrou, ao investigar antes de implementar, que parte do problema proposto já estava resolvida por trabalho anterior, e toda nova peça reaproveitou serviço já existente (`InventoryService`, `logAuthEvent`, o padrão rascunho/confirm, `sharp`) sem nenhum conflito arquitetural aparecer. Isso é o oposto de "módulos crescendo organicamente e gerando inconsistência" — é exatamente a disciplina de "documentar depois de construir e testar de verdade" (ADR-019) funcionando como pretendido. Um documento de arquitetura conceitual para módulos que ainda não existem no código (CRM, People Intelligence, Compra Forte) correria o mesmo risco de ficção especulativa já identificado quando a proposta original de 15 documentos ZES foi recusada.

## Validação

`npm run test:pricing` (9 verificações novas) + suíte de regressão completa (16 scripts agora, 297 verificações totais, sem nenhuma quebra):
- Fórmula bate exatamente com o exemplo do PRD (custo R$6,35 → sugestão R$8,99).
- Custo zero ou negativo nunca gera uma sugestão fantasma (`0`, não um número negativo ou NaN).
- Sugestão nunca fica abaixo do custo (markup sempre soma, nunca gera prejuízo).
- `GET /api/products`: produto sem custo conhecido devolve `suggested_price: null` (não inventa sugestão sem base real); produto com custo real (via `InventoryService.recordMovement`, mesmo caminho das Fases 1/2) devolve `avg_cost` e `suggested_price` corretos, e o `price` já definido pelo lojista permanece intocado.
- `npm run lint` e `npm run build` passam sem erros nos arquivos tocados.
