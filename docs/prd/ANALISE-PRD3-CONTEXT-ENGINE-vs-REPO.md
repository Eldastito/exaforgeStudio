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
| **F5** | Signal Enrichment (PRD 2 → contexto) | COMPOR | sinal + resolver + goal/constraint |
| **F6** | Fala Tu Context Capture — `ContextCandidate` (sem alteração silenciosa de política §36) | ESTENDER | sobre `DecisionActionService`/inbox |
| **F7** | RAG + Memory como evidência (proveniência estruturada) | ESTENDER | `searchContext` structured |
| **F8** | Context Quality — coverage/freshness/confidence/conflicts/gaps | COMPOR | |
| **F9** | Security — RLS(app-level)/RBAC/redaction/isolamento/audit + guarda data-vs-instrução | REUTILIZAR + CRIAR | |
| **F10** | Contratos SkillOS — validar `ContextPacket` estável pro PRD 4 | validação | sem SkillOS |
| **F11** | Observability — métricas (§55/§120) internas | COMPOR | reusa `ai_usage_log`/health |
| **F12** | Hardening — testes (unit/integração/multi-tenant/segurança/golden §97) | testes | golden context tests reusáveis no PRD 4 (§98) |

## Guardrails que NÃO se regridem (anti-patterns §123)

- **Não duplicar** `BusinessContextService`/`ContextEngineService` (AC-A01) — estender.
- **Context Engine não executa** (AC-A02/§90) — `READ + DERIVE`, sem Skill Runtime (AC-A03) nem Policy Engine completo (AC-A04).
- **Não inventar contexto** (§25): ausência → `unknown`, nunca valor arbitrário; inferência marcada (`basis`/fact_type).
- **Não enviar tudo pra IA** (§6/§123): Progressive Disclosure + context budget; medir tokens antes/depois.
- **Não misturar** política/execução/skill com contexto; **não ocultar conflitos** (§31); **não usar dado velho como atual** (freshness); **zero vazamento entre tenants** (§93, testes deliberados).
- **Invisível pro usuário comum** (§124): sem dashboard obrigatório; a complexidade fica embaixo.
- **`ContextPacket` estável pro PRD 4** (AC-A05) — a interface é o contrato entre os dois PRDs (§127).

## Fatia recomendada a seguir: **F5 — Signal Enrichment (PRD 2 → contexto)**

Com F1–F4 no lugar (contratos + grafo + resolver + metas ricas/constraints), o
pacote já entrega momento/fatos/grafo/metas/constraints/qualidade. O próximo
incremento (§38/§39) é COMPOR o **enriquecimento de sinal**: dado um sinal do
Radar (PRD 2), montar seu contexto (resolver ancorado no sujeito do sinal + meta
ameaçada via `goalGapsByDomain` + constraints aplicáveis) — a ponte percepção→
contexto que o Maestro consome. Reúso puro; sem tabela nova.

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
