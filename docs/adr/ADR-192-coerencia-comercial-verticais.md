# ADR-192 — Coerência Comercial de Verticais (escolha no cadastro → tela travada por plano)

**Estado:** **FECHADO — 8 fatias em produção (#1380–#1387).** Aditivo/reversível sobre ADR-091
(grade de planos), ADR-092 (distribuição por vertical) e ADR-153 (vertical entitlements/upgrade).
Sem motor novo — só liga peças que já existiam (`ModuleService.applyVertical`, `EntitlementService`,
`AddonService`, `PLAN_BUNDLES`) ao ponto onde faltavam: o **cadastro** e o **gating de tela**.
**Data:** 2026-08-26.
**Natureza:** correção de coerência de ponta a ponta do ciclo comercial de uma vertical de tela
dedicada (Clínica/Advocacia/Escola/Petshop). Nasceu de um bug report do dono ("as telas das
verticais não aparecem no sidebar") e virou a blindagem de todo o funil: escolher o ramo uma vez,
no cadastro, e o app já nascer sob medida pro plano da vertical assinada — sem acesso livre e sem
armadilhas.

---

## 1. O problema (o que estava incoerente)

O ZapFlow já tinha as peças (ADR-091/092/153): verticais como preset de módulos, planos como teto
(`ModuleService.applyVertical` liga `preset ∩ módulos-do-plano`), gate de rota por módulo
(`MODULE_BY_ROUTE` + `EntitlementService.isModuleAvailable` → 403), add-ons (`AddonService`) e
bundles verticais (`PLAN_BUNDLES`, ex. `growth_clinica`). Mas o ciclo tinha **quatro furos**:

| # | Furo | Sintoma |
| --- | --- | --- |
| F-1 | A vertical só era escolhida no **onboarding** (1º login), não no cadastro; o campo "Segmento" do cadastro era texto-livre jogado fora. | Dono escolhia o ramo **duas vezes**; sem caminho simples pra trocar numa org já criada. |
| F-2 | A tela **Advocacia** era liberada só pela string `vertical === 'advocacia'` (sem gate de módulo/plano); `/api/advocacia/*` fora do `MODULE_BY_ROUTE`. | Qualquer owner/admin trocava o ramo e usava o escritório **de graça**, fora do plano. |
| F-3 | O módulo **`escola`** era gated por rota mas **não estava em nenhum plano nem no catálogo de add-ons**. | A tela de Escola era **inalcançável** por cliente pagante (só cortesia/sem-teto). |
| F-4 | Escolher a vertical no cadastro sem o plano certo deixava o **módulo central desligado** (teto do plano); o bundle não era recomendado nem no cadastro. | Escolhia "Advocacia" + plano genérico → tela não aparecia (armadilha). Petshop (que consome `clinica`) nem era recomendado ao bundle. |

## 2. Decisões (D1–D6)

- **D1 — O plano é o teto, a vertical é o preset.** Trocar/assinar um ramo NUNCA libera módulo fora
  do plano. `applyVertical` já intersecciona `preset ∩ (plano ∪ add-ons ativos)`; toda tela de
  vertical é gated por MÓDULO (`mod('x')` no Sidebar + `MODULE_BY_ROUTE` no servidor), nunca por
  string de vertical. (Fecha F-2.)
- **D2 — Toda tela dedicada é um MÓDULO vendável.** Um módulo route-gated que ninguém pode comprar é
  feature inalcançável. Advocacia e Escola viram módulos de 1ª classe (tier Enterprise + add-on
  Scale, espelhando Clínica). (Fecha F-3.)
- **D3 — A vertical é escolhida no CADASTRO** (seletor de ramo real, público via `/api/verticals`),
  aplica o preset e pula o onboarding; sem vertical válida cai no onboarding antigo (0-regressão).
  Owner/admin também troca o ramo em Configurações (self-service). (Fecha F-1.)
- **D4 — O bundle da vertical é recomendado E ativado no cadastro.** Quando o ramo tem módulo
  central de tier alto, o cadastro sugere o bundle (`verticalHints`) e, ao escolhê-lo, ativa o
  add-on do módulo central (`AddonService.grantForBundle` — a oferta autoriza o add-on fora do
  catálogo do plano-base) → o 1º login já mostra a tela. Petshop entra nos hints do bundle Clínica.
  (Fecha F-4.)
- **D5 — Cobrança real do bundle segue mock/trial** (igual `selectPlan` hoje). A orquestração de
  pagamento é a F5.2 de ADR-153 (`SubscriptionOrchestratorService`), não desta camada.
- **D6 — Invariante codificado como regressão.** `test:module-sellability-coherence` garante que
  todo módulo route-gated é alcançável (tier/add-on/free-addon/core) — teria pego o furo F-3
  sozinho.

## 3. Guardrails / invariantes (RN-CCV-01..06)

1. **Plano é o teto** — mudar o ramo (cadastro ou Configurações) só reorganiza o que a org tem
   direito; nunca libera módulo fora do plano (`applyVertical` filtra; a rota recusa 403).
2. **Tela = módulo** — nenhuma tela de vertical é liberada por `vertical === X` puro; sempre
   `mod(x)` + `MODULE_BY_ROUTE`. (Exceção histórica: Beauty AI = `vertical==='beleza' && mod('estudio')`
   — já exige o módulo estudio, então sem acesso livre.)
3. **Módulo com tela é vendável** — em algum tier OU add-on OU free-addon OU core. Codificado em
   `test:module-sellability-coherence`.
4. **Nunca inventa ramo** — cadastro/troca só aceitam chave do catálogo (`ModuleService.catalog()`);
   inválida → ignorada / cai no onboarding.
5. **Aditivo/reversível/opt-in** — trocar de ramo reaplica o outro preset; desligar preserva dados.
6. **Bundle não inventa preço** — os bundles novos espelham a fórmula documentada do `growth_clinica`
   (Growth 1797 + add-on 3000 = 4797 avulso → 3500/mês, 27% off); preço final ajustável no Master Admin.

## 4. Fatias (PR-a-PR)

| Fatia | PR | Entrega |
| --- | --- | --- |
| CCV-1 | #1380 | Seletor **"Ramo do negócio"** em Configurações → Empresa (troca self-service, owner/admin). Rota `POST /api/analytics/settings/vertical`. `test:vertical-self-switch`. |
| CCV-2 | #1381 | **`EscolaView`** — tela da vertical educacao (Coordenação/Alunos/Professores/Atividades) sobre `/api/escola/*` (ADR-144). Gate `mod('escola')`. `test:escola-view-wiring`. |
| CCV-3 | #1382 | **Advocacia travada por plano** — vira módulo (`MODULE_BY_ROUTE`/preset/tier Enterprise/add-on Scale); Sidebar `mod('advocacia')`. Fecha F-2. `test:advocacia-plan-gated`. |
| CCV-4 | #1383 | **Vertical no cadastro** — `/api/verticals` público + seletor no `LoginView`; `/register` aplica `applyVertical` + pula onboarding. `test:register-vertical`. |
| CCV-5 | #1384 | **Escola vendável** — módulo `escola` no tier Enterprise + add-on Scale. Fecha F-3. `test:escola-plan-gated`. |
| CCV-6 | #1385 | **Bundles** `growth_escola` + `growth_advocacia` (espelham `growth_clinica`). |
| CCV-7 | #1386 | **Petshop** nos `verticalHints` do bundle Clínica (consome o módulo `clinica`) + **guard de coerência** `test:module-sellability-coherence`. |
| CCV-8 | #1387 | **Bundle recomendado e ativado no cadastro** — `AddonService.grantForBundle` + `/register` aceita `bundleKey` (basePlan + add-on do módulo central) + `/api/plans/bundles` público + cartão "🎯 Recomendado" no `LoginView`. Fecha F-4. |

## 5. O ciclo do novo cliente (resultado)

**Cadastro** (dados + **ramo** + **bundle recomendado**) → `/register` aplica plano-base + ativa
add-on do módulo central + `applyVertical` + `onboarding_status='completed'` → **1º login** já cai
no ZapFlow com o menu da vertical ∩ plano, tela dedicada funcionando. Cliente existente troca o ramo
em **Configurações → Empresa**; o bundle recomendado do ramo aparece em **Configurações → Plano e
Expansões** (ADR-153).

## 6. Reuso (o que já existia e foi ligado)

`ModuleService.applyVertical`/`catalog`/`MODULE_BY_ROUTE`/`isEnabled` · `EntitlementService.isModuleAvailable`
(reason `plan_ceiling`/`hidden_by_vertical`) · `PlanService.modulesForPlan` (une add-ons ativos) ·
`AddonService` (`ADDON_CATALOG`, `contract`, novo `grantForBundle`) · `PLAN_GRADE`/`PLAN_BUNDLES`
(ADR-153) · `verticals.ts` (`OPTIONAL_MODULES`/`ADDON_MODULES`/presets) · `LoginView`/`OnboardingView`/
`SettingsView` (que já recomendava bundles por vertical, `recommendedBundles`).

## 7. Diferidos

- **Checkout real do bundle** (cobrança agregada via ASAAS) — F5.2 de ADR-153
  (`SubscriptionOrchestratorService`). Hoje mock/trial.
- **Bundle "Growth + Petshop"** dedicado (hoje petshop usa o hint do bundle Clínica) — decisão
  comercial do dono se quiser preço/nome próprios.

## 8. Testes

`test:vertical-self-switch` (13) · `test:escola-view-wiring` (16) · `test:advocacia-plan-gated` (15) ·
`test:register-vertical` (25) · `test:escola-plan-gated` (12) · `test:plan-bundles` (69) ·
`test:module-sellability-coherence` (9). Regressão coberta: `entitlement-service`, `plans-migration`,
`addons`, `plan-fit-detector`, `blueprint-seeder`, `adaptive-onboarding`, `advocacia-*`.
