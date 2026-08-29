# Pausa de sessão — 2026-08-29
## Auditoria de duplicação (DUP-001..007) + entrada do PRD-ZF-ALTERDATA-GOLIVE-01

**Este documento existe pra retomarmos EXATAMENTE daqui.**
Base: `main` do `Eldastito/exaforgeStudio` em `76bbdb5` (verificado nesta
auditoria; commit `a1b318e` no local).

## 1. O que aconteceu antes de pausar

1. Ciclo de 19 PRs mergeados no `Eldastito/exaforge` (ZapFlow landing/CRM
   público — repo diferente):
   - PRs #24-#38: qualidade/segurança/SEO (CSV export, log rotation,
     Meta webhook GET/POST, sitemap dinâmico, Cache-Control, CSP
     report-only, JSON-LD em todas as landings, npm audit, etc.)
   - PRs #39-#42: 4 novos posts do blog (silêncio como feature, IA que
     decide, preço na página, cobrança por empresa)
2. Usuário pediu auditoria do PRD MASTER de duplicação (`exaforgestudio`).
3. Auditoria feita em cima do código atual (não da narrativa antiga).
4. Novo PRD colado: **PRD-ZF-ALTERDATA-GOLIVE-01** (salvo em
   `docs/prd/PRD-ZF-ALTERDATA-GOLIVE-01.md` na mesma branch).

## 2. Estado real de cada DUP no código atual

Prioridade herda da matriz do PRD MASTER original. Referências de linha
apontam pro `main` deste commit.

### 🔴 DUP-001 — External Effect Choke-Point (P0)

**Ainda tem dual-path em produção.** 5 services suportam executor
mas mantêm o path antigo atrás de feature flags `DEFAULT 0`:

| Service | Linha da flag | Arquivo |
|---|---|---|
| CollectionCadenceService | 105 | `src/server/CollectionCadenceService.ts` |
| CollectionPromiseService | 265 | `src/server/CollectionPromiseService.ts` |
| CollectionResendPixService | 84 | `src/server/CollectionResendPixService.ts` |
| SalesRecoveryPlaybook | 337 | `src/server/SalesRecoveryPlaybook.ts` |
| ProspectExecutionService | 59 | `src/server/ProspectExecutionService.ts` |

Flags em `organization_settings`:
- `collection_cadence_via_executor_enabled` (db.ts:8413)
- `sales_recovery_via_executor_enabled` (db.ts:8421)
- `prospect_via_executor_enabled` (db.ts:8427)

Padrão do código:
```ts
viaExecutor
  ? sendViaExecutor(...)
  : MessageProviderService.sendMessage(...)  // path antigo
```

**Falta:**
1. Migrar 100% das orgs pra flag=ON (script + backfill).
2. Trocar `DEFAULT 0` pra `DEFAULT 1` nas 3 colunas.
3. Remover branch `viaExecutor ? … : MessageProviderService…` dos 5 services.
4. Remover `import { MessageProviderService }` dos domain services.
5. Adicionar regra ESLint `no-restricted-imports` que impede domain
   services importarem `MessageProviderService`, `AsaasService`,
   `EmailProviderService` diretamente.
6. Fechar item no ledger como `EXECUTION_EXTERNAL_EFFECT_DUAL_PATH`
   → PRODUCTION.

### 🔴 DUP-002 — Canonical Scheduling Kernel (P0/P1)

**`ComigoAgendaService` continua com implementação própria.**
`src/server/ComigoAgendaService.ts:98` — `findConflicts` executa SQL
direto contra `appointments` sem passar por `ClinicAgendaService`.

Outras verticais (Petshop, Beauty, Advocacia, Professional Network) já
usam `ClinicAgendaService.findConflicts()` — só Comigo escapou.

**Falta:**
1. Extrair `SchedulingKernel` de `ClinicAgendaService` com:
   - `checkConflict(orgId, startMs, endMs, resource?)`
   - `createAppointment(orgId, payload)`
   - `cancelAppointment(id)`
   - `completeAppointment(id)`
   - `markNoShow(id)`
   - `availability(orgId, resourceId, window)`
   - `validateResource(orgId, resourceId, when)`
2. Refatorar `ClinicAgendaService` pra ser fachada sobre o kernel.
3. Refatorar `ComigoAgendaService.findConflicts` pra delegar a
   `SchedulingKernel.checkConflict`.
4. Documentar no PRD MASTER que agenda tem 1 owner canônico
   (`SchedulingKernel`) e N fachadas (Clinic, Comigo, Beauty, Legal,
   Professional).

### 🟠 DUP-003 — Entitlement dual source (P1)

**Dívida técnica consciente ainda aberta.**
`src/server/EntitlementService.ts:95` — `FALLBACK_HIDDEN_BY_VERTICAL`
coexiste com `blueprint.hiddenModules`.

Commit original `ba63c933` disse: "duplicação intencional pro período
de transição; pode ser removida quando 100% das orgs estiverem migradas."

**Falta:**
1. Query: `SELECT COUNT(*) FROM organizations WHERE blueprint_vertical
   IS NULL OR blueprint_id IS NULL` — número de orgs ainda usando
   fallback.
2. Migração das remanescentes (backfill do blueprint por vertical).
3. Deletar `FALLBACK_HIDDEN_BY_VERTICAL` e o código do fallback em
   `EntitlementService.ts:142`.
4. Deletar comentário histórico linhas 89-94.
5. Fechar item no ledger como `ENTITLEMENT_VERTICAL_DUAL_SOURCE`
   → PRODUCTION.

### 🟠 DUP-004 — Visual Runtime Fragmentation (P1) — **BLOQUEIA Visual Recipe Engine**

**Nenhum kernel comum existe.** Cada domínio visual tem seu próprio:
- `src/server/FashionTryOnService.ts` — provider próprio, fila própria, hash próprio
- `src/server/BeautyHairSimulationService.ts` — ADR diz "espelha 100% do padrão do Fashion Studio"
- Studio (image generation via Google Imagen com fallback OpenAI —
  commit `9bb77d7`) — provider próprio

**Falta ANTES de implementar `/ProductExplosion` e `/3Dbillboard`:**
1. ADR + PRD `VisualGenerationKernel` (ou `VisualTransformationRuntime`)
   com:
   - Provider Registry
   - Model Router
   - Job Queue compartilhada
   - Input Hash canônico
   - Reference Assets Store
   - Image Storage
   - Safety
   - Fidelity Guard
   - Retry
   - Metering
   - Output Formats
   - Observability
2. Migrar `FashionTryOnService` e `BeautyHairSimulationService` pra
   serem fachadas sobre o kernel.
3. Migrar Studio image gen pra usar Provider Registry do kernel.
4. Só depois implementar receitas visuais (`ProductExplosion`,
   `3Dbillboard`) — como recipes do kernel, não novos motores.

### 🟠 DUP-005 — Signal Reaction Policy (P1)

**Consumidores concorrentes de `business_signals` sem contrato.**
- `src/server/SignalProcessRouterService.ts` — sinal → `process_instance`
- `src/server/MissionProactiveService.ts` — sinal → Mission Proposal

Cada um decide sozinho o que fazer com o sinal. Sem registry central
que declare por `signal_type` quais reações disparam.

**Falta:**
1. Criar `SignalReactionPolicy` (tabela + service) declarando por
   `signal_type`:
   - `inform` | `surface` | `mission` | `process` | `decision_action` | `growth_opportunity`
   - `exclusive` vs `composable`
2. Registrar as políticas atuais como seed:
   - `promise_broken` → process `receivable_collection`, mission=false, CEO surface=true
   - `revenue_below_target` → mission `grow_revenue`, process=false, CEO surface=true
   - `stock_rupture` → process `replenishment`, mission=only_if_systemic
3. `SignalProcessRouter` e `MissionProactive` consultam a policy antes
   de agir.
4. Fechar item no ledger como `SIGNAL_REACTION_OVERLAP` → PRODUCTION.

### 🟡 DUP-006 — Vertical/Competitive/Social (P2) — **JÁ RESOLVIDO no código**

Correção da auditoria anterior.
- `CompetitiveIntelligenceService:35` chama
  `VerticalIntelligenceService.runResearch(..., { providerName: "competitive" })`
- `VerticalSocialIntelligenceService:66` chama
  `VerticalIntelligenceService.getFresh(...)`

É composição correta, não motores paralelos.

**Falta:** só documentar ownership no PRD MASTER — não é código.

### 🟡 DUP-007 — Financial Event Identity (P2)

**Detecção existe, resolução não.**
- `src/server/PnlReconciliationService.ts` detecta overlap e emite
  signal `pnl_reconciliation/overlap_risk` (commit `83cbe864`).
- Nenhum `FinancialEventIdentity` existe.

**Falta:**
1. Criar `FinancialEventIdentity` com chaves canônicas pra reconciliar:
   - PDV ↔ Order ↔ Closing ↔ Payment ↔ Receivable ↔ Gateway
2. Chave de dedupe: `(orgId, source, external_id)` + `(orgId, amount,
   date, customer_hash)` como fallback.
3. `PnlReconciliation` passa a resolver deterministicamente (não só
   avisar).

### ➕ Meta — Canonical Capability Registry

**Não existe no código nem em docs/product-evolution/.**

**Falta:**
1. Adicionar segunda matriz ao `PRD-MASTER-PRODUCT-EVOLUTION-LEDGER`:
   Canonical Capability Registry — cada capability declara
   `canonical_owner`, `allowed_facades`, `forbidden`.
2. Adicionar regra no `CLAUDE.md` do studio:
   > **REGRA — ONE CAPABILITY, ONE CANONICAL OWNER**
   > Nenhum novo PRD pode introduzir um engine, registry, scheduler,
   > queue, provider router, signal ledger, agenda kernel, execution
   > gateway, research broker ou fonte de entitlement sem primeiro
   > provar que não existe capacidade equivalente.
3. Seed inicial do registry:
   - `scheduling.conflict_detection` → owner `SchedulingKernel`
   - `external.whatsapp_send` → owner `CommandExecutor`
   - `market.external_research` → owner `VerticalIntelligenceService`
   - `image.generation` → owner `VisualGenerationKernel` (a criar)
   - `signal.reaction` → owner `SignalReactionPolicy` (a criar)
   - `revenue.identity` → owner `FinancialEventIdentity` (a criar)

## 3. Ordem de execução recomendada quando retomarmos

| # | O que | Por quê |
|---|---|---|
| 1 | **DUP-001** (executor choke-point) | Bloqueia toda governança futura (rate limit, quiet hours, LGPD, audit financeiro) |
| 2 | **DUP-004** (Visual Kernel) | Bloqueia `/ProductExplosion`, `/3Dbillboard`; se implementar antes vira 4º motor |
| 3 | **DUP-002** (Scheduling Kernel) | Cada nova vertical (Comigo, Beauty, Legal) reimplementa conflito |
| 4 | **Meta** (Capability Registry + regra no CLAUDE.md) | Previne DUP-008..N nos próximos PRDs |
| 5 | DUP-005 (SignalReactionPolicy) | Menor blast radius; espera |
| 6 | DUP-003 (Entitlement) | Só remove dívida consciente após migração |
| 7 | DUP-007 (FinancialEventIdentity) | Detecção já existe (só avisa) |
| 8 | DUP-006 | Só documentação |

**E paralelo a tudo isso, o PRD-ZF-ALTERDATA-GOLIVE-01** — bloqueador
de go-live da vertical Toulon, entregue em 8 PRs conforme §10 do PRD.

## 4. Onde estão os arquivos

Nesta branch (`claude/prd-alterdata-golive-and-dup-audit`):
- `docs/prd/PRD-ZF-ALTERDATA-GOLIVE-01.md` — PRD novo colado pelo user
- `docs/product-evolution/SESSION-PAUSA-2026-08-29-DUP-AUDIT.md` — este arquivo

Nada de código foi tocado ainda. Retomamos do zero em qualquer um dos
8 itens da §3.

## 5. Contexto adicional (referências úteis)

- `AlterdataSyncRunner`: `src/server/AlterdataSyncRunner.ts`
- `RetailRevenueBridgeService`: `src/server/RetailRevenueBridgeService.ts`
- `ProductionReadinessService`: `src/server/ProductionReadinessService.ts`
- `MessageProviderService`: `src/server/MessageProviderService.ts` — o
  provider que DUP-001 exige que só `CommandExecutor` chame.
- `EntitlementService`: `src/server/EntitlementService.ts` — DUP-003
- `ClinicAgendaService`: onde extrair o `SchedulingKernel` de DUP-002
- `business_signals` table: espinha central que DUP-005 gerencia
