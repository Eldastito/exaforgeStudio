# ADR-050 — Trio de Auditoria Filosófica (Sinek + Sinek + Domingos)

**Status:** Implementado.

**Origem:** Depois de 4 PRs entregando IA que **detecta e sugere** (Manifesto, Radar de Oportunidades, Radar de Recuperação Disney, Big Idea Bar, Notas de Reconhecimento), faltava o simétrico: ferramentas que **ajudam o dono a se auditar**. Três frentes diferentes, três livros diferentes, mas o mesmo espírito: consciência sobre o que se está fazendo.

- **Sinek — "Comece pelo Porquê"**: cada decisão precisa passar pelo teste "isso reforça ou dilui meu Manifesto?"
- **Sinek — "Comece pelo Porquê" (aplicação em copy)**: identificar quando a IA/dono está descendo pra manipulação (desconto/urgência/pressão) em vez de vender pelo Por Quê.
- **Carlos Domingos — "problema é sinal"**: campanha em cima de fundamento quebrado não conserta — amplifica. Antes de subir, checar fundamentos.

---

## Decisão

Três serviços paralelos, três tabelas, uma única UI unificada (`<PhilosophyAudit>`) no Dashboard executivo.

### 1. Celery Test (Sinek)

Metáfora: você está no mercado; alguém sugere colocar salsão no carrinho; antes de comprar, olha pro carrinho e pergunta *"isso combina com o resto?"*. Empresas que colecionam "salsãos" (produtos, canais, práticas que não combinam com o Manifesto) diluem a marca.

`CeleryTestService` + tabela `celery_tests`. Dono digita um assunto ("vender pacote com brinde", "parcelar em 12x sem juros"), IA monta a pergunta usando o **Por Quê do Manifesto** (ADR-045) como bússola. Dono responde `keeps` (combina, mantém), `drops` (destoa, descarta), `needs_review` (preciso pensar mais). Dedupe por semana ISO + mesmo assunto (mesma pergunta 3x no ano não vira 3 registros).

Métrica: distribuição de decisões nos últimos 60 dias mostra o padrão do próprio pensamento do dono com o tempo.

### 2. Radar de Manipulação (Sinek)

Sinek separa **manipulação** (curto prazo, corrói marca) de **inspiração** (Por Quê, longo prazo, fidelidade). Este radar detecta heuristicamente 5 famílias de tática em mensagens outbound:

| Tática | Exemplos regex pt-BR |
|---|---|
| `discount` | "50% off", "desconto imperdível", "pague 2 leve 3" |
| `urgency` | "só hoje", "última chance", "termina em X" |
| `pressure` | "não perca", "você precisa", "garante já" |
| `scarcity` | "restam 2", "apenas 5 vagas", "últimas unidades" |
| `fear` | "vai se arrepender", "todos já estão comprando" |

`ManipulationRadarService.scan(text)` roda `analyzeText`, se detectou tática, cria alerta com `severity` (`low` 1 tática / `medium` 2 / `high` ≥3) + `suggestion` ancorada no Manifesto ("reformule ancorando no Por Quê da marca…"). Dedupe 24h por hash da amostra.

**Hook** em `MessageProviderService.sendMessage` — fire-and-forget, **nunca bloqueia o envio**. Best-effort: se `orgId` disponível no canal, escaneia; se qualquer parte falha, silencia. Não proíbe promoção — deixa **visível** pro dono quando a comunicação está descendo pro reino do "Compre 3 leve 4 SÓ HOJE".

Estados do alerta: `open` → `dismissed` / `reformulated`.

### 3. Checklist de Fundamentos (Domingos)

Domingos: **campanha em cima de fundamento quebrado NÃO conserta — amplifica o problema**. Mais tráfego em atendimento saturado = mais reclamação. Mais leads com CSAT em queda = mais detrator no mundo.

`FundamentalsChecklistService.run(orgId)` lê 5 sinais do próprio banco:

1. **SLA de 1ª resposta em tickets** (últimos 7 dias): `ok` ≤ 30min, `attention` ≤ 2h, `critical` > 2h.
2. **CSAT médio** (últimos 30 dias, n ≥ 3): `ok` ≥ 4, `attention` ≥ 3.5, `critical` < 3.5.
3. **Reclamações abertas há > 3 dias** (via `recovery_events` ativos): `ok` 0, `attention` ≤ 2, `critical` > 2.
4. **Cobertura de estoque** (% produtos ativos sem estoque): `ok` ≤ 5%, `attention` ≤ 15%, `critical` > 15%.
5. **Tickets travados há > 2 dias**: `ok` 0, `attention` ≤ 5, `critical` > 5.

**Regra final:** qualquer `critical` → `status = blocked`; qualquer `attention` sem crítico → `passed_with_warnings`; tudo ok → `passed`. Recomendação em texto: se blocked, "PAUSE ANTES DE SUBIR. Fundamento crítico: X. Arrume antes."

Guarda-costas: se a query falha por qualquer razão, o item vira `unknown` com `evidence` explicando — nunca lança pra rota.

## UI

`<PhilosophyAudit>` no Dashboard executivo mostra 3 sub-cards (Celery / Manipulação / Fundamentos) com contador. Cada um expande sob demanda pra fila de itens abertos com botões de ação. Some do dashboard quando não há nada aberto e nenhum histórico — dashboard limpo.

## Consequências

**Positivas:**
- Fecha o Tier 2 filosófico com **espelho crítico** do próprio dono, não só sugestão da IA.
- Radar de Manipulação alinha copy da marca sem exigir edição manual — visibilidade contínua.
- Checklist de Fundamentos evita gasto de mídia em cima de operação furada.

**Negativas / mitigadas:**
- **Léxico de manipulação é regex, pode falsar** — mitigado por estado `open` (dono julga) + dedupe 24h + severity gradual.
- **Fundamentos assume 30 dias de história** — orgs novas vão ver muitos `unknown`. Aceitável; o próprio texto de evidência explica.
- **Dono pode ignorar Celery Test como "chato"** — mitigado: teste não é obrigatório, dono só cria quando quer submeter uma decisão.

## Testes

`scripts/test-tier2-philosophy-audit.ts` — **37 verificações**:
- **Celery** (5 checks): create + question com Manifesto, dedupe semana+assunto, answer, ordem pending primeiro, metrics.
- **Manipulação** (11 checks): analyzeText por família (discount/urgency/pressure/scarcity/fear), severity escala, scan cria alerta + dedupe 24h, texto neutro não cria, isolamento entre orgs, sugestão ancorada no Manifesto.
- **Fundamentos** (5 checks): 5 itens, amostra pequena → `unknown`, CSAT baixo → `critical` + `blocked` + recomendação "PAUSE".
- Guards (3 checks): orgId/trigger vazios não quebram.
