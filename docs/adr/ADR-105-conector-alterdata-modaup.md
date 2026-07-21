# ADR-105 — Conector Alterdata/ModaUp (ERP da TOULON)

**Status:** Proposto (design). Implementação **bloqueada** por dependências
externas da Alterdata (ver "Pendências externas"). Sem código ainda.

**Origem:** Piloto TOULON. A TOULON opera no ERP **ModaUp da Alterdata**. Para o
ZappFlow refletir estoque/produto/preço/vendas reais **sem digitação dupla**,
precisamos sincronizar com a API da ModaUp. Este ADR fixa a arquitetura a partir
da análise dos specs OpenAPI fornecidos (10 arquivos, 9 módulos distintos).

---

## Contexto (o que os specs mostraram)

A ModaUp expõe **~12 microserviços** REST (um subdomínio cada), OpenAPI 3.0.1,
com **padrão uniforme** em todos:
- **Auth:** header `Authorization: Bearer` em ~todas as operações. **Nenhum spec
  documenta como emitir o token** (sem endpoint de login/OAuth, sem
  `securityScheme` formal). → dependência externa nº 1.
- **Sincronização incremental:** endpoints `GET .../versao/{version}` (e
  variantes `/versao/{filial}/{version}`) em todos os módulos — devolvem o que
  mudou **desde uma versão** (cursor). Não há webhook/push → **polling com
  delta**.
- **Multi-loja:** paths parametrizados por `rede` (cadeia) e `filial` (loja).
- **Paginação por header** (`pagina`, `itensPorPagina`, `ordenadoPor`, `direcao`).
- **v1 + v2** convivendo (v2 é o conjunto novo; preferir onde existir).

Módulos e cobertura relevante ao ZappFlow:

| Módulo | Serve para | Endpoints-chave |
|---|---|---|
| **Supply** | produto/grade/EAN + **estoque** | `Referencia`, `Grade`, `CodigoDeBarras` (EAN), `Saldo` (`/Saldo/versao/{filial}/{version}`), `Produtos/CodigoProduto/{sku}` |
| **Price** | preço + promoção | `TabelaPreco` (`/referencia/{referencia}/{rede}/{sku}/{filial}`), `Preco/versao/{rede}/{table}/{version}`, `PromocaoMalote` |
| **CRM** | cliente + fidelidade + histórico | `Cliente`, `ClienteFidelidade`, `ClienteVendaHistorico`, `ClienteGrupo` |
| **Sales** | vendas/pagamento/caixa/fiscal | `VendaMalote`, `Pagamento`, `ParcelaCartao`, `DataCaixa`, `GestorNota` |
| **eCommerce** | visão e-com de produto/saldo/sacola | `Produto/referencia/...`, `Saldo/valoresEstoqueProduto`, `ItemSacola`, `LinkPagamento`, `Lgpd` |
| Tributário / Receber / Logistic / Purchase | fiscal, a receber, logística, compras | (fase posterior) |

**Modelo de junção (confirmado nos specs):**
`Referência (produto) → Grade (cor × tamanho) → CódigoDeBarras (EAN por variante)
→ Saldo (estoque por filial) → TabelaPreço (preço por filial)`.
Chaves: **`referencia` + `sku`/EAN + `rede`/`filial`**. Casa 1:1 com o modelo do
ZappFlow (`produto → variantes → estoque → preço`).

## Decisão

### Princípios
1. **Read-first, faseado.** No piloto, **somente leitura** da ModaUp → ZappFlow.
   Escrita (criar venda/baixar estoque) só depois de validada.
2. **Conector plugável por org.** Um `AlterdataConnectorService` por organização,
   ativado por flag; o parque que não usa ModaUp não é afetado.
3. **Delta-sync por versão.** Cursor persistido por (org, módulo, recurso,
   filial); cada ciclo chama `/versao/{cursor}` e avança. Backfill inicial full.
4. **Segurança por padrão.** Credenciais **criptografadas** por org
   (`EncryptionService` existente), nunca em texto; acesso auditado; escopo
   mínimo (read-only) no piloto.
5. **Isolamento multi-tenant.** Todo dado sincronizado carrega `organization_id`;
   nunca cruza tenants (mesma regra do resto do ZappFlow).

### Arquitetura (a construir)
- **`AlterdataConnectorService`** — resolve **base URLs por módulo** e a
  **credencial/token** da org; centraliza auth + refresh do token (contrato a
  confirmar com a Alterdata) e o cliente HTTP (paginação por header, ret/backoff).
- **Cursor store** — tabela `alterdata_sync_cursors(org, modulo, recurso, filial,
  version, updated_at)`. É a memória do delta.
- **Sync jobs** — no `Scheduler`/`JobQueueService` existentes: um job por
  recurso, polling agendado (intervalo configurável); backfill inicial em
  lote; idempotência por chave natural (referencia/EAN/codigo).
- **Mappers** — traduzem entidades ModaUp → entidades ZappFlow:
  - `Referencia` + `Grade` + `CodigoDeBarras` → `products_services` +
    `product_variants` (cor/tamanho) + EAN.
  - `Saldo` (por filial) → `inventory_items` (quantidade vendável).
  - `TabelaPreco`/`Preco` → preço do produto/variante (tabela/filial escolhida).
  - `Cliente` (+ `ClienteVendaHistorico`) → `contacts`/CRM.
  - `VendaMalote` → vendas/analytics (fase 2).
- **Config UI** — tela por org: credenciais, rede/filial, módulos ativos,
  intervalo de sync, status/último cursor, botão "ressincronizar".
- **Auditoria** — cada acesso à API e cada import registrado (reusa o padrão de
  audit log / `vision_access_logs`).

### Segurança & governança (LGPD)
- **Token:** guardado criptografado por org; rotacionável; nunca logado.
- **Base legal LGPD:** a **TOULON é a controladora**; ZappFlow e Alterdata são
  operadores. Puxar dados de **cliente** (CRM) exige instrumento contratual
  (TOULON autoriza; idealmente DPA Alterdata↔ZappFlow). **Fase 1 evita PII**
  (só produto/estoque/preço) — cliente entra na Fase 2 com a base legal fechada.
- **Escopo mínimo:** credencial read-only no piloto; só os módulos necessários.
- **Retenção:** respeitar expurgo exigido pela Alterdata/TOULON sobre o dado
  sincronizado.

### Faseamento
1. **Fase 1 — catálogo vivo (maior ganho, sem PII):** leitura de **produto+grade+
   EAN (Supply)** + **estoque (Saldo)** + **preço (Price)** → alimenta a vitrine
   e o atendimento por IA. Começa em **homologação**, 1 filial.
2. **Fase 2 — cliente & vendas:** **CRM** (com base legal) + **Vendas (Sales)** →
   dashboards reais + contexto de atendimento.
3. **Fase 3 — financeiro/fiscal:** pagamento/`ParcelaCartao`/conciliação +
   notas (Tributário/Receber).
4. **Fase 4 — escrita:** criar pré-venda/venda a partir da loja virtual.

## Pendências externas (bloqueiam o início — pedir à Alterdata)
1. ⭐ **Emissão/renovação do token** (não está em nenhum spec). Bloqueante.
2. **Homologação:** base URLs de sandbox + **credencial de teste** da TOULON.
3. **Escopo:** credencial **read-only** possível? Quais módulos a TOULON tem
   licenciados?
4. **rede/filial da TOULON** (uma loja ou várias?).
5. **Contrato do delta:** confirmar que `/versao/{version}` devolve, junto, a
   **nova versão** para persistir como cursor.
6. (menor) specs de HumanResources e Financial — não críticos ao piloto.

Ver [`INTEGRACAO-ALTERDATA-PERGUNTAS.md`](../INTEGRACAO-ALTERDATA-PERGUNTAS.md)
(versão enxuta A+B+rede/filial — o modelo de dados já foi respondido pelos specs).

## Consequências

**Positivas:** ZappFlow reflete o ERP real da TOULON sem redigitação; reaproveita
Scheduler/JobQueue/EncryptionService/CRM/estoque já existentes; padrão uniforme
(auth+delta) reduz o custo por módulo; faseamento sem PII destrava valor cedo e
posterga a complexidade LGPD.

**Trade-offs:** 12 microserviços = 12 base URLs e possivelmente 12 credenciais →
o conector precisa abstrair isso; sem webhook, a "quase tempo-real" depende do
intervalo de polling; a fidelidade do sync depende do contrato de versão
(cursor) — a confirmar. Dependência de a Alterdata fornecer token + sandbox
antes de qualquer linha de código.
