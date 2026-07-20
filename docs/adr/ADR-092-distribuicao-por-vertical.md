# ADR-092 — Distribuição de módulos por vertical (vertical = wishlist, plano = teto)

**Status:** Implementado (jul/26) junto do Bloco A do ADR-091 — vertical moda, presets revisados, interseção preset ∩ plano em `applyVertical`, tela de Módulos em 3 seções.

**Origem:** Item #2 do `docs/BACKLOG-CAMPO-TOULON.md`. As verticais foram desenhadas antes da grade nova de planos (ADR-091). Com a grade nova, um preset de vertical pode "prometer" módulos que o plano do cliente não entrega (ex.: TOULON no Autônomo escolhe varejo e o preset sugere `campanhas`/`diretor`, que só existem no Start/Growth). Precisamos reconciliar vertical × plano de forma transparente.

---

## Contexto

Cada vertical (`src/server/verticals.ts`) tem um preset de módulos aplicado no onboarding via `ModuleService.applyVertical`. As 7 verticais atuais: varejo, food, servicos, saude, educacao, hospitalidade, outro.

O conflito: o preset da vertical assume "todos os módulos disponíveis". A grade de planos (ADR-091) limita o que cada plano entrega. A interseção real pode frustrar — cliente escolhe a vertical, recebe menos do que a lista sugeria, sem entender por quê.

## Decisão

### 1. Modelo: vertical = wishlist, plano = teto (Opção C)

- O **preset da vertical** é a *wishlist* completa: tudo que faz sentido para aquele tipo de negócio, independente de plano.
- O **plano** é o *teto*: define o que o cliente efetivamente pode ligar.
- `ModuleService.applyVertical` liga apenas a **interseção** (preset ∩ plano). O resto fica visível na tela de Módulos como "disponível no plano X" (upgrade path), não como opção morta.

Isso mantém o preset da vertical estável (não precisa de um preset por plano) e deixa transparente o motivo de um módulo não estar ligado: ou não é da vertical, ou requer upgrade.

**Comportamento na tela de Módulos** (a implementar no Bloco A):
- Seção "Recomendados para o seu negócio" — módulos do preset da vertical que o plano permite (ligados por padrão, o dono desliga se quiser).
- Seção "Disponível no seu plano" — módulos que o plano permite mas a vertical não pressupõe (desligados por padrão, dono liga se quiser).
- Seção "Requer upgrade" (colapsada) — módulos da wishlist da vertical que o plano não entrega, com CTA de upgrade.

### 2. Nova vertical: "moda"

Separar **moda** de **varejo**. Varejo genérico (pet shop, eletrônicos, papelaria) não precisa de Estúdio/provador; moda sim.

| Vertical | Público |
|---|---|
| 🛍️ varejo | Pet shop, eletrônicos, papelaria, utilidades — venda por unidade |
| 👗 **moda** (nova) | Roupas, calçados, acessórios — com provador virtual e estúdio de peça |

### 3. Redistribuição revisada dos presets

| Vertical | Preset (wishlist) | Mudança vs hoje |
|---|---|---|
| 🛍️ **varejo** | catalogo, vendas, loja, pagamentos, campanhas, integracoes, diretor, rie, execucao | Remove `cadencias` |
| 👗 **moda** | catalogo, vendas, loja, pagamentos, campanhas, integracoes, **estudio**, diretor, rie, execucao | Nova. Estúdio no preset |
| 🍰 **food** | catalogo, vendas, loja, pagamentos, campanhas, integracoes, diretor, rie, execucao | Sem mudança |
| 🛠️ **servicos** | agenda, vendas, pagamentos, campanhas, cadencias, areas, integracoes, **reservas** (opt-in), assinaturas, diretor, rie, execucao | Reservas vira opt-in |
| 💆 **saude** | agenda, clinica, pagamentos, cadencias, areas, integracoes, assinaturas, diretor, rie, execucao | Sem mudança (clínica default) |
| 🎓 **educacao** | assinaturas, agenda, pagamentos, campanhas, cadencias, areas, integracoes, diretor, rie, execucao | Sem mudança |
| 🏨 **hospitalidade** | reservas, catalogo, vendas, loja, pagamentos, agenda, areas, integracoes, compras, orcamentos, eventos, diretor, rie, execucao | Sem mudança |
| ✨ **outro** | OUTRO_MODULES (tudo menos add-ons) | Sem mudança |

**Nota sobre "Autônomo":** o Autônomo é PLANO, não vertical. Um autônomo pode ser da vertical serviços, moda, saúde, etc. O preset da vertical continua sendo a wishlist; o teto do plano Autônomo (catalogo, agenda, vendas, pagamentos, integracoes, loja-PDV, Autônomo Copiloto) recorta o que ele efetivamente vê. Ex.: autônomo de moda → wishlist moda ∩ teto Autônomo = catalogo, vendas, loja(PDV), pagamentos, integracoes.

### 4. Verticais futuras (aguardam Bloco A)

Emerson confirmou que os exemplos abaixo se aplicam ao mercado, MAS todas dependem de as funcionalidades do plano Autônomo estarem implementadas primeiro (Bloco A do ADR-091). Ficam mapeadas como backlog, não entram agora:

- 🚗 **automotivo** — auto elétrica, oficina mecânica, funilaria (agenda + orçamentos + ordens de serviço)
- 🐾 **petshop** — banho/tosa + venda de produtos + agenda (híbrido varejo + serviços)
- 💇 **beleza** — salão, barbearia, estética (agenda + assinaturas + comissão)
- ☕ **cafe** — cafeterias, lanchonetes, food trucks (variação de food com mesa/comanda)

Quando o Bloco A entregar a base do Autônomo, revisamos quais dessas viram vertical própria vs variação de uma existente.

## Consequências

**Positivas:**
- Preset da vertical fica estável e simples (não multiplica por plano).
- Transparência: o dono entende por que um módulo não está ligado (não é da vertical OU requer upgrade).
- "Moda" separada dá posicionamento comercial melhor (TOULON escolhe "Moda", não "Varejo genérico") e preset otimizado (Estúdio já vem sugerido).
- Upgrade path visível na tela de Módulos vira canal natural de venda de plano superior.

**Trade-offs aceitos:**
- A interseção (preset ∩ plano) exige lógica no `ModuleService.applyVertical` que hoje não considera o plano — precisa ser adicionada no Bloco A.
- Verticais futuras (automotivo, pet, beleza, cafe) ficam represadas até o Bloco A — decisão consciente para não construir preset de vertical antes de a base do Autônomo existir.
- "Moda" nova exige atualizar `VerticalKey` type + `VERTICALS` array + os testes que dependem da lista de verticais.

## Implementação

Vai **junto do Bloco A do ADR-091** (mesma migração de banco + tela de Módulos):

1. `verticals.ts`: adiciona `moda`, ajusta presets (varejo sem cadencias, moda com estudio, servicos com reservas opt-in)
2. `VerticalKey` type recebe `"moda"`
3. `ModuleService.applyVertical`: passa a interseccionar preset da vertical com `PlanService.modulesForPlan`
4. Tela `Configurações → Módulos`: 3 seções (recomendados / disponível no plano / requer upgrade)
5. Cards do onboarding (`GET /api/analytics/verticals`): incluir moda com ícone 👗
6. Teste: `test:vertical-plan-intersection` — vertical moda + plano Autônomo = interseção correta; verticais existentes sem regressão

## Testes

`scripts/test-vertical-plan-intersection.ts` (a criar no Bloco A):
- Moda + Autônomo → só os módulos do teto Autônomo
- Moda + Growth → estudio ligado, catalogo/vendas/loja ligados
- Varejo não tem mais cadencias no preset
- Servicos: reservas fica desligado por default (opt-in)
- Verticais existentes continuam aplicando sem quebrar

## Aprovação

Aprovado por Emerson na conversa de campo (jul/26). Item #2 do backlog marcado como `[x] decidido`. Implementação vinculada ao Bloco A do ADR-091.
