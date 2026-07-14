# ADR-087 — Multiloja nativo: estoque por loja com o ZappFlow como sistema principal

- **Status:** Proposto (roadmap comprometido; implementação quando um cliente real puxar)
- **Data:** 2026-07
- **Contexto de origem:** ADR-084 D4 adiou o `store_id` no estoque nativo (Opção 3 — loja única). Este ADR registra a decisão e o plano para o cenário **multiloja nativo**, que o ZappFlow precisará atender (algum cliente vai querer o ZappFlow como seu **único** sistema across várias lojas físicas).
- **Relacionadas:** ADR-084 (modo de estoque / fonte da verdade), ADR-083 (Retail Ops), ADR-086 (scan/recebimento). Consome `RetailStockModeService.authoritativeLedger`, `RetailInventoryService` (sombra por loja), `InventoryService` (núcleo).

## Contexto

Hoje o ZappFlow atende dois cenários de estoque:
- **Supervisionado** (TOULON): a fonte é externa (Alterdata); a **sombra por loja** (`retail_store_inventory`, permite negativo) é alimentada por import/conciliação. **Pronto.**
- **Nativo loja única**: a fonte é o ZappFlow; o saldo vive no **núcleo** (`inventory_items`, por organização, sem dimensão de loja). **Pronto** (com graduação supervisor→nativo, ADR-084 D5).

**Falta:** **nativo MULTILOJA** — o ZappFlow como sistema principal, com **saldo próprio por loja física**. O núcleo não tem `store_id`, então hoje não há como o modo `native` representar lojas distintas nativamente.

## Opções

### Opção 1 — `store_id` no núcleo (`inventory_items` + `stock_movements`)
Adicionar `store_id` (nullable = loja única/org) ao estoque do núcleo; `UNIQUE(org, store_id, produto, variante)`; `InventoryService` ganha `storeId` opcional em todos os métodos (reserve/commit/sell/restock/recordMovement).
- ✅ Modelo único e "correto"; pedidos/reserva podem ficar store-aware.
- ⚠️ **Mexe no caminho quente do estoque de TODOS os clientes** (food, serviços, e-commerce), inclusive quem não é varejo. Blast radius alto; pedidos de e-commerce não têm conceito de loja. **Alto risco e esforço.**

### Opção 2 — Ledger nativo por loja no domínio retail (**recomendada**)
O núcleo (`inventory_items`, org-level) segue **intocado** servindo e-commerce/pedidos. Para lojas em modo `native`, o saldo por loja vive num **ledger retail autoritativo por loja** — reaproveitando a infraestrutura por loja que já existe (`retail_store_inventory`), mas **clampado** (sem negativo, porque é a verdade) e marcado como autoritativo.
- ✅ **Zero risco ao caminho quente**; contido no domínio retail; encaixa na invariante do ADR-084 D4 (basta o `authoritativeLedger` resolver para esse ledger nativo-por-loja).
- ✅ **Reuso máximo:** scan/recebimento/graduação já escrevem por loja; passam a apontar para o ledger nativo quando o modo da loja é `native` + multiloja.
- ⚠️ Loja que também vende por e-commerce tem o saldo da loja (retail) e o do e-commerce (núcleo) — mas isso É a realidade multiloja (o e-commerce é uma "localização" própria). A regra de qual abastece qual é configuração, não conflito.

## Decisão

**Adotar a Opção 2 quando um cliente real puxar multiloja nativo.** Motivos: entrega o cenário sem arriscar o fluxo de venda de todos os outros clientes, e alavanca tudo que já foi construído (modo de estoque, sombra por loja, scan, recebimento, graduação). A Opção 1 (unificação total com `store_id` no núcleo) só se justifica se, no futuro, **pedidos/reserva do núcleo** precisarem ser store-aware — aí vira um projeto próprio, com migração cuidadosa e faseada do caminho quente.

### Plano de implementação (Opção 2), quando ativado
1. **Ledger nativo por loja:** distinguir, em `retail_store_inventory` (ou tabela irmã), linhas *autoritativas* (native, clampadas ≥ 0) das *sombra* (supervised, permitem negativo) — via coluna `ledger_kind` ou tabela dedicada.
2. **`RetailStockModeService.authoritativeLedger`** passa a resolver, para uma loja `native` de org multiloja, o ledger **`native-store`** (hoje só resolve `core`/`shadow`).
3. **Escritas por loja** (scan `scanReceive`, recebimento `confirm`, ajustes) já recebem `storeId` — passam a gravar no ledger nativo-por-loja quando for o caso.
4. **Vendas/baixa por loja:** quando o ZappFlow registrar a venda por loja (PDV nativo), dar baixa no ledger da loja.
5. **Graduação multiloja:** estender o ADR-084 D5 (hoje loja única → núcleo) para semear o ledger nativo-por-loja a partir da sombra, por loja.
6. **Relatórios/Impact Ledger** ganham a dimensão de loja onde fizer sentido (capital parado por loja, etc.).

## Consequências

**Positivas:** cobre o último cenário de estoque sem regressão nos demais clientes; reuso altíssimo; decisão e plano prontos para execução rápida quando houver demanda.

**Trade-offs:** o núcleo continua sem `store_id` — se algum dia pedidos/reserva precisarem ser store-aware nativamente, será a Opção 1 (projeto à parte). Até lá, e-commerce = uma localização; lojas físicas nativas = ledger retail por loja.

## Guardas
- Invariante do ADR-084 D4 mantida: **um único ledger autoritativo por (loja, produto)** — o modo decide (`core` | `shadow` | `native-store`).
- Não tocar o caminho quente do estoque do núcleo sem um ADR de migração dedicado.
- Isolamento por `organization_id` e auditoria em toda escrita.
