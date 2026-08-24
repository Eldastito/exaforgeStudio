# Runbook — Prontidão Fiscal (Reforma Tributária) (ADR-187)

A camada de LEITURA pro operador ver, num lugar só, quão pronto está pra Reforma (CBS/IBS/IS) — o
que depende DELE, o que depende da PLATAFORMA (curadoria da alíquota) e o que depende do SENADO (a
alíquota cheia de 2027, ainda não definida). Aditivo/reversível sobre a ADR-181 (motores fiscais).
Convenções: isolamento multi-tenant, RN-004 (derivado por query), `business_signals` (nunca tabela
de alerta paralela), determinístico, **nunca inventa alíquota/regra nem presume regime**.

---

## 1. O que resolve

A ADR-181 entregou os MOTORES (perfil fiscal, base curada de alíquotas, advisor Simples, emissão-
scaffold) e são honestos, mas a prontidão ficava ESPALHADA em facetas separadas. Nenhum endpoint
respondia "estou pronto pra Reforma?". O ADR-187 AGREGA as facetas num read-model + uma linha do
tempo factual, **separando três origens de pendência** e nudge proativo quando falta o essencial.

## 2. Mapa dos serviços / pontos de código

| Peça | Onde | Papel |
| --- | --- | --- |
| `FiscalReadinessService.assess` | `src/server/FiscalReadinessService.ts` | **F1** — read-model agregado (`readyPct` + `tenantBlockers`/`tenantWarnings` + `dimensions` + `externalPending` + `timeline`). Reusa `FiscalProfileService.completeness`, `TaxReferenceService.rateFor`, `FiscalIssuanceService.status`. |
| `FiscalReadinessService.publishReadinessSignal` / `pass` | `FiscalReadinessService.ts` | **F2** — sinal advisory quando o tenant tem BLOCKER de identidade; `pass()` no Scheduler só pras orgs FORMALIZADAS (com CNPJ). |
| `GET /api/fiscal/readiness` | `src/server/routes/fiscal.ts` | **F1** — expõe o `assess` (owner/admin; aceita `?asOf`). |
| Card "Prontidão fiscal" | `src/features/settings/FiscalProfilePanel.tsx` | **F3** — barra do `readyPct` + "Depende de você" × "Não depende de você" + linha do tempo (rótulo honesto "depende do Senado" em 2027). |

## 3. Os números (o que significam)

- **`readyPct`** = SÓ o que o TENANT controla (completude da identidade fiscal: CNPJ, regime, IBGE,
  UF). Plataforma/Senado **não descontam** do score (RN-FR-4).
- **`tenantBlockers`** = o que o dono precisa preencher (perfil incompleto). Conta pro score.
- **`tenantWarnings`** = decisão pendente (ex.: Simples escolher DAS × regime regular a partir de
  2027). Não bloqueia.
- **`dimensions.referenceBase.tributes`** = `covered` (alíquota do período curada) × `awaiting_curation`
  (base ainda vazia — pendência de PLATAFORMA, não do tenant; herda `rateFor→null`).
- **`externalPending.senate`** = a alíquota CHEIA da CBS de 2027 depende de resolução do Senado
  (prevista p/ dez/2026) — **nunca estimada, nunca gap do tenant**.
- **`timeline`** = factual da lei; a entrada de 2027 é `defined:false` + `dependsOn:'senate'`.

## 4. O sinal (advisory)

`fiscal_readiness/incomplete` (`business_signals`, dedupe `fiscal_readiness:incomplete`) — publicado
quando o tenant tem BLOCKER de identidade. `basis:hypothesis`, `impactAmount:null`, severity
`attention`. **Nunca** cria `decision_action`, nunca decide regime, nunca sinaliza pendência de
plataforma/Senado (não é do tenant). Self-healing: completou → `resolveByDedupe`; recorre →
`reopenByDedupe` (respeita `dismissed` humano §65). `pass()` horário só pras orgs com CNPJ.

## 5. Guardrails RN-FR (testados em `test:fiscal-readiness-hardening`)

1. **Nunca inventa alíquota/regra** — base não curada → `awaiting_curation`; a cheia de 2027 fica
   "depende do Senado — ainda não definido", nunca estimada.
2. **Nunca presume regime** — regime não declarado → lacuna explícita do tenant.
3. **Prontidão DERIVADA (RN-004)** — reusa `completeness`; não é flag mutável; determinística.
4. **Três origens separadas** — tenant × plataforma × Senado; só a do tenant conta pro `readyPct`.
5. **Advisory** — o sinal nunca bloqueia nem cria `decision_action`; `assess` é read-only (não grava
   regime).
6. **Isolamento por org; determinístico; honesto** (sem dado → lacuna/`awaiting` explícito).
7. **Reusa os motores ADR-181** — sem 2º motor fiscal, sem alíquota hard-coded.

## 6. Troubleshooting

| Sintoma | Causa provável | Ação |
| --- | --- | --- |
| `readyPct` travado abaixo de 100% | perfil fiscal incompleto (falta regime/IBGE/UF) | Preencher em Configurações → Perfil Fiscal; o card reflete na hora. |
| Tributo `awaiting_curation` | alíquota do período ainda não curada na plataforma | Pendência de PLATAFORMA (master carrega a base) — não é do tenant; não conta pro score. |
| Senado sempre pendente | a alíquota cheia de 2027 não existe até a resolução (dez/2026) | Esperado (RN-FR-1) — nunca vira gap do tenant nem número inventado. |
| Sinal `incomplete` não some após preencher | perfil ainda tem campo faltando | Conferir `completeness.missing`; o sinal resolve quando `tenantBlockers` zera. |

## 7. Track futuro (documentado)

- **Curadoria da alíquota do período** — quando o master publicar a base (`TaxReferenceService.curate`),
  os tributos viram `covered` e a pendência de plataforma some sozinha.
- **Alíquota cheia de 2027** — quando o Senado fixar (resolução dez/2026) e a base for curada, a
  entrada `defined:false` da timeline pode virar `defined:true` (mudança de dado, não de motor).

## 8. Testes

- `test:fiscal-readiness` (F1 — read-model + linha do tempo) ·
  `test:fiscal-readiness-signal` (F2 — sinal advisory + self-healing + `pass`) ·
  `test:fiscal-readiness-hardening` (F4 — RN-FR-1..7 + fiação de produção).
