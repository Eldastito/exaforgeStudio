# ADR-187 — Prontidão Fiscal (Reforma Tributária): a camada de leitura pro operador

**Estado:** **F0 MERGEADA (PR #1301)** · **F1 EM PR** — `FiscalReadinessService.assess` + timeline.
Plano F0–F4.
**Data:** 2026-08-24.
**Contexto:** camada OPERADOR-FACING que faltava sobre a ADR-181 (FECHADA — motores CBS/IBS/IS +
perfil fiscal + base curada + emissão-scaffold). A ADR-181 já cogitou um "aviso de perfil fiscal
incompleto p/ 2027" mas nunca implementou a agregação. Aditivo/reversível. Convenções: isolamento
multi-tenant, RN-004 (derivado por query), `business_signals` (nunca tabela de alerta paralela),
determinístico, **nunca inventa alíquota/regra nem presume regime** (herda os guardrails RN-FISCAL).

---

## 1. O problema (o que a auditoria PROVOU)

A ADR-181 entregou os MOTORES e são honestos, mas o operador não tem UMA superfície que responda
"estou pronto pra Reforma?". Hoje a prontidão está espalhada em facetas separadas:

- **Identidade** — `FiscalProfileService.completeness` (`:125`) já diz o que falta (`cnpj`, `regime`,
  `municipalityIbge`, `uf`); exposto só via `GET /api/fiscal/profile`.
- **Base de referência** — `TaxReferenceService.status`/`rateFor` (`:144`/`:122`): a base curada
  **nasce vazia**, é date-effective, e `rateFor` devolve `null` honesto sem alíquota vigente. Mas
  `status` é **master-only** — o operador não vê se a alíquota do SEU período está curada.
- **Decisão de regime** — `SimplesHybridAdvisorService.advise` (`:49`): a decisão DAS × híbrido
  (a partir de 2027) é aconselhada, nunca decidida.
- **Emissão** — `FiscalIssuanceService.status` (`:52`): scaffold honesto (`awaiting_homologation`),
  nunca finge emitir.

**Nenhum endpoint agrega isso numa prontidão** (grep `prontid`/`readiness` no server → zero fiscal).
O dono não sabe, num lugar só, o que depende DELE, o que depende da PLATAFORMA (curadoria) e o que
depende do SENADO (a alíquota cheia de 2027, **não definida** até a resolução de dez/2026).

## 2. Tese e escopo

Uma camada de LEITURA que agrega as facetas num read-model de **prontidão** + uma **linha do tempo**
factual da Reforma, separando com honestidade três origens de pendência: **(a) do tenant** (perfil
incompleto, regime não declarado — o que ele controla e conta pro `readyPct`), **(b) da plataforma**
(alíquota do período ainda não curada na base), **(c) do Senado** (alíquota cheia de 2027 — não
existe ainda; NUNCA vira lacuna do tenant nem alíquota inventada). Um sinal proativo quando o tenant
está materialmente despronto perto da virada. Uma tela pro operador. **Reusa** os motores ADR-181;
nenhuma regra/alíquota nova.

**Fora de escopo (agora):** hard-code de alíquota (a base curada é a fonte — RN-FISCAL-1); decidir
regime pelo dono (RN-FISCAL-9); emissão real (scaffold ADR-181, depende de homologação de 3º);
mutar o DRE/cálculo (só leitura).

## 3. Guardrails RN-FR (duros — no header dos services + testados)

1. **Nunca inventa alíquota/regra.** Base não curada pro período → "aguardando" (herda
   `rateFor→null`); a alíquota cheia de 2027 fica rotulada "depende do Senado (dez/2026)", nunca
   estimada.
2. **Nunca presume regime.** Regime não declarado → lacuna explícita do tenant (herda RN-FISCAL-4).
3. **Prontidão DERIVADA (RN-004).** Reusa `completeness`/`status`/`rateFor`; não é flag mutável.
4. **Três origens separadas.** Pendência do tenant × da plataforma × do Senado — nunca confundidas;
   só a do tenant conta pro `readyPct`.
5. **Advisory.** O sinal nunca bloqueia operação nem cria `decision_action`; nunca decide regime.
6. **Isolamento por org; determinístico; honesto** (sem dado → lacuna/`awaiting` explícito).
7. **Reusa os motores ADR-181** — sem 2º motor fiscal, sem alíquota hard-coded.

## 4. Reuso vs. novo

- **Reusar:** `FiscalProfileService.completeness`/`get`, `TaxReferenceService.rateFor`/`status`,
  `ConsumptionTaxService` (degradação honesta), `SimplesHybridAdvisorService.advise`,
  `FiscalIssuanceService.status`, `business_signals`+`resolveByDedupe`/`reopenByDedupe`, o painel
  `FiscalProfilePanel` (surfacar a prontidão ao lado do perfil).
- **Criar (aditivo, mínimo):** `FiscalReadinessService` (read-model agregado + linha do tempo) + um
  sinal advisory + um card de prontidão na UI.

## 5. Plano por fatias (fatia = 1 PR draft, com teste/rollback)

- **F0 — auditoria + ADR (ESTA, doc-only).**
- **F1 — `FiscalReadinessService.assess(orgId, {asOf?})` + linha do tempo (EM PR).** Read-model:
  `{ readyPct, tenantBlockers[], tenantWarnings[], dimensions:{ identity, referenceBase, regime,
  issuance }, externalPending:{ platform[], senate[] }, timeline:[{ when, label, defined, dependsOn }],
  note }`. `identity` reusa `completeness` (blocker se incompleto); `referenceBase` chama `rateFor`
  pros tributos do período corrente (curado × `awaiting_curation` — pendência de PLATAFORMA, não do
  tenant); `regime` = declarado? + decisão Simples pendente (warning); `issuance` = estado do
  scaffold (informativo). `readyPct` = só o que o tenant controla (RN-FR-4). `timeline` factual da
  lei, com `defined:false`+`dependsOn:'senate'` na alíquota cheia de 2027 (RN-FR-1); `senate` pending
  SEMPRE (nunca gap do tenant); regime nunca presumido. Rota `GET /api/fiscal/readiness` (owner/admin).
  `test:fiscal-readiness` (15); `test:fiscal-profile`/`test:tax-reference` sem regressão.
- **F2 — Sinal proativo de prontidão.** `FiscalReadinessService.publishReadinessSignal` — quando o
  tenant tem BLOCKER (perfil incompleto / regime não declarado), publica `business_signals`
  (`fiscal_readiness/incomplete`, `basis:hypothesis`, `impactAmount:null`, severity attention) pro
  dono completar; nunca bloqueia nem decide (RN-FR-5, zero `decision_action`). Self-healing;
  `pass()` no Scheduler. `test:fiscal-readiness-signal`.
- **F3 — UI: card "Prontidão fiscal".** No `FiscalProfilePanel`, um card que mostra `readyPct` +
  blockers/warnings + a linha do tempo (com o rótulo honesto "depende do Senado" em 2027).
  UI-only sobre a rota F1; tsc+build verdes.
- **F4 — Hardening + runbook (FECHA o ADR-187).** `test:fiscal-readiness-hardening` codifica RN-FR-1..7
  + fiação + runbook `docs/runbook/prontidao-fiscal-operacao.md`.

**Critério de sucesso:** o operador vê, num lugar só, quão pronto está pra Reforma — o que depende
DELE (e conta pro score), o que depende da plataforma/Senado (rotulado, nunca inventado) e o que
muda quando; um nudge proativo quando falta o essencial; nunca inventa alíquota nem decide regime.
