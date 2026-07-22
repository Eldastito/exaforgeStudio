# ADR-114 — Margem de perda aceitável (indicador global de perdas)

- **Status:** Proposto (design aprovado na conversa; implementação por PR focado)
- **Data:** 2026-07
- **Origem:** pedido de campo — "todo negócio tem perdas; o dono define uma **margem de perda aceitável**, lança as perdas na conta, e a IA aprende o padrão do negócio, tira a média do indicador e no futuro identifica **onde** a perda acontece e ajuda a **reduzir**".
- **Relacionadas:** ADR-085 (Impact Ledger — reusa snapshot/trend), RIE / Revenue Intelligence ("onde você perde e recupera receita: índice, drivers, plano de ação"), ADR-088 D6/D7 (merma/perda do autônomo + termômetro de saúde), ADR-091 §6 (IA recomenda, não decide).

## Contexto

Hoje a perda existe espalhada e implícita: merma na ficha do Comigo (`comigo_calibrations.waste_qty`), divergência de fechamento no varejo (RetailOps), calote no fiado (ADR-112), vencimento/quebra de estoque. Falta um **indicador único, global e comparável**: *quanto o negócio perde por mês, e isso está dentro do que o dono aceita?* Sem uma **meta de perda aceitável** definida pelo dono e um **histórico**, a IA não tem baseline para dizer "esse mês perdeu mais que o normal" nem para **atribuir** a perda a um driver e sugerir solução.

Este é um recurso **da plataforma toda** (não só do autônomo): TOULON (varejo) tem quebra; a marmiteira tem merma; a clínica tem no-show (perda de agenda). O indicador é o mesmo; muda só o driver.

## Decisões

### D1 — O dono define a **margem de perda aceitável** (global, por organização)
Campo em `organization_settings`: `acceptable_loss_pct` (%, default 0 = não definido) + `acceptable_loss_basis` (`faturamento` | `custo`, default `faturamento`). É a **meta**: *"aceito perder até X% do faturamento por mês"*. Não pune — é o guarda que diz se o mês está **dentro** ou **acima**.

### D2 — Perdas viram **lançamento tipado por driver** (a "conta" que a IA aprende)
Tabela global `loss_events` — cada perda lançada é `{ period (YYYY-MM), driver, amount, source, note }`. **Driver** é o vocabulário que a IA usa para atribuir e aprender:
`merma` · `quebra` · `vencimento` · `furto` · `desconto` (além da política) · `calote` (fiado não recuperado) · `divergencia` (fechamento) · `retrabalho` · `no_show` · `outro`.
Lançamento **manual** (o dono/gestor coloca na conta) **e automático** (integrações alimentam: a merma do Comigo, a divergência do RetailOps, o calote do fiado já viram `loss_event` sem digitação dupla). "Trabalha com chute, melhora com o real" (ADR-088 D6): pode lançar estimado e refinar.

### D3 — Indicador mensal: **dentro / acima**, com histórico e média (o que a IA aprende)
Fecha-se o mês num snapshot (reusa a infra do Impact Ledger, ADR-085): `loss_pct = Σ perdas do mês ÷ base (faturamento ou custo)`, comparado a `acceptable_loss_pct` → **dentro** ou **acima**. Guarda a série histórica em `loss_monthly_snapshots` (period, loss_amount, base_amount, loss_pct, acceptable_pct, status, by_driver JSON). A partir de ~3 meses, a IA tem **média e desvio** do indicador — o baseline que hoje não existe.

### D4 — IA: **atribuir e sugerir** (aprende agora, age no futuro)
- **Agora (fundação):** a IA (Diretor/RIE) lê a série + o `by_driver` e responde *"onde"* a perda se concentra ("70% da sua perda é desconto fora de política") e se o mês está fora da média.
- **Futuro (evolução):** cruza o driver dominante com o contexto (produto, vendedor, período) e propõe **solução** para reduzir — sempre como **recomendação** (ADR-091 §6: a IA sugere, o dono decide). Nunca cobra performance fee por recomendação de redução de perda.

## Modelo de dados
- `organization_settings`: `acceptable_loss_pct REAL DEFAULT 0`, `acceptable_loss_basis TEXT DEFAULT 'faturamento'`.
- `loss_events` — `id, organization_id, period TEXT, driver TEXT, amount REAL, source TEXT, is_estimate INTEGER DEFAULT 1, note, created_by, created_at`. Índice `(organization_id, period)`.
- `loss_monthly_snapshots` — `id, organization_id, period TEXT, loss_amount REAL, base_amount REAL, loss_pct REAL, acceptable_pct REAL, status TEXT, by_driver TEXT (JSON), created_at`. `UNIQUE(organization_id, period)`.

## Serviço (`LossMarginService`)
- `recordLoss(orgId, { driver, amount, period?, source?, isEstimate?, note? })` — lança na conta (idempotência do source automático evita duplicar).
- `monthlySummary(orgId, period)` — perda total, base (faturamento do período das vendas), `loss_pct`, `acceptable_pct`, status, `byDriver`.
- `snapshotMonth(orgId, period)` — persiste o snapshot (chamado pelo Scheduler no virar do mês).
- `trailingAverage(orgId, months)` — a **média do indicador** (o que a IA aprende).
- Ganchos automáticos: Comigo (merma), RetailOps (divergência), fiado (calote) chamam `recordLoss` com `source` estável.

## Escopo (faseamento)
- **PR (fundação):** settings + `loss_events` + `loss_monthly_snapshots` + `LossMarginService` (record/summary/snapshot/trailingAverage) + rota `/api/loss` + tela mínima (definir a meta, lançar perda, ver dentro/acima + histórico) + snapshot mensal no Scheduler + `test:loss-margin`.
- **Fatia 2:** ganchos automáticos (Comigo/RetailOps/fiado alimentam sem digitação dupla) + card no relatório por vertical (ADR-094).
- **Fatia 3 (IA):** atribuição por driver + sugestão de redução no Diretor/RIE.

## Consequências
**Positivas:** dá à plataforma um **baseline de perda** que hoje não existe — condição para a IA dizer "esse mês fugiu do normal" e, no futuro, atribuir e sugerir; é **global** (um indicador, muitos drivers) e reusa Impact Ledger + RIE; a meta definida pelo dono ancora o julgamento sem punir.

**Trade-offs / riscos:** exige o dono **lançar** a perda (mitigado pelos ganchos automáticos da Fatia 2); base do % (faturamento vs custo) muda a leitura — por isso é configurável; atribuição automática só amadurece com histórico — a Fatia 3 espera dados.

## Guardas
- Isolamento por `organization_id` + auditoria em toda escrita.
- IA **sugere** redução de perda; o dono decide (ADR-091 §6). Nunca performance fee por recomendação.
- Trabalha com estimativa e refina com o real (ADR-088 D6); nunca trava por "não sei o valor exato".

## Testes
`test:loss-margin` — define meta; lança perdas por driver; `monthlySummary` calcula loss_pct vs base e status dentro/acima; `snapshotMonth` persiste e é idempotente; `trailingAverage` sobre N meses; isolamento entre orgs.
