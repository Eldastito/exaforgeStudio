# Análise Comparativa — PRD 9 (Enterprise Learning & External Intelligence 2.0) × Codebase

**Escopo:** entregável da **F0** do PRD 9 (ADR-166). Prova, com evidência `file:symbol`, o que já existe no `main` para que a implementação seja **predominantemente REUTILIZAR/ESTENDER/COMPOR** e só o mínimo CRIAR. **Documento sem código** — a implementação (F1+) está **bloqueada até esta F0 encerrar** (mandato §145/§192), para manter a disciplina por fatias.

**Conclusão executiva:** o ZapFlow já **aprende padrões** (`PatternMemoryService`, genérico, determinístico) e já tem **inteligência externa** com separação física compartilhado×por-org + anonimização + histórico + delta + agendamento (ADR-156/157, FECHADOS). As duas lacunas reais do PRD 9 **não** são motores novos:

1. **Aprendizado não está ligado ao resultado ASSEGURADO.** O `PatternMemoryService.recordOutcome` é **manual, não-idempotente e sem `event_key`** — ninguém o chama a partir da escada de garantia do PRD 8 (`OutcomeAssuranceService`). O aprendizado forte deveria consumir só outcomes **confirmados/medidos**, não qualquer `DONE`. **DONE ≠ EXEMPLO DE SUCESSO.**
2. **Inteligência externa sintetiza pelo modelo, não busca fonte viva.** `LlmResearchProvider` produz conteúdo via `chat()` do modelo (conhecimento paramétrico), **sem** recuperação de fonte real, e `ResearchResult` **não carrega** `sourceEvidence`/`evidenceMode`/`retrievedAt`. **model_synthesis ≠ evidência viva (§53/§54).**

Além disso, o slot de conexão entre os dois mundos já existe e está **vazio**: `EvidencePackageService.historicalEvidence[]` é **sempre `[]`** e o `DecisionEngine` **não lê** aprendizado nem aplica `learningPrior`.

**Cross-tenant learning está FORA de escopo (§79).** Todo aprendizado permanece isolado por `organization_id`; a única camada compartilhada continua sendo a inteligência de **mercado externo anonimizada** (ADR-156), que não carrega dado por-org.

---

## 1. Os conceitos do PRD 9 vs. o que o código já distingue

| Conceito PRD 9 | Existe no código? | Evidência |
| --- | --- | --- |
| **Memória de padrão** (candidate→validated→dormant) | ✅ | `PatternMemoryService.ts` — `upsert:108`, `decayStale:134`, estados em `business_patterns` (`db.ts:2100-2117`). |
| **Confiança determinística** (não LLM) | ✅ | `recordOutcome:199` ajusta `confidence` por `OUTCOME_CONF_DELTA` (`:38`); LLM só narra a descrição (`hypothesize:81`). |
| **Efetividade de intervenção** | ✅ *parcial* | `effectiveness = (worked*1 + no_effect*0.5 + backfired*0)/acted` (`:212`), por **tipo** (`business_pattern_type_stats`, `db.ts:2124`). |
| **Efetividade ASSEGURADA** (só outcome confirmado) | ❌ | não existe — `recordOutcome` conta qualquer `acted`, sem ligação com `action_outcomes`/`OutcomeAssurance`. |
| **Evidência histórica no pacote de decisão** | ❌ | `EvidencePackageService.historicalEvidence[]` é `[]` sempre (`compose:114`). |
| **Prior de aprendizado na decisão** | ❌ | `DecisionEngine.analyze` (`:57`) não lê `historicalEvidence` nem aplica `learningPrior`. |
| **Inteligência externa compartilhada+anonimizada** | ✅ | `vertical_intelligence` (sem `organization_id`, `db.ts:8138`); `researchAnonymize.sanitizeForShared:65`. |
| **Contextualização por-org** | ✅ | `organization_contextualization` (`db.ts:8164`, `UNIQUE(org,fingerprint):8175`). |
| **Histórico + delta da inteligência** | ✅ | `vertical_intelligence_history` (`db.ts:8262`, `delta_json`, `UNIQUE(fingerprint,version):8275`); `ResearchCuratorService.computeDelta:51`. |
| **Agendamento de refresh** | ✅ | `vertical_intelligence_schedule` (`db.ts:8287`); `VerticalIntelligenceResearchService.maybeSweep:113`. |
| **Evidência de fonte viva** (retrieval real) | ❌ | `LlmResearchProvider:90` sintetiza pelo modelo (`chat():112`); `ResearchResult` (`:30`) sem `sourceEvidence`. |
| **Modo de evidência** (model_knowledge × live) | ❌ | não existe campo `evidenceMode` no contrato `ResearchResult`. |
| **Gates de curadoria 2.0** (fonte/frescor/diversidade/contradição/grounding) | ❌ *parcial* | `assessQuality:101` só barra vazio + baixa confiança; sem os demais gates. |

---

## 2. Matriz REUTILIZAR / ESTENDER / COMPOR / CRIAR / DEFERIR (§183)

### 2.1 Enterprise Learning

| Capacidade PRD 9 | Existe | Parcial | Não existe | Reutilizar | Estender | Compor | Criar | Deferir |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Motor de memória de padrão (`PatternMemoryService`) | ✅ | | | ✅ | | | | |
| Estados candidate/validated/dormant + decay | ✅ | | | ✅ | | | | |
| Confiança determinística + deltas de outcome | ✅ | | | ✅ | | | | |
| Sinais de padrão (`publishSignals`) | ✅ | | | ✅ | | | | |
| `recordOutcome` **idempotente** (event_key) | | ✅ | | | ✅ | | | |
| Ligação **OutcomeAssurance → aprendizado** | | | ✅ | | | ✅ | ✅ (mín.) | |
| **Efetividade ASSEGURADA** (só `assured`) | | | ✅ | | ✅ | | | |
| **Learning Episode** (read model derivado) | | | ✅ | | | ✅ | ✅ (mín.) | |
| Preencher `historicalEvidence[]` | | ✅ | | | ✅ | | | |
| **learningPrior** no `DecisionEngine` | | | ✅ | | ✅ | | | |
| Estado `refuted` do padrão (hoje inerte) | | ✅ | | | ✅ | | | |
| Drift/decay temporal | ✅ | | | ✅ | ✅ | | | |
| Intervalo de confiança (Wilson) p/ taxa binária | | | ✅ | | | | ✅ (mín.) | |
| **EnterpriseMemoryEngine paralelo** | | | | | | | | ❌ **PROIBIDO (§184)** |
| **Segundo PatternMemory** | | | | | | | | ❌ **PROIBIDO (§184)** |
| **Cross-tenant learning** | | | | | | | | ⛔ **FORA DE ESCOPO (§79)** |

### 2.2 External Intelligence 2.0

| Capacidade PRD 9 | Existe | Parcial | Não existe | Reutilizar | Estender | Compor | Criar | Deferir |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Separação física compartilhado × por-org | ✅ | | | ✅ | | | | |
| Anonimização + `assertNoTenantData` | ✅ | | | ✅ | | | | |
| Histórico + versão + delta | ✅ | | | ✅ | | | | |
| Broker read-only (tenant nunca chama provider) | ✅ | | | ✅ | | | | |
| Orçamento de pesquisa (global) | ✅ | | | ✅ | | | | |
| Agendamento + lembrete semanal | ✅ | | | ✅ | | | | |
| Contrato `ResearchResult` com `sourceEvidence` | | | ✅ | | ✅ | | | |
| Campo `evidenceMode` (model_knowledge × live) | | | ✅ | | ✅ | | | |
| `retrievedAt`/`freshness`/`tier` por fonte | | | ✅ | | ✅ | | | |
| Provider de **busca viva** (retrieval real) | | | ✅ | | | | ✅ | |
| Gates de curadoria 2.0 (`assessQuality`) | | ✅ | | | ✅ | | | |
| Detecção de `research_need` + taxonomia | | | ✅ | | | ✅ | ✅ (mín.) | |
| `anonymize` com `tenantTerms` **preenchido** | | ✅ | | | ✅ | | | |
| Fusão contextual (interno+histórico+externo) | | ✅ | | | ✅ | ✅ | | |
| **Segundo pipeline de pesquisa paralelo** | | | | | | | | ❌ **PROIBIDO (§184)** |

---

## 3. Evidência por área (síntese da auditoria F0)

### 3.1 Enterprise Learning — `PatternMemoryService` é genérico e reutilizável

1. **Motor único, determinístico.** `PatternMemoryService.ts`: `isEnabled/setEnabled` por flag `organization_settings.pattern_memory` (`:60-69`); `list:71`; `publishSignals:149`; `typeStats:183`/`allTypeStats:188`; `learn:234`. Estados **candidate|validated|dormant** via `upsert:108` + `decayStale:134`. Constantes: `MIN_EVIDENCE=3`/`VALIDATE_EVIDENCE=4`/`VALIDATE_CONFIDENCE=0.5` (`:30-32`), `DECAY=0.6`/`DORMANT_AT=0.2` (`:33-34`), `OUTCOME_CONF_DELTA={worked:0.1, no_effect:-0.05, backfired:-0.2}` (`:38`). **Confiança é DETERMINÍSTICA** — o LLM só narra a descrição em `hypothesize:81`. Roda em CI sem chave de IA.
2. **Achado (measurement gap do aprendizado):** `recordOutcome:199` faz `acted = acted + 1` (`:207`) **sem `event_key`** e **não-idempotente** — chamar 2× dobra a contagem. **Ninguém o chama a partir da escada de garantia** (`OutcomeAssuranceService`): `grep` cruzado retorna **zero** ligação `OutcomeAssurance → PatternMemory`. Ou seja, o aprendizado hoje conta o que alguém instrumentou manualmente, não o que foi **assegurado**.
3. **Efetividade existe, mas não é assegurada.** `effectiveness = (worked*1 + no_effect*0.5 + backfired*0)/acted` (`:212`), por **tipo** em `business_pattern_type_stats` (`db.ts:2124-2136`, `effectiveness DEFAULT 0.5`). **`assuredEffectiveness` NÃO EXISTE** — não há recorte "só quando o outcome foi confirmado/medido pela escada do PRD 8".
4. **Estado `refuted` declarado mas inerte.** O schema `business_patterns` declara `refuted` (`db.ts:2110`) que **nunca é atribuído** pelo código — slot pronto para o PRD 9 usar (padrão que o resultado contradiz).
5. **Duplicação legada isolada (não confundir com reuso):** `RetailPatternMemoryService.ts` tem **tabelas próprias** (`retail_store_patterns`/`retail_pattern_type_stats`, flag `retail_pattern_memory`, chave `storeId`) — é duplicação legada, **não** deve ser estendida pelo PRD 9. Já `ProductionPatternMemoryService` e afins são **detectores finos que delegam** ao motor genérico (não são duplicação).

### 3.2 O slot de conexão já existe — e está vazio

1. **`EvidencePackageService`** — interface `historicalEvidence: any[]` (`:44`, comentário `// adiado`); `compose()` grava `historicalEvidence: []` (`:114`) **sempre**. Em contraste, `externalEvidence` **é preenchido** via `collectExternalEvidence` (`:113/141`, JOIN `organization_contextualization` + `vertical_intelligence` com `c.organization_id AND v.valid_until>now`, `:143-148`). Flag `evidence_layer_enabled` (`isEnabled:53`). **Este é o ponto exato onde o aprendizado entra na decisão.**
2. **`DecisionEngine.analyze`** (`:57`) consome `EvidencePackageService.build` (`:79`) e usa `internalEvidence`/`confidence`/`topPriorities`/`externalEvidence` (`:97,119,155,166`) — mas **não lê `historicalEvidence`** e **não aplica `learningPrior`**. A síntese `stance ∈ proceed|proceed_with_caution|hold_for_human` sai de `synthesize()` (`:220-235`) contando `highRisks`/`redFlags` + `level.n` (`ImpactPrioritizationService.levelFor:58`). Pontos de injeção limpos: objeto de saída (`:94-100`), `synthesize()` (`:220`), `advocate()` support[] (`:203`). **O aprendizado é EVIDÊNCIA, não ordem** — entra como prior explicável, nunca decide sozinho (o gate real segue no RBAC/`ApprovalPolicyService`/Autonomy Contract).
3. **`OutcomeAssuranceService`** (PRD 8) — escada `planned→executed→effect_confirmed→impact_measured→assured` (`:28`), **read-only**. **Nenhum link** com `PatternMemory` hoje — este é o gancho de F1: quando um outcome atinge `assured`, alimentar `recordOutcome` **idempotente** com `event_key`.
4. **`ExecutionTraceService.trace`** (`:41`) já inclui execuções + confirmações (`:55-67`) e `closedLoop:87` — reutilizável para carimbar de onde veio o aprendizado.
5. **`BusinessSignalService.publish`** (`:58`) exige `domain`/`signalType`/`dedupeKey`; `severity ∈ info|attention|risk|critical`; `basis ∈ fact|estimate|hypothesis`; `UNIQUE(org, dedupe_key)`. Padrão aprendido publica como **hipótese** (`basis:'hypothesis'`), nunca fato.

### 3.3 External Intelligence — ADR-156/157 FECHADOS; a lacuna é a fonte viva

1. **Contrato do provider.** `ExternalResearchProvider.ts`: interface (`:37`), `ResearchResult` (`:30`) = `{content:any, sources:string[], confidence, costCents?}` — **sem** `sourceEvidence`/`evidenceMode`/`retrievedAt`. `REGISTRY:148`, `getResearchProvider:154` (default `'stub'`).
2. **Achado central (model_synthesis ≠ live).** `LlmResearchProvider:90` sintetiza via `chat()` do modelo (`:112`); o header (`:11-19`) **confirma que não há vendor de busca**. `StubResearchProvider` é fallback; custo estimado `costCents = LLM_RESEARCH_COST_CENTS` (`:78`). Ou seja: o "research" atual é **conhecimento paramétrico do modelo**, não recuperação de fonte real. O PRD 9 exige **distinguir** os dois (`evidenceMode`) e abrir espaço para um provider de **busca viva**.
3. **Broker read-only intacto.** `ResearchBrokerService.ts:19` **nunca chama provider**; `resolve():29` (L2 `organization_contextualization` / L3 `VerticalIntelligenceService.getFresh`), `contextualize():58`. Tenant permanece consumidor.
4. **Orçamento global.** `ResearchBudgetService.ts:18` — `platform_settings.research_monthly_budget_cents`, `spentThisMonthCents:34`, `canSpend:54`, `record:59`.
5. **Curadoria — extensão clara.** `ResearchCuratorService.ts:42`: `computeDelta:51` (new/gone/grew/shrank por ranking de driver, `:73-75`), `isMaterial:90`, `assessQuality:101` — **hoje só barra vazio + baixa confiança**. É o ponto de estender para os gates 2.0 (fonte, frescor, diversidade, contradição, grounding). `curate:123`.
6. **Publicação + anonimização.** `VerticalIntelligenceService.ts:30`: `researchFingerprint:24` (sha256, 32 chars), `publish():107` (versiona histórico, `delta:133`, `sanitizeForShared` com **`tenantTerms=[]`** `:115`), `runManual:80`. `researchAnonymize.ts`: `sanitizeForShared:65` (`deepStripPII:35` + `assertNoTenantData:51` lança `anonymize_violation`). **Achado:** `tenantTerms` é chamado **vazio** — o PRD 9 deve preencher com os termos do tenant que originou a necessidade, endurecendo a barreira (§94/§129).
7. **Agendamento/lembrete.** `VerticalIntelligenceReminderService.ts:26` (sinal semanal `:85`, **não roda pesquisa**); `VerticalIntelligenceResearchService.ts:27` (`maybeSweep:113` → `curate:120`). `Scheduler.ts:748/751`.
8. **Rotas.** `routes/decisionIntelligence.ts`: rotas de external-intelligence `:161-289` (todas master, exceto `GET /external-evidence:289`, per-org). ADR-156 (FECHADO 2026-08-08, DI-4.1..4.5) e ADR-157 (FECHADO 2026-08-09, DI-5.1..5.5).

---

## 4. Gaps que a implementação (F1+) fecha — sem motor novo

| # | Gap | Onde fecha (REUTILIZAR/ESTENDER/COMPOR) |
| --- | --- | --- |
| G1 | Aprendizado não consome resultado **assegurado** | COMPOR `OutcomeAssuranceService`(assured) → `PatternMemory.recordOutcome` **idempotente** (`event_key`). DONE≠exemplo. |
| G2 | `recordOutcome` não-idempotente (double-count) | ESTENDER com `event_key` + UNIQUE, espelhando o padrão `action_outcomes.event_key` (`db.ts:8925`). |
| G3 | `assuredEffectiveness` não existe | ESTENDER `type_stats`/read model com recorte "só `assured`" (fato), separado do `effectiveness` atual (mistura). |
| G4 | `historicalEvidence[]` sempre vazio | ESTENDER `EvidencePackageService.compose` para preencher a partir do read model de aprendizado (isolado por org). |
| G5 | `DecisionEngine` ignora aprendizado | ESTENDER `analyze`/`synthesize` com `learningPrior` **pequeno/aditivo/explicável/reversível**; evidência, não ordem. |
| G6 | `ResearchResult` sem procedência | ESTENDER contrato com `sourceEvidence[]` (`{url,retrievedAt,tier,freshness}`) + `evidenceMode ∈ model_knowledge\|live`. |
| G7 | Sem busca viva | CRIAR `LiveSearchResearchProvider` (opt-in, budget, master-only) atrás do **mesmo** `ExternalResearchProvider` — sem pipeline paralelo. |
| G8 | Curadoria fraca | ESTENDER `assessQuality` com gates de fonte/frescor/diversidade/contradição/grounding (§53/§54). |
| G9 | `tenantTerms` vazio na anonimização | ESTENDER `publish`/`sanitizeForShared` recebendo os termos do tenant de origem (§94/§129). |
| G10 | Sem detecção de `research_need` | COMPOR sobre `attention()`/lacunas de evidência → mapa de taxonomia `(vertical,topic,region,timeframe)`. |

---

## 5. Guardrails que a auditoria confirma serem cumpríveis por composição

- **DONE ≠ EXEMPLO DE SUCESSO (§9/CA2):** só outcomes `assured` (PRD 8) alimentam aprendizado forte; a escada já distingue os estados.
- **fact/estimate/influenced NUNCA somados:** `action_outcomes` e os Impact services já mantêm as categorias separadas; o aprendizado herda a distinção.
- **Cross-tenant FORA (§79):** todo read model de aprendizado filtra `organization_id`; a única camada sem org é a inteligência de mercado (ADR-156), que **não** carrega dado por-org.
- **model_synthesis ≠ live (§53/§54):** `evidenceMode` torna a distinção explícita no contrato; decisão pondera diferente por modo.
- **Query externa sem dado privado (§94/§129):** `assertNoTenantData` já lança violação; F1+ preenche `tenantTerms` para fechar o vão.
- **Aprendizado é evidência, não ordem:** entra como `learningPrior` no pacote; o gate real permanece RBAC/`ApprovalPolicyService`/Autonomy Contract (ADR-159).
- **Determinístico antes de LLM:** confiança/efetividade continuam calculadas por fórmula; LLM só narra.
- **NÃO criar motor paralelo (§184):** um único `PatternMemoryService` e um único pipeline de pesquisa; F1+ estende, não duplica.

---

## 6. Plano de fatias (resumo — detalhe no ADR-166)

| Fatia | Entrega | Natureza |
| --- | --- | --- |
| **F0** | Esta análise + ADR-166 (doc-only) | Auditoria |
| F1 | `event_key` + idempotência em `recordOutcome`; ligação `OutcomeAssurance(assured)→recordOutcome` | ESTENDER/COMPOR |
| F2 | `assuredEffectiveness` (recorte só-`assured`), separado de `effectiveness` | ESTENDER |
| F3 | Learning Episode (read model derivado, sem tabela nova) | COMPOR |
| F4 | Preencher `historicalEvidence[]` no `EvidencePackageService` | ESTENDER |
| F5 | `learningPrior` no `DecisionEngine` (pequeno/aditivo/explicável/reversível) | ESTENDER |
| F6 | Intervalo de confiança (Wilson) para taxa binária de efetividade | CRIAR (mín.) |
| F7 | `sourceEvidence[]` + `evidenceMode` no contrato `ResearchResult` | ESTENDER |
| F8 | `LiveSearchResearchProvider` opt-in (budget, master-only) | CRIAR |
| F9 | Gates de curadoria 2.0 em `assessQuality` | ESTENDER |
| F10 | `tenantTerms` preenchido na anonimização | ESTENDER |
| F11 | Detecção de `research_need` + taxonomia | COMPOR |
| F12 | Fusão contextual (interno+histórico+externo) no pacote | ESTENDER |
| F13 | Métricas de aprendizado (acurácia do prior, decay, drift) | ESTENDER |
| F14 | Endurecimento (`test:enterprise-learning-hardening`) + runbook | CRIAR (teste) |

**F1+ está bloqueada até esta F0 mergear (§145/§192).**
