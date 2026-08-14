# Runbook — Content & Growth Intelligence Loop (ADR-168 / PRD 11)

Operação da camada que aprofunda a **inteligência criativa** (Brand DNA 2.0, Hook, Roteiro,
adaptação multicanal) e estende a **atribuição para além do engajamento**
(conteúdo → lead → venda → receita → **margem**), para que a **experimentação criativa** e o
**crescimento** escolham o vencedor pelo **resultado de negócio**, não pelo like. Aditivo puro
sobre os PRDs 0–10: **sem** 2º motor de experimento/atribuição/aprendizado/execução/aprovação/
confirmação, **sem** 2º Estúdio/calendário/CRM/meta, **sem** tabela de alerta paralela (§37).

> Regra fundante: **`ENGAGEMENT ≠ BUSINESS VALUE`** (como DONE≠RESULTADO / PUBLISHED≠RESULTADO).
> O like é PROXY; o dinheiro provado (fact) é o resultado. Nada inventa dinheiro nem fonte.

## Mapa dos serviços (F1–F17)

| Fatia | Serviço | Papel |
| --- | --- | --- |
| F1 | `BrandDnaService` | Brand DNA 2.0 estruturado + versionado; voz unificada (`brand_voice_context`, fonte única) |
| F2 | `CampaignObjectiveContractService` | Liga objetivo de campanha → métrica de meta (`BusinessGoalService`) via `correlation_id` |
| F3 | `HookIntelligenceService` | Ganchos de abertura (6 padrões), grounded em tópico+objetivo+Brand DNA (determinístico) |
| F4 | `ScriptIntelligenceService` | Roteiro/storyboard em 5 beats; beat 1 reusa o gancho (F3) |
| F5 | `ChannelAdaptationService` | Adapta conteúdo por canal (legenda/hashtags/formato/CTA/tom) — 6 canais |
| F6 | `CreativeExperimentService` | Motor de experimento (REUSA `ProspectResearchService.twoProportionZ`); campeão por ENGAJAMENTO (proxy) |
| F7 | `ContentLeadAttributionService` + `ContentOutcomeResolver` | conteúdo → LEAD (system-of-record, nunca LLM); resolver no registry do PRD 8 |
| F8 | `ContentRevenueAttributionService` | lead → venda → receita → **margem** (precedência orders>quotes>avg; fact≠estimate) |
| F9 | `CreativeExperimentService.decide` (objective-aware) | **Vencedor por RESULTADO DE NEGÓCIO** sobrepõe o engajamento quando existe |
| F10 | `CreativeLearningService` (2.0) | Motor único (`PatternMemoryService`) aprende "que assinatura VENDE", não "que engaja" |
| F11 | `ProductOpportunityService` | Produto em estoque/alta-margem/parado → `product_opportunity` em `business_signals` (D7) |
| F12 | `BusinessGoalService.METRICS` (`content_revenue`/`content_leads`) | A meta de negócio pode ser o que o CONTEÚDO gerou |
| F13 | `SocialProactivityService.growthBrief` | "O que postar + impacto esperado + campeão" na superfície proativa existente |
| F14 | `FacebookChannelProvider` (+`FacebookService`) | 2º provider social REAL (Graph API de Página), espelha o Instagram |
| F15 | `GrowthAutopilotService` | Postura SHADOW-first (`off`/`shadow`; `auto` rejeitado); PROPÕE, nunca executa |
| F16 | `GrowthOptimizationService` + `GrowthOptimizationCommandHandler` | Aceitar proposta → comando GOVERNADO (`DecisionAction→ApprovalPolicy→CommandExecutor`) |
| F17 | `test:growth-golden-paths` | Prova §47 `ENGAGEMENT ≠ BUSINESS VALUE` ponta-a-ponta (Moda/Clínica/Restaurante) |

## Rotas

`/api/studio/*` (Estúdio):
- **Brand DNA** — `GET/PUT /brand-dna`, `GET /brand-dna/versions[/:version]`, `POST /brand-dna/restore/:version`
- **Objetivo de campanha** — `GET /campaign-objectives`, `GET/POST /campaign-contracts[/:id[/progress|/cancel]]`
- **Criação** — `POST /hooks`, `POST /script`, `GET /channels`, `POST /channel-adaptation`

`/api/social/*` (owner/admin salvo indicado):
- **Experimento** — `POST/GET /experiments`, `GET /experiments/:id`, `POST /experiments/:id/decide`, `GET /experiments/:id/outcome`
- **Atribuição** — `POST /attribution/lead`, `GET /attribution/leads`, `POST/GET /attribution/revenue` (dinheiro role-gated)
- **Oportunidade de produto** — `GET /product-opportunities`, `POST /product-opportunities/match`
- **Crescimento** — `GET /growth-brief`, `GET /growth-autopilot`, `POST /growth-autopilot/mode`
- **Otimização governada** — `GET /growth-optimizations`, `POST /growth-optimizations/propose`, `POST /growth-optimizations/:actionId/execute`

## Passes automáticos (no `Scheduler.tick` — §37, sem 2º Scheduler)

- `ProductOpportunityService.pass()` — orgs com estoque → publica `product_opportunity` (idempotente por dedupe).
- `CreativeLearningService.pass()` — publicações asseguradas → aprendizado forte.

## Fluxo (percepção → conteúdo → experimento → resultado → aprendizado → crescimento)

1. **Marca** — o dono define o Brand DNA (F1); a voz vive em `brand_voice_context` (fonte única).
2. **Criação** — Hook (F3) → Script (F4) → adaptação por canal (F5), tudo grounded no tópico/objetivo.
3. **Experimento** — variantes viram um experimento (F6); cada variante carrega um `correlation_id`.
4. **Atribuição** — publicação gera lead (F7) → venda/receita/margem (F8), sempre perguntando ao
   system-of-record (SQL), nunca ao LLM. `fact` e `estimate` **nunca** somados.
5. **Decisão** — `decide()` (F9): se há resultado de negócio atribuído, ele MANDA (basis
   `business_outcome`); senão cai pro engajamento (proxy). É onde `ENGAGEMENT ≠ BUSINESS VALUE`.
6. **Aprendizado** — a publicação ASSEGURADA (PRD 8) realimenta o motor único (F10) com a
   assinatura criativa que VENDEU.
7. **Meta** — `content_revenue`/`content_leads` (F12) medem o que o conteúdo gerou; o Growth
   Brief (F13) mostra campeão + distância-à-meta.
8. **Crescimento** — o Autopilot (F15, SHADOW) propõe promover o campeão / produto / conteúdo;
   aceitar uma proposta (F16) vira um comando GOVERNADO que nasce `awaiting_approval` e só roda
   depois da aprovação humana (`DecisionAction → ApprovalPolicy → CommandExecutor`).

## Guardrails RN-CG (codificados em `test:content-growth-hardening`)

| Regra | Invariante |
| --- | --- |
| RN-CG-01 | `ENGAGEMENT ≠ BUSINESS VALUE` — o vencedor de negócio sobrepõe o de engajamento |
| RN-CG-02 | Atribuição pergunta ao system-of-record (SQL), nunca ao LLM; não inventa lead |
| RN-CG-03 | Não inventa dinheiro; `fact` ≠ `estimate` (nunca somados); margem `null` sem custo |
| RN-CG-04 | Não plagia concorrente; respeita termos PROIBIDOS do Brand DNA (filtra + caveat) |
| RN-CG-05 | Isolamento cross-tenant (tudo por `organization_id`) |
| RN-CG-06 | Margem/dinheiro role-gated (o SINAL de produto só carrega banda qualitativa) |
| RN-CG-07 | Vencedor exige amostra mínima; sem ela `insufficient_data` (não decide no ruído) |
| RN-CG-08 | Decidir/propor ≠ executar (otimização nasce `awaiting_approval`; plan é read-only) |
| RN-CG-09 | Grounded (proposta obsoleta recusada; hook/roteiro sem tópico recusado) |
| RN-CG-10 | Shadow-first (o autopilot rejeita `auto`; crescimento nunca vai direto pra execução) |
| RN-CG-11 | `PUBLISHED ≠ RESULTADO` (oportunidade/otimização são hipótese até a confirmação) |
| RN-CG-12 | Sem motor/tabela/runtime paralelo (§37 — `business_signals` + `decision_actions` + registry) |

## Rollout

`off` → `shadow` (autopilot só PROPÕE) → aceitar propostas pontuais (F16, governadas por
aprovação humana) → cohort. **Crescimento autônomo nunca vai direto pra execução** (RN-CG-10):
não existe modo `auto`. Todo dinheiro exposto em rota é role-gated (owner/admin/master).

## Troubleshooting

- **"O experimento não decide"** — amostra abaixo do mínimo (`insufficient_data`, RN-CG-07) OU
  empate no resultado de negócio (`inconclusive`). Estenda a amostra; confira as atribuições.
- **"A variante que mais engajou não venceu"** — comportamento CORRETO (RN-CG-01): o resultado de
  negócio (F7/F8) sobrepõe o engajamento. Veja `basis` no retorno de `decide()`.
- **"Receita/margem aparece null/0"** — sem prova no system-of-record (RN-CG-03): pedido não
  pago, custo desconhecido (margem null) ou sem lead atribuído. Não é bug — é honestidade.
- **"A otimização não executou"** — nasce `awaiting_approval` (RN-CG-08/10); precisa de aprovação
  humana no Approval Center antes do `execute`.
- **"O sinal de produto não tem R$"** — por desenho (RN-CG-06): o valor absoluto só sai na rota
  role-gated `GET /product-opportunities`; o sinal carrega só `marginBand` qualitativo.

## Como adicionar um domínio à atribuição de conteúdo

Registre um resolver no `BusinessOutcomeResolverRegistry` (PRD 8) — NÃO crie 2º mecanismo (§37).
O `ContentOutcomeResolver` (F7) é o molde: `appliesTo(action)` filtra `social_publish`,
`resolve(orgId, action)` pergunta ao system-of-record por `correlation_id` e devolve
`confirmed`/`not_confirmed`/`unknown` com `basis: 'system_of_record'` — nunca ao LLM (RN-CG-02).
