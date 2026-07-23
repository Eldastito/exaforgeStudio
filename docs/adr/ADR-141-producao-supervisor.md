# ADR-141 — Supervisor de Produção IA: fundação (produto fabricado + lista de materiais)

- **Status:** Produção / Fatias 1 (produto fabricado + BOM + módulo RBAC `production` + necessidade de materiais) e 2 (**ordem de produção** + etapas + apontamento + atraso) implementadas. Consumo de materiais, qualidade, paradas e alertas vêm nas fatias seguintes.
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

### D5 — Ordem de produção + etapas + apontamento + atraso (Fatia 2)
`production_orders` (planejado/produzido/refugado, status draft→released→in_progress→done|cancelled, datas prometida/prevista), `production_steps` (etapa/responsável/status), `production_events` (cada apontamento: release/progress/scrap/complete/cancel — auditável). `ProductionOrderService`: `create` (valida produto/qtd/BOM), `release` (só de draft — "liberar ordem" com aprovação por perfil na rota), `report` (progresso/refugo → atualiza saldos, marca `in_progress`, e **`done` quando produzido ≥ planejado**; refugo **não** abate o pendente), `addStep`/`setStepStatus`, `cancel`. `get` calcula, de forma **determinística**, o **PENDENTE** (`planejado − produzido`) e o **ATRASO** (`prometida < hoje` e não finalizada) e reusa a **necessidade de materiais** para o saldo pendente. Só apontamento humano — nenhum efeito externo.

## Consequências
**Positivas:** o piloto já roda o ciclo **planejar → liberar → apontar → concluir** com pendente e atraso determinísticos, etapas/responsáveis e trilha de eventos — reusando catálogo/estoque/BOM e o RBAC granular. Determinístico, isolado por org, restrito a gestores. Preparado para as fatias de consumo/qualidade/paradas e para publicar sinais (`production.order.late`, `production.material.shortage`) no núcleo transversal (Pareto/briefing).

**Trade-offs / escopo:** entregues BOM/necessidade (F1) e ordem/etapas/apontamento/atraso (F2); `material_consumptions` (reserva/consumo real que baixa estoque), `quality_checks`, `downtime_events` (motivos de parada) e a **publicação dos sinais** (`production.order.late`/`material.shortage`/`scrap.above_target`) ficam para as próximas fatias. Sem UI (backend + rotas). Sem apontamento por WhatsApp ainda.

## Guardas
- Determinístico (zero-token). Reusa catálogo/estoque (sem cadastro duplicado). RBAC restrito a gestores (via `requirePermission`, com fallback legado). Isolado por `organization_id`. Idempotência (produto por catálogo; item de BOM por material).

## Testes
`test:production-bom` (F1) — **RBAC `production`** (owner/gerente sim; vendedor não; fallback legado owner sim / agent não); produto fabricado idempotente por item do catálogo; BOM + itens com **upsert**; **necessidade determinística** (Farinha 2×60=120 vs 100 → falta 20; Ovos 0,5×60=30 vs 10 → falta 20; `shortageCount` muda com a quantidade); validações; isolamento por org. Regressão RBAC: `rbac-granular` 27/27, `rbac-profiles-api` 28/28, `rbac-finance` 23/23.

`test:production-orders` (F2) — cria ordem (draft; valida produto/qtd/BOM); **não aponta antes de liberar**; `release` só de draft (não libera 2×); **atraso determinístico** (prometida < hoje e não concluída); apontamento 40 bons + 5 refugo → `in_progress`, pendente 60 (**refugo não abate o pendente**), `started_at` e eventos progress/scrap; **`requirements` usa o pendente** (60×2=120); atingir o planejado → `done` (pendente 0, `completed_at`, não atrasada); não aponta ordem concluída; etapas (add/nome obrigatório/`setStepStatus`); cancelar (não cancela concluída); lista por status; isolamento por org.
