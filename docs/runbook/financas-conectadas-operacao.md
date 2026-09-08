# Runbook — Inteligência Financeira Conectada (ADR-200)

A "leitura do CFO": DRE + Balanço + Fluxo de Caixa conectados, respondendo *por que lucrou e não tem dinheiro*. **Gerencial e educativa — não substitui a contabilidade oficial** (RN-FIN-1).

## Mapa dos serviços

| Serviço | Papel | Fonte (reuso, RN-FIN-2) |
| --- | --- | --- |
| `ManagerialDreService` (ADR-128) | DRE gerencial (competência), já soma a loja física (Frente 1) | `order_items` + Comigo + `retailPhysicalFlow` |
| `ManagerialBalanceSheetService` (F1) | Balanço numa data (Ativo = Passivo + PL) | `cash_accounts`/`cash_events` · `receivables` · `retail_store_inventory`×`avg_cost` (fallback `inventory_items`) · `payables` · `owner_draws` |
| `ManagerialCashFlowService` (F2) | Fluxo de caixa método indireto (DRE→caixa via Δ capital de giro) | reusa DRE + Balanço + `stock_movements` (Δ estoque) + `cash_events` (variação real) |
| `ConnectedFinancialsService` (F3) | A conexão + a ponte "lucro ≠ caixa" + o sinal `connected_financials/lucro_sem_caixa` | compõe os três; publica em `business_signals` |

## Rotas (`/api/dre/*`, owner/admin — §73)

- `GET /balance?asOf=YYYY-MM-DD` — Balanço gerencial na data.
- `GET /cashflow?period=YYYY-MM` — Fluxo de caixa método indireto.
- `GET /connected?period=YYYY-MM` — os três + a ponte + narrativa determinística.
- `GET /connected/narrative?period=YYYY-MM` — a leitura do CFO em texto (IA GROUNDED; fallback determinístico sem IA).

## Fluxo (o "filme completo")

1. **DRE** diz o lucro de competência.
2. **Balanço** mostra o que está PRESO (a receber + estoque = capital de giro travado).
3. **Fluxo indireto** faz a ponte: `caixa = lucro − Δ a receber − Δ estoque + Δ a pagar + financiamento`; concilia com o Motor de Caixa; o resíduo é **"a conciliar"** (RN-FIN-3, explícito).
4. **A conexão** narra: *"lucrou R$X, mas R$Z ficou preso, então o caixa só variou R$Y"* e publica `lucro_sem_caixa` quando material (lucro > 0 e caixa gerado ≤ 0 ou ≥30% do lucro não virou dinheiro). Self-healing por dedupe.

## Superfície

Card **"Leitura do CFO"** no topo da seção financeira do menu **Relatórios** (`ReportsPanel`): três pílulas (Lucro × Caixa × Preso) + banner de alerta + narrativa + decomposição da ponte + caveats + disclaimer.

## Guardrails RN-FIN (codificados em `test:connected-financials-hardening`)

1. **Gerencial ≠ contábil** — disclaimer em todo demonstrativo.
2. **Derivado, nunca 2º motor** — tudo por query dos sub-razões (sem GL, sem tabela de saldo mutável, sem 2º Motor de Caixa/DRE).
3. **Identidade + "a conciliar"** — Ativo = Passivo + PL sempre; resíduo explícito, nunca forçado a zero.
4. **A ponte é o método indireto** — lucro ± Δ capital de giro = caixa.
5. **Não inventa** — sem custo/fonte → `null` + caveat, nunca zero/lucro/ativo forjado; sinal `impactAmount` null.
6. **Dois fluxos** — loja física + virtual (Frente 1), sem duplicar fontes.
7. **Isolado por org** — toda query filtra `organization_id`.
8. **Determinístico antes de LLM** — números determinísticos; a narrativa LLM é GROUNDED nos números (nunca inventa), com fallback determinístico.

## Passes no Scheduler

`ConnectedFinancialsService.pass()` roda a cada tick horário para orgs com receita no mês (online + física), publicando/curando o sinal `lucro_sem_caixa`.

## Troubleshooting

- **Balanço com "a conciliar" alto** → sub-razões incompletos (org sem `avg_cost`, recebível/pagável sem data, Motor de Caixa pouco alimentado). É honesto (RN-FIN-3/5); comunicar que não substitui o contador.
- **Δ estoque "não medido" no fluxo** → a org não gera `stock_movements` (ex.: estoque alimentado direto pela Alterdata). O efeito cai em "a conciliar" com caveat — não é bug.
- **Narrativa igual à determinística** → sem IA configurada (`isAIConfigured()` falso) ou erro na chamada. Comportamento esperado (0-regressão).
- **Sinal `lucro_sem_caixa` não some** → só resolve quando o caixa acompanha o lucro no período corrente (self-healing). Dispensa humana (`dismissed`) é respeitada.

## Relação

ADR-128 (DRE) · ADR-129 (Empresa × Proprietário) · Motor de Caixa (`cash_*`) · Frente 1 (#1506/#1507, DRE lê a loja física) · ADR-199 (Grupo — consolidação por fan-out, fora deste ADR).
