# ADR-128 — DRE Gerencial Simplificada (venda × lucro × caixa)

- **Status:** Implementada (Fatias 1–2). F1: DRE mensal (linhas de D1, fontes core + Comigo, descontos das perdas, despesas por competência, disclaimer, rota `/api/dre`, DRE na tela de Relatórios) + retiradas via ADR-129. F2: despesas fixas × variáveis (recorrentes × avulsas), devoluções com driver próprio (ADR-114), comparação mês a mês (deltas nas linhas-chave).
- **Data:** 2026-07
- **Origem:** PRD "Central de Sobrevivência e Decisão" — Épico 3. Traduzir a saúde econômica em linguagem simples, **sem substituir a contabilidade oficial**. Muitos negócios fecham por confundir **faturamento, lucro e caixa**.
- **Relacionadas:** ADR-125 (Motor de Caixa — o "caixa" do trio), ADR-114 (perdas/descontos), ADR-127 (Índice — consome margem), AnalyticsService.getProfit (receita/CMV do core), ComigoHealthService (lucro do Comigo), Empresa × Proprietário (ADR futuro — retiradas). ADR-088 D5 (frugal), PRD §23 (fora do MVP: substituir contabilidade/tributário).

## Contexto

O dono vê "vendeu bem" e acha que "sobrou dinheiro" — mas venda ≠ lucro ≠ caixa. A DRE gerencial mostra, **em linguagem simples e por regra determinística**, como a receita vira (ou não) resultado. É **gerencial e educativa**, não a DRE contábil oficial: o disclaimer é obrigatório e visível.

## Decisões

### D1 — Estrutura enxuta (PRD §10), linha a linha
```
  Receita bruta
(-) Devoluções / descontos
= Receita líquida
(-) Custo dos produtos/serviços vendidos (CMV)
= Margem bruta            (+ margem %)
(-) Despesas (fixas + variáveis)
= Resultado operacional
(-) Retiradas dos sócios
= Sobra (reinveste) / Consumo (tira do caixa)
```
Cada linha traz a **fonte** e é **rastreável**; margem % = margem bruta / receita líquida (não exibe se receita = 0).

### D2 — Fontes por linha (reuso, multi-vertical)
- **Receita bruta e CMV:** soma do **core** (`AnalyticsService.getProfit` — `order_items` com `unit_cost`) **+ Comigo** (`comigo_orders`/`comigo_order_items` pagos, com custo snapshot). Assim a DRE serve tanto varejo/serviço quanto o autônomo (cuja venda é toda no Balcão). Cada origem é somada; o breakdown mostra core × Comigo.
- **Descontos:** perdas com `driver = 'desconto'` do mês (ADR-114). (Devolução ganha driver próprio numa fatia futura.)
- **Despesas:** contas a pagar do mês (ADR-125 `payables`), agregadas por categoria. **Regime**: gerencial por **competência do vencimento** no mês (não é o caixa) — a diferença competência × caixa é justamente o que a DRE ensina, e o caixa fica no Motor de Caixa.
- **Retiradas dos sócios:** **placeholder = 0** nesta fatia, com nota "cadastre no Empresa × Proprietário" (ADR futuro). Quando existir, entra aqui sem redesenho.

### D3 — Determinística e frugal
Cálculo 100% determinístico (zero-token); o LLM (Diretor IA) só **narra** a DRE sob demanda. Isolado por `organization_id`. Período configurável (mês corrente por padrão).

### D4 — Disclaimer obrigatório
Toda tela/resposta traz, de forma visível: **"Visão gerencial e educativa — não substitui a contabilidade oficial."** (PRD §26.2.6). Não faz apuração tributária nem substitui contador.

## Escopo (faseamento)
- **Fatia 1:** `ManagerialDreService.monthly(orgId, period)` (as linhas de D1, fontes de D2, breakdown core × Comigo, disclaimer) + rota `/api/dre` + UI (a DRE na tela de Relatórios ou uma aba própria) + `test:managerial-dre`.
- **Fatia 2:** despesas fixas × variáveis (classificação por categoria), devoluções com driver próprio, comparação mês a mês.
- **Depende de / habilita:** Empresa × Proprietário (retiradas) — ADR seguinte.

## Consequências
**Positivas:** ensina venda × lucro × caixa (dor central do PRD); multi-vertical (core + Comigo); reusa getProfit, perdas e contas a pagar; determinística e testável; alimenta o Índice (margem) e a Central.

**Trade-offs / riscos:** competência × caixa pode confundir → a UI **explica** a diferença e aponta o Motor de Caixa para a visão de caixa; despesas hoje sem split fixa/variável → Fatia 2; retiradas em 0 até o ADR Empresa × Proprietário → nota explícita; risco de ser lida como contábil → **disclaimer obrigatório**.

## Guardas
- **Não substitui a contabilidade** — disclaimer obrigatório e visível.
- Determinística e transparente (fonte por linha); frugal (zero-token).
- Isolada por `organization_id`; margem não exibida com receita zero.

## Testes
- `test:managerial-dre` — receita/CMV somando core + Comigo; margem bruta e % corretas; descontos abatem a receita; despesas reduzem o resultado; resultado = receita líquida − CMV − despesas − retiradas; disclaimer presente; período isolado por org; org vazia zerada sem quebrar.
