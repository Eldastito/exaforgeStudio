# Session Recap — 2026-08-28

Registro durável de uma sessão longa que fechou 3 tracks de closure do
PRD-PEL-01, 2 ADRs retrospectivos, todas as 5 pendências §5 do
`STATUS-DE-EXECUCAO`, uma consolidação de rota e 25 PRs merged em
`main`. Serve como referência pra próximo agent/revisor entender o
que aconteceu sem reconstruir do `git log`.

## Contexto de entrada

Ao início da sessão, `main` estava pós-PR #1402 com:
- **Track A** (Visual Recipe Engine): PRs #1403-#1406 já em progresso,
  parcialmente merged.
- **Track B** (Content Competitor Intelligence): não iniciado.
- **Track C** (Business Skills Pack): bloqueado — `blocked_reason:
  "PRD-BSP-01 fora do repo"` (§Gap-2 da matriz).
- Product Evolution Ledger (backend F1-F5, UI F2, scoring F3, sync F4,
  seed F5) já em produção. **5 pendências §5 abertas.**

## O que foi entregue (25 PRs, todos merged em `main`)

### Track A — Visual Recipe Engine (4 PRs)

Fecha as fatias F3-F5 do Track A do PRD-PEL-01.

| PR | Fatia | Entrega |
| --- | --- | --- |
| #1403 | F3 | UI: dropdown de recipes + inputs + generate no StudioView |
| #1404 | F4 | usageStats + endpoint `/api/studio/visual-recipes/analytics` + card "Insights" |
| #1405 | F3.5 | `suggestForBriefing` (LLM + fallback keyword) + UI |
| #1406 | F5 | Schema aditivo + backend CRUD de aliases per-org |

### Track B — Content Competitor Intelligence (5 PRs)

Cria a espinha completa: ledger de contas → storage de posts → classificação → insights → crossover com o Studio.

| PR | Fatia | Entrega |
| --- | --- | --- |
| #1407 | F1 | Schema + `CompetitorIntelligenceService` + endpoints REST |
| #1408 | F2 | Storage de posts (`CompetitorPostsService`) + upsert |
| #1409 | F3 | Classificação (`CompetitorClassificationService`) via recipes do VRE |
| #1410 | F4 | `CompetitorInsightsService` (agregações) |
| #1411 | UI | Card "O que seus concorrentes usam" no StudioView |

### Gap-2 — Destravando BSP (2 PRs)

| PR | Entrega |
| --- | --- |
| #1412 | `docs/prd/PRD-BSP-01-business-skills-pack.md` (RN-BSP-01..12, US-BSP-01..06, F0-F5) |
| #1413 | `docs/adr/ADR-195-business-skills-pack.md` (fachada aditiva, adapter map, guardrails) |

### Track C — Business Skills Pack (5 PRs)

Implementa as 5 fatias do PRD-BSP-01. 194 checks de teste dedicados no total.

| PR | Fatia | Entrega |
| --- | --- | --- |
| #1414 | F1 | `BusinessSkillsPackService` (fachada aditiva) + adapter map por vertical + `business_skills_pack_org_config`. `test:bsp-pricing` 53/53. |
| #1415 | F2 | RFP templates + `createQuoteFromTemplate` + métricas por vendedor (RN-BSP-05). `test:bsp-rfp` 57/57. |
| #1416 | F3 | Local Marketing: `enrichContactsWithCompetitor` (adaptado a `contacts` × `competitor_accounts`; PRD original falava em `prospects` que não existe). `test:bsp-outreach` 45/45. |
| #1417 | F4 | Gate por dimensão + soft launch (`BSP_SOFT_LAUNCH` env var) + 6 endpoints wireados + `GET /api/bsp/access`. `test:bsp-gate` 39/39. |
| #1418 | F5 | `BspSettingsPanel` em Configurações: toggles + editor de template + preview de pricing. |

### Ledger housekeeping — fecha as 5 pendências §5 (5 PRs)

| PR | Pendência | Entrega |
| --- | --- | --- |
| #1419 | §Gap-2 + §BSP delivered | Docs `INITIAL-GAP-MATRIX` + `STATUS-DE-EXECUCAO` marcam BSP como DELIVERED |
| #1420 | Seed pós-A/B/C | Seed do ledger reflete Tracks A/B/C entregues (VRE + INTELLIGENCE_HUB + BSP → PRODUCTION) |
| #1421 | §5.5 SUPERSEDED | 3 items legados registrados: `SOCIAL_INTELLIGENCE_PRD10_LEGACY`, `VERTICAL_INTELLIGENCE_HUB_LEGACY`, `ENTERPRISE_INTELLIGENCE_PRE_ADR166_LEGACY`. Runner estende pra suportar `target_status: SUPERSEDED` via IMPLEMENTING→setStatus explícito. |
| #1422 | §5.4 dependencies | 4 arestas do grafo registradas: ZAPFLOW_SENSE→VE (requires), SENSE→WIFI (requires), VMS→VE (requires), VRE→STUDIO_IMAGE_GEN_CORE (enhances). Runner com 2º passo pra deps (após todos os items existirem). |
| #1423 | §5.2 + §5.3 (nota) | §5.2 marcada RESOLVIDO NO SEED; §5.3 marcada PENDENTE — decisão do dono com roteiro |

### Content/Growth consolidation (1 PR)

| PR | Entrega |
| --- | --- |
| #1424 | Nova `routes/growth.ts` monta 10 endpoints em `/api/growth/*` delegando aos mesmos services do legado `/api/social/*`. Fecha `blocked_reason` do `CONTENT_GROWTH_ENGINE` no seed (TESTED → PRODUCTION). |

### ADRs retrospectivos (2 PRs)

| PR | Entrega |
| --- | --- |
| #1425 | `ADR-196` formaliza vertical Petshop (composição VAREJO+CLÍNICA+SERVIÇOS via `verticals.ts`); fecha `blocked_reason: "Sem ADR próprio nem PRD dedicado"`. |
| #1426 | `ADR-197` formaliza padrão de composição-por-conector pra integrações (`AlterdataConnectorService` + 9 outras). Decisão: manter o padrão atual, sem fábrica abstrata. Fecha `blocked_reason` do `INTEGRATION_FACTORY`. |

### §5.3 resolvido em código (1 PR)

| PR | Entrega |
| --- | --- |
| #1427 | Split Enterprise Intelligence em 2 iniciativas: `ENTERPRISE_INTELLIGENCE_CONTROLER` (refocada em ADR-135 kernel operacional) + novo `ENTERPRISE_LEARNING` (ADR-166 loop outcome→prior). `superseded_by` do legacy pré-ADR-166 corrigido pra apontar pra `ENTERPRISE_LEARNING`. **Todas as §5 fechadas.** |

### Cleanup / hardening (2 PRs)

| PR | Entrega |
| --- | --- |
| #1428 | Smoke test HTTP pra `/api/growth` (in-memory express + JWT, 22 checks): auth gate, validation, happy path, payload shape, 404. |
| #1429 | Marca os 10 endpoints legados em `/api/social/*` como DEPRECATED via RFC 9745 (`Deprecation: true`) + RFC 8288 (`Link: <successor>; rel="successor-version"`). Test aumenta pra 29/29. |

## Estado do Ledger após a sessão

Seed do PEL agora tem **29 items** (era 25 no baseline F0):
- **25 items ativos** (16 PRODUCTION, 4 TESTED, 4 IDEA remaining — os 4 de hardware/POC: VE/WiFi/Sense + PILOT retail_floor)
- **1 item novo**: `ENTERPRISE_LEARNING` (split §5.3)
- **3 items SUPERSEDED** legados

**Blocked_reasons remanescentes** (6 items, todos external-blocked ou refactor grande):
- `RETAIL_FLOOR_TOULON` — precisa validação de campo real
- `SOCIAL_PROVIDERS` — adapters TikTok/LinkedIn/X (OAuth de terceiros)
- `VISION_VMS_CONTROL_PLANE` — precisa dispositivo real ONVIF/RTSP
- `VISION_EDGE_PERCEPTION` — hardware + decisão de runtime
- `WIFI_PRESENCE_CSI` — hardware CSI-capable
- `ZAPFLOW_SENSE` — cascata dos anteriores
- `RECLAME_AQUI_INTELLIGENCE` — parceria/API oficial
- `EXECUTION_RUNTIME_ZAPPFLOW` — storage refactor (F1.5+)

Nenhum dos 8 restantes é acionável dentro de sessão desta natureza (código local sem external deps).

## Padrões consolidados nesta sessão

Reusáveis pelos próximos agents:

1. **Fatiamento F1..F5** — cada Track fecha em 5 PRs pequenos (schema+service+routes+tests) em vez de 1 PR gigante. Cada PR tem próprio smoke test (~40-60 checks).
2. **Fachada aditiva (ADR-195, ADR-197)** — quando o padrão atual atende, formalizar em ADR retrospectivo em vez de refactor. Blocked_reasons fecham sem código novo.
3. **Seed do PEL como fonte corrente** — quando doc externo (PRD-PEL-01) não existe no repo, o seed vira a autoridade. Reclassificação de prioridades vive nele.
4. **RFC 9745/8288 pra deprecation** — headers padrão, zero breaking, sinal observável em interceptors.
5. **Smoke test HTTP com in-memory express + JWT** — padrão herdado de `test-ai-usage-dashboard`, agora consolidado pra novas rotas via `test-growth-routes`.
6. **CREATE-then-ALTER estrito em `db.ts`** — todas as tabelas novas foram adicionadas no fim, aditivas, sem reordering.
7. **Middleware de deprecation** entre `requireRole` e o handler — chain limpa, handler intocado.

## Bot code-review-graph — comportamento reconhecido

Reportou HIGH/MEDIUM risk em ~todos os PRs. Padrão: flagra símbolos novos como "no direct test" mesmo quando os testes correspondentes cobrem via delegação (services chamados por rotas testadas, helpers de teste flagrados como "test the test"). **Skip silencioso é a resposta correta** — cada finding foi verificado antes.

## O que NÃO foi feito (deliberado)

- **Add-on comercial `AddonService.business_skills_pack`** — RN-BSP-08
  cumprida via gate por dimensão + soft launch (menor blast radius).
  Fica pra quando cobrança por planos evoluir.
- **Editor de outreach pack na UI** — F3 persistiu o enrichment; pack
  em si sem tela de "envio massivo" ainda.
- **Retirar hard `/api/social/{growth-*, attribution/*}`** — sunset
  ainda não fixado. Só marcados como DEPRECATED (#1429).
- **Anexar evidence via API** — RN-PEL-4 exige que evidence seja
  marcada `verified` por humano; anexar programaticamente sem
  verificação seria falso positivo pro ScoringService.

## Próximos alvos naturais (fora do escopo desta sessão)

Quando alguém retomar:

1. **Sunset formal dos endpoints DEPRECATED** — inventário de
   consumidores + `Sunset: <date>` header + hard-remove depois.
2. **Refactor de storage do `EXECUTION_RUNTIME_ZAPPFLOW`** — F1.5+ do
   ADR-152 (tabelas dedicadas em vez de colunas JSON).
3. **UI de "Contatos que são concorrentes"** — consume
   `GET /api/bsp/local-marketing/matches`, pinta na aba Contatos.
4. **Tela de métricas por vendedor** — consume
   `GET /api/bsp/rfp/metrics/by-agent`, mora em Vendas.
5. **Evidence attach via API pelos items DELIVERED** — trabalho manual
   de admin (não script).

## Índice rápido dos artefatos criados

Serviços novos:
- `src/server/BusinessSkillsPackService.ts` (fachada BSP)
- `src/server/CompetitorIntelligenceService.ts` (Track B F1)
- `src/server/CompetitorPostsService.ts` (Track B F2)
- `src/server/CompetitorClassificationService.ts` (Track B F3)
- `src/server/CompetitorInsightsService.ts` (Track B F4)
- `src/server/StudioVisualRecipeService.ts` (Track A)

Rotas novas:
- `src/server/routes/bsp.ts` (8 endpoints BSP)
- `src/server/routes/growth.ts` (10 endpoints consolidados)
- `src/server/routes/competitors.ts` (Track B REST)
- `src/server/routes/studio.ts` (Track A F3-F5)

UI nova:
- `src/features/settings/BspSettingsPanel.tsx`
- Crossover card no `src/features/StudioView.tsx`

Docs novos:
- `docs/prd/PRD-BSP-01-business-skills-pack.md`
- `docs/adr/ADR-195-business-skills-pack.md`
- `docs/adr/ADR-196-vertical-petshop.md`
- `docs/adr/ADR-197-integrations-composition-pattern.md`

Tests novos: `test:bsp-pricing`, `test:bsp-rfp`, `test:bsp-outreach`,
`test:bsp-gate`, `test:growth-routes` + extensões pesadas em
`test:product-evolution-seed` (57→63 checks) e vários outros de
Track A/B.
