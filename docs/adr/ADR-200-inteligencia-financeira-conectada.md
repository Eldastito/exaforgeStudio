# ADR-200 — Inteligência Financeira Conectada: DRE + Balanço Patrimonial + Fluxo de Caixa (a leitura do "CFO")

**Estado:** proposto — decisão de arquitetura para a "Frente 2" levantada na investigação do menu **Relatórios** (pedido TOULON/Emerson). Documento de desenho **antes** de qualquer schema/código; fixa arquitetura, invariante gerencial×contábil, RN e o plano de fatias.
**Data:** 2026-09-08.
**Natureza:** aditiva, determinística (zero-token), read-model **derivado** dos sub-razões que já existem. NÃO cria um segundo motor contábil (Razão/GL), NÃO cria um segundo Motor de Caixa, NÃO substitui a contabilidade oficial. Zero-regressão sobre o DRE gerencial (ADR-128) e o Motor de Caixa existentes.
**Pré-requisito atendido:** Frente 1 (Relatórios/DRE enxergam a loja física — PRs #1506/#1507) já em produção; a receita física entra no DRE gerencial.

---

## 1. Contexto e problema

O gatilho é a metáfora do CFO (trazida pelo cliente): numa reunião de resultados, o executivo lê o **DRE** e comemora "lucrei R$ 1,5 mi"; o CFO, quieto, leu **três demonstrativos conectados** e viu a crise — *"o DRE diz que você lucrou 1,5 mi; o Balanço revela que 2 mi ficaram presos; o Fluxo de Caixa mostra que no fim você tem 500 mil a MENOS no banco."* A diferença não é ler mais números — é ler a **conexão** entre **DRE (competência)**, **Balanço Patrimonial (o que está preso)** e **Fluxo de Caixa (o que sobrou no banco)**.

### Onde o ZapFlow está (verificado no código)

| Demonstrativo | Situação hoje | Onde vive |
| --- | --- | --- |
| **DRE gerencial** | ✅ Existe (ADR-128) e, com a Frente 1, já soma a **loja física** | `ManagerialDreService` · rota `/api/dre` |
| **Fluxo de Caixa** | ✅ Existe como **Motor de Caixa** (saldo, eventos, previsão de semanas) | `cash_accounts`/`cash_events`/`cash_forecast_weeks`/`cash_actions` · `CashForecastService`/`CashActionService` · rota `/api/cash` |
| **Balanço Patrimonial** | ❌ NÃO existe como demonstrativo | — (mas os **componentes** existem, ver abaixo) |
| **A conexão dos três** | ❌ NÃO existe | — (cada tela lê seu número isolado — é exatamente o "ler no escuro" que o CFO critica) |

### O que já está no chão (os componentes do Balanço)

O Balanço Patrimonial gerencial NÃO precisa de um Razão contábil novo — os **sub-razões** que o alimentam já existem, isolados por org:

- **Ativo · Caixa/bancos** → `cash_accounts` (saldo do Motor de Caixa).
- **Ativo · Contas a receber** → `receivables` (competência × recebimento; já usado no Outcome Assurance/Cobrança).
- **Ativo · Estoque** → `retail_store_inventory` × `inventory_items.avg_cost` (valor de estoque a custo — a mesma fonte do CMV da Frente 1).
- **Passivo · Contas a pagar** → `payables` (competência do vencimento; já é a fonte das Despesas do DRE).
- **Patrimônio · Retiradas dos sócios** → `OwnerDrawService`/`owner_draws` (ADR-129).
- **Resultado acumulado** → o DRE gerencial (competência) já entrega `sobra`/`resultadoOperacional`.

### Consequência de projeto (a tese)

Como (a) o **Fluxo de Caixa** já existe (Motor de Caixa) e (b) os **componentes do Balanço** já são sub-razões isolados por org, a Frente 2 é essencialmente um **read-model derivado + a reconciliação que conecta**:

1. **Balanço Patrimonial gerencial** = montar os sub-razões numa foto (Ativo = Passivo + PL) numa data.
2. **Fluxo de Caixa pelo método indireto** = partir do **resultado do DRE (competência)** e reconciliar com a **variação de caixa** ajustando pelas **variações de capital de giro** (Δ contas a receber, Δ estoque, Δ contas a pagar) — que vêm justamente do Balanço.
3. **A conexão** = o read-model que mostra, lado a lado, *"lucro de competência (DRE) × dinheiro que entrou (Caixa) × o que ficou preso (Balanço)"* e NARRA a diferença ("lucrou X, mas Y está preso em estoque/recebíveis, então o banco tem Z").

Nenhum sub-razão precisa "entender demonstrativo"; a camada de consolidação deriva por query (RN-004), como o DRE gerencial já faz.

---

## 2. Objetivos e não-objetivos

**Objetivos**
1. Entregar os **três demonstrativos gerenciais** (DRE já existe; Balanço e Fluxo de Caixa indireto novos/derivados) para o mesmo período, isolados por org.
2. **Conectar** os três: uma leitura única que explica por que **lucro ≠ caixa** (o insight do CFO), a partir das variações de capital de giro.
3. Honrar os **dois fluxos** (loja física + virtual) já unificados na Frente 1.
4. **Zero regressão** no DRE gerencial (ADR-128) e no Motor de Caixa.

**Não-objetivos (fora de escopo — proibições duras)**
- **NÃO** criar um **Razão/Livro-diário contábil (GL) oficial**, plano de contas, partidas dobradas nem escrituração — isto é **gerencial e educativo**, não contábil (disclaimer obrigatório, herdado do ADR-128).
- **NÃO** criar um **segundo Motor de Caixa** — o Fluxo de Caixa reusa `cash_*` e o `CashForecastService`.
- **NÃO** criar um **segundo DRE** nem duplicar a lógica de receita/CMV/despesa — reusa `ManagerialDreService`.
- **NÃO** inventar valor: linha sem dado é `null`/"—" com nota, nunca zero forjado nem lucro/ativo fabricado (mesma regra da margem parcial da Frente 1).
- **NÃO** consolidar cross-org por SQL multi-tenant — se um dia entrar visão de Grupo (ADR-199), é por **fan-out** (RN-GRP-01), fora deste ADR.

---

## 3. Invariantes e regras de negócio (RN-FIN)

- **RN-FIN-1 — Gerencial ≠ contábil.** Disclaimer obrigatório em todo demonstrativo ("visão gerencial e educativa — não substitui a contabilidade oficial"). Não é base para imposto/obrigação acessória.
- **RN-FIN-2 — Derivado, nunca um segundo motor.** Todo número vem por query dos sub-razões existentes (`cash_*`, `receivables`, `payables`, `inventory`, `owner_draws`, DRE). Sem tabela de "saldo de balanço" mutável (RN-004).
- **RN-FIN-3 — Identidade do Balanço.** Ativo = Passivo + Patrimônio Líquido, sempre; a diferença residual (o que os sub-razões não explicam) aparece como **"a conciliar"** explícito, NUNCA é forçada a zero.
- **RN-FIN-4 — A ponte DRE→Caixa é o método indireto.** Fluxo de caixa operacional = resultado de competência ± variações de capital de giro (Δ receber, Δ estoque, Δ pagar). É essa conta que revela "lucro ≠ caixa".
- **RN-FIN-5 — Não inventa.** Componente sem fonte → `null` + nota (ex.: sem `avg_cost`, o estoque do Balanço é parcial — igual à margem parcial da Frente 1). Nunca forja ativo/lucro/caixa.
- **RN-FIN-6 — Dois fluxos.** Receita/estoque/recebíveis consideram loja física + virtual (Frente 1), sem duplicar fontes.
- **RN-FIN-7 — Isolado por org.** Toda query filtra `organization_id`. Cross-org proibido (só via fan-out, se e quando ADR-199).
- **RN-FIN-8 — Determinístico antes de LLM.** Os números são deterministicos (zero-token); a NARRATIVA da conexão (o "texto do CFO") pode ter uma camada LLM opcional GROUNDED nos números derivados — nunca inventa número.

---

## 4. Decisões (D1–D6)

### D1 — Balanço Patrimonial GERENCIAL derivado (sem GL)
`ManagerialBalanceSheetService.snapshot(orgId, asOf)`: monta a foto do patrimônio numa data a partir dos sub-razões — Ativo (caixa + a receber + estoque a custo), Passivo (a pagar), PL (aportes − retiradas + resultado acumulado gerencial). Residual não-explicado vira linha **"a conciliar"** (RN-FIN-3). Read-only, derivado (RN-FIN-2).

### D2 — Fluxo de Caixa pelo MÉTODO INDIRETO, reconciliado com o Motor de Caixa
`ManagerialCashFlowService.indirect(orgId, period)`: parte do **resultado do DRE** (competência) e ajusta pelas **variações de capital de giro** (Δ contas a receber, Δ estoque, Δ contas a pagar entre início e fim do período) → **fluxo de caixa operacional**; soma investimentos/retiradas → **variação de caixa esperada**. Concilia com a **variação REAL do Motor de Caixa** (`cash_events` no período); a diferença é a linha **"a conciliar"**. Reusa o Motor de Caixa, não o substitui (RN-FIN-2, não-objetivo).

### D3 — A CONEXÃO (o read-model que é o valor)
`ConnectedFinancialsService.assemble(orgId, period)`: entrega os três lado a lado + a **ponte explicada** — "Lucro (DRE) R$X · Dinheiro que entrou (Caixa) R$Y · Preso em estoque/recebíveis (Balanço) R$Z", com a decomposição do gap. É o "ver o filme completo": responde por que lucrou e não tem caixa. Publica o insight na espinha (`business_signals`, conv. nº 12) quando o gap é material (ex.: lucro positivo mas caixa caindo).

### D4 — Reusar tudo que existe
DRE = `ManagerialDreService` (com a física da Frente 1). Caixa real = `cash_*`/`CashForecastService`. Componentes do Balanço = `receivables`/`payables`/`retail_store_inventory`×`avg_cost`/`owner_draws`. Nada de fonte nova de verdade — só a camada de montagem/conexão.

### D5 — Honestidade parcial de primeira classe
Todo demonstrativo carrega `coverage`/notas: estoque sem custo, recebível/pagável sem competência clara, caixa não instrumentado → a linha entra como conhecida e o resto é sinalizado (RN-FIN-5), nunca forjado. Herda o padrão da margem parcial da Frente 1.

### D6 — Narrativa GROUNDED opcional (LLM)
Uma camada LLM opcional transforma os números derivados na "leitura do CFO" em português — SEMPRE ancorada nos números (RN-FIN-8); sem IA, o texto é o determinístico ("lucro X, caixa Y, preso Z"). Nunca inventa número.

---

## 5. Plano de fatias (fatia-por-PR)

- **F0 — Auditoria + este ADR** (doc-only). Mapa dos sub-razões e da régua de período; matriz componente→fonte. ✅ (este documento)
- **F1 — `ManagerialBalanceSheetService.snapshot`** (D1): Ativo/Passivo/PL derivados numa data, com "a conciliar" e coverage. Rota `GET /api/dre/balance`. `test:managerial-balance`. ✅ **em produção** — caixa RECONSTRUÍDO na data (saldo atual − eventos posteriores), a receber/a pagar ABERTOS na data, estoque a custo (retail×`avg_cost` com fallback armazém + coverage parcial honesto), PL = capital do sócio + "resultado acumulado / a conciliar" (residual explícito, identidade sempre fecha), `preso` = a receber + estoque (o capital de giro travado do CFO). 21 checks.
- **F2 — `ManagerialCashFlowService.indirect`** (D2): DRE→caixa pelo método indireto, reconciliado com `cash_events`. Rota `GET /api/dre/cashflow`. `test:managerial-cashflow`. ✅ **em produção** — parte do resultado do DRE e ajusta por Δ capital de giro (Δ a receber / Δ a pagar RECONSTRUÍDOS por data via o Balanço F1; Δ estoque pelos `stock_movements` a custo, "não medido" honesto sem movimento) → fluxo operacional; financiamento = aportes − retiradas; variação ESPERADA × REAL (Motor de Caixa) → "a conciliar" explícito. Prova o gap "lucro ≠ caixa". 18 checks.
- **F3 — `ConnectedFinancialsService.assemble`** (D3): os três + a ponte "lucro ≠ caixa"; sinal `financials/lucro_sem_caixa` no `business_signals` quando material. Rota `GET /api/dre/connected`. `test:connected-financials`. ✅ **em produção** — compõe DRE + Balanço (F1) + Fluxo indireto (F2); ponte = gap `lucro − caixa gerado` decomposto nas variações de capital de giro + narrativa determinística ("lucrou X mas o caixa só variou Y, R$Z presos"); sinal `connected_financials/lucro_sem_caixa` (hipótese, impact null, self-healing) quando lucrou mas o dinheiro não veio (material: caixa negativo ou ≥30% do lucro não virou caixa); `pass()` no Scheduler (dois fluxos). 17 checks.
- **F4 — UI** no menu Relatórios (ou um card "Leitura do CFO"): três demonstrativos + a narrativa da conexão; disclaimer sempre; dinheiro role-gated (§73). Sem tela concorrente ao Motor de Caixa.
- **F5 — Hardening + narrativa LLM opcional** (D6) + runbook: `test:connected-financials-hardening` codifica RN-FIN-1..8; `docs/runbook/financas-conectadas-operacao.md`.

---

## 6. Riscos e limitações

- **Precisão gerencial, não contábil.** Sem partidas dobradas, o Balanço pode ter "a conciliar" relevante em orgs com sub-razões incompletos — é honesto (RN-FIN-3/5), mas exige o disclaimer forte e comunicação clara de que não substitui o contador.
- **Cobertura depende do dado.** Sem `avg_cost` (estoque), sem competência em recebíveis/pagáveis, ou com o Motor de Caixa pouco alimentado, os três demonstrativos ficam parciais — sinalizado, nunca forjado.
- **Não é obrigação fiscal.** É ferramenta de decisão do dono (a "leitura do CFO"), não escrituração.

---

## 7. Relação com outros ADRs

- **ADR-128** (DRE gerencial) — base reusada; a Frente 1 (#1506/#1507) já fez o DRE enxergar a loja física.
- **ADR-129** (Empresa × Proprietário) — retiradas/PL.
- **Motor de Caixa** (`cash_*`, `CashForecastService`) — fonte do caixa real.
- **ADR-199** (Grupo multi-org) — se houver visão consolidada de grupo, é por fan-out (RN-GRP-01), fora deste ADR.
