# ADR-121 — Comigo: progressão pedagógica (Fatia 3)

- **Status:** Proposto (escopo aprovado; implementação neste PR)
- **Data:** 2026-07
- **Origem:** Fatia 3 do Comigo (ADR-111). Implementa o ADR-088 D10.
- **Relacionadas:** ADR-088 D10 (faseamento pedagógico — o app cresce com a pessoa), PR #2 (precificação), PR #4 (caderneta/caixa), termômetro (ADR-116).

## Contexto

Não se joga custo + margem + ficha técnica no primeiro dia (ADR-088 D10). A pessoa vira gestora **aos poucos**: **registrar venda → "quanto sobrou" → "quanto custa" → "quanto cobrar" → metas/saúde**. Precisamos de um guia que revele o próximo passo na hora certa, sem sobrecarregar quem está começando nem travar quem já avançou.

## Decisões

### D1 — 5 estágios, derivados do próprio uso (sem input extra)
O estágio sai dos sinais que o Comigo já registra:
| Estágio | Alcança quando | Revela |
|---|---|---|
| **vender** | sempre (dia 1) | Balcão |
| **quanto_sobrou** | ≥ 1 venda | Caderneta (caixa × a receber) |
| **quanto_custa** | ≥ 3 vendas | Precificação (ficha técnica) |
| **quanto_cobrar** | ≥ 1 ficha com custo | preço sugerido |
| **metas** | ficha com custo **e** ≥ 10 vendas | Termômetro de Saúde |

O estágio é o mais avançado alcançado **de forma consecutiva** (progressão linear). Função pura, zero-token.

### D2 — Guia, não cadeia (soft, não bloqueia)
O Comigo mostra um **card "próximo passo"** com a ação da vez, em tom de tutor. As abas além do estágio atual aparecem com um selo sutil ("desbloqueia fazendo X"), mas **continuam acessíveis** — a progressão orienta, não prende o dono que quer ir direto. Respeita o D10 (não sobrecarrega) sem frustrar quem já sabe.

### D3 — Comemora a graduação
Alcançados todos os estágios: *"Você virou gestor do seu negócio 🎓"* — fecha o arco pedagógico do produto (e conecta com a graduação MEI/nota fiscal, próxima peça da Fatia 3).

## Serviço (`ComigoProgressService`)
- `status(orgId)` → `{ stage, stageIndex, totalStages, reached[], unlocked{}, next{ key, label, hint }, done }` (puro, derivado de comigo_orders + comigo_recipes/costs).
- Rota `GET /api/comigo/progress`.
- UI: card "próximo passo" no topo do Comigo + selo nas abas não alcançadas.

## Consequências
**Positivas:** reduz a sobrecarga do dia 1; guia a pessoa a virar gestora; zero input extra (deriva do uso); reusa os dados existentes; casa com a graduação (fecho da Fatia 3).
**Trade-offs:** limiares (1/3/10) são heurística — ajustáveis; soft-gating não impede quem quer pular etapas (decisão consciente: guiar, não prender).

## Guardas
- Puro e testável; zero-token; isolamento por `organization_id`.
- Não bloqueia acesso — orienta. Tom de tutor, nunca condescendente.

## Testes
`test:comigo-progress` — estágio evolui com vendas e fichas (0 vendas → vender; 1 → quanto_sobrou; 3 → quanto_custa; ficha com custo → quanto_cobrar; +10 vendas → metas); `next` aponta a ação certa; `done` ao alcançar tudo; isolamento.
