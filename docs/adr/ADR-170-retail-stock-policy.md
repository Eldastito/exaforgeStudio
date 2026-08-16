# ADR-170 — Política de estoque (mínimo/alvo) para "quanto falta"

**Status:** Implementado (Fase 1 do PRD Moda/TOULON, frente INV).
**Origem:** PRD Moda/TOULON, INV-003/004 + RN nº 3/6 + AC-06/AC-07. O PRD manda
propor ADR curto especificamente para a política de estoque.

## Contexto

O estoque negativo já é exposto por loja (ADR-083). Mas "quanto falta" não podia
ser calculado com honestidade: **saldo negativo NÃO é "quantidade faltante"** sem
uma META de estoque definida pelo negócio (RN nº 6). Sem uma referência de alvo,
qualquer número de "falta" seria inventado.

## Decisão

Nova tabela `retail_stock_policies` (aditiva) com **mínimo** e **alvo** por escopo,
e um serviço que resolve a política EFETIVA por precedência e calcula os números
de falta sem ambiguidade.

### Escopo e precedência (INV-004)

`store_id`/`variant_id` usam `''` (sentinel) para "toda a org / todo o produto",
consistente com `retail_store_inventory`. A resolução tenta, mais específica
primeiro:

1. loja + variante
2. loja + produto
3. organização + variante
4. organização + produto
5. sem política → `null`

Uma política **ativa** por escopo (índice único parcial `WHERE active = 1`).
`remove` desativa (não apaga — preserva histórico).

### Números sem ambiguidade (INV-003, RN nº 3)

- `qty_to_zero = max(-saldo, 0)` — só para **sair do negativo**; independe de meta.
- `shortage_qty = max(alvo - saldo, 0)` — **só com política**; senão `null`
  ("Meta não configurada", AC-06). Nunca confundir os dois.

`RetailInventoryService.listNegative` passa a carregar `qty_to_zero`, `min_qty`,
`target_qty`, `shortage_qty` por item (curto-circuita se a org não tem política).

## Consequências

- AC-06 (sem meta → "Meta não configurada") e AC-07 (saldo -2, alvo 3 → falta 5,
  até-zero 2) atendidos.
- Aditivo/retrocompatível: quem não cadastra política vê os campos `null` e o
  comportamento antigo intacto.
- Isolado por organização; config restrita a owner/admin (§12.1).

## Fora de escopo (fatias seguintes)

- **INV-005 (Reposição):** `available_qty`/`transferable_qty` da loja doadora
  (preservando o mínimo dela) — usa esta política, mas é fiação própria na tela
  de reposição.
- **Vigência por janela de datas:** `effective_from/to` são armazenados; a
  resolução usa `active = 1` como período corrente. Filtro por data fica para
  quando houver necessidade real.
- **Origem `recommendation`:** a política pode nascer de recomendação aprovada
  (source), mas a geração automática de metas não faz parte desta fatia.

## Rotas

- `GET /api/retailops/stock-policies` (list; filtros `storeId`/`productId`)
- `POST /api/retailops/stock-policies` (owner/admin)
- `DELETE /api/retailops/stock-policies/:id` (owner/admin — desativa)

Teste: `scripts/test-retail-stock-policy.ts` (21 checks).
