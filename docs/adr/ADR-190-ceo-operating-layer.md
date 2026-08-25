# ADR-190 — CEO Operating Layer (Executive Business Operating System)

**Estado:** **F0–F9 FECHADAS** (#1341–#1350) + **F10 (golden path) EM PR.** Camada
TRANSVERSAL de gestão executiva — composição sobre o que já existe, sem motores paralelos.
**Data:** 2026-08-25.
**Natureza:** aditiva, composicional, governada, orientada por exceção. **Não** é dashboard/BI novo.
Convenções herdadas: isolamento por org, RN-004 (derivado por query), `business_signals` (nunca alerta
paralelo), determinístico antes de LLM, nunca inventa dado (`null`/`unknown` ≠ 0), aditivo/reversível.

---

## 1. Contexto (o que a auditoria F0 provou)

`docs/prd/ANALISE-CEO-OPERATING-LAYER-vs-CODEBASE.md` mapeou o PRD contra o repo (3 auditorias
paralelas). Veredito: **~90% composição**. O código genuinamente novo cabe em ~4 primitivas. O PRD
superestima dois pontos que já existem:

- **Financeiro** é o braço MAIS consolidado (não o menos — §30 do PRD desatualizado): receita
  (`PnlReconciliationService`), custo (`PnlCostReconciliationService`+`payables`/`cost_centers`), margem
  (`ManagerialDreService`/`ConsolidatedResultService`), **caixa real** (`FinancialLedgerService.cashOnHand`),
  vencido (`overdueReceivables`), break-even (`ResultProjectionService`), e `FinanceSnapshotAdapter` já
  rotula `basis`/`scope`.
- **Priorização** já existe: `ImpactPrioritizationService.prioritize` (≤3 global + ≤3/domínio, L0–L4).

## 2. Decisões arquiteturais (D1–D9)

- **D1** — Executive Snapshot é serviço FINO read-only (§14), compõe `BusinessSnapshotV2Service.read`
  (por domínio) → mapeia a 3 pilares; cacheia via `EvidencePackageService`; nunca persiste o derivado.
- **D2** — PILAR é um MAPA determinístico `domain→pillar`, não motor.
- **D3** — Métricas ESTENDEM `BusinessGoalService.METRICS` (§9/§62) com `pillar`/`basis`/`availability`/
  `source`/`betterDirection`; **sem** `ExecutiveMetricRegistry` paralelo.
- **D4** — Exceção e prioridade REUSAM `BusinessSignalService.attention` + `ImpactPrioritizationService`
  (só projetam pra moldura executiva). Zero tabela de alerta nova.
- **D5** — Financeiro é composição sobre `FinanceSnapshotAdapter` + `default_rate` novo.
- **D6** — Visão = 3 colunas aditivas em `organization_settings` (sem tabela nova).
- **D7** — Fala Tu: a intent de negócio (roteada por `AIOrchestratorService`/`ExecutiveAdvisorService`)
  passa a consumir o Executive Snapshot determinístico (IA narra, não calcula — §43).
- **D8** — `null`/`unknown` de verdade (§8/§10/§31): sem fonte → `availability:'unavailable'` + `value:null`.
- **D9** — Key-person dependency (§38) DEFERIDA (shadow), fora do caminho crítico do North Star.

## 3. Guardrails RN-CEO-01..15

Composição não motor · null≠zero · fato≠hipótese · IA não calcula KPI · executado≠resultado ·
sugerir≠criar (meta/missão) · governança intacta · isolamento · dinheiro role-gated · sem fonte→unknown ·
sem sinal/executor/mission/learning paralelo. Codificados como regressão no hardening (F11).

## 4. Plano de fatias (18 do PRD → 11)

F0 auditoria (FECHADA) · **F1 Executive Metric Registry (EM PR)** · F2 métricas faltantes honestas ·
F3 Business Vision (FECHADA) · F4 `ExecutiveBusinessSnapshotService` (FECHADA) · F5 exceções+constraint (FECHADA) · F6 Mission Bridge (FECHADA) · F7 financeiro executivo (FECHADA) · F8 briefing (FECHADA) · F9 Fala Tu + bloco "Hoje" (FECHADA) · **F10 golden path (EM PR)** ·
F7 financeiro executivo · F8 briefing · F9 Fala Tu intents + bloco "Hoje" · F10 golden path ·
F11 hardening+runbook. **Diferidas:** key-person dependency · briefing proativo · evidence-UI.

Defaults honestos adotados (dono delegou): `new_customers` = 1ª compra em `orders`; `default_rate` =
vencido ÷ total a receber; `churn_rate` = `unknown` + `cancellations` por tipo; visão = 3 colunas em
`organization_settings`; NPS = `unknown` (só há CSAT).

## 14. F10 — Golden path (esta fatia)

`test:ceo-golden-path` (20) prova o North Star (§4) PONTA-A-PONTA compondo os serviços
REAIS F1–F9 (nada novo): o dono pergunta *"Como está minha empresa?"* e a cadeia responde
para um cenário de clínica (meta de receita atrasada + desvio financeiro crítico + recebível
vencido): snapshot 3 pilares com financeiro CRÍTICO + visão (F4) → pior pilar + restrição
HIPÓTESE que ameaça a meta (F5) → missão SUGERIDA (nunca criada) pra recuperar a receita (F6)
→ financeiro rico com inadimplência 40% real (F7) → Diretor NARRA a Visão Executiva (F8) →
"Hoje" por exceção (F9). Guardrails ponta-a-ponta: dinheiro role-gated (redação), null≠zero
(cash sem fonte), sugerir≠criar (0 missões escritas), isolamento multi-tenant. 0-regressão.

## 13. F9 — Fala Tu intents + bloco "Hoje" (esta fatia)

Duas superfícies do Fala Tu passam a responder *"Como está minha empresa?"*: (1) a
INTENT de negócio (via `/ask` do Diretor) já é atendida pela F8 — o mesmo panorama
carrega a Visão Executiva; (2) o bloco **"Hoje"** (`FalaTuHomeService.home`) ganha
`executiveToday` — leitura executiva por EXCEÇÃO (§115/ADR-163 — invisible UX, SEM menu
novo): pior pilar + restrição nº1 (hipótese) + saúde dos 3 pilares + linha humana. COMPÕE
a F5 (`ExecutiveConstraintService.assess`, que já compõe o snapshot F4) — sem motor, sem
tabela, sem rota nova. Role-scoped (§73/RN-CEO-13): só quem tem **visão completa** do negócio
recebe (com dinheiro); vendedor → `null`. Honesto: sem desvio → `worstPillar`/`constraint`
null + linha calma ("Tudo sob controle nos 3 pilares"). Import estático com uso em tempo de
CHAMADA quebra o ciclo com o snapshot (padrão convenção nº 11). `test:executive-today-block`
(9); 0-regressão verificada (`test:falatu-home`/`falatu-home-today`/`mission-home` verdes).

## 12. F8 — Briefing executivo (esta fatia)

O Diretor IA (`ExecutiveAdvisorService`, rotas `/briefing` e `/ask` que JÁ EXISTEM)
passa a CONSUMIR a inteligência executiva (D7): `executiveBlock` injeta no panorama
o Executive Snapshot (F4) + a restrição (F5) como TEXTO DETERMINÍSTICO — 3 pilares
com saúde + indicadores, o pilar em pior forma e a restrição nº1 (rotulada HIPÓTESE).
A IA passa a NARRAR pilares/desvios/constraint, mas os NÚMEROS já vêm derivados daqui
(RN-CEO-04: a IA nunca calcula KPI — §43). Honesto: indicador sem fonte NÃO entra (não
vira 0); restrição só quando existe (não inventa). Mudança MÍNIMA e aditiva — só compõe
mais um bloco no `buildPanorama` (reuso das rotas/serviço existentes; sem rota nova, sem
tabela). O bloco herda a audiência da superfície do Diretor que já existe; a garantia de
dinheiro role-gated vale nas rotas executivas dedicadas (snapshot/finance/constraint).
`test:executive-briefing-block` (10 — o construtor determinístico, sem LLM). 0-regressão.

## 11. F7 — Executive Finance (esta fatia)

O pilar financeiro RICO projetado na moldura executiva: **liquidez** (caixa `fact` +
sobrevivência + 1ª ruptura `estimate`), **recebíveis** (a receber + vencido + `overdueCount`
+ inadimplência `default_rate` %), **rentabilidade** (margem + resultado CORE e CONSOLIDADO
com `scope` explícito + `unknownCostRisk`), **retiradas**. É COMPOSIÇÃO PURA sobre o
`FinanceSnapshotAdapter` (que já deriva tudo e rotula `basis`/`scope`/`source`) +
`default_rate` (F2). Confirma o achado F0: o financeiro é o braço MAIS consolidado (§30 do
PRD desatualizado) — F7 não recalcula nada, não persiste, zero tabela nova. Honestidade
(RN-CEO-08/11): `basis`/`scope` fluem intactos (caixa `fact`, previsão/DRE `estimate`);
bloco sem fonte → `available:false`/`null`, nunca 0; `caveats[]` carrega as notas de escopo
do adapter (core × all_channels nunca somados; custo desconhecido → margem não afirmável).
Dinheiro role-gated (§73): `includeMoney:false` redige os valores BRL, PRESERVA
%/contagens/dias (não são dinheiro). Rota `GET /api/executive/finance` owner/admin.
`test:executive-finance` (16). 0-regressão.

## 10. F6 — Executive → Mission Bridge (esta fatia)

Liga a camada executiva (desvios priorizados, F4/F5) às MISSÕES (ADR-189):
`ExecutiveMissionBridgeService.suggest` — de um desvio que AMEAÇA UMA META declarada
(`affectedGoal` do scoring), devolve o RASCUNHO da missão que a endereça (mesmo shape
que `MissionService.create` aceita). **SUGERIR ≠ CRIAR** (RN-CEO-06/§5): READ-ONLY,
nunca cria — o dono confirma pela UI de missões que já existe. **Não inventa objetivo**
(RN-CEO-11): `targetMetric`/`targetValue` vêm da META REAL; desvio sem meta mapeável →
sugestão SEM rascunho (`draft:null`), não fabrica alvo. `source:'system_proposed'`
(origem válida em `MISSION_SOURCES` — o dono cria direto). Missão VIVA (status não-terminal)
pra aquela métrica → `alreadyCovered` (não duplica). `basis:'hypothesis'` (a missão é a
aposta, não causa provada). Reusa `MissionService`/`ImpactPrioritizationService`/
`BusinessGoalService` — sem motor, sem tabela. Rota `GET /api/executive/mission-suggestions`
owner/admin. `test:executive-mission-bridge` (12). 0-regressão.

## 9. F5 — Executive Constraint & Worst-Pillar (esta fatia)

A F4 dá o panorama por pilar; a F5 dá a leitura COMPANY-LEVEL de *"onde focar"*:
**(a)** o PILAR em pior forma e **(b)** a RESTRIÇÃO (constraint) — o desvio nº1 a
resolver. `ExecutiveConstraintService.assess` é composição PURA sobre a F4
(`ExecutiveBusinessSnapshotService.read`) + o ranking que o
`ImpactPrioritizationService.prioritize` já produz (score + SLA + irreversibilidade
+ meta ameaçada). A constraint é o desvio ABERTO de MAIOR score — um FATO de
priorização; a afirmação de que resolvê-la "destrava o resto" sai rotulada
`hypothesis` (§5/RN-CEO-03), nunca causa provada. `worstPillar` só existe se há
de fato crítico/risco (pilar meramente `ok`/`unknown` no topo → `null`, não é um
"pior pilar" honesto). Sem desvio aberto → `constraint`/`worstPillar` `null`
(null≠zero — não fabrica gargalo). A meta ameaçada vem de `affectedGoal` (do
próprio scoring); a severidade normalizada casa por id com as exceções do
snapshot. Dinheiro role-gated (§73): `includeMoney:false` redige o impacto BRL;
rota `GET /api/executive/constraint` owner/admin. `test:executive-constraint`
(13). Não é motor, não persiste, zero tabela nova. 0-regressão.

## 8. F4 — Executive Business Snapshot (esta fatia)

A PRIMITIVA CENTRAL (D1) que responde ao North Star (§4): *"Como está minha empresa?"* →
**3 pilares** (comercial/operações/financeiro), cada um com **indicadores** (via `measure()` da
F1/F2 — sem fonte → `value:null`, nunca 0, RN-CEO-11) + **metas** (agrupadas pela procedência de
pilar do próprio metric) + **exceções** (do feed `BusinessSignalService.attention`) + **prioridades**
(`ImpactPrioritizationService.prioritize` ≤3), mais **missões** (`FalaTuHomeService.missionsBlock`)
e a **visão** (F3). `ExecutiveBusinessSnapshotService.read` é FINO, READ-ONLY, composição PURA — não
persiste, não cacheia de novo (o `BusinessSnapshotV2.read` já cacheia por baixo), zero tabela nova.
Mapa DETERMINÍSTICO `domain→pillar` (D2, conservador: só o claramente comercial/financeiro sai de
`operations`; não mapeado → `operations` mas nada some do bloco global de atenção). **Saúde
QUALITATIVA** por pilar = rollup determinístico de FATOS já derivados (crítico se há exceção
`critical`; atenção se `risk`/meta `behind`; `ok` se há sinal sem exceção; **`unknown`** se o pilar
não tem indicador disponível, meta nem exceção — null≠zero também na saúde). Dinheiro role-gated
(§73/RN-CEO-13): rota `GET /api/executive/snapshot` é owner/admin; `includeMoney:false` REDIGE
valores BRL (indicador/meta/impacto) pra superfícies de menor privilégio reusarem a primitiva.
`test:executive-snapshot` (19). 0-regressão.

## 7. F3 — Business Vision (esta fatia)

A VISÃO é intenção HUMANA (§12): `ExecutiveVisionService.get/save` grava SÓ o que o dono escreveu
(nunca inventa; patch parcial; string vazia limpa; sem dado → campos null + `defined:false`).
Persistência mínima em **5 colunas aditivas** de `organization_settings` (D6 — sem tabela nova;
`vision_statement`/`vision_horizon`/`strategic_priority`/`vision_updated_at`/`vision_updated_by`);
snapshots derivados NUNCA moram aqui. Rotas `GET/PUT /api/executive/vision` ADICIONADAS ao router
`/api/executive` que JÁ EXISTE (prior art: briefing/effectiveness/ask via `ExecutiveAdvisorService` —
reuso pras futuras F8/F9), com `requireRole('owner','admin')` (§50). `test:executive-vision` (7).

## 6. F2 — Métricas executivas com fonte real

Adiciona ao registro (F1) os indicadores dos 7 executivos (§7) + §11 que faltavam, cada um sobre
system-of-record REAL, com `availability` honesta (RN-CEO-11/§31-33): COMERCIAL `sales_count`,
`new_customers` (1ª compra paga — §37), `average_ticket`; OPERAÇÕES `cancellations` (por tipo, `down`;
churn como TAXA fica `unknown` §36), `customer_satisfaction` (CSAT %; NPS `unknown` — só há CSAT);
FINANCEIRO `operating_cost` (`PnlCostReconciliationService`), `cash_balance` (`FinancialLedgerService.
cashOnHand`, fact; **não infere de receita** §32), `overdue_receivables` (fact), `default_rate`
(vencido÷a-receber, %). As financeiras só ficam `available` quando a fonte existe (payables/cash_accounts/
receivables) — sem fonte → `measure()` devolve `value:null`, nunca 0. `unit` widened p/ `percent`.
`catalog()` (metas) passa a filtrar só métricas `up` (não se define "meta" de aumentar inadimplência);
`executiveCatalog()` mantém todas. `test:executive-metrics-sources` (15). 0-regressão.

## 5. F1 — Executive Metric Registry

ESTENDE `BusinessGoalService.METRICS` (D3) com os descritores executivos, sem registry paralelo e sem
regressão (as 5 métricas existentes — revenue/appointments/content_revenue/content_leads/receivables —
ganham `pillar`/`basis`/`source`/`betterDirection`; fontes internas → `available` por padrão). Novos
públicos: `describe` · `availability` · `measure` (leitura HONESTA: sem fonte → `value:null`+`basis:'unknown'`,
RN-CEO-11) · `executiveCatalog` · `metricsByPillar`. Taxonomia `EXECUTIVE_PILLARS` (commercial/operations/
finance). `test:executive-metric-registry` (16). Sem UI, sem rota, sem tabela — fundação das fatias seguintes.
