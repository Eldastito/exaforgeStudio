# ADR-111 — ZappFlow Comigo (módulo `copiloto`): Fatia 1 — Balcão PDV + Motor de Precificação

- **Status:** Proposto (escopo aprovado na conversa; implementação por PRs focados, um por vez)
- **Data:** 2026-07
- **Origem:** `docs/LEVANTAMENTO-AUTONOMO-PRODUCAO.md` — o plano Autônomo existe, mas o módulo `copiloto` que ele promete é só uma string em `plansGrade.ts`. Este ADR dá corpo ao módulo.
- **Relacionadas:** ADR-088 (visão ZappFlow Comigo — este ADR implementa o MVP dela), ADR-091 (plano Autônomo + módulo `copiloto` no teto), ADR-092 (Autônomo é PLANO; produto do autônomo é MÓDULO, não vertical), ADR-085 (Impact Ledger — snapshot/trend reusado no termômetro), ADR-082 (Continuity — venda offline).

## Contexto

Decisão de enquadramento (confirmada): o produto do autônomo é o **módulo `copiloto`** (marca **"Comigo"**), ligado no plano Autônomo. Os tipos de negócio (marmita, unha, chaveiro, foodtruck) são **arquétipos** dentro do módulo — **não** novas `VerticalKey` (mantém ADR-092).

Fatia 1 entrega o **north star do ADR-088**: revelar *"quanto eu ganho de verdade em cada unidade / cada hora minha"*. O caminho mais curto até esse número é o par **Balcão PDV (registra a venda)** + **Motor de Precificação (diz o custo/margem e recalibra pelo real)**.

Onboarding por arquétipo, Mesa/QR, termômetro completo e sugestão zero-token ficam para as fatias seguintes (ver §Faseamento).

## Decisões

### D1 — `copiloto` vira módulo de verdade (registro)
- Adicionar `"copiloto"` a `OPTIONAL_MODULES` (`src/server/verticals.ts`).
- Adicionar `MODULE_META.copiloto` (`src/server/ModuleService.ts`): label **"Comigo (Copiloto)"**, desc *"Balcão de vendas por toque + precificação: quanto custa, quanto cobrar, quanto sobra."*
- Já está no teto do plano Autônomo (`plansGrade.ts:16`) — nenhuma mudança na grade.
- Nav (`Sidebar.tsx`): `mod('copiloto')` liga a entrada **"Comigo"** (`viewMode='comigo'`), com sub-abas **Balcão** e **Precificação**.
- Rota: `app.use("/api/comigo", comigoRoutes)` em `server.ts`, `src/server/routes/comigo.ts`.

### D2 — Modelo de dados (Fatia 1)
Novas tabelas (multi-tenant por `organization_id`, auditoria em toda escrita — guardas do ADR-088):

- **`comigo_recipes`** (ficha técnica viva) — `id, organization_id, product_id?, name, kind ('revenda'|'fabricacao'|'servico'), yield_qty (rendimento, p/ fabricação), labor_minutes (p/ serviço), created_at, updated_at`.
- **`comigo_recipe_costs`** (itens de custo da ficha) — `id, recipe_id, label, kind ('insumo'|'indireto'|'tempo'), amount, is_estimate (1=chute, 0=real), created_at`. Inclui os "custos que se esquece" (gás, energia, embalagem, transporte, **taxa Pix/PSP**, aluguel da cadeira).
- **`comigo_orders`** (fila do Balcão) — `id, organization_id, session_alias?, status ('open'|'paid'|'done'|'canceled'), consumo ('local'|'viagem'), total, paid_via ('pix_manual'|'pix_dyn'|'card'|'cash')?, created_at, paid_at?`.
- **`comigo_order_items`** — `id, order_id, product_id?, name, qty, unit_price, unit_cost_snapshot`.
- **`comigo_calibrations`** (loop estimativa→realidade) — `id, recipe_id, expected_yield, actual_yield, waste_qty, note?, created_at`. Cada fechamento alimenta a recalibração de rendimento/custo real (o "IP defensável" do ADR-088 D6).

`hora_valor` (quanto vale a hora) e defaults de custos indiretos ficam em `organization_settings` (colunas novas `comigo_hour_value`, `comigo_default_indirects` JSON).

### D3 — Motor de Precificação (`ComigoPricingService`)
Serviço puro (testável isolado), unifica os três tipos mudando só o denominador (ADR-088 D6):

| Tipo | Custo unitário |
|---|---|
| **revenda** | custo de compra ÷ 1 |
| **fabricação** | (Σ insumos + Σ indiretos) ÷ **rendimento** |
| **serviço** | insumo rateado por atendimento **+ (labor_minutes × valor/min)** |

Métodos: `unitCost(recipe)`, `suggestPrice(recipe, targetMargin)`, `applyCalibration(recipeId, actualYield, waste)` (recalcula rendimento/custo real e persiste), `missingCostsHint(recipe)` (lista "custos que você esquece" ainda não preenchidos).

Guarda-corpos (ADR-088 D6): **trabalha com chute** (assume default e refina), **nunca sugere preço que espante o cliente**, ensina sem humilhar. LLM só na frase-conselho da ponta (frugalidade — ADR-088 D5); o cálculo é aritmético, zero-token.

### D4 — Balcão PDV por toque (`ComigoBalcaoView`)
Tela minimalista mobile-first (o autônomo tem só o celular): grade de fotos dos produtos → toque adiciona → quantidade → **cobra** (Pix estático "recebi" reusando `PaymentService.pix_manual`, ou "dinheiro"). Fila em background; na tela, o **pedido da vez** + contador. Sessão do cliente por apelido (sem login), permite adicionar itens depois e marcar **local × viagem**. Cada item grava `unit_cost_snapshot` (vindo do motor D3) — é o que alimenta lucro real depois.

### D5 — Reuso, não reescrita
- Cadastro de item reusa Catálogo + `SmartImportService` (foto) e Whisper (áudio) — o Balcão só consome o catálogo.
- Pagamento Pix estático nível 1 = `PaymentService.pix_manual` (já existe). Pix dinâmico (txid/webhook) é **Fatia 2**.
- Venda offline usa Continuity (ADR-082) — ligar na Fatia 1 se barato; senão Fatia 2.

## Escopo do MVP (Fatia 1) — o que ENTRA
D1 (registro do módulo) · D2 (schema) · D3 (motor revenda+fabricação+serviço com calibração) · D4 (Balcão PDV por toque + Pix estático "recebi" + dinheiro + sessão/consumo) · derivação de **ticket médio** e **custo/margem por item** já a partir do que o Balcão registra.

## Faseamento (resto do ADR-088, não entra agora)
- **Fatia 2:** Mesa/QR pay-first · Pix dinâmico (txid + webhook PSP) · sugestão LLM+RAG · termômetro completo (subindo/estável/caindo, mesmo-período, ponto de equilíbrio + meta ao vivo).
- **Fatia 3:** onboarding por arquétipo + porta própria "Comigo" · progressão pedagógica (D10) · boosts · graduação MEI + nota fiscal.

## Consequências
**Positivas:** greenfield sem legado; reusa Catálogo/Storefront/PaymentService/Whisper/SmartImport/Impact Ledger; entrega já o número-âncora do produto; módulo isolado (não toca o parque existente — só liga por opt-in no plano Autônomo).

**Trade-offs / riscos:** ticket baixo exige toque zero (suporte humano dá prejuízo — ADR-088); calibração pelo real depende de o autônomo registrar o fechamento (mitigar com default + fricção mínima); PWA/offline pode escorregar p/ Fatia 2 se o custo de ligar Continuity no Balcão for alto.

## Guardas
- Isolamento por `organization_id` + auditoria em toda escrita.
- LGPD: faturamento é dado sensível do negócio da pessoa — transparência.
- Frugalidade de token: cálculo é aritmético; LLM só na frase-conselho.
- Guarda-corpo do tutor: nunca sugerir preço que quebre a pessoa nem espante o cliente.

## Testes (a criar junto do código)
- `test:comigo-pricing` — unitCost dos 3 tipos, suggestPrice com margem, applyCalibration recalcula rendimento/custo, missingCostsHint.
- `test:comigo-balcao` — abrir pedido, adicionar itens, sessão por apelido, cobrar (pix_manual/dinheiro), snapshot de custo por item, ticket médio.
- `test:comigo-module` — `copiloto` aparece em OPTIONAL_MODULES/MODULE_META, respeita teto do plano (só Autônomo+), gating de nav/rota.

## Aprovação
Escopo (módulo + Fatia 1 = Balcão + precificação) aprovado na conversa. Próximo passo: PR focado **#1 = registro do módulo (D1) + schema (D2)**, depois **#2 = motor (D3)**, depois **#3 = Balcão (D4)**. Um por vez, validando cada um (método do backlog TOULON).
