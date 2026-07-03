# ADR-019 — Smart Inventory Fase 0: cadastro de produto por foto

**Status:** Implementado e testado (checagens automáticas de API + navegador real; a chamada de visão da IA em si não foi exercitada de ponta a ponta porque este ambiente de sandbox não tem `OPENAI_API_KEY` configurada — ver seção de validação).
**Origem:** PRD "ZappFlow Smart Inventory" (comerciante fotografa o produto, a IA cadastra, humano só confirma o preço). Antes de prometer qualquer coisa, levantei o que já existia no código real — a notícia foi boa: a parte mais arriscada do PRD (IA vendendo pelo WhatsApp, carrinho inteligente, baixa de estoque, reposição automática) **já estava construída e madura**. O que faltava de fato era só o pedaço que o próprio PRD identificou como o mais valioso: eliminar o cadastro manual.

## O que já existia (reaproveitado, não duplicado)

- `products_services`/`inventory_items`/`product_images` — schema já cobria quase tudo (faltava só um jeito de a IA preencher os campos).
- `POST /api/products/ai/describe` — já existia geração de título/descrição por IA a partir do nome, com a mesma regra "nunca invente" que a Fase 0 do Smart Inventory precisava.
- `llm.ts: describeImage()`/`analyzeImageForChat()` — a infraestrutura de "mandar imagem para um modelo com visão" já existia e já era usada para OCR de nota fiscal em texto livre no atendimento do WhatsApp. A peça que faltava era só uma variação que devolve **JSON estruturado** batendo com os campos de cadastro, em vez de texto livre.
- `storefront_visible` já nasce ligado (1) por padrão — um produto novo já aparece na loja sem passo manual de "publicar".
- Carrinho inteligente, baixa de estoque na venda e reposição automática (`AIOrchestratorService`, `OrdersService`, `PurchaseRequisitionService`) — zero código novo necessário; a Fase 0 só precisava alimentar essas peças já existentes com produtos cadastrados mais rápido.

## O que é novo nesta rodada

### `llm.ts: extractProductFromImage()`

Variação de `describeImage()` com `response_format: json_object` e um prompt que pede SOMENTE os campos de cadastro (nome, marca, categoria, peso/volume, descrição, grau de confiança). Mesma regra rígida já usada em `/ai/describe`: **nunca inventa** marca/peso/categoria que não estejam visíveis — usa `null` quando não tem certeza. E, decisão deliberada: **nunca sugere preço**. Sem nota fiscal/custo conhecido (essa é uma fase futura, XML de NF-e), a IA não tem base nenhuma para precificar — forçar um preço "chutado" seria pior que não sugerir nada. Quem define o preço final é sempre o humano, na tela de confirmação.

### `POST /api/products/smart-scan` (novo endpoint)

Recebe a foto (multipart, mesmo padrão de `routes/uploads.ts`), salva em `MEDIA_DIR` (URL pronta pra já virar a imagem do produto) e devolve a extração da IA — **sem criar nada no banco ainda**. É só uma prévia editável. Só existe produto de verdade quando o usuário confirma na tela seguinte, chamando o `POST /api/products` que já existia — nunca um segundo caminho de criação que pudesse divergir do já testado.

### `category` — campo que já existia na tabela, mas nunca era escrito

`products_services.category` existia desde antes (usado na busca de fornecedores em `procurement.ts`), mas nenhuma rota jamais escrevia nele. `POST`/`PATCH /api/products` agora aceitam `category` (mudança aditiva — quem não manda o campo continua funcionando exatamente igual).

### Frontend (`CatalogView.tsx`)

Botão "Cadastro Inteligente" ao lado de "Importar CSV"/"Novo Item" — abre uma foto (câmera no celular via `capture="environment"`), mostra "Analisando com IA...", e devolve um formulário PRÉ-PREENCHIDO (nome, categoria, descrição) com o **preço em branco, obrigatório** antes de poder publicar. Ao confirmar: cria o produto (`POST /api/products`) e anexa a foto (`POST /api/storefront/products/:id/images`, endpoint que já existia). Nunca publica sem esse clique explícito.

## Validação

**O que foi testado de ponta a ponta**, via API real + Chromium real:
- `category` persiste corretamente em criação e edição (round-trip confirmado via API).
- `smart-scan` sem `OPENAI_API_KEY` configurada devolve erro claro (400, "IA não configurada nesta instância") — nunca quebra, nunca trava a UI.
- Botão "Cadastro Inteligente" aparece no Catálogo, abre o modal, mostra o erro de forma legível quando a IA não está disponível.
- **Regressão**: o cadastro manual ("Novo Item") continua funcionando exatamente como antes — nenhuma das mudanças (novo endpoint, campo `category` novo, import de `multer`/`fs`/`path` em `products.ts`) afetou o fluxo existente.
- Suíte completa do projeto (12 scripts, 220 verificações do Radar) roda sem alteração — este PR não toca em nenhum arquivo que ela cobre.

**O que NÃO foi testado**: a chamada de visão em si (`extractProductFromImage` batendo na API de verdade da OpenAI) — este ambiente de sandbox não tem `OPENAI_API_KEY` configurada. A infraestrutura de visão que essa função reaproveita (`describeImage`) já está em produção há tempo servindo o "olhos" do atendimento (`analyzeImageForChat`), então o risco técnico da chamada em si é baixo — mas a extração de produto especificamente (prompt novo, JSON novo) precisa de validação com fotos reais assim que houver uma chave configurada em ambiente com IA ativa.

## Não incluído nesta rodada (deliberado, Fases seguintes do PRD)

- **Foto de nota fiscal / XML de NF-e** — cadastro de vários produtos de uma vez a partir de uma compra. Passo natural seguinte, mas trata OCR de documento fiscal (impostos, NCM) — mais arriscado que uma foto de produto isolado, melhor validar a Fase 0 primeiro.
- **SEO/slug por produto** — não existe hoje nem no schema; a vitrine usa slug no nível da LOJA, não do produto.
- **Analytics de mais/menos vendido** — o dado bruto existe (`order_items`), mas nenhum relatório usa isso ainda; fica para quando o cadastro por foto já estiver gerando volume real de produtos pra analisar.
- **Cálculo de margem/preço sugerido** — só faz sentido quando houver custo conhecido (da nota fiscal), que é a fase seguinte.

## Sobre a proposta de documentação "ZES" (Bíblia do ZappFlow)

Recomendei explicitamente **não** pré-escrever uma coleção de 15 documentos cobrindo módulos que ainda não existem (People Intelligence, Culture OS, Compra Forte, Supply Network...) — isso vira ficção especulativa que diverge do código real no primeiro dia. Esta ADR segue a mesma disciplina que já vinha funcionando bem nas 18 ADRs anteriores do módulo Radar: documentar depois de construir e testar de verdade, uma decisão real por vez.
