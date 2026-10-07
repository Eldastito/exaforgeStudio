# Análise PRD Fase 4 × codebase — Gêmeo Digital, Planejamento Estratégico e Otimização da Rede

**Status: F4.0 — doc-only (2026-10-07).** Nenhum código foi escrito. Este documento audita o PRD da Fase 4 contra o que já existe, diz o que é reuso e o que é lacuna, e diz **o que ainda não dá para afirmar**. Decisões do dono: ADR-205.

## 1. O que esta análise NÃO sabe (leia primeiro)

- **Não tenho acesso ao banco de produção da TOULON.** Esta sessão roda num container isolado; o `zappflow.db` que existe aqui é um arquivo local de desenvolvimento, ignorado pelo git e de 30/09 — **não é a base da TOULON** e não foi usado como prova de nada. Tudo que se afirma sobre dados reais abaixo vem do **print do dono (07/10)** ou do **código**.
- Os números do print são **cotas diárias** (e ainda sem venda do dia: "0 de 5 lojas com fechamento", Informado R$ 0,00 às 11:04). Não são histórico de vendas, margem nem estoque. Servem para ilustrar top-down × bottom-up, **não** para calibrar nada.
- Nada da Fase 3 foi validado por vendedor no celular (ADR-204 §28). A Fase 4 herda esse risco: cenário sobre dado não conferido sai **com confiança baixa**, e o sistema tem que dizer isso.

### Dados informados pelo dono (print de 07/10, Operação da Rede → Informe diário)
| Loja | Cota 07/10 | Cota 08/10 | Δ |
| --- | ---: | ---: | ---: |
| Av. Brasil | 5.022 | 5.450 | +8,5% |
| Bangu | 2.150 | 2.650 | +23,3% |
| Carioca | 1.580 | 1.750 | +10,8% |
| Grande Rio | 2.890 | 4.400 | +52,3% |
| Nova Iguaçu | 2.600 | 3.500 | +34,6% |
| **Rede** | **14.242** | **17.750** | **+24,6%** |

Pergunta em aberto (não é conclusão): por que a cota de Grande Rio sobe 52% de um dia para o outro enquanto Av. Brasil sobe 8,5%? Dia da semana, regra de distribuição ou meta manual? Isso muda como o "bottom-up" da Fase 4 deve tratar a cota.

## 2. Matriz PRD §→ o que já existe

| PRD | Pedido | Já existe (reusar) | Lacuna real |
| --- | --- | --- | --- |
| §4–8 | Scenario Engine (conservador/base/favorável, premissas editáveis, cenário ≠ previsão) | `DecisionSimulatorService` (`scenarios`, `buyStock`, `hire`, `withdraw`, `payback`) · `PurchaseScenarioService` (F3.9) · `CashForecastService` (13 semanas) · `RetailForecastService` (faixa + confiança por loja) | Sem **sensibilidade**, sem **versão/registro de premissas**, sem **comparação cenário × real depois**, sem faixa de confiança unificada. Cada simulador tem seu formato. |
| §9–11, 35–37 | Plano semestral/anual, calendário estratégico, orçamento, caixa 3/6/12m, stress test | `CashForecastService` · `BusinessGoalService` · Mission OS / `MissionReversePlanner` · `PeriodicBriefingService` | Horizonte > 13 semanas, orçamento comercial consolidado, calendário estratégico por período, stress test (não existe). |
| §12–13 | Alocação de capital | — (nada) | Tudo. Depende de retorno esperado por alternativa — dado que hoje não existe estruturado. |
| §14–16 | Benchmark interno da rede normalizado | `RetailFloorAnalyticsService` · `SellerDiagnosisService` · `RetailForecastService` · `GroupConsolidationService` (consolida, não normaliza) | **Normalização por oportunidade** (fluxo/m²/equipe), "práticas a testar" como experimento. Ranking simples já existe — é justamente o que o PRD proíbe. |
| §17–18, 47 | Benchmark externo / inteligência competitiva | `ResearchBrokerService` · `VerticalIntelligenceService` (ADR-156/157, camada anonimizada, `evidenceMode`, fonte e data) | Consumo pelo FalaTu em linguagem de varejo de moda; mínimo de amostra para benchmark de plataforma (§46). |
| §19–25 | Planejamento de lojas, fechamento, nova loja, expansão, canibalização, equipe | `DecisionSimulatorService.hire`/`payback` (parcial) | Nova loja, fechamento, **canibalização**, score de região, capacidade de equipe. Quase tudo é novo; depende de histórico por loja e dado externo de região. |
| §26–27 | Meta inteligente, top-down × bottom-up | `NetworkObjectiveService` (top-down: rede → lojas, F3.6b) · `RetailForecastService` | **Bottom-up** (capacidade histórica) e o **gap** entre ambição e capacidade. |
| §28–30 | Backtesting de política/comissão/campanha | — (grep: zero) | Tudo. Exige o histórico de vendas por vendedor/dia e as regras de comissão como dado. |
| §31–34 | Orçamento de marketing, Supplier Intelligence, concentração, negociação | `SupplierPerformanceService` · `SupplierQuoteService` · `PurchaseOrderService` · `PurchasePayableService` | Concentração de compras, histórico de prazo/entrada por fornecedor consolidado, texto de negociação. É composição, não ERP novo. |
| §38–41 | Conselho virtual, memória estratégica, decisão → hipótese → resultado | Memória empresarial (F3.2) · `PatternMemoryService` · `OutcomeAssuranceService` | Registro de decisão estratégica com hipótese e resultado comparável. Multi-perspectiva explícita (financeiro × comercial × operacional) com contradição declarada. |
| §42–43 | Board Review mensal, QBR | `PeriodicBriefingService` (semanal/mensal, F3.10) | Estrutura executiva (o que mudou/funcionou/não funcionou/riscos/decisões pendentes), trimestral, export. **Herda as lacunas do briefing**: margem confiável, estoque, clientes e campanhas não são lidos. |
| §44–46 | Grupo, comparação entre empresas, não misturar clientes | `GroupConsolidationService` (fan-out, ADR-199, atrás de `FEATURE_ORG_GROUPS`) | Métricas normalizadas entre operações; regra de amostra mínima/anonimização para benchmark de plataforma. |

**Estimativa honesta de reuso:** a parte de *composição* (briefing, caixa, metas, fornecedores, grupo, pesquisa externa) está ~70% pronta. A parte que dá nome à fase — **sensibilidade, backtest, alocação de capital, nova loja/canibalização, stress test** — é **nova** e é a que mais depende de dado que ninguém conferiu.

## 3. Dados necessários × estado conhecido

| Dado | Onde está no código | Estado |
| --- | --- | --- |
| Vendas por loja/dia | PDV/Alterdata (`retail_*`) | Existe; **qualidade e meses de histórico por loja não conferidos** (Bangu < 3 meses, conforme F3). Hora da venda **não confiável** (D7). |
| Custo/margem | `products_services` (custo médio, `custo` do ERP em `metadata_json`) · `LossMarginService` | Existe no modelo; **margem "confiável" nunca foi validada** — por isso o briefing a declara fora. |
| Estoque | `retail_stock_*` · Alterdata stock mapper | Existe. Saldo negativo ≠ falta sem META (ADR-170). |
| **Coleção** | `AlterdataSupplyMapper` grava `colecao` da `Referencia` em `products_services.metadata_json.alterdata.colecao` | **Corrijo o ADR-204 §28.2 #9:** a dimensão *é capturada* quando o ERP envia; o que falta é (a) conferir se o ERP da TOULON preenche, (b) **usar** o campo (hoje nada calcula sell-through por coleção) e (c) data de entrada/quantidade comprada por coleção. |
| Contas a pagar / fornecedores | `PurchasePayableService`, `SupplierPerformanceService` | Existe; cobertura real não conferida. |
| Clientes/campanhas | CRM, campanhas | Existe; **o briefing não os lê** (limitação do serviço, não ausência do dado — corrijo a redação do §28.2 #8). |
| Folha / aluguel / custo fixo | — | **Não identificado** como dado estruturado. Necessário para nova loja, fechamento e break-even. |
| Fluxo de pessoas/m² | — | **Não existe.** Benchmark "venda/m²" só se o dono informar m² por loja. |

## 4. Riscos do PRD (a contradizer, não a aceitar)

1. **Falsa precisão em cenários de alto impacto** (nova loja, fechamento) com histórico curto. Mitigação do próprio PRD (faixas, confiança) é necessária, mas **não suficiente**: sem dado de folha/aluguel/região, esses cenários só podem ser *gabaritos de pergunta* ("preciso que você informe X"), não resultados.
2. **Backtest vira promessa.** O PRD diz que não é; a UI tem que impedir a leitura como "vai render".
3. **Benchmark externo cross-tenant** (§46) é o ponto de maior risco de privacidade. Só entra o que já passa pelo filtro de anonimização do ADR-156; nada novo cruza organizações.
4. **Escopo.** 10 fatias de motor novo sobre superfícies da Fase 2/3 ainda não validadas. Recomendo parar na F4.2 até o piloto produzir evidência (ADR-205 D3).
5. **Capacidade de decisão do operador:** o PRD pressupõe que Bruno responde a cenários em linguagem natural. Nenhum teste de uso real do FalaTu estratégico existe.

## 5. Guardrails RN-F4 (do PRD §50–55)

RN-F4-1 simulação **nunca executa** · RN-F4-2 decisão de alto impacto (loja, dívida, folha, demissão, investimento relevante) exige pessoa · RN-F4-3 cenário ≠ previsão (rótulos distintos) · RN-F4-4 premissas sempre visíveis e editáveis, versionadas · RN-F4-5 faixa, não ponto · RN-F4-6 dado ausente reduz confiança e é dito · RN-F4-7 contexto externo com fonte e data · RN-F4-8 correlação ≠ causalidade; backtest ≠ promessa · RN-F4-9 benchmark externo agregado/anonimizado/mínimo de amostra · RN-F4-10 isolamento por organização no Grupo · RN-F4-11 cálculo financeiro **reusa** o canônico (nenhum duplicado) · RN-F4-12 fechamento de loja = análise econômica, nunca recomendação trabalhista/jurídica.

## 6. Plano F4.1–F4.10 (ajustado)

| Fatia | Entrega | Gate | Observação |
| --- | --- | --- | --- |
| F4.1 | `ScenarioEngine`: contrato único (premissas versionadas, 3 cenários, faixa, confiança, sensibilidade) **sobre** `DecisionSimulatorService`/`PurchaseScenarioService`/`CashForecastService` | F4.0 aceita | Sem tabela de dinheiro nova; adaptadores, não reescrita. |
| F4.2 | Modelo estratégico: decisão → premissas → cenário → resultado real depois | F4.1 | Aditivo; liga a `OutcomeAssurance`. |
| F4.3 | Benchmark interno normalizado | **Dados de oportunidade por loja informados pelo dono** | Sem isso, só ranking — que o PRD proíbe. |
| F4.4 | Planning Engine (mensal/trimestral/anual, orçamento, calendário) | Piloto + D3 | Herda lacunas do briefing. |
| F4.5 | Alocação de capital | F4.1 + retorno esperado estruturado | Compara trade-offs; **não escolhe**. |
| F4.6 | Supplier Intelligence + negociação | Cobertura de compras conferida | Composição. |
| F4.7 | Backtesting | Histórico confiável por vendedor/dia | Só leitura; não toca produção. |
| F4.8 | Group Intelligence | `FEATURE_ORG_GROUPS` ligada | Fan-out, nunca SQL cross-org. |
| F4.9 | Contexto externo / nicho | — | Reusa `ResearchBrokerService`. |
| F4.10 | Board Review + QBR + piloto TOULON | F4.1–F4.4 + piloto | Reaproveita `PeriodicBriefingService`. |

## 7. Testes obrigatórios (PRD §54) → onde entram
Venda −20% / +20% · fornecedor +preço · prazo reduz · nova loja · fechamento · contratação · compra grande de coleção · estoque encalha · campanha abaixo · meta agressiva · comissão alterada → todos viram casos do `test:scenario-engine` (F4.1) e `test:strategic-*`, **com dado sintético**. Nenhum deles valida o negócio da TOULON; só o motor.

## 8. Critério de sucesso (PRD §57) — leitura honesta
O ZapFlow poderá *montar e comparar cenários* depois da F4.1–F4.5. Que o resultado seja **útil à estratégia da TOULON** só se prova com dado real conferido e acompanhamento da decisão ao longo de meses (F4.2). Isso não cabe em PR.
