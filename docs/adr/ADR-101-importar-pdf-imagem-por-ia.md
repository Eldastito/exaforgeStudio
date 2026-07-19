# ADR-101 — Importar PDF/imagem por IA (além de CSV) com preview obrigatório

**Status:** Aprovado (aguardando implementação — item independente).

**Origem:** Item #14 do `docs/BACKLOG-CAMPO-TOULON.md`. Hoje só dá pra importar dados por **CSV** (colar/planilha). O lojista quase sempre recebe listas em **PDF** (catálogo de fornecedor, tabela de preços) ou **foto/print**. Adicionar "Importar PDF/imagem" onde a IA extrai os dados estruturados.

---

## Contexto (o que existe hoje)

**Telas com importação de ENTRADA por CSV (3):**
1. **Catálogo — produtos** (`CatalogView.tsx`): cabeçalho `nome,preco,quantidade,descricao,tipo` → POST `{csv}` (`routes/products.ts`). *(Importa XML de NF-e à parte, já com IA.)*
2. **Prospecção — contas/contatos** (`ProspectView.tsx`): CSV 1 linha por contato, dedupe por domínio/e-mail.
3. **Reservas — quartos/tarifas** (`ReservasView.tsx`): CSV nome/preço/capacidade/unidade.

*(Contatos, Vendas, Agenda da Clínica só EXPORTAM CSV — fora do escopo deste item.)*

**Extração por IA já existe (`llm.ts`) — os tijolos estão prontos:**
- `extractPdfText(buffer)` — texto de PDF via `pdf-parse` (`llm.ts:559`).
- `analyzePdfForChat(buffer)` — extrai + classifica/resume (já usado como "olhos" de PDF no WhatsApp, `:577`).
- **GPT-4o multimodal** (`image_url`) — OCR/leitura de imagem (`classifyInventoryPhoto`, `describeImage`, etc.).
- Padrão "IA extrai → JSON estruturado" (`parseInventoryReply`) já é usado.

Falta apenas **ligar** um botão de import de arquivo → extração → mapear pro mesmo formato que o CSV já aceita.

## Decisão

Adicionar **"Importar PDF/imagem"** nas **3 telas** que hoje têm import CSV, com um **mecanismo reusável** e **preview obrigatório**.

### 1. Mecanismo genérico e reusável
- Novo serviço (ex.: `SmartImportService`) que recebe um arquivo (PDF **ou imagem**) + o **schema-alvo** da tela (colunas esperadas) e devolve **linhas estruturadas** + confiança:
  - **PDF com texto** → `extractPdfText` → LLM extrai pro schema (JSON).
  - **PDF escaneado / imagem (JPG/PNG/print)** → GPT-4o multimodal (`image_url`) → LLM extrai pro schema.
  - Detecta automaticamente qual caminho usar (se `extractPdfText` vier vazio, cai pro multimodal).
- Cada tela informa seu schema (produtos: nome/preço/qtd/descr/tipo; prospecção: contato/empresa/e-mail/…; reservas: nome/preço/capacidade/unidade). O núcleo é o mesmo; só o schema muda.

### 2. Preview obrigatório (IA pode errar)
- O resultado **NUNCA** é salvo direto. A IA extrai → a UI mostra as **linhas numa tabela editável** → o dono **revisa/corrige/remove** → só então confirma e salva.
- O **commit reusa o backend do CSV** existente (mesma rota/validação de cada tela) — a importação por PDF/imagem é só uma nova *fonte* das mesmas linhas.
- Sinaliza células de baixa confiança (ex.: preço ilegível) pra revisão dirigida; nunca falha a importação inteira por uma célula ruim.

### 3. PDF + imagem
- Aceitar **PDF e imagem** (JPG/PNG). Muitas listas chegam como foto/print — e o multimodal já lê imagem, então o custo marginal é baixo.
- Limites de tamanho/página (ex.: teto de páginas por PDF, compressão de imagem) pra controlar custo de IA; avisa se o arquivo for grande demais em vez de estourar.

## Consequências

**Positivas:**
- Tira o atrito do CSV (o dono não precisa converter PDF/foto em planilha na mão).
- Reusa infra pronta (`extractPdfText`, GPT-4o multimodal, backends de import CSV) — trabalho é de ligação, não de motor novo.
- Preview obrigatório protege contra erro de leitura da IA — o dono é a última milha.
- Um mecanismo, três telas — e fácil de estender a novas telas depois.

**Trade-offs aceitos:**
- Extração por IA tem custo por página/imagem — mitigado por limites de tamanho + detecção texto-vs-multimodal (texto é bem mais barato).
- Leitura pode errar (layout incomum, foto ruim) — mitigado pelo preview obrigatório e destaque de baixa confiança.
- PDFs muito grandes / múltiplas páginas podem exceder contexto — tratar por limite de páginas e feedback claro, sem "engolir" silenciosamente (regra dos "sem caps silenciosos").
- 3 telas de uma vez = um pouco mais de UI, mas o núcleo compartilhado dilui o esforço.

## Implementação (item independente)

1. `SmartImportService.extract(file, schema)` — roteia PDF-texto vs multimodal; LLM → JSON no schema; retorna linhas + confiança.
2. Rota genérica `POST /api/import/extract` (multipart) que recebe arquivo + tipo de schema e devolve as linhas (sem salvar).
3. UI: botão "Importar PDF/imagem" nas 3 telas (Catálogo, Prospecção, Reservas) → upload → tabela de preview editável → confirmar → commit no backend CSV existente de cada tela.
4. Limites: teto de páginas/tamanho + compressão de imagem + mensagem quando exceder.
5. Testes: `test:smart-import` — PDF-texto e imagem extraem pro schema; preview não salva sozinho; commit reusa a validação do CSV; arquivo grande avisa em vez de estourar.

## Aprovação

Aprovado por Emerson (jul/26): "Importar PDF/imagem" nas **3 telas** (Catálogo, Prospecção, Reservas) de uma vez, com **preview obrigatório** (IA extrai → revisa → salva) e aceitando **PDF + imagem**. Reusa a extração de PDF/multimodal já existente e os backends de import CSV. Item #14 do backlog marcado `[x] decidido`.
