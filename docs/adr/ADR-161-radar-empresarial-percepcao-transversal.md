# ADR-161 — Radar Empresarial: percepção transversal + sensibilidade de negócio (aditivo sobre ADR-135/136/152/158)

- **Status:** **FECHADO** — PRD 2 (Business Signal & Radar Engine) entregue em 12 fases (F1–F12) / 20 PRs, 0 breaking change, aditivo e reversível (opt-in). As 20 CAs (§101) atendidas. Runbook operacional em `docs/runbook/radar-operacao.md`.
- **Data:** 2026-08-11
- **Origem:** `PRD 2 — ZapFlow Business Signal & Radar Engine`; auditoria de partida (Fase 1, §99) em `docs/prd/ANALISE-PRD2-RADAR-vs-REPO.md` — matriz REUTILIZAR/ESTENDER/CRIAR/DEFERIR. A auditoria provou que **~80% da espinha de percepção já existia** (ADR-136/158): o trabalho foi dar **sensibilidade empresarial** à base, **sem** ledger/feed/alerta paralelo.
- **Relacionadas:** ADR-136 (Decision & Action Ledger — `business_signals`, o ledger canônico que este ADR estende), ADR-158 (espinha única — `correlation_id`/`subject_type`/`expires_at`), ADR-135 (Snapshot/Evidence), ADR-152 (Runtime), ADR-156 (External Intelligence — camada de mercado COMPARTILHADA, distinta do sinal externo POR-ORG da D9 aqui), ADR-160 (Onda A — a `attention()` transversal nasceu na ADR-160 F1 e é consumida aqui). CLAUDE.md convenções nº 1 (isolamento), nº 2 (CREATE-then-ALTER), nº 4 (derivar por query), nº 10 (opt-in), nº 12 (BusinessSignal — sem tabela de alerta nova).

---

## Contexto

O `business_signals` (ADR-136) já era o ledger canônico onde ~15 detectores publicavam, e a ADR-158 já dera a espinha de rastreabilidade (`correlation_id`, `subject_type`, `expires_at`). Faltava transformar esse **registro de eventos** num **radar empresarial**: perceber por múltiplas origens, distinguir dado de interpretação, correlacionar N sinais numa situação, investigar causa provável, priorizar por impacto/meta/prazo/reversibilidade, rotear pro processo certo — e tudo isso **observável e contido em custo** pra produção.

**Regra arquitetural inegociável (PRD §5, CA1/CA10):** **não construir outro Radar do zero.** `business_signals` é o ledger único; `BusinessSignalService.publish` (idempotente por `dedupe_key`) é o único writer; `attention()` é o feed único. Nada cria tabela paralela de "alertas". Toda a inteligência abaixo é **aditiva** sobre isso e **determinística** (roda em CI sem chave de IA); o LLM só **sintetiza/interpreta** o que as regras já calcularam, nunca é o loop principal (§81-83).

A entrega seguiu o §100 (nada de big bang): cada fase é uma fatia pequena, opt-in por flag (`{modulo}_{feature}_enabled`, default OFF), reversível, com sua suíte `test:*` na matrix de CI.

---

## Decisões

### D1 — Signal Contract Hardening (F2 — ENTREGUE)

Completar o contrato do sinal **só onde faltava**, sem novo ledger (§99-F2). `basis` passou a aceitar **`hypothesis`** (além de `fact`/`estimate`) — separando DADO de INTERPRETAÇÃO (CA3, §12-13); coluna aditiva **`subject_id`** (par do `subject_type` da ADR-158). **TTL enforcement** (F2.2): `datetime(expires_at)` normaliza o ISO gravado antes de comparar — corrigiu o bug histórico em que `'T' > ' '` fazia expiry passado nunca filtrar (o TTL era inerte); `expireStale()` faz o STATUS refletir a expiração. **`correlation_id` no processo** (F2.3): fechou o furo em `process_instances` pra a cadeia universal (CA14). Retrocompat total (sinais legados seguem `fact|estimate`, colunas novas NULL). Suítes: `signal-contract-hardening`, `signal-ttl`.

### D2 — Correlation Engine (F3 — ENTREGUE)

N sinais → 1 situação, **sem destruir a evidência individual** (CA4). `SignalCorrelationService.clusters` deriva por query: confiança **ALTA** (mesmo `(subject_type, subject_id)`, multi-domínio, na janela) e **MÉDIA** (mesmo `signal_type` em sujeitos distintos → `related[]`, não colapsa). O `attention()` colapsa a situação de alta confiança num único item (opt-in `radar_attention_correlate_enabled`, com `evidenceCount`+`signalIds`) — os sinais colapsados referenciam suas evidências, nada se perde. Suítes: `signal-correlation`, `attention-correlation`, `signal-related`.

### D3 — Anomaly Framework + Registry (F4 — ENTREGUE)

Antes era código inline repetido em cada detector. Extraído um primitivo **puro, sem IA** (`anomalyPrimitives`: mean/stdDev/percentile/`evaluateAnomaly`/cooldown/`ttlIso`, com min-sample fail-safe) + um **registry** com contrato (§67): `AnomalyDetectorRegistry` (`register`/`byVertical`/`evaluate`→`SignalInput`) e packs por vertical (§89-90). O detector piloto (RetailFloor `conversion_drop`) foi **migrado** pra decidir via registry+primitiva com **equivalência provada** (sinal preservado, threshold movido pra a definição). CA5/CA6. Suítes: `anomaly-primitives`, `anomaly-registry`, `detector-migration`.

### D4 — Goal-Aware Prioritization (F5 — ENTREGUE)

Um sinal que ameaça uma **meta atrasada** sobe na fila. `ImpactPrioritizationService` ganhou um boost **MULTIPLICATIVO** (0 sem meta atrasada → score idêntico ao pré-F5, zero regressão) derivado de `BusinessGoalService.progress` (pace `behind`). Mapa meta→domínios; `affectedGoal` exposto no output. CA7.

### D5 — Investigation Pipeline (F6 — ENTREGUE)

"Por que isso provavelmente acontece?" — determinístico primeiro. `SignalInvestigationService.investigate` gera **causas-candidatas** de um registry de hipóteses, com evidência **a favor/contra** e confiança (`clamp01(base + 0.15·apoio − 0.2·contra)`), `basis: hypothesis`, manchete sempre "a causa **mais provável** é…" (§13 — nunca promove a fato). A síntese por IA (`investigateDeep`) é **gated por nível de impacto** (L3+, reusa a classificação DI-1) e o sintetizador é **injetável** (roda em CI sem chave); o LLM só compõe sobre os fatos dados, nunca recalcula. Suítes: `signal-investigation`, `signal-investigation-deep`.

### D6 — Impact Refino: SLA + reversibilidade (F7 — ENTREGUE)

Dois fatores situacionais que o score de 5 fatores (§9.2) não media (§38): **pressão de prazo** (`slaPressure`, derivada de `expires_at` — estourado→1, dentro do horizonte 72h→cresce, além→0) e **irreversibilidade** (`irreversibility`, do hint `evidence.reversibility`). Ambos boosts **MULTIPLICATIVOS default-0** (mesma mecânica da D4 → zero regressão para sinais que não os carregam); o detector DECLARA, o scorer HONRA. `score = base · (1 + 0.5·goal + 0.4·sla + 0.3·irreversibilidade)`. CA9. Suíte: `impact-sla-reversibility`.

### D7 — Routing Expansion / beachhead (F8 — ENTREGUE)

Sinal → processo maduro. `SignalProcessRouterService` ganhou mapa explícito (`sales:stalled_opportunities → sales_recovery_v1`) + o mecanismo `recommendedProcessType` (o detector recomenda, o router honra **só** se o processo estiver na allowlist de maduros — `sales_recovery_v1`, `receivable_collection_v1`). **Auto-trigger ≠ auto-execute** (§43/CA13): o roteamento pode disparar, mas o gate real de execução segue no RBAC/`ApprovalPolicyService`. CA12/CA20. Suíte: `signal-routing-expansion`.

### D8 — Origem Humana da percepção (F9 — ENTREGUE)

A primeira das duas origens que faltavam pra normalizar o contrato H/D/E (CA2). `HumanSignalService.observe` (opt-in `radar_human_signals_enabled`): uma observação humana ("terceiro cliente procurando o produto X") vira um `business_signal` com **ACÚMULO DE EVIDÊNCIA** (§46) — observações do mesmo assunto acumulam num único sinal, subindo confiança (0.30→0.85, **nunca 1**) e severidade (info→attention→risk), o contador DERIVADO de `observations.length` (RN-004). **Nunca é `fact`** (§13 — percepção humana é `estimate`/`hypothesis`). Read-append-publish atômico; sem tabela nova (observações no `evidence_json`). Suíte: `human-signals`.

### D9 — Origem Externa da percepção (F10 — ENTREGUE)

Fecha a CA2 (H/D/E 100%). `ExternalSignalService.ingest` (opt-in `radar_external_signals_enabled`) é o **molde de ingestão** provider-agnóstico (§50 — só o contrato; os conectores Reclame AQUI/reviews/market intel são PRDs próprios). A marca é **proveniência + confiança**: `source`+`externalId` obrigatórios (dedupe idempotente por origem, §49); `fact` **só** com `verifiable:true` (senão rebaixa a `estimate`, §13); confiança externa < 1 (0.7 verificável, 0.5 senão); severidade derivada de rating/sentiment; autor externo **mascarado** (LGPD). Distinto da ADR-156 (inteligência de mercado COMPARTILHADA sem org): aqui o sinal é POR-ORG, sobre a própria org. Suíte: `external-signals`.

### D10 — Feedback & Calibração (F11 — ENTREGUE)

Loop fechado de qualidade. `dismiss(reason)` captura o motivo (§65 — `incorrect` = falso-positivo, a métrica-chave). `SignalCalibrationService.detectorMetrics` deriva por query (RN-004) por detector: false-positive rate, dismissal rate e um flag de **calibração** (`poor` quando dismissalRate > 0.9 — alerta-fadiga §63). CA19. Suíte: `signal-calibration`.

### D11 — Production Readiness (F12 — ENTREGUE)

Três incrementos que tornam o Radar operável em produção:

- **F12.1 Radar health** (`RadarHealthService.overview`, §94-98/CA16): saúde OPERACIONAL agregada — volume por status/severidade/domínio, **freshness** (detector que parou = stale; como o CA16 torna a falha silenciosa por design, aqui ela vira observável), **storm** (volume recente muito acima da média do detector, §53), calibração (reusa F11) e status geral `ok|watch|degraded`. `GET /api/signals/health` (owner/admin). Suíte: `radar-health`.
- **F12.2 Budget por-detector** (`DetectorBudgetService`, §84/CA17): teto DIÁRIO de investigação profunda (LLM) por `(org, detector)` — um detector barulhento não drena a verba de IA da org. Conta **sem tabela nova** via marcador no `ai_usage_log` (`kind='radar_investigation:<detector>'`, custo 0); default 20/dia com override por org (`radar_detector_daily_budget`); gate em `investigateDeep` → `budget_exhausted` (só o determinístico). Fail-safe (falha de contabilidade permite — é proteção de custo, não gate de segurança). `GET /api/signals/detector-budget`. Suíte: `detector-budget`.
- **F12.3 Runbook** (`docs/runbook/radar-operacao.md`): o "como operar/habilitar/diagnosticar" — mapa das três origens + camadas, flags opt-in, endpoints, diagnóstico por incidente (storm/stale/mal-calibrado/budget/TTL), guardrails e checklist de go-live.

---

## Guardrails que NÃO se regridem (RN do PRD 2)

- **Ledger canônico único (CA1/§5):** `business_signals` + `BusinessSignalService.publish`; nunca tabela de alerta paralela. Toda origem (humana/digital/externa) e toda camada publicam/derivam ali.
- **Fato × interpretação (§13, CA3):** nunca promove hipótese/estimativa a fato. Humano e externo entram como `estimate`/`hypothesis`; investigação sai como `hypothesis`; externo só é `fact` se `verifiable`.
- **Auto-trigger ≠ auto-execute (§43/CA13):** roteamento dispara; execução passa pelo RBAC/`ApprovalPolicyService`.
- **IA nunca é o loop principal (§81-83):** default determinístico (CI sem chave); LLM só sintetiza, gated por impacto (L3+) e budget (D11).
- **Derivado por query (RN-004):** acúmulo de evidência, calibração, saúde, budget, saldo — tudo derivado, nunca contador mutável.
- **Isolamento multi-tenant:** toda query filtra `organization_id`; todo service recebe `orgId` como 1º arg.
- **Opt-in reversível (§54/convenção #10):** cada fatia atrás de flag default 0; desligar volta ao comportamento anterior sem perda de dado (retenção — cancelar é status, nunca DELETE).

## Números

12 fases (F1–F12) · 20 PRs draft→CI verde→merge · 6 services novos (`SignalCorrelationService`, `SignalInvestigationService`, `SignalCalibrationService`, `HumanSignalService`, `ExternalSignalService`, `RadarHealthService`, `DetectorBudgetService`) + 2 estendidos (`BusinessSignalService`, `ImpactPrioritizationService`) + `anomalyPrimitives`/`AnomalyDetectorRegistry` + `SignalProcessRouterService` · ~11 endpoints em `/api/signals/*` · ALTERs aditivos (`subject_id`, `dismiss_reason`, `radar_*_enabled`, `radar_detector_daily_budget`, `process_instances.correlation_id`) · ~14 suítes `test:*` (todas PASS na CI matrix) · **0 tabelas novas de alerta, 0 breaking changes.**
