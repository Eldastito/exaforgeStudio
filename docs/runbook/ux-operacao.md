# Runbook — Operar a Invisible UX & Zero-Training (PRD 6 / ADR-163)

Referência única de operação da onda de UX invisível: o que cada superfície faz, como
ligar por tenant, quais rotas responder, e os guardrails que **não se regridem**.
Todas as fatias são **aditivas/reversíveis**, determinísticas (rodam em CI sem chave de
IA) e isoladas por `organization_id`. Nenhum engine canônico foi duplicado (CA17).

## 1. O que a onda é (mapa mental)

O ZapFlow deixa de exigir que o usuário **saiba onde a funcionalidade mora** e passa a
**saber o que o usuário precisa**. Nada disso é redesign nem Home concorrente — tudo
**compõe** o que já existia (Fala Tu Home, Smart Inbox, Context Engine, Entitlement,
proatividade).

| Superfície | Service | Papel |
| --- | --- | --- |
| Navegação por necessidade | `NavigationManifestService.forUser` | Deriva Hoje/Fala Tu/Executando/Resultados/Empresa (1º nível) + Explorar (módulos ativos, 2º nível) de `EntitlementService.overview` |
| "Hoje" por exceção | `FalaTuHomeService.home` (estendido) | Atenção + resolvido-desde-ontem + metas |
| Decision Card + estados humanos | `UxPresentationService` | Forma sobre `decision_actions`: o-que/por-que/impacto/recomendo/posso-fazer/regra; `humanState`/`humanError` |
| Executando / Resultados | `ExecutionResultsService` | Processos ativos por objetivo + Impact Ledger (categorias nunca somadas) |
| Onboarding adaptativo | `AdaptiveOnboardingService` | Autodiscovery com fonte+confiança; nunca inventa |
| Inferred settings | `InferredSettingsService` | Sugere regra de aprovação; nunca auto-aplica política |
| Ajuda zero-training | `ZeroTrainingHelpService` | Fala Tu responde ensine/mostre/faça/onde (determinístico) |
| Upgrades contextuais | `ContextualUpgradeService` | Upgrade só na interseção recomendação-situacional ∩ fora-do-plano |
| Telemetria de UX | `UxTelemetryService` + `ux_telemetry_events` | TTFV/adoção/abandono, LGPD-minimizada |
| Mobile hardening | `MobileReadinessService` | Prontidão dos fluxos + fallback garantido |
| Redução de legado | `LegacyReductionService` | Gate ADVISÓRIO de aposentadoria (nunca remove tela) |
| Preferências | `UxPreferencesService` | Quiet-hours + limiar de alerta (efeito real na proatividade) |

## 2. Habilitar por tenant (opt-in, reversível)

Colunas em `organization_settings` (todas default 0 / NULL — sem a flag, o comportamento
é o legado, **0 regressão**). O **backend sempre computa**; a flag só diz ao frontend se
renderiza a experiência nova.

| Flag/coluna | Liga | Fatia |
| --- | --- | --- |
| `simplified_navigation_enabled` | nav por necessidade no Sidebar | F2 |
| `invisible_ux_enabled` | framing "Hoje" por exceção + Decision Card + ajuda | F3/F4/F7 |
| `adaptive_onboarding_enabled` | fluxo de onboarding adaptativo | F5 |
| `inferred_settings_enabled` | sugestões de política inferidas | F6 |
| `contextual_upgrade_enabled` | ofertas de upgrade contextuais | F9 |
| `ux_telemetry_enabled` | coleta de telemetria de UX (consentimento §84) | F10 |
| `proactive_awake_start` / `proactive_awake_end` | janela "acordado" (NULL = 07h..22h) | F13 |
| `alert_min_amount` | limiar de valor pro push proativo (NULL = 0) | F13/F14 |

## 3. Endpoints (isolados por org; role-gate onde indicado)

- `GET /api/entitlements/navigation-manifest` — manifesto de navegação (F2).
- `GET /api/ux/executing` · `GET /api/ux/results` — Executando / Resultados (F8; dinheiro role-gated §73).
- `GET /api/ux/onboarding/discover` · `POST /api/ux/onboarding/confirm` — onboarding adaptativo (F5).
- `GET /api/ux/inferred-settings` · `POST /api/ux/inferred-settings/apply` — inferred settings (F6; **apply = gestor**).
- `GET /api/ux/contextual-upgrades` — upgrades situacionais (F9; **gestor**).
- `POST /api/ux/help` — ajuda zero-training (F7).
- `POST /api/ux/telemetry` · `GET /api/ux/telemetry/summary` — telemetria (F10; **summary = gestor**).
- `POST /api/ux/mobile/readiness` · `GET /api/ux/mobile/manifest` — mobile (F11).
- `GET /api/ux/legacy-reduction` — gate de retirada advisório (F12; **gestor**).
- `GET /api/ux/preferences` · `PUT /api/ux/preferences` — preferências (F13; **PUT = gestor**).

O Decision Card (F4) mora nas rotas de ação: `GET /api/actions/cards` · `GET /api/actions/:id/card`.

## 4. Diagnóstico — sintomas comuns

### O usuário não vê a experiência nova
A flag do tenant está desligada (§2). O backend responde normalmente; ligue a flag correspondente.

### "Executando"/"Resultados" sem valores em R$ pra um usuário
Esperado (§73): dinheiro é role-gated. Só quem tem visão completa de negócio vê o valor;
os demais veem `restricted:true` — o **fato** do impacto nunca some, só o número.

### Onboarding pergunta algo que já deveria saber
`discover` só pergunta LACUNAS. Se um campo conhecido virou pergunta, cheque a fonte
(`organization_settings`). O autodiscovery **nunca inventa**: ausência vira "ainda não sei".

### Sugestão de política não aparece / não some
Sugestão de `inferred-settings` exige ações financeiras/destrutivas **sem banda** nos 90
dias. Depois de `apply`, a banda existe e a sugestão some. Só gestor recebe.

### Upgrade contextual não aparece
Correto quando não há gatilho (§56, sem catálogo de cadeados). Só surge na interseção
recomendação pending ∩ módulo `available_to_buy`+visível.

### Push proativo sumiu / chega em hora ruim
Cheque `GET /api/ux/preferences`: janela "acordado" e limiar de alerta. Fora da janela é
quiet-hours; valor abaixo do limiar não vira push (segue na Inbox). **Crítico nunca é
silenciado.**

### `legacy-reduction` só devolve `insufficient_data`
Esperado sem telemetria acumulada (§112, default conservador = mantém). Precisa de adoção
real da superfície nova antes de recomendar aposentadoria.

## 5. Guardrails que NÃO se regridem (RN-UX)

- **RN-UX-1** — nada de Home/Inbox/Context Engine/assistente concorrente; sempre COMPOR (CA17).
- **RN-UX-2** — RBAC/entitlement sempre respeitado; esconder ≠ burlar permissão.
- **RN-UX-3** — inferência/ajuda **nunca** vira autorização de política material sem confirmação explícita (`inferred-settings/apply`, `onboarding/confirm` recusa campo material).
- **RN-UX-4** — simplicidade não mente: nunca esconder erro (`humanError` sempre expõe o técnico), custo, risco, ou disponibilidade (nav honesta sobre fora-do-plano); `failed` é estado visível.
- **RN-UX-5 / §112** — não remover tela/rota legada sem telemetria provando substituição. A F12 é ADVISÓRIA — **não remove nada**.
- **RN-UX-6** — autodiscovery nunca inventa: valor incerto declara fonte+confiança ou "ainda não sei".
- **RN-UX-7 / LGPD §84** — telemetria minimizada: sem conteúdo/PII; só `event_type` do whitelist + ids curtos sanitizados + `user_id` interno.
- **§73** — dinheiro role-gated em toda superfície (Home, Executando/Resultados, Decision Card).
- **§45/D7** — quiet-hours e limiar filtram só o proativo NÃO-crítico; o crítico e a decisão de valor desconhecido sempre passam.

## 6. Testes por fatia (CI)

`npm run test:navigation-manifest` · `test:falatu-home-today` · `test:ux-presentation` ·
`test:ux-execution-results` · `test:adaptive-onboarding` · `test:inferred-settings` ·
`test:zero-training-help` · `test:contextual-upgrades` · `test:ux-telemetry` ·
`test:mobile-readiness` · `test:legacy-reduction` · `test:ux-preferences` ·
`test:proactive-alert-threshold`. Todos determinísticos, isolados, multi-tenant.

## 7. Rollback

Toda fatia é reversível: desligue a flag do tenant (§2) e a experiência nova some, com o
legado intacto. As preferências (F13) voltam ao default setando `null`. Nenhuma migração
destrói dados (colunas/tabela são aditivas; a telemetria é opt-in).
