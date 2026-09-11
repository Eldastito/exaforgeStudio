# Análise Fase 0 — PRD "Evolução de Marca e Comunicação do ZapFlow" (8 PRDs) × Codebase

**Fonte:** `docs/prd/PRD-BRAND-EVOLUTION-8prds.md` (roadmap de 8 PRDs: Brand Core → Verbal → Comercial → IDO → Valor → UX → Vertical → Brand Intelligence).
**Objetivo deste doc:** o próprio PRD 01 exige uma **Fase 0 (auditoria do codebase antes de codar)** e um **gate de aprovação por PRD**. Isto é essa Fase 0 — o Reuse Map + as ponderações críticas — para decidir o que construir, o que já existe e o que reclassificar, ANTES de qualquer código.

> Regra da casa aplicada: RE→EXTEND→COMPOR→MIGRAR→CRIAR (criar é último recurso); "uma capacidade, um dono canônico"; aditivo/reversível; não quebrar o que funciona; não duplicar.

---

## 0. A ponderação que muda tudo — descasamento de arquitetura

O PRD está escrito num **idioma de arquitetura que não é o do ZapFlow**. Ele assume Postgres + Supabase:

| PRD assume | ZapFlow real |
| --- | --- |
| **RLS** ("proteção no banco", "não confiar no frontend") | **SQLite (`better-sqlite3`)** — isolamento por **filtro `organization_id` em service** + `requireRole`/`requireMasterAdmin` na rota (convenção nº 1). Não há RLS. |
| "Supabase/functions", "server actions" | **Express** (`src/server/routes/*.ts`), services `static` com `orgId` 1º arg |
| "RLS validado", "RLS alterado" | traduz para: **teste de isolamento multi-tenant** + gate de rota master-only |
| JSONB/`configuration store` versionado | `organization_settings` (por-org, colunas + JSON) · `platform_settings` (GLOBAL, sem `organization_id`) · snapshot canônico versionado (padrão `brand_dna_versions`, ADR-168) |

**Consequência prática:** todo "RLS obrigatório" do PRD deve ser lido como **"escopo GLOBAL em `platform_settings` + rota `requireMasterAdmin` + teste que prova que tenant não lê/escreve"**. Nenhuma linha de RLS/Supabase deve ser criada — seria arquitetura paralela.

---

## 1. Reuse Map por PRD (RE=reutilizar · EXT=estender · COMP=compor · CRIAR)

| PRD | Tema | Já existe no repo? | Veredito |
| --- | --- | --- | --- |
| **01** | **Brand Core (marca INSTITUCIONAL do ZapFlow)** | **NÃO** existe marca da plataforma. Mas o *padrão* existe: `BrandDnaService` (versionamento+snapshot+restore+`completeness`), `platform_settings` (escopo GLOBAL sem org), `AdminMasterView`+`requireMasterAdmin` (admin+RBAC), `auditLog`/`logAuthEvent` (auditoria). | **CRIAR mínimo COMPONDO padrões provados.** É a única fundação genuinamente nova — mas pequena e aditiva (escopo plataforma, não toca tenant). |
| **02** | Identidade verbal (message house: pitches/tom/vocabulário/claims proibidos) | Parcial: `BrandDnaService` (tone/voice/`forbidden`/do-don't) e `GrimoireService` (voz) existem **por-tenant**. Message house **da plataforma** não existe. | **EXTEND o Brand Core (PRD 01)** com campos de mensagem. Não criar store novo. |
| **03** | Comunicação comercial (landing/apresentações/propostas) | Landing existe (`test:falatu-landing`, checkout). É majoritariamente **conteúdo de marketing**, não motor. | **EXTEND conteúdo (feature-flag/progressivo).** Consome PRD 01/02. Baixo risco técnico, alto risco de copy. |
| **04** | **IDO — Índice de Dependência Operacional** | Índice "de dependência" NÃO existe. Mas **`SurvivalIndexService`** (placar 0-100 ponderado, `faixa`, `confidence`, `components` com pesos, snapshots históricos) e **`RecoveryViabilityService`** (IRF, fórmula determinística documentada) são **exatamente o padrão** de índice versionado com histórico. | **CRIAR o índice, mas ESPELHANDO o `SurvivalIndexService`** (reusar máquina de score/snapshot/faixa/confidence). Questionário é novo. NÃO criar motor de score paralelo. |
| **05** | **Value Ledger (demonstração de valor)** | **LARGAMENTE JÁ EXISTE.** `UnifiedImpactLedgerService` + `action_outcomes` (+`OutcomeMeasurementService`) + `cash_events` + `business_signals` + **Outcome Assurance (ADR-165)** já fazem valor MEDIDO/estimado com `basis` (fact/estimate/influenced, nunca soma bases), `provenValue`, e a regra "nunca inventa dinheiro". | **ALREADY_DONE em ~80%.** O `ValueEvent` do PRD ≈ `action_outcomes`+`cash_events`+`basis`. Falta só a **superfície de dashboard "valor gerado este mês"** + categoria `timeSaved`. **EXTEND**, jamais 2º ledger (§ "não criar métrica paralela"). |
| **06** | Brand Experience no produto (microcopy/empty states/humanState) | **JÁ EXISTE (ADR-163):** `UxPresentationService` (Decision Card + `humanState`/`humanError`), `FalaTuHomeService` ("Hoje" por exceção), `ExecutionResultsService`. | **EXTEND** `UxPresentationService` p/ ler tom do Brand Core. Núcleo já pronto. |
| **07** | Comunicação por vertical | `verticals.ts` (presets por vertical) + `docs/ux/ADR-163-F1-information-architecture.md` existem. "VerticalBrandProfile" (dores/outcomes/terminologia/objeções/messaging) como camada de *marca* é parcial. | **EXTEND** `verticals.ts` + Brand Core. Vertical **herda**, nunca redefine a essência. |
| **08** | **Brand Intelligence p/ CLIENTES + Brand Guardian** | **LARGAMENTE JÁ CONSTRUÍDO (ADR-168):** `BrandDnaService` (marca do tenant: persona/audience/positioning/`forbidden`/do-don't/versionamento), `StudioService.suggestCaption` consome o DNA, `HookIntelligenceService`/`ScriptIntelligenceService`/`ChannelAdaptationService` aplicam a marca e **filtram termo proibido (RN-CG-04)**, `GrimoireService` (voz). | **~70% ALREADY_DONE.** O **Brand Guardian** (checagem de coerência/risco PRÉ-publicação, "explica e sugere alternativa, não bloqueia") é o incremento real — **EXTEND** o filtro de proibições + o publishing governado (F11 do PRD 10). **NUNCA** 2º RAG / 2º motor de contexto de marca (o próprio PRD proíbe). |

---

## 2. Ponderações críticas (parceiro de debate, não "sim senhor")

1. **A ordem do PRD (01→08) está tecnicamente invertida no fim.** O PRD coloca Brand Intelligence (08) por último com uma razão *de negócio* ("validar nossa marca antes de automatizar a do cliente"). Mas no repo, **08 é o MAIS pronto** (Brand DNA do tenant + Estúdio + variantes/hook/roteiro já aplicam marca) e **01 é o MENOS pronto** (marca institucional não existe). Reconstruir 08 do zero seria duplicação pura (viola o próprio §768 do PRD). **Recomendo tratar 08 como "auditar+estender o que já há (Brand Guardian)", não greenfield.**

2. **PRD 05 é quase um falso-novo.** Pedir um "Value Ledger" novo colidiria de frente com `UnifiedImpactLedgerService`+`action_outcomes`+Outcome Assurance. O valor real da fatia 05 é **1 superfície (dashboard "R$ gerado")**, não um ledger. Construir ledger novo seria o erro que o PRD diz querer evitar.

3. **O que é genuinamente novo e vale:** **PRD 01 (Brand Core institucional)** e **PRD 04 (IDO)**. Os dois são aditivos, escopo isolado (01 = plataforma/master-only; 04 = por-org com questionário), e reusam padrões provados (BrandDna-versioning; SurvivalIndex-scoring). O resto é copy/superfície (02/03/06/07) ou já-feito (05/08).

4. **Risco de "documento de marketing virar spec de engenharia".** Muitos itens do PRD (hero copy, pitches, claims) são **conteúdo**, não código. O código só precisa de: (a) um lugar versionado master-only para guardar isso (Brand Core), (b) um resolver de leitura, (c) consumidores que optam por ler. Não confundir "escrever a copy" (decisão humana/sua) com "construir a fundação" (engenharia).

5. **`FEATURE_ORG_GROUPS` / flags:** o PRD pede feature flag. O padrão do repo é flag opt-in em `organization_settings` (por-org) ou env var (`FEATURE_ORG_GROUPS`). Para Brand Core (global/master-only), o gate natural é **rota `requireMasterAdmin`** — não precisa de flag nova (o próprio PRD §45 diz "não construir sistema de flags só pra isto").

6. **Seed sem auto-publish (§43) casa com a casa:** criar V1 como DRAFT e exigir publish manual espelha o padrão "IA sugere, humano decide" + "seed não liga flag". Bom alinhamento.

---

## 3. Recomendação de sequência (revisada para o repo real)

| Ordem sugerida | Fatia | Por quê | Esforço |
| --- | --- | --- | --- |
| **1** | **PRD 01 — Brand Core institucional** | Fundação real e ausente; pequena; aditiva; master-only; compõe padrões provados. | Baixo-médio |
| 2 | PRD 02 — campos de mensagem NO Brand Core | Estende 01 (mesmo store), não novo. | Baixo |
| 3 | PRD 04 — IDO | Novo e com valor comercial; espelha SurvivalIndex. | Médio |
| 4 | PRD 05 — **só o dashboard de valor** | Reusa UnifiedImpactLedger; não recria ledger. | Baixo |
| 5 | PRD 06 — tom do Brand Core no UxPresentation | Estende ADR-163. | Baixo |
| 6 | PRD 07 — vertical herda Brand Core | Estende verticals.ts. | Baixo |
| 7 | PRD 08 — **Brand Guardian** (só o gap) | Estende filtro de proibições + publishing governado; NÃO recria Brand DNA/RAG. | Médio |
| — | PRD 03 — copy comercial | Conteúdo, decisão humana; feature-flag progressivo. | Copy |

**Gate mantido:** cada fatia = 1 PR draft → CI verde → sua validação → próxima (exatamente o que o PRD pede em §63).

---

## 4. Guardrails herdados (não regredir) aplicáveis a todas as fatias

Isolamento por `organization_id` (ou escopo GLOBAL master-only p/ Brand Core institucional) · CREATE-then-ALTER estrito em `db.ts` · versionamento/snapshot canônico (padrão `brand_dna_versions`) · auditoria via `logAuthEvent`/`auditLog` · nunca inventa (dado ausente → null/`not_configured`, jamais placeholder) · nunca inventa dinheiro (basis fact/estimate; PRD 05) · aditivo/reversível · não duplicar (sem 2º Brand DNA, 2º ledger, 2º RAG, 2º motor de score) · IA sugere / humano publica.

---

## 5. Estado (a atualizar conforme fatias forem entregues)

- [x] Fase 0 — auditoria + Reuse Map (este doc)
- [ ] PRD 01 — Brand Core institucional (aguardando gate/aprovação do dono)
- [ ] PRD 02..08 — conforme sequência revisada acima
