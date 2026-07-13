# ADR-086 — Entrada de mercadoria scan-first + pré-estoque/recebimento (economia de token)

- **Status:** Proposto (decisão para ponderação; implementação em fases próprias)
- **Data:** 2026-07
- **Contexto de origem:** reduzir o consumo de tokens de IA no cadastro/entrada de produtos (hoje via foto/OCR), aproveitando a operação de **leitura de código de barras** que muitas lojas já fazem, e trazer higiene de **recebimento de mercadoria** (pré-estoque → conferência → estoque).
- **Relacionadas:** ADR-084 (composição de capacidades / modo de estoque), ADR-085 (Impact Ledger), ADR-083 (Retail Ops), ADR-076 (cotação de compra/fornecedor), ADR-019/020 (Smart Inventory — entrada por foto/XML com revisão humana).

## Contexto

### Fatos sobre código de barras (verificados e do domínio)
- **EAN-13 / UPC-A comum = só o número (o GTIN).** Não embute nome, preço nem peso. O número tem **estrutura**: prefixo GS1 (789/790 = Brasil) + fabricante + produto + dígito verificador. Dele se deriva **país de registro** e (com consulta) **fabricante** — mas **o nome do produto exige lookup**.
- **Para virar produto cadastrado, precisa de lookup:** (a) **catálogo próprio** da loja (a coluna `products_services.ean` já existe), (b) **base externa** (no Brasil, Cosmos/Bluesoft; ou Open Food Facts), (c) GS1.
- **Códigos "ricos" carregam mais:** GS1-128, GS1 DataBar e QR podem embutir **lote, validade, peso e preço** (via Application Identifiers) — usados em **balança de supermercado** e em **caixas/paletes**. Servem à capacidade **perecível/peso** do ADR-084.
- **Decodificar o código = ZERO token** (decodificador no dispositivo, ex.: ZXing/Quagga). Ler imagem por OCR = consome token.

### O que o código JÁ tem
- `eanUtil.ts` — validação de GTIN-8/UPC-A/EAN-13/GTIN-14 por dígito verificador; `products_services.ean`.
- `nfeParser.ts` — **NF-e por XML** cria o produto já com o EAN, **sem token**.
- `InventoryIntakeService` / `WhatsAppInventoryIntake` — entrada por **foto/XML** com **rascunho → confirmação humana**.
- `purchase_requisitions` / `purchase_quotes` (ADR-076) — pedido de compra com status `ordered`.

### O que FALTA
- **Fluxo de scan** (câmera → decode → lookup pelo `ean` no catálogo).
- **Máquina de estados de recebimento** (encomendado → recebido → disponível), i.e. o **pré-estoque**.
- **Lookup externo de EAN** (opcional) para produto novo sem nota.

## Decisões

### D1. **Scan-first** — hierarquia de custo de entrada (imagem é o último recurso)
Ordem de preferência para dar entrada em mercadoria, do mais barato ao mais caro:
1. **NF-e por XML** — cria/atualiza produtos com EAN, **sem token** (já existe).
2. **Scan de código de barras de item CONHECIDO** — decode local + lookup pelo `ean` no catálogo → só ajusta saldo. **Zero token.**
3. **Scan de item DESCONHECIDO** — decode local + **lookup externo** de EAN (opcional, D5) para pré-preencher o cadastro. **Zero/baixo token.**
4. **Imagem/OCR** — **fallback** apenas quando não há nota nem código legível (granel, importado, etiqueta danificada).

Consequência prática: a foto/OCR deixa de ser o caminho principal e vira exceção — **cai o consumo de token** (a imagem só aparece no que é realmente novo e sem nota).

### D2. Decodificação **client-side e determinística** (a IA nunca "lê o número")
Ler o código de barras é trabalho de **decodificador**, não de IA. A IA nunca é usada para extrair os dígitos do código — só, quando muito, para o cadastro de item desconhecido sem nota (passo 4). Isso protege a economia de token e a precisão (o dígito verificador já rejeita leitura torta — `eanUtil`).

### D3. **Pré-estoque / recebimento** como máquina de estados
1. **Pedido de compra** cria itens em **pré-estoque** (`encomendado`, **não disponível**) — reusa `purchase_requisitions`/`quotes` (status `ordered`, ADR-076).
2. **No recebimento**, a equipe **bipa os códigos** e o sistema **confere contra o pedido** (bateu? faltou? veio a mais/errado?).
3. **Confirmação humana → libera** para **estoque disponível**.
4. **Divergência** (falta/sobra/errado) → **alerta** (e alimenta o Impact Ledger, D7).

Isso elimina o "achismo" de quantidade na entrada e dá rastreabilidade do pedido ao saldo.

### D4. Aproveitar **códigos ricos** para lote/validade/peso (best-effort)
Quando o código lido for GS1-128/DataBar/QR com Application Identifiers, extrair **lote, validade e/ou peso** e alimentar a capacidade **perecível/peso** do ADR-084 (farmácia, minimercado). Sem exigir: EAN-13 simples segue funcionando só com o GTIN.

### D5. **Lookup externo de EAN** opcional, plugável e com cache
- Ordem: **catálogo próprio primeiro** → base externa só como **enriquecimento** de item novo → nunca bloqueia a operação.
- **Cache local por org**: um produto cadastrado uma vez resolve todas as próximas entradas sem nova consulta (e sem token).
- Provedor concreto (Cosmos/Bluesoft/Open Food Facts) e termos ficam para o ADR/PR de implementação (D-not-decided).

### D6. **Confirmação humana** preservada (ADR-083/019/020)
Scan preenche **rascunho** de entrada/recebimento; **humano confirma**. A IA/sistema nunca dá entrada/baixa de estoque sozinha nem sem regra.

### D7. Feed do **Impact Ledger** (ADR-085)
Divergência de recebimento apontada e corrigida vira **evento de valor comprovado** ("conferência evitou pagar por mercadoria não recebida"). Reforça a prova de valor operacional.

### D8. Encaixe no modelo de **capacidades** (ADR-084)
"Entrada scan-first" e "recebimento/pré-estoque" são **capacidades componíveis**: toda loja com **estoque nativo** ganha; **perecível** liga a leitura de lote/validade (D4). No **modo supervisionado** (PDV externo, TOULON), o recebimento pode operar como **conferência** sem ser a fonte da verdade do saldo (invariante do ADR-084 D4).

## O que este ADR **não** decide (fica para ADRs de implementação)
- Provedor de lookup externo de EAN e política de custo/limite.
- Esquema exato das tabelas de recebimento (`goods_receipt*`) e nomes dos estados.
- A tela/app de scan (reuso do PWA da Continuity Layer, ADR-082, para usar a câmera) e a lib de decode.
- Regras de tolerância de divergência no recebimento (ex.: aceitar ±X%).

## Consequências

**Positivas**
- **Menos token**: XML e scan cobrem o grosso da entrada; imagem só no novo-sem-nota.
- **Higiene de recebimento**: pré-estoque + conferência elimina erro de quantidade e dá rastreabilidade.
- **Feed de valor** para o Impact Ledger; **suporte a perecível** via códigos ricos.
- Reuso alto (eanUtil, ean, nfeParser, InventoryIntake, purchase_requisitions).

**Trade-offs / riscos**
- Lookup externo de EAN no Brasil tem **cobertura e custo variáveis** — por isso é enriquecimento opcional, não dependência.
- Item novo sem nota ainda precisa de **uma** fonte de cadastro (externo ou imagem) na primeira vez.
- Código ausente/ilegível (granel, importado) → fallback imagem/manual permanece necessário.

## Guardas
- Decode **determinístico** e **client-side** (zero token); dígito verificador rejeita leitura torta.
- **Confirmação humana** na entrada/recebimento; nada de baixa/entrada automática.
- Cache local de EAN por `organization_id`; isolamento e auditoria (`logAuthEvent`) em toda entrada.
- Perecível/peso via códigos ricos é **best-effort** — não quebra o EAN-13 simples.
