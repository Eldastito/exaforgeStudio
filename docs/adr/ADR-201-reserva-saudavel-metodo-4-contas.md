# ADR-201 — Reserva Saudável (método das 4 contas / Profit First)

**Status:** F1 em produção (fatia única — serviço + rota + Scheduler + UI + teste).
**Contexto de origem:** observação do cliente / vídeo sobre o "método das 4 contas" (lógica *Profit First*): alocar o faturamento por percentuais fixos e **reservar o lucro primeiro**, em vez de "lucro = o que sobrar".

## Problema

A DRE gerencial (ADR-128) responde **o que aconteceu** — `receita − CMV − despesa − retirada = sobra`. É descritiva e olha pra trás. Falta a leitura **prescritiva** que o dono de fato faz: *"de cada real que entra, quanto DEVERIA ir pra cada bolso, e onde eu estou estourando?"*.

O `OwnerDrawService` (ADR-129) já é o mais próximo disso (sugere pró-labore sustentável e alerta excesso), mas ancorado em **% do resultado**, não no rateio das 4 contas sobre o faturamento.

## Decisão

Adicionar `HealthyReserveService` — uma **lente prescritiva** sobre os números que a DRE já calcula. Zero tabela nova (RN-HR-4, derivado/RN-004), zero segundo motor financeiro (RN-HR-7 — reusa `ManagerialDreService` + as retiradas).

As 4 contas e seus alvos (configuráveis, defaults):

| Conta | Tipo | Default | Realizado (medido?) |
| --- | --- | --- | --- |
| Lucro | reserva (piso) | 10% | **sim** — a sobra (`resultado − retiradas`) |
| Pró-labore | teto | 50% | **sim** — retiradas `pro_labore` do mês |
| Impostos | reserva | 18% | **não** — misturado nas despesas → só a meta de reserva |
| Operação | teto | 22% | **sim** — despesas por competência |

### Base do rateio (o ponto de honestidade — RN-HR-2)

Os 10/50/18/22 assumem um negócio de **serviço**, onde o maior custo é "operação". Numa **loja (moda/varejo)** o maior custo é o **CMV** (comprar mercadoria) — que **não é uma das 4 contas**. Aplicar "operação ≤ 22% do faturamento" cru numa rede de moda acusaria falso estouro (10+50+18+22 já esgota 100% do faturamento **sem sobrar nada pra comprar mercadoria**).

Por isso o rateio corre sobre:
- **margem bruta** (`receita − CMV`) nas verticais de mercadoria (varejo, moda, food, hospitalidade, beleza, petshop);
- **faturamento** (receita líquida) nas demais;
- ou o modo **forçado** pela config (`reserve_base_mode`).

Quando o CMV físico ainda é parcial (`retailCostPartial` da DRE), o serviço carrega o caveat de que a base pode estar superestimada. Base ≤ 0 → **não rateia** (RN-HR-5, `null ≠ 0`).

### Sinal proativo (advisory, opt-in)

`publishReserveSignal` publica um `business_signal` (`healthy_reserve/allocation_off`, `basis:'hypothesis'`, `impactAmount:null`) quando a alocação sai do saudável (operação/pró-labore acima do teto, ou lucro abaixo da meta). **OPT-IN** por `healthy_reserve_enabled` (não estreia um tipo de sinal em todo mundo); **ver** o plano não exige flag. Self-healing por dedupe. `pass()` no Scheduler pega só orgs opt-in com receita no mês — os **dois fluxos** (online + loja física), espelhando `ResultProjectionService.pass`.

## Guardrails RN-HR

1. **Advisory** — sugere reserva, **nunca move dinheiro** (sem `decision_action`).
2. **Base honesta por setor** — varejo rateia sobre margem bruta.
3. **Só compara o que mede** — impostos é reserva sugerida, não medição.
4. **Derivado** (RN-004) — zero tabela nova.
5. **Nunca inventa dinheiro** — base ≤ 0 → sem rateio; `impactAmount` null.
6. **Isolado/determinístico** — `organization_id` sempre; zero-token.
7. **Reusa a DRE + as retiradas** — sem 2º motor financeiro.

## Rotas

- `GET /api/dre/healthy-reserve?period=YYYY-MM` → `{ plan, config }` (owner/admin, §73).
- `PUT /api/dre/healthy-reserve/config` → alvos (%), `baseMode`, flag do sinal.

## Superfície

Card **"Reserva saudável"** no menu Relatórios (`ReportsPanel`), abaixo da DRE e da Projeção do mês: as 4 contas com meta (R$/%) × realizado × status, base do rateio explícita, caveats e o toggle do aviso proativo.

## Não-objetivos

- Não cria "envelopes" de reserva reais no Motor de Caixa (fica pra uma F2 futura — hoje é orientação, não movimentação).
- Não mede o imposto realizado (a DRE não separa) — declara isso, não finge.
- Não substitui a contabilidade oficial (disclaimer sempre).

## Testes

`test:healthy-reserve` (26 checks): base por setor (varejo margem bruta × serviço faturamento), metas × realizado × status, impostos não medido, base ≤ 0 sem rateio, config get/set com validação, sinal opt-in + hipótese + impact null + self-healing, `pass()` só opt-in com receita (rede física incluída), isolamento. Regressão verde: `test:managerial-dre` (29), `test:owner-draws` (15), `tsc`.
