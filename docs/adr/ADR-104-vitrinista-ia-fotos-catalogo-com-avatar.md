# ADR-104 — Vitrinista IA: fotos de catálogo tratadas + looks com avatar

**Status:** Implementado (Blocos 1, 2 e 3, backend + frontend). Ciclo completo:
peça chega → IA cadastra (B1) → IA monta looks (B2) → gerente aprova no Kanban →
IA veste o avatar e gera 2 poses (B3) → publica na galeria de looks da vitrine.
O Kanban gera/publica os looks (com dropdown de avatar e status de geração), o
cadastro de avatar tem tom de pele, há toggle "publicar direto", e a vitrine
pública renderiza o lookbook.

**Refinamentos de campo (Bloco 3):** 2 imagens por look (2 poses do mesmo
modelo); a IA escolhe o avatar por **tom de pele** (clara/média/escura) que
combina com as cores das peças, com override manual; galeria/lookbook como
primeiro lar da foto na vitrine.

**Origem:** Pedido de campo do Emerson (jul/26), evoluindo o item #13. Quando peças
novas chegam à loja, o gerente cadastra por foto no Zapp; a IA deve tratar as
fotos e — como **consultora de moda / vitrinista** — sugerir combinações, deixar
o lojista curar num Kanban, e publicar na loja imagens dos **avatares vestindo os
looks aprovados**.

---

## Contexto

Já existe no código:
- **Cadastro por foto (Smart Inventory):** `WhatsAppInventoryIntake` — o gerente
  fotografa, a IA reconhece (`classifyInventoryPhoto`/`extractProductFromImage`),
  o gerente informa custo/margem/quantidade, e `InventoryIntakeService` cria o
  produto + 1 imagem em `product_images`.
- **Tratamento/estúdio de foto:** `editProductImageB64` (ADR-032) —
  edição que **preserva o produto real** e limpa/profissionaliza (fundo de
  estúdio). Usado por `StudioCatalogPhotoService`.
- **"Vestir peça no avatar":** `FashionTryOnService` combina avatar (buffer) +
  peça(s) (buffers) via `editImagesB64` → imagem vestida. Hoje disparado pela
  cliente; o mecanismo é reusável no cadastro.
- **Motor de combinação de looks:** `FashionLookService` (sugere looks à cliente,
  com validação anti-injection e fallback determinístico) — reusável para montar
  looks de **vitrine**.
- **Avatares preset da loja:** `fashion_preset_avatars` (ADR-103) — modelos
  curados, imagem pública em `/media`.
- **Fila:** `JobQueueService`; **teto de estúdio:** `PlanService.studioAllowed` +
  `studio_creations` (limite mensal `studio_images_monthly`).
- **Publicação:** inserir linha em `product_images` de produto `storefront_visible=1`
  já aparece na vitrine (sem passo extra).

## Decisão

### Síntese do fluxo
- **Cada peça** → o gerente tira **2 fotos reais** (peça inteira + tecido
  ondulado). A IA **trata cada uma** (remove fundo, deixa só a peça, acabamento
  profissional via `editProductImageB64`) e publica como as imagens do produto.
  **Não** há imagem com avatar por peça isolada.
- **Looks (combinações)** → a IA sugere combinações das peças cadastradas; o
  lojista **cura num Kanban** (arrasta/solta, cria as suas). Ao aprovar, uma
  **fila** gera a imagem do **avatar vestindo o look** (a IA escolhe qual dos 5+
  avatares combina) e publica na loja. É onde a imagem com avatar agrega valor —
  e onde vale gastar IA (só looks aprovados, não cada SKU).

### Por que "avatar só por look aprovado"
Economiza tokens (não gera avatar para cada peça) e vende melhor (looks curados
> peças soltas). A peça isolada fica com as 2 fotos reais tratadas.

### Economia de tokens
- Peça: 2 tratamentos `editProductImageB64` (~$0.04 cada) — qualidade profissional
  pedida explicitamente.
- Look: 1 geração `editImagesB64` por look aprovado (~$0.04), em fila, só após
  aprovação. Dedupe por `input_hash` (avatar+peças) evita regerar a mesma combinação.
- Tudo amarrado em `studioAllowed`/`studio_creations` (hoje a foto de catálogo
  não conta no teto — lacuna que este ADR fecha).

### Publicar
O gerente escolhe, por lote/look: **aprovar antes** de publicar **ou** **publicar
direto**. Default: aprovar antes (curadoria), com opção de marcar "publicar direto".

## Blocos

1. **Cadastro com 2 fotos tratadas por peça** (este bloco): estende o intake para
   2 fotos por peça; cada foto tratada por IA (fundo/estúdio) em fila; publica em
   `product_images`; amarra no teto do plano. Entrega já as fotos profissionais.
2. **IA vitrinista + Kanban de looks:** a IA combina as peças NOVAS do lote
   (novas como base, podendo puxar antigas que combinem) em looks de vitrine,
   gravados em `storefront_looks` (tabela nova, sem cliente — distinta dos
   `fashion_looks` da cliente); o lojista dispara por "montar vitrine" no
   WhatsApp **ou** por botão na tela, e cura num Kanban (arrasta/solta,
   cria/edita). Motor com a mesma rede anti-injection do look da cliente +
   fallback determinístico. **Este PR:** backend (motor + tabela + endpoints +
   gatilho WhatsApp). **PR seguinte:** o Kanban (frontend).
3. **Geração + publicação dos looks:** looks aprovados → fila gera imagem do
   avatar vestindo o look (IA escolhe o modelo), publica; escolha aprovar × direto.

## Consequências

**Positivas:** IA merchandiser diferenciada; fotos profissionais sem estúdio
físico; tokens gastos só onde vendem (looks aprovados); reaproveita ~80% da infra
(intake, try-on, look engine, fila, teto).

**Trade-offs:**
- Tratamento de foto é geração de imagem (custo por foto) — mitigado pelo teto do
  plano e por rodar em fila (não trava o WhatsApp).
- Qualidade do "vestir no avatar" depende do provedor de imagem — mesmo do try-on,
  já validado.
- A escolha de avatar por look precisa de heurística/prompt (Bloco 3).

## Aprovação

Aprovado por Emerson (jul/26): peça = 2 fotos reais tratadas por IA (fundo
removido, profissional) antes de publicar; avatar só por look aprovado; IA
escolhe o modelo entre 5+; gerente decide aprovar × publicar direto; toda loja de
roupa usa. Faseado em 3 blocos.
