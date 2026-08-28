# STATUS-DE-EXECUCAO — baseline Fase 0

**Data**: 2026-08-27
**Branch auditada**: `main` @ `c57a773`
**Último merge conhecido**: PR #1391 "claude/zappflow-radar-diagnostic-38py50"
**Autor**: Fase 0 automatizada (revisão humana pendente)

Este arquivo captura o **estado factual do repositório** no momento da Fase 0
do PRD-PEL-01. Serve de referência para:

- separar o que já está no código do que ainda é planejamento;
- ancorar futuras auditorias com um ponto zero comparável;
- registrar suítes de teste e workflows existentes para não duplicar wiring
  nas fatias futuras.

## 1. Repositório

- **Repo**: `Eldastito/exaforgeStudio` (público, distinto de `Eldastito/exaforge` — o CRM ZapFlow).
- **Stack**: React (frontend) + Node/Express (backend monolítico em `server.ts`) + SQLite via `better-sqlite3`.
- **Convenção crítica** (do `CLAUDE.md`): monolito com 15+ módulos verticais isolados por `organization_id`; `db.ts` estrito CREATE-then-ALTER, aditivo no fim; services com `orgId` como 1º arg; `business_signals` (ADR-136) é o canal universal de alertas — nunca criar tabela própria de "alertas".
- **Ambiente clonado**: shallow (`--depth 1`), então histórico anterior a HEAD não está local. Se a revisão exigir arqueologia (grep por rename/decisão específica), rodar `git -C /home/user/exaforgestudio fetch --unshallow` primeiro.

## 2. Métricas do repo

| Métrica | Valor |
| --- | ---: |
| ADRs em `docs/adr/` | 193 |
| PRDs/análises em `docs/prd/` | 19 |
| Runbooks em `docs/runbook/` | vários (mencionados no CLAUDE.md por ADR) |
| Scripts `scripts/test-*.ts` | 814 |
| Scripts `scripts/pilot-*.ts` (CLI de piloto) | 2 (retail-floor, runtime) |
| Scripts `scripts/loadtest-*.ts` | 2 (retail-analytics, capacity) |
| Comandos `npm run test:*` no `package.json` | 816 |
| Apps separadas | 2 (`apps/edge/` — Continuity Layer; `apps/vision-cloud/` — Vision VMS control plane) |

## 3. CI e execução de testes

- Workflow principal: `.github/workflows/ci.yml` (roda em PR contra `main` e push em `main`).
- **Estratégia de sharding**: 16 shards (`matrix.shard: [0..15]`), ~51 suítes por shard. Isso porque o limite duro de 256 jobs por matrix do GitHub Actions não comportaria as 816 suítes em jobs individuais.
- Shard driver: `scripts/ci-shard.mjs` deriva a lista dos scripts `test:*` do `package.json`, roda em sequência dentro do shard e reporta todas as suítes falhas antes de sair.
- Jobs adicionais: `Build + typecheck` (gate obrigatório — `npm run lint` retorna zero é gate desde Epic 0 / ADR-138).
- `PUPPETEER_SKIP_DOWNLOAD=true` para evitar flake do postinstall.
- Concurrency group: `ci-${workflow}-${ref}` com `cancel-in-progress: true`.
- Outros workflows: `code-review-graph.yml`, `security-review.yml`.

**Baseline pré-Fase 0**: essa infra não muda. Nenhuma fatia do Ledger deve
adicionar dependência de workflow novo até a Fase 4 (GitHub Evidence Sync),
e mesmo lá o novo workflow será opt-in.

## 4. Estado por cluster (resumo)

Compilado a partir de `INITIAL-GAP-MATRIX.md`. Detalhes por linha lá.

### 4.1 Governança/Operating Layers (§1–§4 da matriz)
Todos EXISTE ou PARCIAL. Nenhum bloqueador externo.
- `CEO_OPERATING_LAYER` (ADR-190 F0–F11) — EXISTE
- `MISSION_OPERATING_LAYER` (ADR-189 F0–F28, F29 em PR) — EXISTE, F29 pendente
- `DECISION_INTELLIGENCE_RADAR` (6 ADRs, ~14 services, ~17 tabelas, 25+ testes) — EXISTE
- `EXECUTION_RUNTIME_ZAPPFLOW` (ADR-152) — PARCIAL (armazenamento via colunas JSON, `docs/execution-runtime/STATUS-DE-EXECUCAO.md` deve ter % real por fase — não lida nesta Fase 0)

### 4.2 Verticais em produção ou avançados (§5–§10)
- `FALA_TU` (ADR-151, ADR-154 rascunho) — EXISTE (20+ services, 19 tabelas, ~40 testes)
- `RETAIL_FLOOR_TOULON` (ADR-083/150/170/175/176) — PRECISA VALIDAR COM DADOS REAIS (código pronto; campo pendente)
- `PETSHOP` — PARCIAL (composição sem ADR próprio)
- `AGENDA_FEDERADA` (ADR-060, ADR-180) — EXISTE
- `BEAUTY_SALOES` (ADR-169) — EXISTE (~30 testes, tenant-B coberto)
- `ADVOCACIA` (ADR-191, ADR-178) — EXISTE (F0–F12 + UI fechada)

### 4.3 Content, Growth, Social, Intelligence, Reputation (§11–§13, §22, §25)
- `CONTENT_GROWTH_ENGINE` (ADR-168) — PARCIAL (falta rota consolidada)
- `SOCIAL_PROVIDERS` (ADR-167) — PARCIAL / BLOQUEADO POR TERCEIRO (adapters TikTok/LinkedIn/X)
- `INTELLIGENCE_HUB` (ADR-135/156/157/166/167 F5) — PARCIAL (provider stub)
- `RECLAME_AQUI_INTELLIGENCE` (ADR-162 F0–F14) — PARCIAL / BLOQUEADO POR TERCEIRO (contrato Reclame AQUI)
- `INTELLIGENCE_HUB_SUPERSEDED_LEGACY` — SUPERSEDED (PRDs históricos absorvidos)

### 4.4 Visual Recipe + Studio base (§14, §X)
- `VISUAL_RECIPE_ENGINE` — NÃO EXISTE (comandos `/ProductExplosion` etc. sem hits)
- `STUDIO_IMAGE_GEN_CORE` — EXISTE (Gemini Imagen/Veo + OpenAI fallback pronto para reuso)

### 4.5 Business Skills (§15)
- `BUSINESS_SKILLS_PACK` — **DELIVERED** (Track C fechado em 2026-08-28).
  Todas as 5 fatias do PRD-BSP-01 mergeadas em `main`:
  - **F1 — Pricing 360 (fachada)** — PR #1414
    (`src/server/BusinessSkillsPackService.ts`, adapter map por vertical,
    tabela `business_skills_pack_org_config`, endpoint
    `/api/bsp/pricing/suggest`). Cobertura: `test:bsp-pricing` 53/53.
  - **F2 — RFP templates** — PR #1415
    (`getQuoteTemplate`, `renderTemplateString`, `createQuoteFromTemplate`
    delegando para `QuoteService.buildAndSave`, métricas por vendedor
    RN-BSP-05, endpoints `/api/bsp/rfp/*`). Cobertura: `test:bsp-rfp` 57/57.
  - **F3 — Local Marketing** — PR #1416
    (`enrichContactsWithCompetitor` cruzando `contacts.identifier` ×
    `competitor_accounts.handle`, tabela cache
    `bsp_contact_competitor_match`, endpoints `/api/bsp/local-marketing/*`).
    Adaptação vs PRD: usa `contacts` em vez de `prospects` — a tabela
    `prospects` referida no PRD não existe neste repo; contacts +
    competitor_accounts (Track B F1) cumpre o mesmo sinal. Cobertura:
    `test:bsp-outreach` 45/45.
  - **F4 — Gate + soft launch** — PR #1417
    (feature flag `BSP_SOFT_LAUNCH` env var, `checkAccess(orgId, dim?)`
    com curto-circuito no bake-in, helper `gateOrDeny` wireado em 6
    endpoints, novo `GET /api/bsp/access` pro CTA de upgrade na UI).
    Cobertura: `test:bsp-gate` 39/39.
  - **F5 — UI** — PR #1418 (`BspSettingsPanel` em Configurações → aba
    "Business Skills Pack", com 3 cards: toggles de dimensão, editor
    do quote_template com placeholders visíveis, preview de sugestão
    de preço).

  §Gap-2 do PRD-PEL-01 fechado. Estado no ledger:
  `DELIVERED` (F1-F5 em produção via `main`; soft launch on por default
  em bake-in via env `BSP_SOFT_LAUNCH=1`).

  Fora do escopo desta implementação (deliberado; possível trabalho
  futuro):
  - Add-on comercial `business_skills_pack` no `AddonService` +
    `PlanService.businessSkillsPackAllowed` + module_keys
    `bsp_pricing_360/bsp_rfp/bsp_local_marketing` no `ModuleService`.
    F4 cobriu RN-BSP-08 via gate por dimensão + soft launch sem mexer
    em `ModuleService`/`OPTIONAL_MODULES` (blast radius menor).
  - Editor de outreach pack na UI (o campo `outreach_pack_json` está
    reservado na config, mas sem tela de "envio massivo" ainda).
  - Tela de métricas por vendedor (endpoint pronto; superfície natural
    é "Vendas", não Configurações).
  - Lista de matches contact↔competitor na UI (idem — natural em
    Contatos).

### 4.6 Vision, Wi-Fi, Sensor Fusion (§16–§19)
- `VISION_VMS_CONTROL_PLANE` (ADR-001..008) — PARCIAL (sem ingestão real)
- `VISION_EDGE_PERCEPTION` — NÃO EXISTE (`apps/edge/` é Continuity Layer, não Vision Edge)
- `WIFI_PRESENCE_CSI` — NÃO EXISTE (conceitual)
- `ZAPFLOW_SENSE` — NÃO EXISTE (depende dos anteriores)

### 4.7 Platform / Integração / Enterprise / AI (§20, §21, §23, §24)
- `PLATFORM_RELIABILITY_CAPACITY` (ADR-164 F0–F14) — EXISTE (baseline data-dependent)
- `INTEGRATION_FACTORY` — PARCIAL (conectores dedicados; sem fábrica/registry)
- `ENTERPRISE_INTELLIGENCE_CONTROLER` (ADR-135, ADR-166) — EXISTE (2 blocos: Enterprise Learning + CONTROLER)
- `AI_RELIABILITY` (ADR-165 F0–F13) — EXISTE

## 5. Pendências identificadas na Fase 0

Estas são as decisões que **precisam de humano** antes de avançar para F1
do Ledger:

1. ~~**Confirmar §Gap-2**: PRD-BSP-01 está fora do repo (drive/notion/conversa) e precisa ser importado, ou o pacote precisa ser reescrito consolidando serviços verticais existentes?~~ **RESOLVIDO** (2026-08-28): PRD-BSP-01 e ADR-195 escritos e mergeados; Track C F1-F5 entregues em `main` (ver §4.5). Gap-2 fechado.
2. **Reclassificar prioridades do PRD-PEL-01 §11 vs realidade** (§Gap-7 da matriz):
   - `PLATFORM_RELIABILITY_CAPACITY` foi classificada como "parcial/ausente" no PRD-PEL-01; na verdade está F0–F14 em produção.
   - `RECLAME_AQUI_INTELLIGENCE` foi P3 backlog "ausente"; espinha está COMPLETA, falta só conector.
   - `VISION_VMS_CONTROL_PLANE` "parcial/avançado" é acurado, mas o bloqueador real é o Edge Perception não existir.
3. **Decidir tratamento de Enterprise Intelligence / CONTROLER**: 1 iniciativa combinada (§23 atual) ou 2 iniciativas separadas (`ENTERPRISE_LEARNING` + `CONTROLER_OPERATIONAL`)?
4. ~~**Confirmar dependências** que serão registradas na F1 do Ledger como `requires`:~~
   - ~~`ZAPFLOW_SENSE` requires `VISION_EDGE_PERCEPTION`, `WIFI_PRESENCE_CSI`~~
   - ~~`VISION_VMS_CONTROL_PLANE` → `PILOT`/`PRODUCTION` requires `VISION_EDGE_PERCEPTION`~~
   - ~~`VISUAL_RECIPE_ENGINE` requires `STUDIO_IMAGE_GEN_CORE` (relação `enhances`, não `requires` — motor base é opcional se decidirem trocar depois)~~

   **RESOLVIDO** (2026-08-28): 4 arestas de dependência registradas no
   seed do ledger via `SeedItem.dependencies[]` + 2º passo do runner
   (após todos os items existirem). Registradas exatamente como acima:
   `ZAPFLOW_SENSE requires VISION_EDGE_PERCEPTION`, `ZAPFLOW_SENSE
   requires WIFI_PRESENCE_CSI`, `VISION_VMS_CONTROL_PLANE requires
   VISION_EDGE_PERCEPTION`, `VISUAL_RECIPE_ENGINE enhances
   STUDIO_IMAGE_GEN_CORE`. Todas com `notes` referenciando §5.4 e
   idempotentes por UNIQUE (item, depends_on, type).
5. ~~**Registrar PRDs superseded**: (a) PRD 10 Social Intelligence, (b) Vertical Intelligence Hub histórico, (c) Enterprise Intelligence pré-ADR-166.~~ **RESOLVIDO** (2026-08-28): 3 items SUPERSEDED registrados no seed do ledger (`SOCIAL_INTELLIGENCE_PRD10_LEGACY` → `INTELLIGENCE_HUB`; `VERTICAL_INTELLIGENCE_HUB_LEGACY` → `INTELLIGENCE_HUB`; `ENTERPRISE_INTELLIGENCE_PRE_ADR166_LEGACY` → `ENTERPRISE_INTELLIGENCE_CONTROLER`). Seed loop estendido pra suportar `target_status: SUPERSEDED` via `IMPLEMENTING → setStatus(SUPERSEDED, superseded_by)`.

## 6. Métricas do PRD-PEL-01 §25 (critérios de aceite do próprio Ledger)

Para referência quando F1..F5 forem implementadas, o critério de "PRD Master implementado" (§25) inclui:

- Admin Master abre `/admin/product-evolution`.
- Todas as iniciativas seed aparecem.
- Cada item possui origem e estado.
- Itens sem evidência não podem ser `VALIDATED`.
- PRD sem código aparece como gap.
- Score é explicável.
- Gap Closure gera fila priorizada.
- Business Skills aparece relacionado ao PRD-BSP-01. **← bloqueado por §Gap-2**
- Vision Edge e Wi-Fi ficam separados do control plane existente.
- Nenhum cliente comum vê essa funcionalidade.
- Testes de isolamento/RBAC passam.
- Runbook existe.

Esta Fase 0 só entrega os 3 primeiros itens em forma de matriz de auditoria —
os demais dependem do backend/UI a serem implementados nas fatias F1..F5.

## 7. Entregas desta fatia (F0)

- `docs/product-evolution/README.md` — propósito e regra central
- `docs/product-evolution/CONVENCOES.md` — formato de `evolution_key`, estados, evidência
- `docs/product-evolution/INITIAL-GAP-MATRIX.md` — matriz das 25+1 iniciativas com evidência
- `docs/product-evolution/STATUS-DE-EXECUCAO.md` — este arquivo

**Zero código.** Zero migration. Zero teste. Zero alteração em ADR/PRD
existentes. Só docs de auditoria.

## 8. O que vem depois (não desta fatia)

Ordem sugerida na PR body, escolha final do dono do repo:

1. Revisão humana desta Fase 0 → aprovação da matriz.
2. ADR do Ledger (`docs/adr/ADR-193-product-evolution-ledger.md` ou próximo disponível) descrevendo fatias F1..F5 do backend + UI.
3. F1: backend mínimo (3 tabelas: `product_evolution_items`, `product_evolution_evidence`, `product_evolution_sources`) + service + rotas Admin Master. `product_evolution_dependencies`, `product_evolution_reviews`, `product_evolution_closure_batches` ficam para F1.5 (quando houver necessidade real de grafo/histórico/onda).
4. F2: UI `/admin/product-evolution` com abas Matriz e Gaps.
5. F3: Reconciliation engine + score determinístico.
6. F4: GitHub Evidence Sync (read-only, opt-in via env, rate-limited, cache SQLite).
7. F5: Import da matriz atual como seed. Registra os 5 pendências acima como issues do próprio Ledger.
8. Closure Tracks P0 → P3 conforme §21 do PRD.
