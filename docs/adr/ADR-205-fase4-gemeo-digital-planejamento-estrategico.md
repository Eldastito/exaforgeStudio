# ADR-205 — Fase 4: Gêmeo Digital Gerencial, Planejamento Estratégico e Otimização da Rede

- **Status:** F4.0 FECHADA (doc-only, 2026-10-07). Demais fatias **não iniciadas**; aguardam as decisões abaixo.
- **Base:** ADR-203 (Fase 2), ADR-204 (Fase 3), ADR-136/156/157/199.
- **Análise:** `docs/prd/ANALISE-PRD-FASE4-vs-CODEBASE.md`.

## 1. Contexto
O PRD da Fase 4 leva o ZapFlow de "o que fazer" para "o que provavelmente acontece se eu fizer isso": cenários, benchmark da rede, planejamento, alocação de capital, backtest, Board/QBR. A auditoria mostra que ~70% da *composição* já existe (simuladores, caixa, metas, briefing, fornecedores, Grupo, inteligência de nicho) e que o **núcleo novo** — sensibilidade, backtest, alocação de capital, nova loja/canibalização, stress test — é justamente o que mais depende de dado ainda não validado.

## 2. Decisões de arquitetura
1. **Um `ScenarioEngine` como contrato**, não como 2º simulador: adaptadores sobre `DecisionSimulatorService`, `PurchaseScenarioService` e `CashForecastService`. Nenhum cálculo financeiro novo (RN-F4-11).
2. **Premissas são dado versionado**; cenário ≠ previsão (rótulos e campos distintos).
3. **Nada executa.** Decisão de alto impacto só por pessoa; o cenário alimenta `DecisionAction` apenas como recomendação.
4. **Contexto externo = `ResearchBrokerService`/ADR-156**, sem estrutura paralela. Benchmark de plataforma só agregado/anonimizado/com amostra mínima.
5. **Grupo por fan-out** (RN-GRP-01); nenhuma consulta cross-org.
6. Tudo aditivo, opt-in por flag, reversível (convenções nº 2, 10).

## 3. Guardrails
RN-F4-1..12 — ver a análise §5.

## 4. Decisões pendentes do dono
- **D1 — Pré-requisitos (ADR-204 §28.5).** Implementar F4.1 antes do piloto? **Recomendo:** só F4.1–F4.2 (motor + registro, que não dependem de calibração) com **confiança baixa por padrão**; F4.3 em diante só depois de 2 semanas de piloto evidenciado.
- **D2 — Dados que só o dono tem:** m² e equipe por loja, folha, aluguel/custo fixo, histórico mensal de vendas por loja (≥12 meses), margem real por coleção, prazo/entrada de fornecedores. Sem isso, nova loja/fechamento/benchmark são "perguntas", não resultados.
- **D3 — Escopo da primeira entrega:** compra de coleção + stress test de caixa (já há base) **antes** de nova loja/expansão (sem base). *(recomendo)*
- **D4 — O ZapFlow pode usar o campo `colecao` do ERP?** Confirmar se a TOULON preenche `colecao` na `Referencia` do Alterdata.
- **D5 — Cota diária:** como a cota é distribuída por loja/dia (print de 07→08/10: Grande Rio +52%, Av. Brasil +8,5%)? Define o "bottom-up".
- **D3 da Fase 3 (holdout) e consentimento:** seguem pendentes e continuam bloqueando campanha preditiva e backtest de campanha.

## 5. Plano
F4.1 Scenario Engine · F4.2 modelo estratégico · F4.3 benchmark interno · F4.4 planning · F4.5 alocação de capital · F4.6 fornecedores · F4.7 backtest · F4.8 Grupo · F4.9 contexto externo · F4.10 Board/QBR + piloto. Gates por fatia na análise §6.

## 6. Limites desta F4.0
Nenhum dado de produção foi acessado. Nenhuma simulação foi feita. Os números do print são cotas diárias e ilustram, não calibram.
