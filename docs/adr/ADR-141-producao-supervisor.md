# ADR-141 — Supervisor de Produção IA: fundação (produto fabricado + lista de materiais)

- **Status:** Produção **MVP COMPLETO** — Fatias 1 (BOM + necessidade), 2 (ordem + apontamento + atraso), 3 (chão de fábrica: consumo/qualidade/paradas) e 4 (**sinais de produção no núcleo transversal** — atraso/falta/refugo → Pareto/briefing) implementadas. Apontamento por WhatsApp como refinamento futuro.
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

### D6 — Chão de fábrica: consumo real + qualidade + paradas (Fatia 3)
`material_consumptions`, `quality_checks`, `downtime_events`. `ProductionShopFloorService`: `consumeMaterial` **baixa o estoque de verdade** via `InventoryService.recordMovement('saida')` (o **mesmo motor** do recebimento de compras — ADR-137) e registra o consumo + evento; `consumeForBom` consome todos os materiais da BOM para uma quantidade; `addQualityCheck` (checklist aprovado/reprovado) e `addDowntime` (motivo + minutos) registram e viram evento; `summary` agrega consumo total, qualidade (total/reprovados) e minutos de parada. Consumo só em ordem **liberada/em produção**. `ProductionOrderService.get` passou a incluir `consumptions`/`qualityChecks`/`downtime`/`shopFloor`. Só apontamento humano; determinístico; auditável.

### D7 — Sinais de produção no núcleo transversal (Fatia 4)
`ProductionSignalPublisher.run(orgId, {asOfDate, scrapTargetPct})` deriva das ordens abertas e publica no `business_signals` (ADR-136 C1): **`production.order.late`** (prometida < hoje, impacto = pendente), **`production.material.shortage`** (falta de material para o saldo pendente — reusa a necessidade da BOM, evidência com os materiais), **`production.scrap.above_target`** (refugo/total > meta, default 10%). Determinístico, **idempotente por `tipo:ordem:dia`**, sob demanda (rota `POST /api/production/signals/refresh`). Como são sinais do ledger, **fluem automaticamente para o Pareto e o briefing** — a produção "aparece" para o Diretor sem novo canal. Só sinaliza; não executa.

## Consequências
**Positivas:** o Supervisor de Produção fica **completo (MVP)** — planejar → liberar → apontar → consumir (baixa estoque) → medir qualidade/paradas → concluir, **e** os problemas (atraso/falta/refugo) viram sinais que o gestor já vê no Pareto/briefing. Tudo determinístico, reusando catálogo/estoque/BOM, o motor de estoque do recebimento, o ledger de sinais e o RBAC granular. Isolado por org, restrito a gestores.

**Trade-offs / escopo:** MVP completo (F1–F4). O apontamento por WhatsApp e uma UI de produção ficam como refinamentos. O publisher é sob demanda (sem passe no Scheduler nesta fatia). O consumo baixa estoque na saída; reserva prévia (empenho) não é modelada.

## Guardas
- Determinístico (zero-token). Reusa catálogo/estoque (sem cadastro duplicado). RBAC restrito a gestores (via `requirePermission`, com fallback legado). Isolado por `organization_id`. Idempotência (produto por catálogo; item de BOM por material).

## Testes
`test:production-bom` (F1) — **RBAC `production`** (owner/gerente sim; vendedor não; fallback legado owner sim / agent não); produto fabricado idempotente por item do catálogo; BOM + itens com **upsert**; **necessidade determinística** (Farinha 2×60=120 vs 100 → falta 20; Ovos 0,5×60=30 vs 10 → falta 20; `shortageCount` muda com a quantidade); validações; isolamento por org. Regressão RBAC: `rbac-granular` 27/27, `rbac-profiles-api` 28/28, `rbac-finance` 23/23.

`test:production-orders` (F2) — cria ordem (draft; valida produto/qtd/BOM); **não aponta antes de liberar**; `release` só de draft (não libera 2×); **atraso determinístico** (prometida < hoje e não concluída); apontamento 40 bons + 5 refugo → `in_progress`, pendente 60 (**refugo não abate o pendente**), `started_at` e eventos progress/scrap; **`requirements` usa o pendente** (60×2=120); atingir o planejado → `done` (pendente 0, `completed_at`, não atrasada); não aponta ordem concluída; etapas (add/nome obrigatório/`setStepStatus`); cancelar (não cancela concluída); lista por status; isolamento por org.

`test:production-shopfloor` (F3) — consumo só em ordem em produção; **consumo baixa o estoque de verdade** (Farinha 500→400) + registro + evento; validações (material inexistente, qtd ≤ 0); **`consumeForBom`** consome os 2 materiais (Farinha −100, Ovos −25); qualidade aprovado/reprovado (nome obrigatório); parada (motivo obrigatório); **`summary`** (consumido 225, 2 checks/1 reprovado, 60 min de parada) e `get()` traz o chão de fábrica; isolamento por org.

`test:production-signals` (F4) — publica **atraso/falta/refugo** (1 de cada) nas ordens certas, com evidência; **ordem saudável não gera sinal**; domínio `production`; **idempotente por dia** (re-rodar não duplica); ordem no prazo não recebe atraso; `asOf` antes da data prometida → sem atraso; **os sinais viram prioridades no Pareto**; isolamento por org.
