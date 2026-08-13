# Runbook — Social Intelligence & Creative Execution (ADR-167 / PRD 10)

Operação da camada final que liga a **inteligência de mercado** às superfícies reais
(**Canais e IA** + **Estúdio**), fechando o ciclo **percepção → conteúdo → publicação
governada → resultado → aprendizado**. Aditivo puro sobre a espinha existente (PRDs 0–9):
**sem** motor/scheduler/policy/confirmation/learning paralelo (§42).

> Tese: o PRD 10 **não é um motor de social media** — é a fiação que faz o cérebro do
> ZapFlow (percepção→contexto→evidência→decisão→governança→execução→confirmação→garantia
> →aprendizado) atuar sobre canais sociais reais. **PUBLISHED ≠ RESULTADO.**

## Mapa dos serviços (F1–F17)

| Fatia | Serviço | Papel |
| --- | --- | --- |
| F1 | `SocialChannelProvider` (+`StubSocialChannelProvider`) | Contrato provider-agnóstico de canal; capabilities DESCOBERTAS; estados §5 |
| F2 | `SocialConnectionService` | Connection Hub: estado por-org, credenciais CIFRADAS, health, capabilities |
| F3 | `InstagramChannelProvider` | 1º provider REAL (envolve `InstagramService`/Graph API) |
| F4 | `SocialAnalyticsService` | Ingestão de posts+analytics próprios → `social_post_metrics` (null≠0) |
| F5 | `CompetitiveIntelligenceProvider` (+Service) | Inteligência competitiva de fonte pública no pipeline do PRD 9 |
| F6 | `VerticalSocialIntelligenceService` | Consolida externo (pool) + próprio (F4) por nicho |
| F7 | `OpportunityMatchingService` | Cruza F6 × momento da org → oportunidade em `business_signals` |
| F8 | `StudioBriefService` | Oportunidade → briefing orientado pro Estúdio |
| F9 | `CreativeVariantService` | Briefing → variantes A/B/C |
| F10 | `EditorialCalendarService` | Calendário draft→approved + best-time (derivado da F4) |
| F11 | `SocialPublishCommandHandler` + `GovernedPublishService` | Publicação = comando GOVERNADO (D4) + idempotência durável |
| F12 | `SocialAttributionService` | Confirmação `social_publish` × analytics → outcome (Outcome Assurance) |
| F13 | `CreativeLearningService` | Publicação ASSEGURADA → `PatternMemoryService` (motor único) |
| F14 | `SocialProactivityService` | Digest social nas superfícies proativas existentes (Fala Tu/Radar) |
| F15 | `SocialEntitlementService` | Gate de plano server-side (mapeia p/ módulo `estudio`) |

## Rotas (`/api/social/*`, owner/admin salvo indicado)

- **Conexão** — `GET/PUT/DELETE /connections[/:channel]`, `POST /connections/:channel/health`
- **Analytics** — `POST /analytics/:channel/sync`, `GET /analytics/:channel`
- **Inteligência de nicho** — `GET /vertical-intelligence`
- **Oportunidade** — `POST /opportunities/match`
- **Estúdio** — `GET /studio/opportunities`, `GET /studio/brief/:signalId`, `GET /studio/variants/:signalId`
- **Calendário** — `GET/POST /studio/calendar`, `POST /studio/calendar/:id/approve`, `DELETE /studio/calendar/:id`, `GET /studio/best-time`
- **Publicação GOVERNADA** — `POST /publish` (propõe; **402 + upgrade** se fora do plano), `POST /publish/:actionId/execute`
- **Atribuição** — `POST /attribution/resolve`, `GET /attribution`
- **Aprendizado** — `POST /creative-learning/sweep`, `GET /creative-learning`
- **Proativo / plano** — `GET /proactive`, `GET /entitlement`
- **Competitiva (master-only)** — `POST /api/decision-intelligence/competitive-intelligence/gather`

## Fluxo ponta-a-ponta (o que roda sozinho vs. sob demanda)

```
pesquisa externa (VI/competitiva, master)         [sob demanda / semanal]
  → SocialAnalyticsService.pass()                 [Scheduler.tick, horário]
  → OpportunityMatchingService.pass()             [Scheduler.tick] → business_signals (attention)
  → [humano] Estúdio: brief → variante → gerar arte
  → GovernedPublishService.propose                [humano/UI] → aprovação (ou Autonomy Contract)
  → CommandExecutor.execute (SocialPublishCommandHandler) → publica + ConfirmationEngine.expect
  → SocialAttributionService.pass()               [Scheduler.tick] → confirma com engajamento medido
  → CreativeLearningService.pass()                [Scheduler.tick] → PatternMemory (só assured)
  → SocialProactivityService.digest               [leitura] → Fala Tu/Radar "Hoje"
```

Passes no `Scheduler.tick` (horário, best-effort, isolados por org): `SocialAnalyticsService`,
`OpportunityMatchingService`, `SocialAttributionService`, `CreativeLearningService`.

## Guardrails (RN-SI / RN-EI) — codificados em `test:social-hardening`

- **RN-SI-05** segredos nunca vazam: `config_enc` CIFRADO (AES-GCM); `status`/`list` REDIGEM.
- **RN-SI-06** capacidade DESCOBERTA, não presumida; falta de capacidade DEGRADA explícito
  (`manual_required`/`capability_unavailable`) — nunca simula.
- **RN-SI-08** publicação IDEMPOTENTE; durável via `idempotencyKey=action.id` + guard
  `action_already_executed` do executor.
- **RN-SI-03** PUBLISHED ≠ RESULTADO: oportunidade é hipótese; confirmação fica `pending` até
  o analytics chegar; resultado social = **engajamento medido**, nunca dinheiro inventado.
- **RN-SI-11 / RN-EI-5/6** competitiva só de fonte pública/legal; sem fonte → `model_knowledge`
  (não inventa live); `live` exige grounding (≥1 fonte).
- **RN-SI-12** métrica ausente → NULL, nunca 0.
- **RN-SI-14** gate de plano SERVER-SIDE (esconder botão não é segurança) — a rota `/publish`
  recusa **antes** de propor.
- **§42** publicação via `decision_actions` (sem runtime paralelo); oportunidade em
  `business_signals` (sem tabela de alerta paralela); aprendizado no `PatternMemoryService`
  (motor único); pesquisa no pipeline do PRD 9 (sem pipeline paralelo).
- **convenção #1** isolamento multi-tenant em toda query.

## Operações comuns

**Conectar um canal real (Instagram).** O token vem do fluxo OAuth existente (tabela
`channels`, provider `instagram`) — **não** há 2ª tela de credenciais. Depois, no Hub:
`PUT /connections/instagram { provider:"instagram", enabled:true }` e
`POST /connections/instagram/health` pra descobrir capacidades. Sem OAuth conectado o
provider degrada honesto (`not_connected`).

**Adicionar um novo provider (ex.: TikTok).** Implemente `SocialChannelProvider` (espelhe
`InstagramChannelProvider`), registre no `providerFor` do Hub (opt-in por
`social_connections.provider`), e prove com `test:social-provider-<x>`. Capability é
DESCOBERTA; degrade explícito. Sem tocar OAuth no browser (RN-SI-05).

**Publicar sob governança.** `POST /publish` propõe (default exige aprovação humana —
policy `single`). Aprove via `/api/actions/:id/approve`, depois `POST /publish/:id/execute`.
O Autonomy Contract do dono pode liberar (auto) ou bloquear (deny) por banda de valor.

**Ligar a inteligência competitiva.** Master: `POST .../competitive-intelligence/gather
{ vertical }`. Sem `COMPETITIVE_INTEL_SOURCE_URL` a síntese é `model_knowledge` (honesta).

## Flags & env

- `social_connections.enabled` (opt-in por org/canal) · `external_intelligence_enabled`
  (pool compartilhado) · `pattern_memory` (aprendizado).
- Env: `SOCIAL_CHANNEL_PROVIDER` (default stub) · `COMPETITIVE_INTEL_SOURCE_URL`/`_API_KEY`
  (opt-in, fonte pública) · `EXTERNAL_RESEARCH_SEARCH_URL` (busca viva, PRD 9).

## Rollout

`OFF → shadow (stub) → single-tenant (1 canal real) → approved (publicação com aprovação
humana) → cohort → GA`. **Autonomous publishing nunca vai direto pra GA** — só depois de
cohort com Autonomy Contract configurado e revisado. Reversível: desligar `enabled`/flags
volta ao estado anterior sem perda (aditivo).

## Troubleshooting

| Sintoma | Causa provável | Ação |
| --- | --- | --- |
| `publish` retorna 402 | plano não cobre `estudio` | `GET /entitlement` → CTA de upgrade |
| publicação vira `manual_required` | canal sem capacidade (ou desconectado) | `POST /connections/:c/health`; conectar OAuth |
| confirmação fica `pending` | analytics do post ainda não ingerido | rodar `POST /analytics/:c/sync` + `/attribution/resolve` |
| `best-time` = `insufficient_data` | < 3 posts com analytics | ingerir mais histórico (F4) |
| aprendizado não acontece | ação não chegou a `assured`, ou `pattern_memory` off | checar `attribution` + flag |
| oportunidade não aparece | sem inteligência fresca ou broker off | `runResearch`/`gather` + `external_intelligence_enabled` |

## Testes (regressão da espinha)

`test:social-channel-contract` · `social-connection-hub` · `social-provider-instagram` ·
`social-analytics-sync` · `competitive-intelligence` · `vertical-social-intelligence` ·
`opportunity-matching` · `studio-brief` · `creative-variants` · `editorial-calendar` ·
`governed-publishing` · `social-attribution` · `creative-learning` · `social-proactivity` ·
`social-entitlement` · `social-hardening` (guardrails) · `social-golden-paths` (§47
ponta-a-ponta Moda/Clínica/Restaurante) · `social-intelligence-hardening` (production
readiness / wiring).
