# Integração Alterdata / ModaUp — Contrato de Homologação (referência)

Documento de referência do **contrato que o conector do ZappFlow espera** dos
microserviços da ModaUp (SUPPLY e PRICE). Serve para a equipe da Alterdata e a
engenharia do ZappFlow **conferirem campo a campo** contra os `/API-DOCS` de
homologação antes de ligar o sync.

- **Base do conector:** ADR-105 (`AlterdataConnectorService`, `AlterdataSyncService`, `AlterdataSyncRunner`, mappers de referência/estoque/preço).
- **Ambiente de homologação (TOULON — Grande Rio):**
  - SUPPLY: `https://toulon-fq-grande-rio-supply.apimodaup.com.br` (`/API-DOCS`)
  - PRICE: `https://toulon-fq-grande-rio-price.apimodaup.com.br` (`/API-DOCS`)
- **Padrão de URL configurado no ZappFlow:** `toulon-fq-grande-rio-{module}.apimodaup.com.br`
  (o marcador `{module}` é substituído por `supply` / `price`).

## Autenticação

Token emitido pelo **Guardian da ModaUp** (OAuth2 `client_credentials`):

```
POST https://guardian.apimodaup.com.br/connect/token
Content-Type: application/x-www-form-urlencoded
grant_type=client_credentials
client_id=<e-mail do usuário de retaguarda com acesso total>
client_secret=<senha desse usuário>
scope=<módulos>
```

O `access_token` é enviado como `Authorization: Bearer <token>` em toda chamada e
renovado automaticamente (inclui um retry ao receber `401`). Credenciais e token
são guardados **cifrados** no ZappFlow e nunca retornam em texto.

## Endpoints consumidos pelo sync

| Módulo | Recurso | Método + Path | Para quê |
|---|---|---|---|
| supply | Referencia | `GET /api/v1/Referencia/versao/{versao}` | produtos (referências) |
| supply | CodigoDeBarras | `GET /api/v1/CodigoDeBarras/versao/{versao}` | variantes (cor/tamanho/EAN) |
| supply | Saldo | `GET /api/v1/Saldo/versao/{filial}/{versao}` | estoque por filial |
| price | Preco | `GET /api/v1/Preco/versao/{rede}/{tabela}/{versao}` | preços |

`{rede}`, `{tabela}` e `{filial}` são os códigos configurados no ZappFlow
(rede e tabela de preço da retaguarda; filial = código da loja). `{versao}` é o
cursor do delta-sync (começa em `0` e avança sozinho).

## Paginação e versionamento (delta-sync)

- **Request (headers):** `pagina`, `itensPorPagina` (opcionais: `ordenadoPor`, `direcao`). `Accept: application/json`.
- **Lista na resposta:** array puro **ou** um dos envelopes `{ itens: [...] }` / `{ data: [...] }` / `{ registros: [...] }`.
- **Total de páginas (header):** `total-paginas` (aceita `totalpaginas` / `x-total-pages`).
- **Versão para avançar o cursor:** header `versao` / `x-versao`, ou `versao` no corpo, ou **por item o campo `controleVersao`** (fallback `versao` / `version`). O cursor avança para a MAIOR versão vista.
- **Retry:** backoff em `5xx`, `429` e falha de rede (até 3 tentativas).

O loop é idempotente: o cursor só avança e os mappers fazem **upsert por chave
natural**, então reprocessar não duplica.

## Campos lidos por recurso (contrato dos mappers)

Nomes em **negrito** são os principais; os demais são alternativas aceitas
(o conector é tolerante a sinônimos).

### Referencia → produto
| Campo | Uso no ZappFlow |
|---|---|
| **`referenciaId`** (ou `referencia` / `codigo`) | chave da referência (external_ref do produto) |
| **`descricao`** | nome do produto |
| `preco` | preço base (referência) |
| `precoMin` | preço mínimo |
| `colecao`, `tipo`, `linha` | metadados (guardados em `alterdata.*`) |
| `custo` | custo (metadado) |
| `controleVersao` | cursor delta |

### CodigoDeBarras → variante (SKU)
| Campo | Uso no ZappFlow |
|---|---|
| **`codigo`** (ou `referencia` = referência-pai) | chave da variante (external_ref / sku) |
| **`cor`** | atributo da variante |
| **`tamanho`** | atributo da variante |
| **`ean`** | GTIN/código de barras (sanitizado) |
| `controleVersao` | cursor delta |

### Saldo → estoque por loja
| Campo | Uso no ZappFlow |
|---|---|
| **`filial`** | casa com o **Código** da loja no ZappFlow (Operação da Rede) |
| **`produto`** | casa com o `codigo` do CodigoDeBarras (external_ref/sku da variante) |
| **`saldoAtual`** | quantidade disponível (truncada para inteiro) |
| `controleVersao` | cursor delta |

### Preco → preço
| Campo | Uso no ZappFlow |
|---|---|
| **`produto`** | casa com o `codigo` do CodigoDeBarras (external_ref/sku da variante) |
| **`preco1`** (ou `preco`) | preço de venda aplicado à variante/produto |
| `controleVersao` | cursor delta |

### VendaMalote → venda do PDV + VENDEDOR (comissão individual)
| Campo | Uso no ZappFlow |
|---|---|
| **`caixa.filial`** | loja da venda (casa com o Código da loja) |
| **`caixa.boleta`** + **`caixa.data`** | chave natural da venda (upsert idempotente) |
| **`caixa.matricula`** | **OPERADOR de caixa** (não é o vendedor) → coluna `vendedor` |
| **`caixa.usuario`** (= **CAI_USUARIO**) | **VENDEDOR** da comissão → coluna `vendedor_codigo` (aceita `vendedorCodigo`/`codigoVendedor`/`venCodigo`/`caiUsuario`) |
| `caixa.valor`, `caixa.vendidas` | valor e peças da venda |
| `vendas[]` (produto/quantidade/valor/comissão) | itens da venda (mais-vendidos) |
| `parcelasCartao[]` | recebíveis de cartão (líquido/taxa/vencimento) |

> **Homologação Toulon — Q1 (RESOLVIDA).** A pergunta era "onde fica o vendedor
> por venda, já que `matricula` é o operador de caixa". Resposta da Alterdata: o
> vendedor é o **CAI_USUARIO**, em relação com a tabela **VENDEDORES** por
> **`VEN_CODIGO = CAI_CODIGO`**. No conector, o CAI_USUARIO (campo `usuario`) é
> gravado em `retail_pdv_sales.vendedor_codigo` e a **comissão individual passa a
> ser atribuída por ele** (`RetailCommissionService.pdvSalesBySeller`), com
> fallback para o operador quando ausente. Para os nomes aparecerem, mapear os
> vendedores em *retail_sellers* usando o **código do vendedor (CAI_USUARIO)** como
> matrícula.
>
> **Tela (última milha).** O painel *Operação da Rede* mostra a seção **"Vendas por
> vendedor — PDV (CAI_USUARIO)"**: a rota `GET /pdv-sellers` agrega por
> `COALESCE(vendedor_codigo, vendedor)` (mesma chave da apuração) e casa
> *retail_sellers* por ela; clicar no código dá nome ao vendedor. A comissão sai
> **estimada** pela regra percentual ativa. ⚠️ **Vendas já importadas antes desta
> mudança só exibem o vendedor após um novo sync da Alterdata** (repopula
> `vendedor_codigo` no período); até lá caem no operador (retrocompatível).
>
> **Relatório oficial por vendedor.** As vendas do PDV por CAI_USUARIO agora
> entram na base do relatório oficial (`combinedSalesBySeller` → seção **"Por
> vendedor"** de `GET /commission/report` e a apuração `createRun`), somadas a
> ZappFlow + lançamentos manuais/foto + ERP. Quando o gestor tem só regra(s)
> **"por loja"** (sem regra de escopo *vendedor*), a comissão por vendedor sai
> pela **% EFETIVA DA LOJA** onde cada venda aconteceu (loja específica > rede >
> global — não uma % plana, ver próximo item) — e a linha **"por loja" vira
> referência** (não soma no total, para não pagar a verba duas vezes). Criando
> uma regra própria de escopo *vendedor*, as duas passam a ser distintas e somam
> normalmente.
>
> **Comissão individualizada por LOJA (pedido Toulon).** Cada loja pode ter o
> seu **próprio percentual**, definido pelo dono da rede: uma regra de escopo
> "loja" pode mirar UMA loja específica (`store_id` na regra) com uma % só dela;
> sem loja específica, vale pra rede toda. Quando uma loja tem regra própria, a
> regra de rede NÃO se aplica a ela (sem pagar duas vezes).
>
> **⚠️ ALERTA — CAI_USUARIO pode não individualizar em TODAS as lojas.** Depois
> de ligar o CAI_USUARIO na comissão, o dono da Toulon reportou que o extrato
> por loja/vendedor mostrava, na loja Nova Iguaçu, um **único** "vendedor"
> cujo valor batia EXATAMENTE com o total da loja inteira — parecia que a
> segmentação não era real ali. Investigação confirmou: **o `GROUP BY` da
> apuração está correto** (prova: um vendedor que passou por 3 lojas diferentes
> apareceu em 3 linhas distintas, cada uma com o valor certo daquela loja); o
> problema é que o campo que a Alterdata manda como CAI_USUARIO **pode ser
> constante numa loja inteira** (login/terminal compartilhado), reproduzindo —
> com outro nome de campo — a mesma "anomalia do vendedor" já documentada
> antes para a `matricula` do operador (que também repetia entre lojas antes
> do ADR-105). Ou seja: a resposta da Alterdata ("o vendedor é o CAI_USUARIO")
> descreve o MODELO DE DADOS do ERP, mas não garante que o campo `usuario` do
> VendaMalote de fato varia por vendedor real dentro de cada loja — isso só se
> confirma loja a loja, com dado real.
>
> **Ferramenta de diagnóstico.** `GET /pdv-seller-diagnosis` agora devolve
> também `byFilial`: por loja, quantos códigos de vendedor DISTINTOS
> (`vendedor_codigo`/CAI_USUARIO) apareceram no histórico, e um `risco: true`
> quando uma loja com mais de 5 vendas só tem 1 código — dado concreto pra
> levar de volta ao suporte da Alterdata ("Loja Nova Iguaçu: N vendas, só 1
> CAI_USUARIO distinto — isso é esperado ou o campo não está vindo certo
> aqui?"). Na tela, a tabela "Extrato por loja e por vendedor" (todas as
> lojas) marca com um selo **"só 1 vendedor"** a loja que cai nesse caso, pra
> o gestor não confiar cegamente no número sem checar.
>
> **Extrato por loja e por vendedor (o "comando" do dono da rede).** A rota
> `GET /commission/store-report?start=&end=&storeId=&sellerKey=`
> (`RetailCommissionService.storeSellerExtract`) funde as 4 fontes de venda
> (ZappFlow, manual/foto, ERP, PDV/CAI_USUARIO) **mantendo a loja de cada
> venda** — o mesmo vendedor que vendeu em duas lojas aparece em duas linhas,
> cada uma com a % daquela loja. Filtra por loja (ou todas), por vendedor (ou
> todos) e por qualquer intervalo de datas — inclusive **parcial dentro do
> mês** (ex.: 1º ao dia 15), pra o vendedor saber quanto já acumulou de
> comissão antes do fechamento (dia 30/31). Na tela *Operação da Rede*, a seção
> **"Extrato por loja e por vendedor"** tem os seletores de loja/vendedor,
> atalhos de período (Hoje / Esta semana / Esta quinzena / Este mês) e datas
> personalizadas.

### Venda/ComissaoVendasPorPeriodo → comissão do ERP (conferência)
Relatório agregado por vendedor no período (`data.metaVendedorRealizado[]`),
usado só para **conferir** a comissão já calculada pelo ERP (não é a base).

> **Homologação Toulon — Q2 (ESCLARECIDA).** O endpoint volta **vazio** quando
> **não há metas cadastradas por vendedor** no ERP (confirmado pela Alterdata:
> *"como não tem metas cadastrada o campo não vai conter informação"*). Não é bug:
> o conector trata o vazio como esperado (importa 0, sem erro) e a comissão sai
> normalmente pela venda a venda (VendaMalote + CAI_USUARIO, acima). Assim que as
> metas forem cadastradas, o relatório passa a preencher a conferência sozinho.

## Dois pontos críticos de casamento (mais prováveis de divergir)

1. **Chave do produto consistente entre os três recursos.** O `produto` de
   **Saldo** e de **Preco** precisa ser **o mesmo identificador** que veio como
   `codigo` em **CodigoDeBarras**. Se vier em formato diferente (ex.:
   referência+cor+tamanho concatenados, ou um SKU interno distinto), o sync
   **pula** o item (`skippedNoProduct`). → Confirmar que os três usam a mesma chave.

2. **Código da filial = Código da loja no ZappFlow.** `Saldo.filial` liga à loja
   pelo campo **Código** cadastrado em *Operação da Rede → Nova loja*. → Ao
   cadastrar as filiais no ZappFlow, use no **Código** exatamente o número da
   filial no Alterdata (ou configure um mapa `filialToStore`).

## Ordem de sincronização

`Referencia` → `CodigoDeBarras` → `Saldo` (por filial) → `Preco`. As variantes
precisam existir (CodigoDeBarras) antes de Saldo/Preco casarem por `produto`.

## Checklist para a conferência na doc de homologação

- [ ] Paths e método (`GET /api/v1/{Recurso}/versao/…`) batem?
- [ ] Paginação é por **header** (`pagina`/`itensPorPagina`) ou por querystring? *(se for querystring, é o único ponto que exige ajuste no conector)*
- [ ] Campo de versão é **`controleVersao`**? Onde vem o total de páginas?
- [ ] Nomes dos campos batem, em especial `produto`, `saldoAtual`, `preco1`, `ean`, `cor`, `tamanho`, `referenciaId`, `descricao`?
- [ ] A chave `produto` (Saldo/Preco) é idêntica ao `codigo` (CodigoDeBarras)?
- [x] **Vendedor da comissão** = `caixa.usuario` (CAI_USUARIO → VENDEDORES por `VEN_CODIGO = CAI_CODIGO`), não a `matricula` (operador). *(Q1 resolvida)*
- [x] `Venda/ComissaoVendasPorPeriodo` vazio = **sem metas cadastradas** (esperado; comissão sai por VendaMalote). *(Q2 esclarecida)*

> Divergência encontrada? Basta informar o **nome real do campo** (ou colar um
> JSON de exemplo de cada endpoint) que o mapeador correspondente é ajustado.
