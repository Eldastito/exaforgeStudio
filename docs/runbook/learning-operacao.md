# Runbook — Enterprise Learning & External Intelligence 2.0 (PRD 9 / ADR-166)

Operação do ciclo de aprendizado do ZapFlow: como o resultado ASSEGURADO vira
aprendizado, como o aprendizado entra na decisão, e como a inteligência externa
distingue síntese do modelo de fonte viva. Todos os serviços são determinísticos,
read-only sobre a FSM, isolados por `organization_id`.

> **Regra de ouro:** `DONE` não é `EXEMPLO DE SUCESSO`. Só um outcome **assegurado**
> (confirmado E medido pela escada do PRD 8) realimenta o aprendizado forte. Padrão
> aprendido é **evidência**, nunca **ordem**.

---

## 1. Mapa dos serviços

### Aprendizado interno (metade F1–F6)
| Serviço | Papel | Fatia |
| --- | --- | --- |
| `PatternMemoryService` | Motor ÚNICO de memória de padrão (candidate→validated→dormant). `recordOutcome` idempotente por `event_key`; `assuredStats` (recorte só-assured); `allEffectiveness` | F1/F2/F6 |
| `PatternLearningFromAssuranceService` | Liga `OutcomeAssurance(assured)` → `recordOutcome` (só `assured` aprende forte). `sweep` per-org no Scheduler | F1 |
| `LearningEpisodeService` | Read model do fio padrão→desfechos→estado (`unproven`/`reinforced`/`weakened`/`contested`); `suggestedRefutation` | F3 |
| `EvidencePackageService.historicalEvidence[]` | Carrega o aprendizado assegurado no pacote de decisão | F4 |
| `DecisionEngine.learningPrior` | Prior ASSIMÉTRICO na decisão (só adiciona cautela) | F5 |
| `statsWilson` | Banda de confiança (Wilson) da taxa binária `worked/assured` | F6 |
| `LearningMetricsService` | KPIs derivados (cobertura assegurada, estados, drift) | F13 |

### Inteligência externa (metade F7–F12)
| Serviço | Papel | Fatia |
| --- | --- | --- |
| `ExternalResearchProvider` | Contrato `ResearchResult` com `evidenceMode` (`model_knowledge`/`live`) + `sourceEvidence[]` | F7 |
| `StubResearchProvider` / `LlmResearchProvider` | Síntese — `model_knowledge` (fontes citadas = tier C alegado) | F7 |
| `LiveSearchResearchProvider` | Busca VIVA (`live`, tier B, `retrievedAt`); sem vendor → cai no stub | F8 |
| `ResearchCuratorService.assessQuality` | Gates 2.0: grounding (live sem fonte bloqueia) + diversidade/frescor/contradição (avisos) | F9 |
| `VerticalIntelligenceService` (`tenantTermsFor`) | Anonimização endurecida — nome do tenant vazado bloqueia | F10 |
| `ResearchNeedService` | Detecção de `research_need` + taxonomia `(vertical,topic,region,timeframe)` | F11 |
| `ContextualFusionService` | Funde interno + histórico + externo (força categórica; nunca soma bases) | F12 |

---

## 2. Fluxo — do resultado ao aprendizado à decisão melhor

```
outcome ASSEGURADO (PRD 8)
  → PatternLearningFromAssuranceService.sweep (Scheduler, per-org, lookback 30d)
  → PatternMemoryService.recordOutcome(source='assured', event_key)   [idempotente]
  → business_pattern_outcomes (ledger)  +  business_pattern_type_stats (agregado)
  → LearningEpisodeService.episode (estado derivado)  +  assuredStats (recorte forte)
  → EvidencePackageService.historicalEvidence[]  (entra no pacote)
  → DecisionEngine.learningPrior  (prior assimétrico — só cautela)
  → decisão melhor → nova ação → novo outcome (revalida)
```

## 3. Fluxo — inteligência externa

```
ResearchNeedService.detect  (lacunas de mercado do org, taxonomia pronta)
  → [master decide]  runResearch / curate  (opt-in + budget + master-only)
  → provider (stub/llm=model_knowledge  |  live=fonte viva)
  → ResearchCuratorService.assessQuality  (gates 2.0: grounding bloqueia live sem fonte)
  → VerticalIntelligenceService.publish  (anonimiza c/ tenantTerms + versiona)
  → ResearchBrokerService.resolve  (contextualiza por-org, read-only)
  → EvidencePackageService.externalEvidence[]  +  ContextualFusionService.fuse
```

---

## 4. Rotas

- `GET /api/decision-intelligence/learning/episodes` · `/learning/episode/:patternId` — episódios.
- `POST /api/decision-intelligence/assurance/learn` — aprende de `assured` (`?actionId=` ou sweep).
- `GET /api/decision-intelligence/learning/metrics` — KPIs do aprendizado.
- `GET /api/decision-intelligence/research-needs` — lacunas de pesquisa (taxonomia).
- `GET /api/decision-intelligence/context-fusion` — fusão contextual por tópico.
- `GET /api/insights/patterns` — padrões + `typeStats` (com recorte assegurado + interval).

## 5. Flags / env

- `organization_settings.pattern_memory` — motor de padrão (opt-in por org).
- `organization_settings.external_intelligence_enabled` — consumo de inteligência externa (opt-in).
- `EXTERNAL_RESEARCH_PROVIDER` — `stub` (default) | `llm` | `live`.
- `EXTERNAL_RESEARCH_SEARCH_URL` / `_API_KEY` — vendor de busca viva (F8). Sem ele → stub honesto.
- `EXTERNAL_RESEARCH_CONFIDENCE_FLOOR` — piso do gate de qualidade.
- `research_monthly_budget_cents` (`platform_settings`) — orçamento GLOBAL de pesquisa.

---

## 6. Guardrails (RN-EL / RN-EI) — codificados em `test:enterprise-learning-hardening`

**RN-EL (aprendizado):** DONE≠exemplo (só assured aprende forte) · evidência não ordem ·
determinístico antes de LLM · idempotência (`event_key`) · null≠zero · fact/estimate/assured
nunca somados · isolamento (cross-tenant proibido) · prior pequeno/aditivo/explicável/reversível/
ASSIMÉTRICO (só cautela, nunca relaxa nem toca `hold_for_human`) · motor ÚNICO.

**RN-EI (externo):** `model_synthesis` ≠ `live` · query sem dado privado · camada compartilhada
zero-org · provider só miss+opt-in+budget+L3+ · grounding obrigatório (live sem fonte bloqueia) ·
não inventa fonte · pipeline ÚNICO.

## 7. Diagnóstico rápido

| Sintoma | Onde olhar |
| --- | --- |
| Aprendizado não evolui | `pattern_memory` ligado? Há outcomes `assured`? `learning/metrics.assuredCoveragePct` |
| Decisão não muda com o aprendizado | `historicalEvidence[]` populado? `learningDomain` no input? Prior é ASSIMÉTRICO (só cautela) |
| Pesquisa externa "genérica" | `evidenceMode` = `model_knowledge`? Sem `EXTERNAL_RESEARCH_SEARCH_URL` cai no stub |
| Pesquisa live reprovada | `assessQuality.reasons` = `ungrounded_live` (live sem `sourceEvidence`) |
| Publicação bloqueada | `anonymize_violation` — nome/CNPJ do tenant vazou pro compartilhado (F10) |
| `research-needs` vazio | Org tem `vertical`? Há sinais abertos? Intel já fresca cobre os temas |

## 8. Como adicionar um domínio ao aprendizado

1. O detector do domínio publica um `business_signal` com `sourceEntityType='business_pattern'`
   e `sourceEntityId=<pattern.id>` (via `PatternMemoryService.publishSignals`).
2. A ação nascida desse sinal, ao atingir `assured` (PRD 8), é capturada pelo
   `PatternLearningFromAssuranceService.sweep` automaticamente — nada a fazer no domínio.
3. Para o tópico de mercado, adicione o mapeamento `domain→topic` em `ResearchNeedService`
   (e `ContextualFusionService`) se quiser rótulo dedicado; o fallback usa o próprio domínio.
