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

> Divergência encontrada? Basta informar o **nome real do campo** (ou colar um
> JSON de exemplo de cada endpoint) que o mapeador correspondente é ajustado.
