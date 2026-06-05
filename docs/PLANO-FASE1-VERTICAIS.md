# Plano de Implementação — Fase 1: Verticais + Gating de Módulos

> Objetivo: permitir que cada cliente escolha sua **categoria (vertical)** e veja/
> pague só pelos **módulos** que fazem sentido. SEM depender dos engines novos
> (reserva por período / cobrança recorrente — esses são Fase 2).
>
> Princípio: **uma base só** + flags. É evolução do que já existe, não reescrita.

## 0. O que já existe a nosso favor (confirmado no código)

- `organization_settings` já tem `segment` e `size_range` (db.ts ~L372–373) — hoje
  sem uso no onboarding.
- `plans` com `features` JSON + `PlanService.parseFeatures` / `aiAllowed` (gating
  por limite já funciona).
- `protectedApi` monta as rotas em sequência após `requireAuth` +
  `requireOrganizationAccess` (server.ts L306–332) — ponto ideal para inserir o
  gate de módulo.
- Sidebar é uma lista plana de `NavItem(label, viewMode)` — fácil de filtrar.
- Onboarding (`OnboardingView.tsx`) tem 2 passos e faz POST em
  `/api/analytics/settings/onboarding` (analytics.ts L80–95).

## 1. Catálogo de módulos (chaves canônicas)

| Módulo (key) | viewMode(s) | Rotas backend | Core? |
|---|---|---|---|
| `atendimento` | kanban, channels | messages, tickets, ai, channels | **sempre on** |
| `contatos` | contacts | contacts | **sempre on** |
| `relatorios` | dashboard, reports | analytics | **sempre on** |
| `agenda` | agenda | appointments | opcional |
| `catalogo` | catalog | products | opcional |
| `vendas` | vendas | orders | opcional |
| `loja` | storefront | storefront | opcional |
| `pagamentos` | (modal) | payments | opcional |
| `campanhas` | campanhas | campaigns | opcional |
| `cadencias` | cadencias | cadences | opcional |
| `areas` | areas | areas | opcional |
| `integracoes` | integrations | integrations | opcional |

Core nunca é escondido/bloqueado (todo negócio atende e tem contatos).

## 2. Presets por vertical (a "dor específica" resolvida por configuração)

Cada vertical define: `modules[]`, `sale_mode` padrão e uma **semente de persona**
da IA (tom + instruções iniciais). Engines novos ficam anotados como gap.

| Vertical | Módulos ligados | sale_mode | Gap (Fase 2) |
|---|---|---|---|
| `varejo` (Comércio/Varejo) | catalogo, vendas, loja, pagamentos, campanhas, cadencias, integracoes | unit | — |
| `food` (Alimentação/Delivery) | catalogo, vendas, loja, pagamentos, campanhas | slice/unit | — |
| `servicos` (Prestadores/Serviços) | agenda, vendas, pagamentos, campanhas, cadencias | unit (tipo serviço) | — |
| `saude` (Saúde/Bem-estar) | agenda, pagamentos, cadencias | unit (serviço) | — |
| `educacao` (Escolas/Cursos) | agenda, pagamentos, campanhas, cadencias | unit (serviço) | **cobrança recorrente** |
| `hospitalidade` (Hotéis/Restaurantes/Pensão) | catalogo, vendas, loja, pagamentos, agenda | unit | **reserva por período** |
| `outro` (Genérico) | TODOS | unit | — |

Definir em UM arquivo compartilhado: `src/shared/verticals.ts` (consumido por
front e back) com `{ key, label, descricao, modules, saleMode, personaSeed }`.

## 3. Banco de dados (migrações idempotentes em db.ts)

- `ALTER TABLE organization_settings ADD COLUMN vertical TEXT` (chave do preset).
- `ALTER TABLE organization_settings ADD COLUMN enabled_modules TEXT` (JSON array).
- (Reusar `segment`/`size_range` existentes para texto livre, se quiser.)

**Compatibilidade:** `enabled_modules = NULL` ⇒ tratar como **todos habilitados**
(comportamento atual). O gate só restringe quando há um array não-nulo. Orgs
antigas não quebram.

## 4. Backend

### 4.1 ModuleService (`src/server/ModuleService.ts`)
- `MODULE_BY_ROUTE: Record<prefix, moduleKey>` (ex.: `products→catalogo`,
  `orders→vendas`, `storefront→loja`, `payments→pagamentos`,
  `appointments→agenda`, `campaigns→campanhas`, `cadences→cadencias`,
  `areas→areas`). Prefixos fora do mapa = sempre liberado (core).
- `enabledModules(orgId): string[] | null` (lê `enabled_modules`; null = todos).
- `isEnabled(orgId, moduleKey): boolean`.
- `applyVertical(orgId, verticalKey)`: grava `vertical`, `enabled_modules` (do
  preset), `sale_mode` default e semeia a persona da IA se ainda vazia.

### 4.2 Middleware de gate (`requireModuleAccess`)
- Inserir **após** `requireOrganizationAccess` (server.ts L307).
- Deriva o módulo do 1º segmento do path; se desabilitado → `403 {error:
  'module_disabled', module}`. Core/desconhecido → segue.

### 4.3 Endpoints (analytics.ts)
- `GET /api/analytics/settings` → incluir `vertical` e `enabled_modules` no retorno.
- `POST /api/analytics/settings/onboarding` → aceitar `vertical`; chamar
  `ModuleService.applyVertical`.
- `POST /api/analytics/settings/modules` → `{ enabled_modules: string[] }`
  (toggle manual; sempre força os core a ficarem on). Para o cliente
  ligar/desligar um módulo opcional depois.

## 5. Frontend

### 5.1 Store (`useStore.ts`)
- Estado `enabledModules: string[] | null` e `vertical: string | null`,
  carregados do `GET /settings` no boot.
- Helper `isModuleEnabled(key)` (null ⇒ true).

### 5.2 Sidebar
- Mapear cada `NavItem` → `moduleKey`. Esconder item se `!isModuleEnabled(key)`
  (core sempre visível). Admin Master mantém regra atual.

### 5.3 App.tsx (guarda leve)
- Se `viewMode` apontar para módulo desligado, cair em `kanban` (evita tela
  "fantasma" se alguém forçar a rota).

### 5.4 Onboarding (novo passo)
- Novo Passo: **"Qual o seu tipo de negócio?"** — grid de cards (os verticais do
  `verticals.ts`, com ícone + descrição curta). Seleção obrigatória.
- POST do onboarding passa a enviar `vertical`. Backend aplica o preset.

### 5.5 Configurações → aba "Módulos"
- Lista os módulos opcionais com toggles (estado de `enabled_modules`). Salva via
  `POST /settings/modules`. Texto: "Ative só o que faz sentido pro seu negócio."

## 6. Fora de escopo da Fase 1 (anotado p/ Fase 2)
- Gating por **plano/preço** (monetização) — reaproveita `enabled_modules` +
  `plans.features.modules`. Construir junto da UI de planos (não existe ainda).
- **Motor de reservas por período** (hospitalidade/restaurante-mesa).
- **Cobrança recorrente** (educação/assinaturas).

## 7. Decisões a confirmar com o dono
1. **Gating só esconde a UI** ou **bloqueia o backend também?** Recomendado:
   ambos (já no plano), mas se a meta agora é só organizar a experiência, dá pra
   entregar só o front primeiro. Backend é o que sustenta o "pague pelo que usa".
2. **Lista/labels dos verticais** acima estão boas? (varejo, food, serviços,
   saúde, educação, hospitalidade, outro.)
3. Reusar `segment` ou criar coluna `vertical` dedicada? Recomendado: `vertical`
   dedicada (explícito, sem ambiguidade).

## 8. Ordem de entrega (PRs pequenos e empilhados)
1. `verticals.ts` + migrações (`vertical`, `enabled_modules`) + `ModuleService`.
2. Middleware `requireModuleAccess` + `GET/POST settings` ajustados.
3. Sidebar + store + guarda no App (gating de UI).
4. Passo de vertical no Onboarding + `applyVertical`.
5. Aba "Módulos" em Configurações.

Cada passo é independente e testável (`tsc --noEmit` + `npm run build`).
