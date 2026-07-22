# ADR-120 — Comigo: onboarding por arquétipo (Fatia 3)

- **Status:** Proposto (escopo aprovado; implementação neste PR — abre a Fatia 3)
- **Data:** 2026-07
- **Origem:** Fatia 3 do Comigo (ADR-111). Implementa o ADR-088 D1.
- **Relacionadas:** ADR-088 D1 (o produto se molda por arquétipo, não por segmento; reusa o *padrão* recommend/apply do `RetailDiagnosticService`), PR #3 (Balcão), PR Mesa/QR (ADR-119).

## Contexto

O Comigo hoje mostra todas as abas para todo mundo. Mas a marmiteira por encomenda não precisa de Mesa/QR; a manicure trabalha por **hora marcada**; o foodtruck é **móvel** e usa Mesa. O ADR-088 D1: o onboarding são **3 perguntas em linguagem de gente** que resolvem dois eixos — **agenda × balcão** e **fixo × móvel** — e o motor liga só os pilares certos.

## Decisões

### D1 — 3 perguntas, motor puro (padrão RetailDiagnosticService)
1. **O que você faz?** → arquétipo (marmita, salgados/bolo, foodtruck/galeto, feira/praia, unha, cabelo, chaveiro/serviço, revenda/ambulante, outro).
2. **Como você atende?** → *chegou-e-comprou* (**balcão**) × *hora marcada* (**agenda**).
3. **Fica num ponto ou se move?** → **fixo** × **móvel**.

`ComigoArchetypeService.recommend(answers)` (função pura) → config; `apply(orgId, answers)` persiste. Mesmo desenho do `RetailDiagnosticService` (recommend/apply), mas com o vocabulário do autônomo.

### D2 — O que o arquétipo liga/desliga
- **Mesa/QR:** só faz sentido em *chegou-e-comprou* de comida com consumo no local (foodtruck/galeto). A marmiteira por encomenda e o chaveiro usam **só Balcão + Comigo** → Mesa desligada (a aba some).
- **Tipo de ficha padrão** (motor de preço, PR #2): serviço (hora marcada) → `servico`; comida → `fabricacao`; ambulante/revenda → `revenda`. Novas fichas já nascem no tipo certo.
- **Modo** (`balcao`/`agenda`) e **móvel** ficam registrados para o tutor e para futuras adaptações (agenda em destaque, venda offline no móvel).

### D3 — Onboarding leve, no próprio Comigo (porta própria, fatia inicial)
Sem archetype definido, o Comigo abre com um **card de boas-vindas do tutor** com as 3 perguntas (linguagem de gente, tom "sócio que caminha junto"). Aplicou → o produto se molda. Nada de "implantar sistema". (A porta própria/sub-marca completa é refino posterior.)

## Modelo de dados
`organization_settings`: `comigo_archetype TEXT`, `comigo_mode TEXT` (balcao|agenda), `comigo_mobile INTEGER`, `comigo_mesa_enabled INTEGER DEFAULT 1`, `comigo_default_recipe_kind TEXT`.

## Serviço (`ComigoArchetypeService`)
- `ARCHETYPES` (curados) + `questions()`.
- `recommend(answers)` → `{ archetype, mode, mobile, mesaEnabled, defaultRecipeKind, tips }` (puro).
- `apply(orgId, answers)` → persiste + auditoria.
- `getConfig(orgId)` → config atual (ou `{ configured:false }`).
- Rotas: `GET /api/comigo/archetype`, `POST /api/comigo/archetype`.

## Consequências
**Positivas:** o produto deixa de ser genérico e passa a caber no negócio da pessoa em 3 toques; reusa o padrão recommend/apply; desliga o que não serve (Mesa some pra quem não usa); ficha já nasce no tipo certo.
**Trade-offs:** a lista de arquétipos é curada (não cobre tudo) — "outro" é o fallback; a porta própria/sub-marca completa fica para depois.

## Guardas
- Motor **puro** e testável; `apply` audita e é idempotente (reconfigura sem quebrar).
- Não remove dado; só ajusta a visão. Isolamento por `organization_id`.
- Linguagem de gente, tom de tutor; nunca "opere seu pipeline".

## Testes
`test:comigo-archetype` — recommend liga Mesa p/ foodtruck e desliga p/ marmita; hora marcada → modo agenda + ficha `servico`; móvel marcado; apply persiste e getConfig lê; reconfigurar sobrescreve; isolamento.
