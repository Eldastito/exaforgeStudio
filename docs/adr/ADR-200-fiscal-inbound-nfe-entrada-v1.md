# ADR-200 — Entrada Automática de NF-e (v1 enxuta): captura via provedor + recebimento em sombra

**Status:** Aceito (Fase 0 — Proteção e Contratos)
**Data:** 2026-09-21
**Autor:** IA Dev
**PRD:** PRD ZapFlow — Entrada Automática de NF-e v1 (enxuta)
**Complementa:** ADR-021/022 (Smart Inventory — parser XML), ADR-029 (assinatura NF-e / fila),
ADR-083 (Retail Ops — fechamento), ADR-084 (composição de capacidades / modo de estoque),
ADR-086 (entrada scan-first / pré-estoque), ADR-198 (Alterdata go-live)

## 1. Contexto

Hoje o ZapFlow lê XML de NF-e por **upload manual** (`nfeParser.ts`,
`POST /api/products/invoice-scan/xml`) e extrai um subconjunto de campos
(`name`, `quantity`, `unit`, `unitCost`, `ean`), truncando `xProd` em 120
caracteres. Não existe:

- captura automática do documento fiscal completo (`procNFe`);
- distinção persistida entre resumo (`resNFe`), XML completo (`procNFe`) e
  evento (`procEventoNFe`);
- vínculo do rascunho de nota com **loja física** e com o **recebimento** de
  mercadoria;
- proteção contra o rascunho confirmar estoque sem conferência.

O `RetailReceivingService` (ADR-086) já modela recebimento aberto → bipagem →
confirmação e credita no ledger autoritativo do `RetailStockModeService`
(ADR-084 D4: `core` em `native`, `shadow` em `supervised`). Mas `confirm()`
ainda **não é transacional** e não tem chave de idempotência de movimento, e
`retail_goods_receipt_items` usa `INTEGER` e exige `product_service_id`,
descartando item esperado que ainda não está no catálogo.

Um PRD anterior (longo) propôs obter o XML **direto da SEFAZ** (certificado
A1, mTLS, SOAP `NFeDistribuicaoDFe`, cursor NSU, manifestação) **e** escrever
no Alterdata. Isso concentra duas fontes de risco altas para um piloto de um
cliente (Toulon), um CNPJ: guarda de certificado A1 (que **emite** documento
fiscal — não é só leitura) e escrita num ERP cujos endpoints ainda não estão
contratados (ADR-198 mostra o Alterdata ainda em consolidação de perfis).

## 2. Decisão

Implementar uma **v1 enxuta** que remove as duas fontes de risco:

### 2.1 Captura via PROVEDOR fiscal, não SEFAZ direto

A obtenção do XML completo e a manifestação passam a ser responsabilidade de um
**provedor fiscal** (default: Nuvem Fiscal; alternativa: PlugNotas/TecnoSpeed),
que já resolve distribuição DFe, manifestação do destinatário, rate-limit e
guarda do certificado sob a compliance dele. O ZapFlow **nunca** guarda A1,
nunca fala SOAP, nunca gerencia cursor NSU.

Verificado (SEFAZ/NT 2014.002): a **Ciência da Operação** é suficiente para o
destinatário receber o `procNFe` completo via distribuição — antes dela só vem
`resNFe` (resumo). Logo a v1 automatiza **apenas Ciência da Operação**
(governada e auditada); Confirmação/Desconhecimento/Não-Realizada ficam
**manuais** e fora do escopo.

Adapter único por trás de interface interna (`FiscalInboundProvider`):
`FiscalProviderAdapter` (provedor) e `ManualXmlAdapter` (upload convergindo no
mesmo pipeline). **Sem `SefazDfeAdapter` na v1.**

### 2.2 Modo `supervised`, sombra pura — zero escrita no Alterdata

Para a Toulon, `RetailStockModeService = supervised`. Ledger autoritativo =
`shadow` (`retail_store_inventory`). A v1 **não escreve** no core nem no
Alterdata. No máximo, relatório comparativo read-only (fase posterior). O
Alterdata continua fonte oficial de saldo.

### 2.3 NF-e cria estoque ESPERADO, nunca vendável

`procNFe` autorizado cria **recebimento esperado**; o estoque de sombra só muda
na **confirmação** do recebimento físico, e apenas nas quantidades realmente
recebidas. `xProd` é preservado como descrição fiscal original e nunca
sobrescreve nome comercial confirmado.

### 2.4 Invariantes

1. `organization_id + access_key` único por documento; upload manual, provedor e
   consulta por chave enriquecem o **mesmo** registro (dedupe multiorigem).
2. `resNFe` nunca aparece como XML completo; assinatura local ≠ situação fiscal.
3. Só `procNFe` com protocolo coerente (`cStat=100`) segue automático para
   recebimento.
4. Confirmar/reprocessar o mesmo recebimento não duplica movimento (chave
   `receipt_id + receipt_item_id + movement_kind`).
5. Toda escrita de estoque passa pelo ledger de `RetailStockModeService`.
6. Segredo (token de provedor, XML) nunca volta na API, log, analytics ou erro.
7. Cancelamento posterior a movimento gera exceção auditada, nunca exclusão
   silenciosa.
8. LLM não interpreta XML, não calcula tributo, não manifesta, não confirma
   recebimento; só sugere associação de produto.

## 3. Escopo por fase

- **Fase 0 (esta entrega):** proteção e contratos. Feature flag
  `fiscal_inbound_enabled` por org (**default OFF**), fixtures XML sanitizadas e
  este ADR. **Gate: nenhuma chamada produtiva a provedor/SEFAZ.**
- **Fase 1:** domínio + parser expandido (não truncar `xProd`, quantidade
  decimal, classificação de completude) + persistência idempotente + upload
  convergindo no novo pipeline.
- **Fase 2:** CNPJ na loja + resolução determinística de loja +
  `supplier_product_mappings` + recebimento esperado (item sem produto não é
  descartado) + `confirm()` transacional e idempotente.
- **Fase 3:** `FiscalProviderAdapter` (Nuvem Fiscal) + `probe` real + webhook/
  polling + storage privado do XML + política de Ciência da Operação + ingestão
  de cancelamento + UI de estado fiscal honesto + backoff/dead-letter.
- **Fase 4 (pós-piloto):** pesquisa por loja/período, painel de divergências,
  relatório comparativo read-only ZapFlow × Alterdata (sem escrita).

## 4. Consequências

**Positivas:** remove a guarda de A1 e o SOAP da SEFAZ (menos risco fiscal/LGPD
e menos código não-diferencial); remove a dependência de contrato Alterdata para
entregar valor; cada fase é PR pequeno e reversível atrás de flag; reaproveita
`nfeParser`, `invoice_scan_drafts`, `RetailReceivingService`,
`RetailStockModeService`, `JobQueueService`, `EncryptionService`,
`StorageService`.

**Negativas / limites aceitos:** a v1 **não** concilia com o Alterdata — o
lojista compara manualmente até o contrato existir; depende de um provedor pago;
notas anteriores a ~90 dias da conexão podem não ser recuperáveis (janela do
`resNFe` na distribuição); custo de aquisição (rateio de frete/desconto/IPI/
ICMS-ST) exige ADR próprio na Fase 1/2.

**Fora de escopo (v1):** SEFAZ direto / A1 / mTLS / NSU; escrita no Alterdata;
Confirmação da Operação automática; carta de correção com recálculo automático;
CT-e/NFS-e/MDF-e; SPED; multi-réplica do job (exige lock distribuído antes de
escalar).

## 5. Entregáveis desta fase (Fase 0)

- `organization_settings.fiscal_inbound_enabled` (migração aditiva, default 0).
- `src/server/FiscalInboundFlagService.ts` (kill-switch por org, default OFF).
- `scripts/fixtures/fiscal-inbound/*.xml` — `procNFe` autorizado, `resNFe`,
  cancelamento, namespace prefixado, item sem EAN, quantidade decimal
  (sanitizadas, dados fictícios).
- `scripts/test-fiscal-inbound-fixtures.ts` (`npm run test:fiscal-inbound-fixtures`).
- Este ADR.
