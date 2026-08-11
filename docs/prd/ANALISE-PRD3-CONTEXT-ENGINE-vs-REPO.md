# PRD 3 — Business Context Engine — Fase 0: Reconciliação com o Codebase

> Gate obrigatório do §99/§128: **nenhuma implementação antes desta análise.** Matriz
> **REUTILIZAR > ESTENDER > COMPOR > CRIAR** (§128) + mapa de cada contrato exigido
> pelo PRD contra o que já existe no `main`.
> Baseline auditado: `main` após PRD 2 (Radar/ADR-161) fechado. Data: 2026-08-11.
> Método: 5 varreduras paralelas do codebase (contexto/snapshot · orquestração/Fala Tu ·
> sinais/metas/políticas/RBAC · RAG/memory/evidence/audit · tenancy/planos/verticais/entidades).

## Sumário executivo

O PRD 3 pede uma **"consciência operacional"**: antes de decidir/executar, resolver *"o que
está acontecendo, com quem, em qual empresa/unidade/momento, com quais objetivos, restrições,
evidências e histórico"*, entregando um **Context Packet** consumível pelo futuro SkillOS (PRD 4).

**A auditoria confirma que ~70-80% da mecânica já existe** — espalhada, mas madura. O ZapFlow
já tem a camada de contexto (`ContextEngineService`), o ledger de percepção (`business_signals`/
Radar), o snapshot cacheável com freshness/confidence/sources (`EvidencePackageService`), a
projeção por papel (`ContextProjectionService`/`PermissionService`), o ciclo de proposta→
aprovação auditada (`DecisionActionService`), a captura candidata (`FalaTuService`), RAG,
memória, política de aprovação e os **6 fatores de impacto já computados**
(`ImpactPrioritizationService`).

**Portanto o PRD 3 é predominantemente COMPOSIÇÃO + CONTRATO, não construção de motor novo.**
O trabalho real é:
1. **Definir os contratos estáveis** que o PRD 4 vai consumir (`ContextPacket`, `ContextRequest`,
   `ContextScope`, `EvidenceReference`, `SkillHints`, `ContextQuality`) — hoje inexistentes como
   tipos de 1ª classe;
2. **Um Context Resolver** que orquestra os serviços existentes num pacote *mínimo e relevante*
   por intent (Context Progressive Disclosure, §6) — não um prompt gigante;
3. As poucas peças **genuinamente ausentes**: `BusinessConstraint`, resolução de conflito/
   precedência de fonte, e o **snapshot imutável de contexto na hora da decisão** (§52).

**Regra arquitetural inegociável (AC-A01/§64/§65):** **não duplicar `BusinessContextService`/
`ContextEngineService`.** Não criar `BusinessContextEngineService` paralelo. **Estender** o
`ContextEngineService` (que já é o contrato único de fusão narrativa+snapshot+projeção). Não
criar engine por vertical (§46) — a vertical entra por `vertical_blueprints`/`verticals.ts`
(já é assim). O Context Engine é `READ + DERIVE`, nunca `EXECUTE` (AC-A02/§90).

---

## Matriz REUTILIZAR / ESTENDER / COMPOR / CRIAR / DEFERIR

### ✅ REUTILIZAR (existe e é maduro — não duplicar)

| Capacidade do PRD | Onde já vive |
| --- | --- |
| Contrato de contexto único (fusão narrativa + snapshot + proveniência + projeção por papel) | `ContextEngineService.build/render/buildForUser` (ADR-160 F3) |
| Snapshot estruturado por domínio (finance/sales/inventory/procurement/retail_ops/tasks), cada métrica `{value, basis, source, confidence?}` | `BusinessSnapshotV2Service.read/build` + `*SnapshotAdapter` (ADR-135) |
| Snapshot cacheável/versionado com **freshness + confidence + sources** (§28/§27/§75) | `EvidencePackageService` + `evidence_packages` (opt-in `evidence_layer_enabled`, TTL 12h, upsert 1/subject) |
| Projeção por papel + **redaction** fail-closed (§68/§70) | `ContextProjectionService` (reusa `PermissionService`; DOMAIN_MODULE, redige custo/margem/CPF…) |
| RBAC granular (módulo→nível none/read/write/full) + `requireRole`/`requirePermission` (§68) | `PermissionService` + `role_profiles`/`role_permissions` (ADR-095) |
| Ledger de fatos/percepção com `basis (fact\|estimate\|hypothesis)`, confidence, subject, evidence, source, correlation, TTL (§11/§26) | `business_signals` + `BusinessSignalService` (o `SignalInput` já é quase o `ContextFact`) |
| **6 fatores de impacto/prioridade** (impact·urgency·confidence·goal_alignment·risk·reversibility) (§41) | `ImpactPrioritizationService.scoreSignal` (todos emitidos em `components`) |
| Correlação de sinais (N→situação), investigação de causa determinística (§38/§39) | `SignalCorrelationService`, `SignalInvestigationService` |
| Momento/atenção transversal (base do **Business Moment** §17) | `BusinessSignalService.attention()` (funde sinais + riscos, ranqueado) |
| Metas como entidade de DB + **distância à meta/pace** (§9/§14) | `BusinessGoalService` + `business_goals` (mínimo — ver ESTENDER) |
| Contexto de política/aprovação por papel+valor (§16) | `ApprovalPolicyService.resolve/resolveContract` + `agent_policies` (bands valor→papel, ADR-159) |
| Ciclo **proposta → aprovação auditada** = base do **Context Candidate** (§37) | `DecisionActionService.propose/approve/reject` + `FalaTuApprovalService` (present+delegate) |
| Captura candidata (capturar→pendente→confirmar, nunca altera silenciosamente) (§36/§37) | `FalaTuService.capture/confirm/discard` (`falatu_inbox_items.status`) |
| RAG org-wide (embed + busca) (§49) | `geminiRAG` + `knowledge_documents/chunks` + `vectorSimilarity` |
| Memória (padrões por-org + semântica por-usuário), já marcada "não é fonte da verdade" (§51) | `PatternMemoryService`+família, `FalaTuMemoryEmbeddingsService`, `CustomerMemoryService` |
| Auditoria (actor/evento/metadata) + masking LGPD (§54/§69) | `auditLog.logAuthEvent` + `auth_audit_logs` + `maskIdentifier` |
| Freshness/TTL/stale (§28/§29) | `expires_at` + `expireStale` + `datetime(expires_at)` + `EvidencePackage.freshness` + decay de padrões |
| Snapshot **imutável canonicalizado** (base do §52/§53) | `canonicalize` + `computeDocumentHash` + colunas `*_snapshot` (Fase 27/29) |
| Registry de schema por vertical (§47) | `VerticalBlueprintService` + `vertical_blueprints`/`organization_blueprints` (ADR-153) |
| Contexto de plano/assinatura + entitlement (§44) | `PlanService`, `ModuleService.isEnabled`, `EntitlementService.check`→`EntitlementDecision` |
| Modelo de vertical (single engine + extensões por prefixo de tabela) (§45/§46) | `verticals.ts` + tabelas `retail_*`/`clinic_*`/`fashion_*`/`comigo_*`… |
| Isolamento multi-tenant (orgId 1º arg, filtro em toda query) (§66) | `middleware/auth.ts` + convenção #1 + `scripts/test-tenant-isolation.ts` |
| Sub-escopo org (loja/depto/local) (§8) | `retail_stores`+`store_id`, `business_departments`(hierárquico)+`cost_centers`, `inventory_locations` |
| Entidades núcleo (cliente/produto/fornecedor/equipe/identidade) (§10) | `contacts`, `products_services`, `purchase_orders.supplier_*`, `employees`, `organization_settings` |
| Métricas de custo de IA / token economy (§55/§56) | `llm.recordUsage` → `ai_usage_log` + `PRICES` |
| Primitivas anti prompt-injection (§71) | `AIOrchestratorService.isPromptInjection` + padrão `sanitize*` (whitelist de saída) |

### 🔧 ESTENDER (existe, mas precisa de acréscimo aditivo)

| Item | O que estender | Por quê |
| --- | --- | --- |
| `ContextEngineService` | Adicionar um modo **resolver** (intent-scoped, budget-bounded) que monta um `ContextPacket` mínimo — não o panorama inteiro | §18/§20 Context Resolver + §6 Progressive Disclosure. É o ponto de extensão natural (AC-A01 proíbe duplicar) |
| `business_goals` | Colunas aditivas `title, baseline, deadline, priority, owner, status` (hoje só `metric, target_amount`) | §14 BusinessGoal first-class rico; hoje é métrica→alvo (revenue/appointments) |
| `geminiRAG.searchContext` | Retornar **proveniência estruturada** `{documentId, chunkIndex, source, title, score}` em vez de `string[]` | §49 preservar document_id/chunk/source/timestamp; dado existe nas linhas, é descartado |
| `basis` (fact/estimate/hypothesis) | Mapear/refinar pro fact-type do PRD (observed/declared/calculated/inferred/derived/external) — aditivo, não sistema novo | §26 taxonomia de 6; o `basis` já separa dado de interpretação |
| `EvidencePackage` / snapshot metric | Granularidade `EvidenceReference` (`observedAt`, `field`, confidence-por-valor) | §24 hoje há `{value, basis, source}` + `sources[]`, falta observedAt/field/per-value |
| `ContextProjectionService` redaction | Redaction por **propósito/skill/execução** além de papel | §70 hoje só por papel |

### 🧩 COMPOR (montar a partir do que existe — sem motor/tabela nova)

| Item | Composto de |
| --- | --- |
| **Business Moment** (§17) | `attention()` + domínios do snapshot + `BusinessGoalService.progress()` — view read-only |
| **Context Quality** (§75) | coverage(`dataQuality.pct`) + confidence(`EvidencePackage`) + freshness + contagem de conflitos |
| **Signal Context Enrichment** (§38/§39) | sinal + resolver + `goalGapsByDomain` (correlação a meta já existe) + constraints |
| **Priority support** (§41) | `ImpactPrioritizationService.components` já emite os fatores |
| **skillHints** (§21) | derivar de `recommendedProcessType`/`ACTION_MAP`/domínio → campo de pista no packet (sem selecionar/executar skill — isso é PRD 4) |
| **Context Coverage** (§34) | `dataQuality` + disponibilidade por domínio (`available:false`) |
| **Business Profile** (§32) | view sobre `organization_settings` + `business_manifesto` + `business_goals` + `brand_profiles` + blueprint `config_json` (não um objeto novo) |

### 🆕 CRIAR (genuinamente ausente — net-new mínimo)

| Item | Por quê é novo | Escopo |
| --- | --- | --- |
| **`ContextPacket`** (§20) — o envelope de saída | Não existe como tipo; é o principal contrato pro PRD 4 | Tipo + montagem por composição |
| **`ContextRequest`** (§19) — a entrada | Não existe | Tipo |
| **`ContextScope`** (§8) — escopo multidimensional (GLOBAL…TIME_WINDOW) | Não existe como enum/tipo (os FKs de escopo existem soltos) | Tipo + resolução |
| **`ContextResolverService`** (§73) — pipeline de 15 passos | Orquestra serviços existentes; a "cola" é nova, o conteúdo é reúso | Serviço (composição-pesada) |
| **`BusinessConstraint`** (§15) | Sem modelo de 1ª classe (só `negotiator_max_discount`, bands, budgets soltos) | Tabela pequena + serviço |
| **`ContextConflict` + precedência de fonte** (§30/§31/§72) | Ausente; só `RetailReconciliationService` sinaliza divergência de 1 par de campos | Resolver + config de precedência por domínio |
| **Context Snapshot na decisão** (§52/§53) | Quase ausente (só `baseline_json`/`premises_json`); falta congelar a evidência que justificou a decisão | Reusa `canonicalize` + tabela/registro imutável linkado à decisão |
| **`ContextCandidate`** (§37) — estados DETECTED/PENDING/CONFIRMED/REJECTED/EXPIRED | `DecisionActionService`+inbox Fala Tu são próximos; formalizar o contrato de candidato de **contexto/regra** (não de ação) | Compor/estender sobre os dois |
| **Guarda data-vs-instrução** (§71) | Primitivas existem (isPromptInjection + sanitize) mas não há camada única que isole conteúdo externo não-confiável antes da LLM | Serviço fino reusando as primitivas |

### ⏸️ DEFERIR (o próprio PRD exclui — §83)

Skill Registry/Runtime/Factory · Tool Search · Execution Runtime completo · Policy Engine
completo · Progressive Autonomy (já existe parcial, ADR-159) · Impact Ledger novo · Learning
Engine completo. **Provider adapter model-agnostic completo (§85/§86):** o Context Engine é
`READ+DERIVE` e majoritariamente determinístico (§90) — **não depende de LLM** pra resolver
contexto, então o requisito model-agnostic é atendido *por não usar LLM no caminho crítico*; o
seam de provider pro `llm.chat/embed` (hoje acoplado à OpenAI) fica pra quando for necessário.

---

## Mapa contrato do PRD → casa no repo (síntese)

| Contrato PRD 3 (§84) | Status | Casa / ação |
| --- | --- | --- |
| `ContextPacket` | 🆕 CRIAR (tipo) | novo envelope, montado por composição |
| `ContextScope` | 🆕 CRIAR (tipo) | novo; FKs de escopo já existem |
| `ContextEntity` | 🧩 COMPOR | projeção sobre `contacts`/`products_services`/`retail_stores`/`employees`/… |
| `ContextFact` | 🔧 ESTENDER | `SignalInput`/`evidence_json` + `{value,basis,source}` do snapshot |
| `EvidenceReference` | 🔧 ESTENDER | granularidade sobre `EvidencePackage.sources` + `source_entity_*` |
| `BusinessGoal` (rico) | 🔧 ESTENDER | `business_goals` + colunas title/baseline/deadline/priority/owner/status |
| `BusinessConstraint` | 🆕 CRIAR | ausente |
| `ContextQuality` | 🧩 COMPOR | dataQuality+confidence+freshness+conflitos |
| `SkillHints` | 🧩 COMPOR | de `recommendedProcessType`/`ACTION_MAP` |

---

## Fases → fatias (§99-111, nada de big-bang §113; shadow mode §114)

| Fase PRD | Escopo | Tipo dominante | Fatia sugerida |
| --- | --- | --- | --- |
| **F0** | Esta reconciliação | doc | **1 PR (este)** |
| ~~**F1**~~ ✅ | Core Context Model — **ENTREGUE**: `src/server/contextModel.ts` (puro, sem DB/LLM) — `ContextScope`(23 níveis)/`ContextEntity`/`ContextFact`/`ContextRelationship`/`EvidenceReference`/`ContextSource`(+precedência §30/§72)/`ContextFreshness`/`ContextConflict`(+`detectConflict`/`resolveConflictByPriority` §31) + `factTypeFromBasis`(§26)/`confidenceBand`(§27)/`freshnessOf`(§28) + mappers `factFromSignal`/`evidenceFromSignal` (traduz SignalInput≈ContextFact, nunca inventa §25). `test:context-model` (26 checks) | CRIAR (tipos) + ESTENDER | ✅ |
| ~~**F2**~~ ✅ | Context Graph — **ENTREGUE**: `src/server/ContextGraphService.ts` (read-only, sem tabela/coluna nova). Travessia BFS sobre os FKs que já existem (department↔parent/manager · cost_center↔dept/store/owner · store↔manager/contact · inventory_location↔store/dept/responsible · employee↔user/manager/role · product↔supplier via pedido · X↔organization) → `ContextEntity[]`+`ContextRelationship[]` (contratos F1). Direção canônica filho→pai; dedup por `from\|type\|to`. Guardrails duros testados: RN-CG-1 isolamento (FK cross-tenant não resolve), RN-CG-2 não-inventa (FK pendurada não vira nó), RN-CG-3 read+derive, RN-CG-4 limitado (maxDepth/maxNodes/fanLimit + `truncated`), RN-CG-5 org enumera estrutura só como âncora. `test:context-graph` (38 checks) | COMPOR | ✅ |
| ~~**F3**~~ ✅ | **Context Resolver** — **ENTREGUE**: `src/server/ContextResolverService.ts` + contratos I/O em `contextModel` (`ContextRequest`/`ContextPacket`/`ContextMoment`/`SkillHint`/`ContextQuality` + `resolveBudget`/`PROFILE_BUDGETS`). `resolve(orgId, request)` monta um `ContextPacket` mínimo-e-relevante por intent (§6): momento←`attention` · fatos←`business_signals`/`factFromSignal`(F1) escopados ao sujeito da âncora · grafo←`ContextGraphService`(F2) · metas←`BusinessGoalService.progress` · pistas←`ImpactPrioritizationService`(recommendedActionType, §21) · qualidade←`dataQuality` (cobertura+confiança+frescor+conflito+lacunas, §75). Âncora vem de `focus` ou da dimensão mais específica do escopo; âncora que não resolve → `anchor:null` (não inventa). Orçamento por perfil (minimal/standard/deep) + overrides + `truncated`. `ContextEngineService.resolve` delega (fachada única, AC-A01). Guardrails RN-CR-1..5. `test:context-resolver` (29 checks) | CRIAR (composição) | ✅ |
| ~~**F4**~~ ✅ | BusinessGoal (rico) + BusinessConstraint — **ENTREGUE**: (1) `business_goals` +aditivos `title/baseline/deadline/priority/owner/status` (§14); `BusinessGoalService.set` update PARCIAL (preserva o não informado), `list` traz os ricos, `progress` só conta ATIVAS por padrão + ordena por prioridade + `attainmentFromBaselinePct` do baseline. (2) `business_constraints` (tabela nova) + `BusinessConstraintService` (§15): CRUD + `applicable(scope)` (global + escopo), kinds discount_ceiling/budget_limit/margin_floor/payment_term_max/policy/custom, isolado/auditado, READ+DERIVE (sem enforcement — gate no RBAC). (3) `ContextPacket` ganha `constraints: ContextConstraint[]` (aplicáveis à âncora) + metas ricas fluem. Rotas `/api/goals` (rico) e `/api/constraints` (CRUD, gestor). Guardrails RN-BC-1..4. `test:business-constraints` (29 checks); F1/F2/F3/business-goals/goal-aware-priority seguem verdes | ESTENDER + CRIAR | ✅ |
| ~~**F5**~~ ✅ | Signal Enrichment — **ENTREGUE**: `src/server/SignalEnrichmentService.ts` (compose-only, sem tabela/coluna nova). `enrich(orgId, signalId)` monta o CONTEXTO de um sinal do Radar (a ponte percepção→contexto pro Maestro): âncora no SUJEITO do sinal (subject_type→entidade do grafo F2, só quando resolve — senão anchor:null) · pacote do resolver (F3) escopado ao domínio · lente de prioridade (`ImpactPrioritizationService.scoreOne` — MESMO cálculo do feed, exposto p/ 1 sinal, reúso do `scoreSignal` privado) com score/impactLevel/ação recomendada/SLA/irreversibilidade · meta AMEAÇADA (`affectedGoal` do goalGapsByDomain) · restrições aplicáveis (F4, já no pacote) · correlatos do mesmo sujeito (§39). O sinal vira `ContextFact` (F1). Rota `GET /api/signals/:id/context` (`?profile=`). Guardrails RN-SE-1..5 (isolamento→found:false p/ outro tenant · não-inventa âncora · READ+DERIVE · estende não duplica · mínimo). `test:signal-enrichment` (26 checks); F1/F2/F3/business-constraints/goal-aware-priority/impact-prioritization seguem verdes — 0 regressão | COMPOR | ✅ |
| ~~**F6**~~ ✅ | Fala Tu Context Capture — **ENTREGUE**: `context_candidates` (tabela nova) + `ContextCandidateService.ts` + contrato `ContextCandidate` em `contextModel` (estados DETECTED→PENDING→CONFIRMED/REJECTED/EXPIRED + `canTransitionCandidate`, §37). Um candidato de CONTEXTO/REGRA (não de ação): mudança PROPOSTA ao contexto (restrição/regra ou fato) capturada do Fala Tu / detector, que só afeta o contexto depois de CONFIRMADA por humano — nunca em silêncio (§36). `confirm` é o ÚNICO ponto que promove: kind=constraint → `BusinessConstraintService.create` (F4); kind=fact → `BusinessSignalService.publish` (ADR-136) — reúso, não duplica (RN-CC-5). `detect`/`reject`/`expireStale` NUNCA promovem. Promovido = EXATAMENTE o `proposed` (não inventa §25). Rotas `/api/context-candidates` (list/get/POST detect/submit/confirm/reject, gestor). Guardrails RN-CC-1..5. `test:context-candidate` (30 checks); F1–F5 + business-constraints/impact-prioritization seguem verdes — 0 regressão | ESTENDER + CRIAR | ✅ |
| ~~**F7**~~ ✅ | RAG + Memory como evidência — **ENTREGUE**: `geminiRAG` ESTENDIDO (sem tabela nova). `loadOrgChunks` preserva a proveniência que a linha já carregava e era descartada (`document_id`/`chunk_index`/`created_at` + título via join a `knowledge_documents`). Novo `RagHit` (proveniência estruturada: documentId/chunkIndex/title/source/score/observedAt) + `rankChunksToHits` (PURO — filtro canal/área + topK + score, testável sem embed) + `searchContextRich` (I/O em volta). `searchContext` (string[]) segue como projeção retrocompat — 0 quebra nos callers (AIOrchestrator/generateRagResponse). Mapper `evidenceFromRagHit` (contextModel) traduz um hit em `EvidenceReference` (§24) APPROVED_DOCUMENT (sourceId=documentId, field=chunk:N, confidence=score) — RAG/memória viram evidência de 1ª classe rastreável; não inventa (§25). `test:rag-provenance` (21 checks, determinístico sem chave de IA); context-model/falatu-rag/falatu-embeddings + F3/F5/F6 seguem verdes — 0 regressão | ESTENDER | ✅ |
| ~~**F8**~~ ✅ | Context Quality — **ENTREGUE**: `ContextQualityService.ts` (COMPOR, sem tabela nova) + `ContextQualityReport`/`ContextCoverageItem` em `contextModel`. A matemática do resumo (`assessFromFacts`: cobertura+confiança+banda+frescor+conflitos+lacunas) foi EXTRAÍDA do `ContextResolverService.computeQuality` (F3) pra cá — o resolver agora DELEGA (fonte única, `packet.quality` idêntico → 0 regressão). Sobre isso, o relatório RICO: `coverageByItem` (§34 disponibilidade por-fonte, available true/false) · `conflictsDetailed` (§31 conflito entre fontes REPORTADO com valores em disputa, não só a contagem) · `evidenceSummary` (§24 proveniência agregada por tipo, FUNDINDO a evidência estruturada do RAG/F7 via `evidenceFromRagHit`). `assess()` resolve o pacote (import dinâmico quebra o ciclo) e consolida; exposto pela fachada `ContextEngineService.quality` + rota `GET /api/context/quality`. Guardrails RN-CQ-1..5. `test:context-quality` (19 checks); F1/F3/F5/F6/F7/context-engine seguem verdes — 0 regressão | COMPOR | ✅ |
| ~~**F9**~~ ✅ | Security — **ENTREGUE** (REUTILIZAR + CRIAR): (1) `ContextGuardService.ts` — a guarda ÚNICA data-vs-instrução (§71): `classify` (heurística de injeção consolidada das cópias do AIOrchestrator+geminiRAG) + `neutralize` (DEFANG: remove chars de controle + DESARMA o sentinela do cerco — sem quebra de cerco, RN-CG-1) + `fence` (embrulha em `<untrusted_external_data>` e propaga `suspicious`; isolar > censurar). (2) `ContextProjectionService.projectPacket` (§68/§70) — projeta o `ContextPacket` (F3) por PAPEL **+ PROPÓSITO**: redige objeto de fato/atributo de entidade/valor de restrição sensível; `redact`→`redactWith` parametrizado; `PURPOSE_FORBIDDEN` (customer_facing redige custo/margem/PII **mesmo pro dono**, §70 além-do-papel); dono full sem propósito → CRU (0 regressão); manifesto de paths redigidos. Fachada `ContextEngineService.resolveFor` (resolve+projeta, porta única entregável). (3) Testes DELIBERADOS de isolamento cross-tenant (§93). Guardrails RN-CG-1..3 + a redação fail-closed reusada. `test:context-security` (21 checks); falatu-context-projection/F1/F3/F7/F8 seguem verdes — 0 regressão | REUTILIZAR + CRIAR | ✅ |
| ~~**F10**~~ ✅ | Contratos SkillOS — **ENTREGUE** (validação): `CONTEXT_PACKET_SCHEMA_VERSION` + `validateContextPacket`/`assertContextPacket` em `contextModel` (puro, determinístico). Blinda o `ContextPacket` como CONTRATO estável do PRD 4 (AC-A05/§127): valida forma + tipos + schemaVersion + budget completo + moment/quality bem-formados + as INVARIANTES (budget RESPEITADO — array acima do teto FALHA; confiança em [0,1] com banda válida; frescor inteiro ≥0; truncated coerente). Junta TODAS as violações (não para na 1ª). O resolver passa a emitir a constante (era literal `1`). Fachada `ContextEngineService.validatePacket` delega. `test:context-contract` (20 checks — todo pacote real resolvido passa em minimal/standard/deep; malformações pegas com erro preciso); F1/F3/F7/F8/F9 seguem verdes — 0 regressão | validação | ✅ |
| ~~**F11**~~ ✅ | Observability — **ENTREGUE** (COMPOR, 0 tabela nova): `ContextMetricsService.ts` — métricas DERIVADAS por query (RN-004). `forPacket` (PURO): tamanho do pacote (facts/entities/…), truncated, cobertura/confiança/banda, conflitos/lacunas, utilização do orçamento (0..1, clampada), proveniência por tipo + atalho de RAG (reusa `evidenceSummary` F8/F7). `snapshot(orgId)`: resolve pacote representativo (F3) + momento do `business_signals` (por domínio/severidade, RN-004) + token economy do `ai_usage_log` (§55, janela `sinceDays`). Fachada `ContextEngineService.metrics` + rota `GET /api/context/metrics`. Guardrails RN-CM-1..4 (isolamento, deriva-não-materializa, read-only, reusa). `test:context-metrics` (18 checks); F1/F3/F7/F8/F9/F10 seguem verdes — 0 regressão | COMPOR | ✅ |
| ~~**F12**~~ ✅ | Hardening — **ENTREGUE** (testes, FECHA O PRD 3): `contextGolden.ts` — utilitários golden REUSÁVEIS pro PRD 4 (§98): `canonicalizeContextPacket` (normaliza os campos voláteis — org sorteada→`<org>`, uuid→`<uuid>`, timestamp→`<ts>`, `ageMs`→`<age>` — e ordena chaves) + `goldenStringify` + `firstGoldenDiff` (aponta ONDE quebrou). `test:context-golden` (14 checks): REPRODUTIBILIDADE (mesma org 2×→idêntico), GOLDEN cross-tenant (2 orgs c/ mesmos insumos→canônico idêntico: pureza/isolamento), SENSIBILIDADE (insumo a mais muda), VALORES travados (momento/fato/qualidade de cenário conhecido), CONTRATO F10 em todo golden, cenário vazio estável. Todas as 11 suítes de contexto (F1/F2/F3/F5/F6/F7/F8/F9/F10/F11 + golden) verdes — 0 regressão | testes | ✅ |

## Guardrails que NÃO se regridem (anti-patterns §123)

- **Não duplicar** `BusinessContextService`/`ContextEngineService` (AC-A01) — estender.
- **Context Engine não executa** (AC-A02/§90) — `READ + DERIVE`, sem Skill Runtime (AC-A03) nem Policy Engine completo (AC-A04).
- **Não inventar contexto** (§25): ausência → `unknown`, nunca valor arbitrário; inferência marcada (`basis`/fact_type).
- **Não enviar tudo pra IA** (§6/§123): Progressive Disclosure + context budget; medir tokens antes/depois.
- **Não misturar** política/execução/skill com contexto; **não ocultar conflitos** (§31); **não usar dado velho como atual** (freshness); **zero vazamento entre tenants** (§93, testes deliberados).
- **Invisível pro usuário comum** (§124): sem dashboard obrigatório; a complexidade fica embaixo.
- **`ContextPacket` estável pro PRD 4** (AC-A05) — a interface é o contrato entre os dois PRDs (§127).

## PRD 3 — Business Context Engine: **FECHADO** ✅ (F1–F12, 12 fatias)

Todas as 12 fatias entregues e em produção. O motor entrega um `ContextPacket`
mínimo-e-relevante por intent — momento/fatos/grafo/metas/constraints/qualidade/
segurança —, com contrato blindado (F10), observabilidade (F11) e golden tests
reusáveis (F12). A interface (`ContextPacket` + `contextGolden`) é o contrato
estável pro PRD 4 (SkillOS). 11 suítes de contexto verdes; aditivo sobre a Onda 0.

### (histórico) Fatia entregue: **F12 — Hardening (golden tests)**

`contextGolden.ts` (canonicalize/goldenStringify/firstGoldenDiff, REUSÁVEIS pro
PRD 4) + `test:context-golden` (14 checks): reprodutibilidade, golden cross-tenant
(pureza/isolamento), sensibilidade, valores travados, contrato F10, vazio estável.
FECHA O PRD 3. ✅

### (histórico) Fatia entregue: **F11 — Observability**

`ContextMetricsService` — métricas internas do Context Engine DERIVADAS por query
(RN-004, 0 tabela nova): `forPacket` (tamanho/corte/cobertura/confiança/orçamento/
proveniência) + `snapshot` (momento do `business_signals` + token economy do
`ai_usage_log`). Fachada `ContextEngineService.metrics` + `GET /api/context/metrics`. ✅

### (histórico) Fatia entregue: **F10 — Contratos SkillOS**

Validador determinístico do `ContextPacket` (`validateContextPacket`/`assert` +
`CONTEXT_PACKET_SCHEMA_VERSION`) — blinda a interface PRD 3 ↔ PRD 4 (AC-A05/§127)
contra regressão silenciosa (forma + tipos + invariantes de budget/confiança/
frescor). Fachada `ContextEngineService.validatePacket`. ✅

### (histórico) Fatia entregue: **F9 — Security**

(1) `ContextGuardService` — guarda ÚNICA data-vs-instrução (§71): classify +
neutralize (sem quebra de cerco) + fence. (2) `ContextProjectionService.projectPacket`
— projeção por papel + PROPÓSITO (§70) do `ContextPacket`, redação fail-closed +
manifesto; fachada `ContextEngineService.resolveFor`. (3) Testes deliberados de
isolamento cross-tenant (§93). ✅

### (histórico) Fatia entregue: **F8 — Context Quality**

COMPOR a qualidade do contexto como leitura de 1ª classe: `assessFromFacts`
(extraído do resolver — delegação, 0 regressão) + relatório rico (cobertura
por-fonte §34 + conflitos detalhados §31 + proveniência agregada §24 fundindo o
RAG da F7). Fachada `ContextEngineService.quality` + `GET /api/context/quality`. ✅

### (histórico) Fatia entregue: **F7 — RAG + Memory como evidência**

ESTENDER `geminiRAG` pra devolver **proveniência estruturada** (`RagHit` —
documentId/chunkIndex/source/title/score/observedAt) em vez de só `string[]`, +
`evidenceFromRagHit` (RAG/memória viram `EvidenceReference` de 1ª classe).
Retrocompat total: `searchContext` (string[]) segue como projeção. ✅

### (histórico) Fatia entregue: **F6 — Fala Tu Context Capture (`ContextCandidate`)**

ESTENDER sobre `DecisionActionService`/inbox do Fala Tu: `ContextCandidate`
(DETECTED/PENDING/CONFIRMED/REJECTED/EXPIRED) — candidato de CONTEXTO/REGRA (não de
ação), SEM alteração silenciosa de política (§36). `confirm` promove pelos serviços
da 1ª classe (constraint/signal). Net-new mínimo (tabela + contrato de estados). ✅

### (histórico) Fatia entregue: **F5 — Signal Enrichment (PRD 2 → contexto)**

COMPOR o **enriquecimento de sinal**: dado um sinal do Radar (PRD 2), montar seu
contexto (resolver ancorado no sujeito do sinal + meta ameaçada via
`goalGapsByDomain` + constraints aplicáveis + correlatos) — a ponte percepção→
contexto que o Maestro consome. Reúso puro; sem tabela nova. ✅

---

## (histórico) Fatia recomendada a seguir: **F1 — Core Context Model**

Menor incremento que destrava tudo, aditivo, risco ~zero, e é literalmente a interface que o
PRD 4 vai consumir. Define os **tipos estáveis** (`ContextScope`, `ContextEntity`, `ContextFact`,
`EvidenceReference`, `ContextSource`, `ContextFreshness`, `ContextConflict`) — a maioria com
tradução direta do que já existe (`ContextFact` ≈ `SignalInput`; `EvidenceReference` ≈
`source_entity_*`+`sources[]`; `ContextFreshness` ≈ `expires_at`/`freshness`). Sem tabela nova
obrigatória (tipos + validação); um `ContextResolverService` esqueleto pode nascer aqui devolvendo
um `ContextPacket` montado só do snapshot+attention+goals pra um intent, provando o fluxo do DoD
(§129: `Signal → Resolver → Packet → Quality → Maestro`) em **shadow mode** (§114) — sem afetar
produção.
