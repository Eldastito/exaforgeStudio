# Análise PRD Fase 5 (Intelligence Network, Playbooks Verticais e Escala Multiempresa) × código existente

F5.0 — doc-only, 2026-10-10. Auditoria feita por varredura do repositório (`src/server`, `docs/adr`); veredictos de alguns serviços vêm de cabeçalhos e nomes, não de leitura integral (marcados com †). O banco do repositório tem 0 organizações: nenhuma amostra real foi medida.

## 1. Resumo

O PRD descreve 59 pontos. Quase todos têm uma base parcial no código; **nenhum item é "do zero" em motor**. A Fase 5 só pode ser feita como **extensão por lacuna** (ADR-166 RN-EL-9 / §184 proíbem motor paralelo). Três blocos do PRD **contradizem decisões já registradas** e dependem de decisão do dono (seção 4).

## 2. Item → status → evidência → lacuna

| # | PRD | Status | Já existe | Falta |
|---|---|---|---|---|
| 1 | Knowledge Governance (origem/escopo/status/validade/conflito/proveniência) | PARCIAL (fraco) | `PatternMemoryService.decide()` (humano obrigatório, histórico append-only `business_pattern_decisions`); `stageOf()`; `business_patterns.status`; `ManagerSolutionService` (FSM draft→promoted); `AutonomyKillSwitchService` | `valid_from`/`valid_until`; estado `expirado`; hipótese como estado explícito; escopo formal; **detecção de conflito entre regras (não existe)**; campo padronizado de origem; `refuted` declarado e nunca atribuído |
| 2 | Business Archetypes | PARCIAL (1 eixo) | `RetailReplenishmentStrategyService` (`continuous_replenishment`/`collection_sellout`, `organization_settings.retail_replenishment_strategy`); 11 verticais em `verticals.ts`; blueprints versionados | catálogo de arquétipos; preset por vertical×arquétipo; "moda" é vertical única |
| 3 | Playbook Registry versionado | PARCIAL | `PlaybookEngine` (puro); `process_definitions` (versão, `autonomy_level_default`, condições, `UNIQUE(org,type,version)`); playbooks de domínio em código (`SalesRecoveryPlaybook`, `RetailClosingPlaybook`, `CollectionPlaybook`) | registry de PLATAFORMA (hoje é por org); vertical, arquétipo, risco, autonomia máxima, pré-condições, eficácia por versão |
| 4 | Shadow / escada de autonomia / regressão automática | PARCIAL | níveis 0–3 (`ApprovalPolicyService`), `execution_mode` shadow/assisted/approved_execution/autonomous, `ProgressiveAutonomyService` (só propõe SUBIR), `GrowthAutopilotService` (off/shadow), `MissionService`, `ExternalEffectShadowService`, escada SkillOS | **regressão automática não existe** (só `AutonomyKillSwitch`/`SkillOsRolloutService.stepDown` manuais); 4 escadas paralelas não unificadas; não há "experimental" |
| 5 | Sandbox/backtest de playbook | PARCIAL (só previsão) | `ForecastBacktestService`, `ScenarioEngine`, `ExternalEffectShadowService` | rodar playbook sobre histórico NÃO existe; ADR-205 §17 declara falta de histórico por vendedor/dia conferido |
| 6 | Eficácia por versão/vertical/tamanho | PARCIAL | `PatternMemoryService.assuredStats`, `LearningEpisodeService`, `InterventionEffectivenessService`, Wilson, `LearningMetricsService` | tudo por org; sem corte por versão de playbook, vertical ou porte |
| 7 | Inteligência anonimizada entre clientes / benchmark | PARCIAL (só mercado externo) | `vertical_intelligence` (sem org), `researchAnonymize`, `ResearchBrokerService` (ADR-156/157); `StoreBenchmarkService`/`GroupIntelligenceService` (≥3 operações, mesmo grupo) | **benchmark ENTRE empresas não existe**; anonimização de MÉTRICAS de tenant não existe (a atual cobre texto de pesquisa); k-anonimato; consentimento |
| 8 | Precedência organization>archetype>vertical>platform | NÃO EXISTE (só peças) | `applyVertical`, blueprints, `platform_settings`, `organization_settings`, `BrandVerticalProfileService` (inherited/overlay) | resolvedor de configuração em camadas |
| 9 | Orquestração multi-competência por trás do FalaTu | PARCIAL | `SkillOsPlannerService`†, `SkillOsResolverService`†, `MissionService`, `FalaTuMultiActionService` | `MaestroService` NÃO é orquestrador (só handoff/Vision); ponte FalaTu↔Planner SkillOS não evidenciada; resolução de divergência entre competências |
| 10 | Control Tower de grupo / políticas herdáveis / shared services | PARCIAL (leitura) | `GroupConsolidationService`, `GroupIntelligenceService`, `OrgGroup*`, `account_identities` (ADR-199) | **políticas herdáveis e shared services contradizem ADR-199** (RN-GRP-01; não-objetivos) |
| 11 | Onboarding conversacional | PARCIAL | `AdaptiveOnboardingService` (uma lacuna por vez), `OnboardingTemplateService`, cards de vertical | extração por linguagem natural; inferência de vertical/modelo (vertical e plano são recusados pelo RN-UX-3) |
| 12 | Strategic Policy (pesos, prioridade temporal) | PARCIAL | `BusinessGoalService` (priority, deadline), `StrategicPlanService` | pesos numéricos; política que condicione recomendações da IA; ligação com `ImpactPrioritizationService` |
| 13 | Aprendizado negativo | PARCIAL | desfecho negativo medido, `learningPrior` assimétrico, `suggestedRefutation`, `rejection_reason` livre | pergunta ativa "por que não funcionou?" com motivo estruturado |
| 14 | Product/Customer Intelligence, NBA | PARCIAL (fraco) | `product_variants` (cor/tamanho), `ProductOpportunityService`, `CustomerProfileService`, `ChurnRiskDetectorService`, `vectorSimilarity` | desempenho por atributo; similaridade de produto; segmentos dinâmicos; Next Best Action formal |
| 15 | Confidence Budget | PARCIAL | `SkillOsConfidenceService`, gates por tipo de ação (`minConfidence`, `maxExecuteAmount`, `maxDataAgeMinutes`), bandas valor→papel | política risco→confiança mínima; orçamento que se consome |

## 3. Contradições com decisões registradas

1. **Aprendizado/benchmark entre clientes** × ADR-166 D10/RN-EL-7/§79 ("cross-tenant FORA"), ADR-199 RN-GRP-01, ADR-205 §16–17. Não existe contrato/consentimento de contribuição de dados do tenant (o único consentimento é do cliente final do PDV).
2. **Regressão automática de autonomia** × RN-014/RN-F3-3 (a IA nunca altera a própria autonomia). Rebaixar é mais seguro que subir, mas não está coberto.
3. **"Auto" na escada** × ADR-204 D1 (Nível 4 bloqueado, `level4Blocked`). A escada precisa dizer se "auto" é o Nível 3 existente.
4. **Políticas herdáveis de grupo / shared services** × não-objetivos do ADR-199.
5. **Pré-requisito não cumprido**: ADR-204 §28.5 exige piloto ≥2 semanas, calibração e decisão D3/consentimento antes de nova camada de inteligência; ADR-205 §17: nada da Fase 4 foi validado.
6. **Três FSMs de governança de conhecimento já existem** (`business_patterns`, `ManagerSolution`, `skillos_rollout`): devem ser reconciliadas, não duplicadas.

## 4. O que NÃO depende de decisão sobre dados entre clientes

F5.1–F5.5 (governança de conhecimento, arquétipos, registry, shadow, avaliação) funcionam só com a TOULON e só dentro de cada org. F5.6/F5.7 (rede e benchmark entre empresas) **não têm dado hoje** (0–1 cliente) e dependem de decisão + base contratual/LGPD.
