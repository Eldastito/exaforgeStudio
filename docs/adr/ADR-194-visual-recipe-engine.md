# ADR-194 — Visual Recipe Engine (Fase 1: contrato e resolver)

**Estado:** **F1 aberto — 1 fatia (contrato + tabelas + service + seed).** Aditivo
sobre StudioService/llm.ts existentes. Admin (crud) e público (list/get) apenas
para org logada.
**Data:** 2026-08-27.
**Natureza:** primeira fatia do Closure Track A do PRD-PEL-01 (§12). Destrava
Gap-4 da matriz F0 do Product Evolution Ledger — os 6 comandos discutidos
(`/ProductExplosion`, `/3Dbillboard`, `/MagazineCover`, `/AddCreative`,
`/3DSoft`, `/LifestyleShort`) passam de "prompt truque" a capacidade nativa
com contrato versionado.

## 1. O problema

Os 6 comandos existem hoje como "prompt engineering" repetido em conversas.
Cada geração é uma reinvenção do template — sem controle de qualidade, sem
histórico de variações, sem alias para outros nomes ("outdoor 3d", "capa de
revista"), sem restrição de formato (Story 9:16 vs Feed 1:1). O motor de
geração (`StudioService` + `llm.ts` com Gemini Imagen + Veo + OpenAI fallback)
**já existe** e é bom — o gap é a camada declarativa em cima.

## 2. Decisões (D1–D6)

- **D1 — Visual Recipe é contrato versionado, não código.** Cada receita vive
  em `studio_visual_recipes` como linha com `key` + `version`. Novas versões
  criam linhas novas (nunca UPDATE). Consumidores fixam versão explícita ou
  usam "active".
- **D2 — Aliases separados da receita.** Tabela `studio_visual_recipe_aliases`
  liga strings livres (`/3Dbillboard`, `outdoor 3d`, `3d billboard`) a uma
  `recipe_key`. Case-insensitive na resolução. Slash é opcional.
- **D3 — Nunca gera imagem nesta fatia.** F1 entrega **só** o contrato +
  resolver. Integração com `StudioService.generateImageB64` fica para F2. Isso
  força revisão do contrato antes de compromisso runtime.
- **D4 — Global por default; per-org overrides em fatia futura.** Recipes e
  aliases vivem GLOBAL (sem `organization_id`). F2+ pode adicionar overrides
  per-org se demanda aparecer — não neste PR.
- **D5 — Sem LLM na resolução.** `resolveAlias(str)` é lookup determinístico
  no banco. `buildPromptPlan(recipe, inputs)` também: monta um objeto
  estruturado a partir do JSON da receita + inputs do caller. LLM só entra
  quando `StudioService` recebe o plan e chama o provider (fatia F2+).
- **D6 — Seed dos 6 comandos como parte desta fatia.** Sem seed, o gap
  continua aberto até alguém rodar CRUD manual. Seed é idempotente
  (skip se `key` já existe).

## 3. Guardrails / invariantes (RN-VRE-01..05)

1. **`recipe_key` imutável** — regex `^[A-Z][A-Z0-9_]{2,63}$` (mesma do Ledger).
   UPDATE de key rejeitado.
2. **Version é monótona** — `INSERT`, nunca `UPDATE`. Nova versão = nova
   linha com mesma key + `version+1`.
3. **Alias único global** — `UNIQUE(alias)` na tabela de aliases. Case-
   insensitive na resolução mas armazenado como o caller enviou.
4. **Formato mínimo obrigatório na receita** — cada receita precisa declarar
   ≥1 `supported_format` (`feed_1_1` | `story_9_16` | `landscape_16_9` | ...).
   Sem formato → 400 na criação.
5. **Sem provider hard-coded** — o campo `provider_hints_json` é dica; quem
   escolhe o provider real é o `StudioService` (F2+) com base no que está
   configurado no repo.

## 4. Contrato de recipe (JSON)

```jsonc
{
  "key": "PRODUCT_EXPLOSION",
  "version": 1,
  "name": "Product Explosion",
  "description": "Produto em explosão com cenário 3D dramatizado.",
  "intent": "product_hero",
  "composition_json": {
    "camera": "wide_angle_low",
    "lighting": "dramatic_rim",
    "background": "solid_gradient",
    "product_position": "center_hero",
    "extras": ["debris", "smoke"]
  },
  "provider_hints_json": {
    "preferred": ["gemini_imagen", "openai_gpt_image"],
    "avoid": []
  },
  "constraints_json": {
    "preserve_product_identity": true,
    "allow_text_on_image": false,
    "max_people_in_scene": 0
  },
  "supported_formats_json": ["feed_1_1", "story_9_16"],
  "vertical_hints_json": ["retail", "storefront"]
}
```

## 5. Fatias (PR-a-PR)

| Fatia | PR | Entrega |
| --- | --- | --- |
| VRE-F1 | (este PR) | 2 tabelas em `db.ts`; `StudioVisualRecipeService`; rota GET `/api/studio/recipes` (list + get + resolve alias); seed dos 6 comandos; `test:studio-visual-recipes` (~25 checks). |
| VRE-F2 | (futuro) | `buildPromptPlan(recipe, inputs)` mais rico + integração com `StudioService.generateImageB64` (chama Imagen/OpenAI). |
| VRE-F3 | (futuro) | UI no Estúdio: dropdown com os 6 recipes + auto-sugestão baseada em produto. |
| VRE-F4 | (futuro) | Analytics: qual receita gera mais, por vertical. Feedback loop. |
| VRE-F5 | (futuro) | Per-org overrides (aliases customizados por org, sem tocar em recipes globais). |

## 6. Contratos de rota

`GET /api/studio/recipes` — lista recipes ativas (não requer master admin;
qualquer usuário logado pode ler o catálogo).

`GET /api/studio/recipes/:key` — 1 recipe (versão active) por `key` (ou por
alias — o service resolve).

## 7. Reuso

- `StudioService.ts` — ficará como consumidor da receita em F2+.
- `llm.ts` (`generateImageB64` com fallback Gemini→OpenAI) — provider real.
- `AuthRequest` + `requireAuth` — mesma auth do resto de `/api/studio`.

## 8. Diferidos

- **UI de escolha do recipe** (F3).
- **Analytics de uso** (F4).
- **CRUD por Admin Master** — recipes são globais e imutáveis por versão;
  criar UI de admin depois se demanda aparecer. Por enquanto, seed cobre.
- **Auto-sugestão** ("dado um produto tênis + objetivo feed, sugira 3
  recipes") — decisão de produto; fica pra F3 na UI.
- **Vinculação com vertical** — hoje é hint (`vertical_hints_json`); F4
  pode transformar em filter/rank efetivo.

## 9. Rollback

Aditivo puro. Reverter = drop das 2 tabelas + delete de service/rota/seed/
teste. Zero migration destrutiva; nenhuma feature do Studio existente
tocada.
