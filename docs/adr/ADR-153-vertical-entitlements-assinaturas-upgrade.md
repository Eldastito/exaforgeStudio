# ADR-153 — Vertical Entitlements, Assinaturas e Upgrade Inteligente

**Status:** ACEITO — Fase 0 em execução.
**Data:** 2026-08-04.
**Autor:** Claude (IA Dev), sob especificação de Eldastito.
**PRD:** [docs/prd/PRD-VERTICAL-ENTITLEMENTS-ASSINATURAS.md](../prd/PRD-VERTICAL-ENTITLEMENTS-ASSINATURAS.md).
**Documentos operacionais:** `docs/vertical-entitlements/{ANALISE-ARQUITETURAL,PLANO-DE-IMPLEMENTACAO,STATUS-DE-EXECUCAO,DECISOES-E-PENDENCIAS,MATRIZ-DE-COBERTURA-DO-PRD}.md`.

## Contexto

O ZappFlow tem 5 planos (Autônomo/Start/Growth/Scale/Enterprise), 8 verticais (varejo/moda/food/servicos/saude/educacao/hospitalidade/outro) e 28 módulos opcionais mais 4 core. A composição "vertical × plano × módulo × add-on × RBAC × feature flag" já existe e gateia acesso na prática (backend em `ModuleService.isEnabled` + `PermissionService.checkRouteAccess`), mas 10 riscos concretos impedem venda em escala (ver §1 do PRD). Os 3 mais críticos:

1. **Upgrade pode remover o Comigo** — `copiloto` só está em `AUTONOMO` (ver `plansGrade.ts:16`); trocar plano para `Start` remove o balcão de peixaria/chaveiro sem aviso.
2. **Clínica só no Enterprise** — a vertical `saude` no onboarding sugere `clinica`, mas `plansGrade.ts:20` só a libera no Enterprise. O bundle comercial "Clínica" não existe.
3. **Trocar `plan_id` NÃO é upgrade comercial** — `PlanService.selectPlan` (`PlanService.ts:108`) muda o teto de módulos, mas não chama `AsaasService.subscribe` nem calcula proporcionalidade nem exige consentimento explícito. `AsaasService.subscribe` só roda no primeiro checkout (`routes/plans.ts:78`) e nunca é chamado de novo em upgrades.

Além disso: nenhum motor recomenda plano (só ModuleService.overview classifica módulos em `recommended|available|upgrade` — pura visualização). Não existe conceito de "Blueprint" (produto por nicho versionado). Master Admin não tem UI/CLI para criar/mudar assinatura Asaas — só flip de `billing_status` e `plan_id`. Nenhuma coluna `terms_accepted_at`.

## Decisão

Adotar **arquitetura unificada de entitlements** organizada em 4 primitivas novas + 3 correções obrigatórias antes de vendas em escala:

### Primitivas novas

1. **`EntitlementService`** — porta única que responde `{allowed, visibility, reason, source, upgradeEligible}` a partir de `(orgId, userId, resource, action)`. Consumido por menu (frontend), middleware de rota (backend), tela de Configurações, motor de recomendação. Substitui a duplicação atual entre `ModuleService.MODULE_BY_ROUTE`, `PermissionService.ROUTE_MODULE` e `useStore.isModuleEnabled + canAccessModule`.
2. **`VerticalBlueprintService`** — produtos por nicho versionados e imutáveis. Blueprint = `{key, version, baseVertical, allowedPlans, requiredModules, optionalModules, hiddenModules, commercialUpgrades, quickStartPack, runtimePlaybooks}`. Blueprint publicado é imutável — nova versão exige `publishVersion`. Blueprints iniciais: `moda_loja_unica_v1`, `moda_rede_lojas_v1`, `clinica_multiespecialidades_v1`, `chaveiro_autonomo_v1`, `peixaria_balcao_peso_v1`.
3. **`SubscriptionOrchestratorService`** — checkout + upgrade + downgrade + proporcionalidade + consentimento + webhook idempotente. Deprecia troca direta de `plan_id` no fluxo do dono — só o Master Admin mantém `setPlan` bruto. Persiste `subscription_change_requests` com `consent_at + provider_reference + effective_at`.
4. **`UpgradeRecommendationEngine`** — publica sinais em `business_signals` (novo `domain='plan'`) com score 0..100 baseado em 6 dimensões (necessidade operacional 30, uso próximo do limite 20, ganho financeiro provável 20, recorrência 15, adequação à vertical 10, confiança 5). Explica em linguagem natural via evidence_json. Respeita frequência (uma vez/30d por plano, silenciado após rejeição/inadimplência/incidente).

### Correções obrigatórias antes de vender

- **Comigo persistente** — `copiloto` passa a estar em TODOS os planos ou vira add-on preservado (a implementação escolhe menor regressão — DECISÃO #1 pendente).
- **Bundle Clínica** — `clinica_multiespecialidades_v1` sai como bundle `Growth ou Scale + add-on Clínica incluído`.
- **Checkout real de upgrade** — `POST /api/billing/upgrade/{preview,confirm}` chama Asaas, aguarda webhook confirmado antes de aplicar entitlements. Se pagamento falha, mantém plano anterior.

## Consequências

**Positivas:**
- Uma única fonte de verdade elimina a divergência histórica menu × middleware × Configurações.
- Blueprints tornam o rollout de novo nicho uma questão de dados (publish + assign), não de código.
- Auditoria comercial completa (`subscription_change_requests`, `upgrade_recommendations`) — pré-requisito de LGPD e conformidade contratual.
- IA Dev pode recomendar upgrade com base em uso real sem risco de pressão comercial indevida (score/frequência/explicabilidade).

**Negativas / trade-offs:**
- Grande refactor no eixo comercial — 8 fases, provavelmente 15+ fatias. Roadmap longo antes do primeiro efeito de vendas.
- Duplicação temporária entre `ModuleService.isEnabled` (legado, mantido) e `EntitlementService.check` (novo) durante a migração — necessária pra não quebrar 200+ call sites de uma vez.
- Blueprint imutável exige disciplina — cada mudança no preset da Clínica é uma nova versão `clinica_multiespecialidades_v2`, com migração explícita das orgs (não é automática).
- Contrato ToS versionado (`terms_accepted_at`, `terms_version`) precisa ser desenhado com jurídico — bloqueia F5 se demorar.

**Neutro:**
- `ModuleService`, `PlanService`, `PermissionService` continuam existindo — o EntitlementService compõe eles + Blueprints + add-ons. Não recriar o que já funciona.

## Alternativas rejeitadas

- **"Consertar só o Comigo e vender"** — resolve 1 dos 10 riscos. A tela de Configurações ainda vazaria Clínica pra chaveiro; upgrades continuariam sem cobrança; recomendação continuaria copy estática. Débito técnico cresce.
- **"Adotar produto SaaS comercial fechado (Stripe Billing / Chargebee)"** — Asaas é a decisão vigente (ADR-091, integração já funcional e adequada ao BR). Trocar de PSP é fora de escopo e criaria migração de dezenas de orgs vivas.
- **"Blueprint sem versionamento"** — igual ao Quick-Start hoje (`OnboardingTemplateService.PACKS`, hard-coded). Já provou-se problemático: mudar preset da vertical `saude` afetaria orgs vivas silenciosamente. Versionamento imutável é não-negociável.

## Guardrails (regras invioláveis)

- **G-153-1** — Nenhuma tela define permissão. O frontend apenas representa o resultado do `EntitlementService`.
- **G-153-2** — Upgrade nunca remove capacidade operacional ativa. Se houver incompatibilidade técnica, exige aviso + consentimento + plano de migração antes de efetivar.
- **G-153-3** — IA nunca contrata plano, add-on ou muda cobrança sem `POST /api/billing/upgrade/confirm` explícito do dono (clique + aceite).
- **G-153-4** — Todo preço mostrado ao dono é sempre calculado no backend na hora, nunca vem do frontend. Idempotência de webhook Asaas via `asaas_webhook_events` continua vigente.
- **G-153-5** — Blueprint publicado é imutável. Correção = nova versão + assign explícito.
- **G-153-6** — Recomendação de upgrade só publica se score ≥ 60 E não houver rejeição no mesmo plano nos últimos 30d E org não está em inadimplência.
- **G-153-7** — Downgrade nunca apaga dados de módulos removidos — vira `read_only` (visualização mantida, escrita bloqueada).

## Status

Fase 0 (Auditoria + PRD + Análise + Plano) — em execução. Ver `docs/vertical-entitlements/STATUS-DE-EXECUCAO.md`.

Próximos passos após Fase 0: aprovação do dono nas decisões pendentes (`DECISOES-E-PENDENCIAS.md`) → início da Fase 1 (`EntitlementService`).
