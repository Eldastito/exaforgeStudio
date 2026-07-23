# ADR-141 — Supervisor de Produção IA: fundação (produto fabricado + lista de materiais)

- **Status:** Produção / Fatia 1 (produto fabricado + BOM + módulo RBAC `production` + necessidade de materiais determinística) implementada. Ordens de produção, etapas, consumo, qualidade, paradas e alertas vêm nas fatias seguintes.
- **Data:** 2026-07
- **Origem:** PRD "ZappFlow Enterprise Intelligence" (Epic de Produção, §…). "Supervisor de Produção IA: acompanha ordens, capacidade, atraso, consumo, qualidade e perdas." Condição de entrada — piloto industrial com processo mapeado. Diretriz do PRD: "começar com produção discreta simples", "reusar catálogo e estoque", "cálculos de necessidade e atraso são determinísticos", "um PR entrega uma capacidade testável e reversível".
- **Relacionadas:** ADR-138 (RBAC granular), Smart Inventory (catálogo/estoque), ADR-136 (sinais transversais). PRD §16 (Supply) como vizinho.

## Decisões

### D1 — Produto fabricado + BOM, reusando catálogo/estoque
`manufactured_products` (produto acabado **vinculado ao catálogo** `products_services`, idempotente por `(org, product_service_id)`), `bill_of_materials` (versão/rótulo da receita), `bom_items` (material **do catálogo** + quantidade por unidade + unidade; upsert por `(org, bom, material)`). Materiais e produtos acabados **não** duplicam cadastro — são itens do catálogo já existente; o estoque vem de `inventory_items`.

### D2 — Necessidade de materiais determinística
`ProductionService.materialRequirements(org, bomId, quantity)`: para produzir `quantity` unidades, por material `required = perUnit × quantity`, cruza com o **saldo em estoque** (`Σ quantity_available`) e devolve a **FALTA** (`max(0, required − onHand)`) + `hasShortage`/`shortageCount`. Zero-token, reproduzível — base do futuro alerta `production.material.shortage`.

### D3 — Módulo RBAC `production` (só gestores por padrão)
`production` entra em `RBAC_MODULES` + mapeamento `/production` → `production`. Templates: **owner/gerente** (default full) veem; demais perfis não. Rotas usam `requirePermission("production", …)`, que vale **inclusive no fallback legado** (owner→full, agent→none) — produção restrita a gestores em qualquer org, sem flag. `seedSystemProfiles` faz o top-up do módulo nos perfis já semeados.

### D4 — Escopo mínimo, testável e reversível
Só a **fundação** (produto/BOM/necessidade). Sem ordens de produção, consumo, qualidade ou paradas — isso vem nas próximas fatias, quando houver piloto. Aditivo: tabelas e rotas novas; nenhum fluxo atual muda.

## Consequências
**Positivas:** abre Produção pela base que dá valor imediato e barato — "para produzir N, o que falta de material?" — reusando catálogo/estoque e o RBAC granular. Determinístico, isolado por org, restrito a gestores. Preparado para as fatias de ordem/consumo/qualidade e para publicar sinais no núcleo transversal (Pareto/briefing).

**Trade-offs / escopo:** `production_orders`/`production_steps`/`production_events`, `material_consumptions`, `quality_checks`, `downtime_events` e os alertas (atraso/refugo/capacidade) ficam para as próximas fatias. Sem UI (backend + rotas). Sem apontamento por WhatsApp ainda.

## Guardas
- Determinístico (zero-token). Reusa catálogo/estoque (sem cadastro duplicado). RBAC restrito a gestores (via `requirePermission`, com fallback legado). Isolado por `organization_id`. Idempotência (produto por catálogo; item de BOM por material).

## Testes
`test:production-bom` — **RBAC `production`** (owner/gerente sim; vendedor não; fallback legado owner sim / agent não); produto fabricado idempotente por item do catálogo (exige item existente); BOM + itens com **upsert** (não duplica material); **necessidade de materiais determinística** (Farinha 2×60=120 vs 100 → falta 20; Ovos 0,5×60=30 vs 10 → falta 20; `shortageCount` correto e muda com a quantidade); validações (material inexistente, quantidade ≤ 0); isolamento por org. Regressão RBAC: `rbac-granular` 27/27, `rbac-profiles-api` 28/28, `rbac-finance` 23/23.
