# ADR-166 — Enterprise Learning & External Intelligence 2.0 (PRD 9)

**Programa:** ZapFlow Execution Intelligence (ZEI)
**Estado:** **F0 FECHADA (auditoria + matriz — doc-only, mergeada). F1 FECHADA — primeira ligação real do ciclo: ledger por-evento `business_pattern_outcomes` + `event_key`/idempotência + `source` em `recordOutcome` (fecha o achado (a): antes `acted+1` sem chave dobrava a contagem) e `PatternLearningFromAssuranceService` liga `OutcomeAssurance(assured)→PatternMemory` — só `assured` aprende forte (DONE ≠ exemplo, RN-EL-1); desfecho worked/backfired DETERMINÍSTICO do valor MEDIDO de base `fact` (RN-EL-3/6); sweep idempotente per-org no Scheduler (lookback 30d) + rota `POST /api/decision-intelligence/assurance/learn`; `test:enterprise-learning-assured` 28 checks. F2 FECHADA — `assuredEffectiveness` (achado (b)): `assuredStats`/`allEffectiveness` DERIVAM por query do ledger o recorte só-`assured`, SEPARADO do `effectiveness` que mistura (RN-EL-6); sem desfecho assured → `null`, nunca 0 (RN-EL-5); anexado ao `/api/insights/patterns`; `test:assured-effectiveness` 12 checks. F3 FECHADA — `LearningEpisodeService`: read model DERIVADO (sem tabela nova, D5/RN-004) que amarra padrão→desfechos assured→`learningState` (`unproven`/`reinforced`/`weakened`/`contested`); `suggestedRefutation` endereça o achado (c) como EVIDÊNCIA (não escreve `refuted` — RN-EL-2); rotas `/learning/episodes` + `/learning/episode/:patternId`; `test:learning-episode` 17 checks. F4 FECHADA — `EvidencePackageService.historicalEvidence[]` (antes `[]` sempre, `compose:114`) agora carrega o aprendizado com prova ASSEGURADA (Learning Episodes `assured`): é o ponto onde o aprendizado entra no pacote de decisão como EVIDÊNCIA (nunca ordem — RN-EL-2/8); refutação-sugerida primeiro; vazio sem prova (0-regressão); `test:historical-evidence` 8 checks. F5 FECHADA — `DecisionEngine.learningPrior` consome o `historicalEvidence` e vira prior ASSIMÉTRICO: só ADICIONA cautela (`proceed→proceed_with_caution` quando o aprendizado assegurado mostra padrões que enfraqueceram/contradisseram), NUNCA relaxa nem toca `hold_for_human` (RN-EL-2/8, CA11-14); pequeno/aditivo/explicável (lista os padrões no `why`)/reversível; `learningDomain` filtra; `test:learning-prior` 14 checks. Ciclo interno FECHADO (outcome assegurado→aprendizado→evidência→decisão melhor). F6 FECHADA — `statsWilson.wilsonInterval` (pura/determinística) dá banda de confiança honesta à taxa binária `worked/assured`: distingue "1/1" (banda larga, pouca prova) de "40/45" (estreita); `assuredStats` expõe `workedRate`/`interval`/`confidence`; n=0 → null (RN-EL-5); flui pro `LearningEpisode`; `test:effectiveness-interval` 16 checks. F7+ (External Intelligence) segue o plano.** Tese dupla: (1) o ZapFlow já **aprende padrões** (`PatternMemoryService`, genérico/determinístico) mas o aprendizado **não consome o resultado ASSEGURADO** do PRD 8 — `recordOutcome` é manual, não-idempotente, sem `event_key`, e **nenhuma** ligação `OutcomeAssurance→PatternMemory` existe (grep zero); (2) a inteligência externa (ADR-156/157 FECHADOS) já tem separação física compartilhado×por-org + anonimização + histórico + delta + agendamento, mas **sintetiza pelo modelo, não busca fonte viva** (`LlmResearchProvider` via `chat()`; `ResearchResult` sem `sourceEvidence`/`evidenceMode`/`retrievedAt`). O slot de conexão entre os dois mundos já existe e está **vazio**: `EvidencePackageService.historicalEvidence[]` é `[]` sempre (`compose:114`) e o `DecisionEngine` não aplica `learningPrior`. Achados F0: (a) `recordOutcome:199` faz `acted+1` (`:207`) sem `event_key`, não-idempotente; (b) `assuredEffectiveness` NÃO EXISTE — `effectiveness=(worked*1+no_effect*0.5+backfired*0)/acted` (`:212`) conta qualquer `acted`, não só o `assured`; (c) estado `refuted` declarado (`db.ts:2110`) mas nunca atribuído; (d) `LlmResearchProvider:90` é conhecimento paramétrico (header `:11-19` confirma sem vendor de busca); (e) `assessQuality:101` só barra vazio+baixa-confiança; (f) `sanitizeForShared` chamado com `tenantTerms=[]` (`VerticalIntelligenceService:115`). Aditivo puro; **NÃO** cria EnterpriseMemoryEngine, segundo PatternMemory, segundo pipeline de pesquisa, novo Decision/Context Engine (§184). Cross-tenant learning FORA de escopo (§79). Plano F0–F14. Análise em `docs/prd/ANALISE-PRD9-vs-CODEBASE.md`.
**Prioridade:** P0 — o resultado assegurado (PRD 8) só vale se realimentar decisões melhores; e evidência externa só vale com procedência.
**Acesso:** aprendizado per-tenant (opt-in por flag, isolado por `organization_id`); inteligência externa compartilhada+anonimizada (master-only na escrita, ADR-156).
**Natureza:** Realimentação de aprendizado sobre outcome assegurado + procedência/busca-viva na inteligência externa.
**Estratégia:** REUTILIZAR → ESTENDER → COMPOR → **só então** CRIAR.
**Dependência dura:** PRD 8 (ADR-165) **encerrado** — pré-condição **ATENDIDA**. O aprendizado forte consome a escada `assured` do `OutcomeAssuranceService`.
**Não é:** novo motor de memória (`EnterpriseMemoryEngine`), segundo `PatternMemory`, segundo pipeline de pesquisa, novo Decision Engine, novo Context Engine, nem aprendizado cross-tenant.

> **Regra de ouro (PRD 9):** *`DONE` não é `EXEMPLO DE SUCESSO`. Só um outcome **assegurado** (confirmado e medido pela escada do PRD 8) realimenta o aprendizado forte. Padrão aprendido é **evidência**, nunca **ordem** — entra como prior explicável no pacote de decisão e nunca contorna RBAC/política/Autonomy Contract.*

---

## 1. Contexto e objetivo

O ZapFlow já **executa com confiança** (Action Trust, ADR-158/159), já **mede resultado** onde alguém instrumentou (PRD 8, ADR-165: a escada `planned→executed→effect_confirmed→impact_measured→assured` torna o resultado assegurado observável), e já **aprende padrões** (`PatternMemoryService`). Mas os três mundos não se fecham num ciclo:

- O **aprendizado** conta o que alguém chamou manualmente (`recordOutcome`), não o que a escada **assegurou**. Aprende de `DONE`, que pode ser ação disparada sem resultado.
- A **decisão** não lê o aprendizado: `historicalEvidence[]` está vazio e não há `learningPrior`.
- A **inteligência externa** sintetiza pelo modelo, sem procedência de fonte viva — então não dá para ponderar "isto é conhecimento do modelo" × "isto é uma fonte recuperada agora".

O PRD 9 fecha esses três vãos **sem criar motor novo**: liga a escada de garantia ao motor de memória existente, injeta o aprendizado como prior explicável na decisão, e dá procedência (`sourceEvidence`/`evidenceMode`) à inteligência externa, abrindo espaço opt-in para um provider de busca viva atrás do **mesmo** contrato.

---

## 2. F0 — Auditoria do `main` (evidência `file:symbol`)

**Conclusão: as peças existem; faltam os elos.** O motor de memória é genérico e determinístico; a inteligência externa está madura (ADR-156/157). Reutiliza-se, não se recria.

### 2.1 Enterprise Learning

| # | Superfície | `file:symbol` | Veredito | Papel / achado |
| --- | --- | --- | --- | --- |
| 1 | **Motor de memória** | `PatternMemoryService.ts`: `upsert:108`, `decayStale:134`, `learn:234` | EXISTE (genérico) | Estados candidate\|validated\|dormant em `business_patterns` (`db.ts:2100-2117`). Determinístico; LLM só narra (`hypothesize:81`). Reutilizar como o **único** motor. |
| 2 | **Confiança/efetividade** | `recordOutcome:199`; `effectiveness:212` | PARCIAL | `OUTCOME_CONF_DELTA` (`:38`) determinístico. **Achado (a):** `acted+1` (`:207`) sem `event_key`, **não-idempotente**. **Achado (b):** `effectiveness=(worked*1+no_effect*0.5+backfired*0)/acted` conta qualquer `acted`; `assuredEffectiveness` **não existe**. |
| 3 | **Stats por tipo** | `business_pattern_type_stats` (`db.ts:2124-2136`) | EXISTE | `acted/worked/no_effect/backfired/effectiveness DEFAULT 0.5` por **tipo**. Estender com recorte só-`assured`. |
| 4 | **Estado `refuted`** | `db.ts:2110` | INERTE | Declarado, **nunca atribuído**. Slot pronto p/ "padrão que o resultado contradiz". |
| 5 | **Escada de garantia (PRD 8)** | `OutcomeAssuranceService.ts:28` `assess` | EXISTE (desligado) | Read-only; estados `planned..assured`. **Nenhum** link com `PatternMemory` (grep zero). Gancho de F1. |
| 6 | **Slot de evidência histórica** | `EvidencePackageService.ts:44` (`historicalEvidence:any[] // adiado`); `compose:114` | VAZIO | `historicalEvidence:[]` **sempre**. `externalEvidence` **é** preenchido (`collectExternalEvidence:141`). Ponto exato de injeção do aprendizado. |
| 7 | **Consumo na decisão** | `DecisionEngine.ts:57` `analyze`; `synthesize:220`; `advocate:203` | PARCIAL | Usa internal/external/confidence/priorities; **não lê** `historicalEvidence`, **não aplica** `learningPrior`. Injeção limpa em `:94-100`/`:220`/`:203`. |
| 8 | **Trace por correlação** | `ExecutionTraceService.ts:41` `trace` | EXISTE | Já inclui execuções+confirmações (`:55-67`), `closedLoop:87`. Reutilizar p/ procedência do aprendizado. |
| 9 | **Sinal de exceção** | `BusinessSignalService.ts:58` `publish` | EXISTE | `basis ∈ fact\|estimate\|hypothesis`; `UNIQUE(org,dedupe_key)`. Padrão aprendido publica como **hipótese**. |
| 10 | **Duplicação legada** | `RetailPatternMemoryService.ts` (tabelas próprias, `storeId`) | ISOLAR | Duplicação legada — **não** estender pelo PRD 9. `ProductionPatternMemoryService` etc = detectores que **delegam** ao genérico (ok). |

### 2.2 External Intelligence 2.0

| # | Superfície | `file:symbol` | Veredito | Papel / achado |
| --- | --- | --- | --- | --- |
| 11 | **Contrato do provider** | `ExternalResearchProvider.ts:37`; `ResearchResult:30`; `getResearchProvider:154` | PARCIAL | `{content,sources,confidence,costCents?}` — **sem** `sourceEvidence`/`evidenceMode`/`retrievedAt`. Default `'stub'`. |
| 12 | **Provider ativo** | `LlmResearchProvider.ts:90` (`chat():112`; header `:11-19`) | GAP | **Conhecimento paramétrico do modelo**, não busca viva. **Achado (d).** `StubResearchProvider` fallback; custo estimado (`:78`). |
| 13 | **Broker read-only** | `ResearchBrokerService.ts:19` `resolve:29`/`contextualize:58` | EXISTE | Tenant **nunca** chama provider (L2 org_contextualization / L3 `getFresh`). Preservar. |
| 14 | **Orçamento global** | `ResearchBudgetService.ts:18` (`canSpend:54`/`record:59`) | EXISTE | `platform_settings.research_monthly_budget_cents`. Reutilizar para busca viva. |
| 15 | **Curadoria** | `ResearchCuratorService.ts:42` `computeDelta:51`/`isMaterial:90`/`assessQuality:101` | PARCIAL | **Achado (e):** `assessQuality` só barra vazio+baixa-confiança. Estender c/ fonte/frescor/diversidade/contradição/grounding. |
| 16 | **Publicação + anonimização** | `VerticalIntelligenceService.ts:107` `publish` (`sanitizeForShared` c/ `tenantTerms=[]` `:115`); `researchAnonymize.ts:65` (`assertNoTenantData:51`) | PARCIAL | **Achado (f):** `tenantTerms` **vazio**. Barreira já existe (lança `anonymize_violation`); preencher endurece §94/§129. |
| 17 | **Camadas físicas** | `vertical_intelligence` (sem org, `db.ts:8138`); `organization_contextualization` (`:8164`); `vertical_intelligence_history` (`:8262`, delta+versão) | EXISTE | Separação compartilhado×por-org + histórico + delta **prontos**. Cross-tenant learning **não** reusa isto p/ dado por-org (§79). |
| 18 | **Agendamento/lembrete** | `VerticalIntelligenceResearchService.ts:113` `maybeSweep`; `VerticalIntelligenceReminderService.ts:85`; `Scheduler.ts:748/751` | EXISTE | Lembrete semanal **não** roda pesquisa (honesto). Reutilizar. |

*(auditoria completa e narrativa em `docs/prd/ANALISE-PRD9-vs-CODEBASE.md`)*

---

## 3. Decisões arquiteturais

- **D1 — Um único motor de memória.** F1+ **estende** `PatternMemoryService`; **proibido** `EnterpriseMemoryEngine` ou segundo `PatternMemory` (§184). `RetailPatternMemoryService` fica congelado (legado), não é base.
- **D2 — Aprendizado forte só de `assured`.** A ligação `OutcomeAssuranceService(assured) → recordOutcome` é a **única** fonte de aprendizado forte. `DONE`/`executed`/`planned` **não** contam como exemplo de sucesso (CA2). Outcomes não-assegurados podem, no máximo, formar *candidatos* (sinal fraco), nunca *validados*.
- **D3 — `recordOutcome` idempotente.** F1 adiciona `event_key` + UNIQUE, espelhando `action_outcomes.event_key` (`db.ts:8925`). Sem isso, aprender do PRD 8 dobraria contagens.
- **D4 — `assuredEffectiveness` separado.** Novo recorte (só `assured`, `basis:fact`), **nunca somado** ao `effectiveness` atual (que mistura). fact/estimate/influenced permanecem distintos.
- **D5 — Learning Episode é read model derivado.** Sem tabela nova em F3 — derivado por query sobre `business_patterns` + `action_outcomes` + `OutcomeAssurance`. Estado derivado, **não** muda FSM (herda RN-OA-3 do PRD 8).
- **D6 — Aprendizado é evidência, não ordem.** `learningPrior` entra em `EvidencePackageService.historicalEvidence[]` e é **ponderado** pelo `DecisionEngine` como prior **pequeno, aditivo, explicável e reversível**. O gate real permanece RBAC/`ApprovalPolicyService`/Autonomy Contract (ADR-159). Nunca autoexecuta.
- **D7 — `evidenceMode` explícito.** `ResearchResult` ganha `evidenceMode ∈ model_knowledge|live` + `sourceEvidence[]` (`{url,retrievedAt,tier A|B|C,freshness}`). A decisão pondera diferente por modo — `model_knowledge` nunca é tratado como fonte viva (§53/§54).
- **D8 — Busca viva atrás do mesmo contrato.** `LiveSearchResearchProvider` é **opt-in**, master-only, sob budget, registrado no **mesmo** `REGISTRY` — sem pipeline paralelo (§184). Miss + opt-in + budget + L3+ (mesma disciplina ADR-156).
- **D9 — Anonimização endurecida.** `publish`/`sanitizeForShared` recebem `tenantTerms` preenchidos com os termos do tenant de origem; `assertNoTenantData` continua sendo a barreira dura.
- **D10 — Cross-tenant learning fora de escopo (§79).** Todo read model de aprendizado filtra `organization_id`. A única camada sem org continua sendo a inteligência de mercado externa anonimizada (ADR-156), que não carrega dado por-org.

---

## 4. Guardrails duros (RN — no header dos services + testados)

**RN-EL (Enterprise Learning):**
- **RN-EL-1** — `DONE ≠ EXEMPLO DE SUCESSO`: só `assured` vira aprendizado forte (CA2).
- **RN-EL-2** — aprendizado é evidência, não ordem: nunca contorna RBAC/política/Autonomy Contract.
- **RN-EL-3** — determinístico antes de LLM: confiança/efetividade por fórmula; LLM só narra.
- **RN-EL-4** — idempotência: `recordOutcome` só conta uma vez por `event_key` (anti-dupla-contagem).
- **RN-EL-5** — `null ≠ zero`, `ausência ≠ falha`: sem outcome medido → efetividade `unknown`, nunca `0`.
- **RN-EL-6** — fact/estimate/influenced **nunca somados**; `assuredEffectiveness` separado do `effectiveness`.
- **RN-EL-7** — isolamento: todo aprendizado filtra `organization_id`; **cross-tenant proibido** (§79).
- **RN-EL-8** — prior pequeno/aditivo/explicável/reversível: nunca vira o voto dominante da decisão.
- **RN-EL-9** — um único motor: proibido segundo `PatternMemory`/`EnterpriseMemoryEngine` (§184).

**RN-EI (External Intelligence):**
- **RN-EI-1** — `model_synthesis ≠ live evidence`: `evidenceMode` sempre explícito (§53/§54).
- **RN-EI-2** — query externa sem dado privado: `tenantTerms` preenchido + `assertNoTenantData` (§94/§129).
- **RN-EI-3** — camada compartilhada carrega **zero** dado por-org/pessoal (ADR-156).
- **RN-EI-4** — provider só no miss + opt-in + budget + L3+ (disciplina ADR-156).
- **RN-EI-5** — grounding obrigatório: recomendação externa só entra com procedência (`sourceEvidence`).
- **RN-EI-6** — não inventa fonte: sem retrieval real → `evidenceMode:model_knowledge`, honesto.
- **RN-EI-7** — um único pipeline: busca viva atrás do mesmo contrato/registry (§184).

---

## 5. Mapeamento dos 40 Critérios de Aceite (CA1–CA40, §180)

| CA | Como o PRD 9 cumpre | Fatia |
| --- | --- | --- |
| CA1 | Aditivo/reversível por flag; 0 breaking changes | todas |
| CA2 | `DONE ≠ exemplo`: só `assured` aprende forte | F1 |
| CA3 | `recordOutcome` idempotente (`event_key`) | F1 |
| CA4 | Ligação `OutcomeAssurance→PatternMemory` | F1 |
| CA5 | `assuredEffectiveness` separado | F2 |
| CA6 | `null≠zero`/`ausência≠falha` | F2 |
| CA7 | Learning Episode derivado (sem tabela nova) | F3 |
| CA8 | Estado derivado não muda FSM | F3 |
| CA9 | `historicalEvidence[]` preenchido | F4 |
| CA10 | Isolamento por `organization_id` | F4 |
| CA11 | `learningPrior` no `DecisionEngine` | F5 |
| CA12 | Prior pequeno/aditivo/explicável/reversível | F5 |
| CA13 | Aprendizado nunca contorna gate | F5 |
| CA14 | Prior explicável (mostra de onde veio) | F5 |
| CA15 | Intervalo de confiança (Wilson) p/ taxa binária | F6 |
| CA16 | Decay/drift temporal reutilizado | F6/F13 |
| CA17 | `sourceEvidence[]` no contrato | F7 |
| CA18 | `evidenceMode ∈ model_knowledge\|live` | F7 |
| CA19 | `retrievedAt`/`freshness`/`tier` por fonte | F7 |
| CA20 | `model_synthesis ≠ live` | F7 |
| CA21 | `LiveSearchProvider` opt-in atrás do contrato | F8 |
| CA22 | Provider só no miss+opt-in+budget+L3+ | F8 |
| CA23 | Master-only na escrita; tenant read-only | F8 |
| CA24 | Gate de fonte na curadoria | F9 |
| CA25 | Gate de frescor | F9 |
| CA26 | Gate de diversidade de fontes | F9 |
| CA27 | Gate de contradição | F9 |
| CA28 | Gate de grounding | F9 |
| CA29 | `tenantTerms` preenchido | F10 |
| CA30 | `assertNoTenantData` mantém barreira | F10 |
| CA31 | Camada compartilhada sem dado por-org | F10 |
| CA32 | Detecção de `research_need` | F11 |
| CA33 | Taxonomia `(vertical,topic,region,timeframe)` | F11 |
| CA34 | Fusão contextual interno+histórico+externo | F12 |
| CA35 | Fusão não soma bases distintas | F12 |
| CA36 | Métrica: acurácia do prior | F13 |
| CA37 | Métrica: decay/drift observável | F13 |
| CA38 | Endurecimento como regressão | F14 |
| CA39 | Runbook operacional | F14 |
| CA40 | Nenhum motor/pipeline paralelo (§184) | todas |

---

## 6. Plano de fatias (F0–F14)

| Fatia | Entrega | Natureza | Teste |
| --- | --- | --- | --- |
| **F0** | Esta ADR + `ANALISE-PRD9-vs-CODEBASE.md` (doc-only) | Auditoria | — |
| **F1 ✅** | `business_pattern_outcomes` (ledger por-evento) + `event_key`/idempotência + `source` em `recordOutcome`; `PatternLearningFromAssuranceService` liga `OutcomeAssurance(assured)→recordOutcome` (worked/backfired pelo valor medido); rota `POST /assurance/learn`; Scheduler sweep per-org (lookback 30d) | ESTENDER/COMPOR | `test:enterprise-learning-assured` (28) |
| **F2 ✅** | `PatternMemoryService.assuredStats`/`allEffectiveness` — recorte só-`assured` DERIVADO por query do ledger (RN-004), separado do `effectiveness` misto; sem prova → `null` (RN-EL-5, não inventa 0); surge no `/api/insights/patterns` | ESTENDER | `test:assured-effectiveness` (12) |
| **F3 ✅** | `LearningEpisodeService` — fio padrão→desfechos assured→estado (`unproven`/`reinforced`/`weakened`/`contested`) DERIVADO por query (sem tabela nova, não muda status); `suggestedRefutation` endereça o achado (c) como EVIDÊNCIA (não escreve `refuted`); rotas `GET /learning/episodes` e `/learning/episode/:patternId` | COMPOR | `test:learning-episode` (17) |
| **F4 ✅** | `EvidencePackageService.compose` preenche `historicalEvidence[]` (antes `[]` sempre) com os Learning Episodes `assured` (aprendizado com prova); refutação-sugerida primeiro; vazio sem prova (0-regressão) | ESTENDER | `test:historical-evidence` (8) |
| **F5 ✅** | `DecisionEngine.learningPrior` consome o `historicalEvidence` (F4) como prior ASSIMÉTRICO: prior `cautionary` sobe `proceed→proceed_with_caution`, nunca relaxa nem toca `hold_for_human` (RN-EL-2/8, CA11-14); explicável (lista os padrões assegurados no `why`); `learningDomain` filtra | ESTENDER | `test:learning-prior` (14) |
| **F6 ✅** | `statsWilson.wilsonInterval` (pura, determinística) dá banda de confiança à taxa binária `worked/assured`; distingue "1/1" (banda larga) de "40/45" (estreita); `assuredStats` expõe `workedRate`/`interval`/`confidence`; n=0 → null (RN-EL-5); flui p/ episódio | CRIAR (mín.) | `test:effectiveness-interval` (16) |
| F7 | `sourceEvidence[]`+`evidenceMode` no `ResearchResult` | ESTENDER | `test:research-provenance` |
| F8 | `LiveSearchResearchProvider` opt-in (budget, master-only) | CRIAR | `test:live-search-provider` |
| F9 | Gates de curadoria 2.0 em `assessQuality` | ESTENDER | `test:research-curation-gates` |
| F10 | `tenantTerms` preenchido na anonimização | ESTENDER | `test:anonymize-tenant-terms` |
| F11 | Detecção de `research_need` + taxonomia | COMPOR | `test:research-need` |
| F12 | Fusão contextual (interno+histórico+externo) | ESTENDER | `test:contextual-fusion` |
| F13 | Métricas de aprendizado (acurácia do prior, decay/drift) | ESTENDER | `test:learning-metrics` |
| F14 | Endurecimento + runbook `docs/runbook/learning-operacao.md` | CRIAR (teste) | `test:enterprise-learning-hardening` |

**F1+ está bloqueada até esta F0 (ADR-166) mergear (§145/§192).** Cada fatia = 1 PR draft → CI verde → merge → próxima.

---

## 7. O que o PRD 9 NÃO faz (§184)

- **NÃO** cria `EnterpriseMemoryEngine` nem segundo `PatternMemory` — estende o único que existe.
- **NÃO** cria segundo pipeline de pesquisa — busca viva entra atrás do `ExternalResearchProvider`/`REGISTRY`.
- **NÃO** cria novo Decision Engine nem Context Engine — injeta `learningPrior` no `EvidencePackageService`/`DecisionEngine` existentes.
- **NÃO** faz aprendizado cross-tenant (§79) — tudo isolado por `organization_id`.
- **NÃO** transforma aprendizado em ordem — é evidência ponderada; o gate segue RBAC/política/Autonomy Contract.
- **NÃO** trata `model_synthesis` como fonte viva — `evidenceMode` mantém a distinção honesta.

---

## 8. Pré-requisito atendido e sucessor

- **Entrada:** PRD 8 (ADR-165) **FECHADO** — a escada `assured` existe e é observável; é a fonte do aprendizado forte.
- **Saída:** o PRD 9 é pré-requisito do **PRD 10** (Integração Final, Produção & Prova Comercial), que fecha o programa ZEI.
