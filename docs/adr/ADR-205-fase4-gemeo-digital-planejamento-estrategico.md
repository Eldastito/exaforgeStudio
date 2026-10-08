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

## 7. Status F4.1 — EM PR (Scenario Engine, 2026-10-07)
Decisão do dono: "começar a F4.1 com as recomendações" → D1 adotada como recomendada (motor + registro **antes** do piloto, com confiança limitada); D2–D5 seguem abertas e **não** bloqueiam esta fatia.

`ScenarioEngine` (`src/server/ScenarioEngine.ts`) é um **contrato**, não um 2º simulador (RN-F4-11): os cálculos continuam em `PurchaseScenarioService`/`CashForecastService`/`DecisionSimulatorService`; o motor padroniza a saída. Três tipos: **compra de estoque** (3 cenários), **vendas ±X%** e **contratação**. Rota `POST /api/health-center/simulate/scenario` (+ `GET …/kinds`), só gestor (§73).

- **Cenário ≠ previsão:** `type:"scenario"`, `isForecast:false`, frase "se estas premissas ocorrerem… Não é uma previsão". **Nunca executa** (`executes:false`; nada é gravado).
- **Premissas:** cada uma com origem `data`/`default`/`user` e `editable`; `assumptionsVersion` = hash (F4.2 persiste e compara com o real). Alterar premissa = rodar de novo com outro valor.
- **Faixa:** `range.display` arredonda (2 algarismos; 3 a partir de 1 mi) — nunca centavos.
- **Sensibilidade:** re-roda o cálculo canônico variando um driver por vez e ranqueia por efeito. Compra: valor (preço do fornecedor) e prazo. Vendas: variação % e margem. Contratação: custo. **Declarado como não modelado:** entrada, remarcação (markdown), custos fixos, quanto o contratado vende.
- **Confiança:** limitada a "média" enquanto `PILOT_VALIDATED=false` (ADR-204 §28.5), com o motivo dito; dado ausente → null e confiança baixa.
- **Casos do PRD §54 cobertos aqui:** venda −20%, venda +20%, fornecedor aumenta o preço, prazo reduz, compra grande de coleção, contratação. **NÃO cobertos (sem dado/sem motor):** nova loja, fechamento, estoque encalha (só o encalhe medido que a compra já mostra), campanha abaixo, meta agressiva, comissão alterada (F4.7).
- `test:scenario-engine` (42): contrato, validação, faixa, premissas/versão, sensibilidade, cada caso acima, confiança (inclui mutação do gate), isolamento, rota.
- **Sem UI** nesta fatia (superfície do FalaTu/Central de Saúde vem depois de validar o formato). Dados da TOULON **não** foram usados.

## 8. Status F4.2 — MERGED (#1861) (Modelo estratégico: decisão → hipótese → resultado, 2026-10-07)
Decisão do dono: "começar a F4.2 com as recomendações" (D1 como recomendada: registro **antes** do piloto, confiança limitada).

`StrategicDecisionService` + 2 tabelas aditivas (`strategic_decisions`, `strategic_decision_outcomes`) fecham o ciclo que a F4.1 abriu: o cenário vira **decisão registrada**, e o **resultado real** volta para dizer se o motor acertou.

- **Registrar ≠ executar** (RN-F4-1): não cria ação, pedido, pagamento nem tarefa; só **dono/admin** registra e decide (RN-F4-2). Estados: `considering` → `decided`/`rejected` → `revoked`.
- **Snapshot congelado e calculado no servidor:** o cenário é rodado pelo `ScenarioEngine` na hora do registro (o cliente não envia o resultado) e guardado com `assumptionsVersion`/`engineVersion`/confiança. Mudar vendas ou caixa depois **não** altera o que foi decidido (convenção nº 3).
- **Faixa esperada:** vem da faixa do cenário; cenário de **caso único** (vendas, contratação) não tem faixa, então usa o valor **± tolerância** (padrão **20%**, declarada e editável — é premissa, não dado).
- **Resultado APPEND-ONLY:** a última medição vale, a anterior fica no histórico, `basis` fact|estimate dito por quem informou. `compare` devolve `within`/`below`/`above`/`no_actual`/`no_expectation` — **sem expectativa ou sem medição nunca vira "acertou"**.
- **Calibração:** taxa de resultados dentro da faixa com intervalo de Wilson (reuso de `statsWilson`); `null` sem amostra; amostra pequena é dita ("não é prova de que o motor acerta").
- **Memória estratégica (PRD §40):** categoria `principle` ("priorizar margem sobre crescimento") — explícita, **revisável** (`revoke`, `revisit`), nunca inferida. Texto livre é dado do dono, truncado e sem controle; quem reusar num prompt trata como não confiável.
- **Lembrete de revisão:** quando `reviewOn` vence sem resultado (ou a diretriz precisa de revisão), o Scheduler publica UM sinal em `business_signals` (conv. nº 12, fato, sem dinheiro), que **resolve sozinho** ao registrar o resultado ou revisitar.
- Rotas em `/api/health-center/strategic/*` (ler = gestor; escrever = dono/admin). `test:strategic-decisions` (46, com mutação verificada).
- **Limites:** o resultado real é **informado por uma pessoa** (o sistema ainda não o mede sozinho); sem UI; sem dados da TOULON. A calibração só diz algo depois de várias decisões com resultado — meses de uso.

## 9. Status F4.3 — MERGED (#1862) (Benchmark interno normalizado, 2026-10-07)

`StoreBenchmarkService` + 1 tabela aditiva (`store_opportunity_profiles`) comparam as lojas **da própria rede** sem cair no "ranking de venda bruta" que o PRD proíbe. Loja grande sempre vence loja pequena em faturamento bruto — comparar exige **normalizar**, e normalizar exige dado que só o dono tem.

- **O que é dado do dono (novo):** m² da loja, tamanho da equipe, data de abertura — `PUT /benchmark/profiles/:storeId` (só dono/admin; atributo atual com auditoria, não série). Aluguel, folha e custos fixos **já existiam** (`RetailStoreCostService`) e o faturamento vem dos fechamentos: o serviço só **compõe** (RN-F4-11).
- **Métricas:** faturamento por m², faturamento por pessoa, custo fixo sobre faturamento (nesta, menor é melhor).
- **Sem dado, sem comparação:** insumo faltando → `null` por loja (null ≠ 0) e a loja entra em `missing`. Faturamento 0 = "sem fechamento no mês", não "vendeu zero".
- **Amostra mínima (D, 3 lojas comparáveis por métrica):** abaixo disso `ranked:false` + motivo. Com 2 lojas qualquer "ranking" é uma subtração.
- **Loja nova (<6 meses de abertura) fica fora do ranking** e é dita; abertura desconhecida entra, com aviso. **Mês corrente não ranqueia** (faturamento parcial contra custo fixo cheio); o padrão é o último mês fechado.
- **Resultado:** posição vs **mediana** (acima/perto/abaixo, faixa de ±10%) e **perguntas neutras** para quem está ≥25% pior ("o que é diferente nessa loja?"). Nunca causa (RN-F4-8), nunca meta, nunca recomenda fechar loja/contratar/demitir (RN-F4-12). Confiança só `insuficiente`/`baixa`/`media` — um mês não vê sazonalidade.
- Read-only: não cria ação, sinal nem tarefa. Rotas `GET /api/health-center/benchmark/{stores,profiles}` (ler = gestor) e `PUT …/profiles/:storeId` (dono/admin). `test:store-benchmark` (34, com mutação verificada em 4 regras).
- **Limites:** só **uma** rede (benchmark externo/entre empresas é F4.8/F4.9, com anonimização e amostra mínima); um único mês; sem UI; **inútil até o dono preencher m² e equipe** — o sistema não inventa. Os limiares (3 lojas, 6 meses, ±10%, ≥25%) são premissas declaradas, **sem calibração com dado real da TOULON**.

## 10. Status F4.4 — MERGED (#1863) (Plano de período do dono + plano × realizado, 2026-10-07)

`StrategicPlanService` + 2 tabelas aditivas (`strategic_plans`, `strategic_plan_lines`). **Escopo deliberadamente menor que o "Planning Engine" do PRD:** o gate da análise (§6) para a F4.4 era "piloto + D3" e **nenhum dos dois foi cumprido** (o piloto não rodou; não há histórico validado). Por isso a fatia **não projeta nada**: é o plano do dono (intenção) com acompanhamento do realizado. Sem previsão de horizonte longo, sem meta sugerida — para "e se?" existe o `ScenarioEngine` (F4.1).

- **O plano é escrito pelo dono** (só owner/admin cria, revisa, ativa, encerra — RN-F4-2) para um **mês, trimestre ou ano** atual/futuro, com 3 tipos de linha: **meta de faturamento**, **orçamento por categoria** (compras, marketing, pessoal, estoque, aluguel, outros) e **calendário de eventos** com impacto de caixa que o dono declara.
- **Versionado e append-only:** revisar cria a versão N+1; as anteriores ficam. Um único plano em aberto (rascunho/ativo) por período; encerrado não se revisa, e o período pode ganhar plano novo.
- **Realizado sempre derivado (RN-004):** faturamento dos fechamentos das lojas; orçamento das **contas a pagar lançadas com a categoria** do plano (comprometido × pago × restante). Sem fechamento → `null` (não "faturou zero"); sem contas a pagar lançadas → orçamento `null` e dito.
- **Ritmo** = régua linear de calendário (dias decorridos ÷ dias do período, banda ±10%): `ahead`/`on_pace`/`behind`, e após o fim `met`/`missed`. É régua, **não previsão** e não conhece sazonalidade — declarado nos avisos.
- **Contexto:** mostra o realizado do período anterior e quanto a meta cresce sobre ele, para o dono ver o tamanho da ambição (derivado; não recomenda).
- **Caixa dos eventos:** soma só o que o dono declarou, rotulada "declarado", **fora** do caixa previsto. Nada é executado (sem ação, tarefa, pedido, mensagem nem sinal — RN-F4-1).
- Rotas `/api/health-center/plans[/:id[/track|/activate|/close]]` (ler = gestor; escrever = dono/admin). `test:strategic-plan` (34, mutação verificada em 5 regras).
- **Limites:** só leitura de realizado em nível de período (mês inteiro, não por dia); faturamento só de lojas com fechamento diário; orçamento só do que for lançado; **sem UI**; sem validação com dado real da TOULON. Orçamento comercial consolidado, calendário por loja e horizonte > 13 semanas ficam para depois do piloto.

## 11. Status F4.5 — MERGED (#1864) (Comparação de alternativas de investimento, 2026-10-07)

`CapitalAllocationService` — **compara, não escolhe**. É stateless e read-only: sem tabela, sem gravação. O gate da análise para a F4.5 era "F4.1 + retorno esperado estruturado": a F4.1 existe; o retorno estruturado **não existe no sistema e não pode ser inventado** — por isso ele é a entrada **obrigatória** do dono.

- **Entrada (2 a 8 alternativas):** nome, valor, **retorno mensal esperado em faixa** (pior–melhor), **de onde vem o número** (`source`), **quão firme é** (`basis`: fact|estimate|hypothesis), **risco** (low|medium|high) e **se é reversível**; início do retorno (0–24 meses) e horizonte (1–60, padrão 12). **Nada é preenchido por padrão:** faltou qualquer um desses → o serviço recusa com o motivo. Capital disponível é opcional.
- **Saída por alternativa:** líquido em faixa (retorno × meses de retorno − investimento), ROI em %, payback em faixa (`null` quando o pior caso não rende — "pode não se pagar", nunca um número otimista), efeito do desembolso no caixa (menor caixa projetado em 13 semanas, **rodado no `ScenarioEngine`** — RN-F4-11), a origem/firmeza que o dono declarou e confiança (`media` só se `fact`; senão `baixa`; **nunca alta**).
- **Sem vencedor:** não há "melhor", ranking, score nem recomendação. Há (a) **liderança por critério** — menor desembolso, maior potencial, melhor pior caso, payback mais rápido, menor risco, reversíveis — com **empates listados**; (b) **dominância** puramente lógica (custa ≤, rende ≥ nos dois extremos, começa antes, risco ≤, tão reversível), só informativa; (c) com capital informado, as **combinações que cabem**, somando faixas (pior+pior, melhor+melhor), **em ordem de cadastro, não de preferência** (corte em 40).
- **Decisão é humana (RN-F4-2):** `decisionOwner:"human"`; depois de decidir, registra-se em `/strategic/decisions` (F4.2) para confrontar a hipótese com o resultado real.
- Rota `POST /api/health-center/capital/compare` (gestor — mostra caixa). `test:capital-allocation` (35, mutação verificada em 7 regras).
- **Limites:** o resultado é **tão bom quanto o retorno que o dono informa** — se estiver otimista, a comparação também estará; não modela interação entre alternativas (canibalização, mesma equipe, mesmo cliente); o caixa só enxerga 13 semanas e só o desembolso (não o retorno chegando); horizontes diferentes não são diretamente comparáveis (avisado); **sem UI**; sem dado real da TOULON.

## 12. Status F4.6 — MERGED (#1865) (Inteligência de fornecedores + pauta de negociação, 2026-10-08)

`SupplierIntelligenceService` — **composição read-only**, sem tabela nova e sem gravação. O gate da análise para a F4.6 era "cobertura de compras conferida" e **ele não está cumprido** (a cobertura real da TOULON nunca foi conferida). Por isso a fatia **mede e mostra a própria cobertura** em vez de pressupô-la.

- **Concentração** (`GET /suppliers/concentration`): parcela de cada fornecedor no valor das ordens de compra do período (padrão: 180 dias; ordens canceladas e sem valor ficam de fora e as sem valor são contadas à parte — null ≠ 0), índice HHI e faixa (maior fornecedor ≥30% média, ≥50% alta; `single_supplier` com um só). É **informação, não conselho**: nunca "troque de fornecedor". Limiares declarados, sem calibração.
- **Cobertura primeiro (RN-F4-6):** o sistema só enxerga compra feita pelo ciclo cotação→ordem. `coverage` compara o valor das ordens com as contas a pagar da categoria `compras` **sem ordem ligada** — esse dinheiro está fora da concentração. Abaixo de 70% o aviso é explícito; sem nenhum dos dois lados, `null` (não 100%).
- **Ficha do fornecedor** (`GET /suppliers/:key`): entrega prometida × realizada, completude e divergências (**reuso do `SupplierPerformanceService`**, nenhum recálculo), prazo médio de pagamento (das contas a pagar ligadas às ordens) e variação de preço do **mesmo produto** (primeira × última compra do período) — cada número com o tamanho da amostra; confiança `media` só com ≥3 ordens.
- **Pauta de negociação** (`GET /suppliers/:key/negotiation-brief`): **rascunho**, nunca enviado. Só entram pontos que o histórico sustenta e com **amostra mínima de 2 ordens** (o que ficou de fora é dito em `omitted`); cada ponto traz a evidência e o tamanho da amostra. **Não inventa desconto, prazo-alvo nem contraproposta** — o pedido sugerido não contém número — e não acusa o fornecedor (diferença não prova culpa, RN-F4-8). Reconhece o que vai bem (pontual, completo). Sem fato que se sustente → `insufficient_history`, sem texto.
- Dinheiro de compra é do gestor (§73); `GET /api/health-center/suppliers/{overview,concentration,:key,:key/negotiation-brief}`. `test:supplier-intelligence` (36, mutação verificada em 6 regras).
- **Limites:** só o que passou pelo ciclo cotação→ordem; o rascunho **não é enviado** a ninguém (sem WhatsApp/e-mail); a variação de preço não separa reajuste de mudança de especificação; nenhuma validação com dado real da TOULON; sem UI.

## 13. Status F4.9 — EM PR (Contexto externo ao lado da decisão, 2026-10-08)

`ExternalDecisionContextService` — **consumo**, não pesquisa. Lê o que o admin master já publicou no pool compartilhado e anonimizado (ADR-156/157) via `ResearchBrokerService`, que respeita o **opt-in** da empresa e a **validade**, e **nunca chama o provedor**. Sem tabela nova; a única escrita possível é o cache por-org (L2) que o próprio broker já grava. Escolhida antes da F4.7/F4.8 porque não depende de histórico por vendedor nem da flag de Grupo.

- **Por tipo de decisão** (`GET /api/health-center/external-context?kind=purchase|sales_change|hire|capital|plan|supplier`): usa uma taxonomia fechada de tópicos (ex.: compra → demanda e sazonalidade · preço e prazo de fornecedores · tendências de coleção); aceita até 5 tópicos livres, saneados (3–80 caracteres, sem marcação). O nicho vem de `organization_settings.vertical`; sem nicho ou sem opt-in → vazio e honesto, com o motivo.
- **Fonte e data em cada item (RN-F4-7):** fontes com tier A/B/C, data de coleta, quando foi gerado e até quando vale. **Síntese do modelo ≠ fonte viva:** só é "fonte_viva" quem tem evidência `live` **com fonte A/B datada**; uma entrada que se declara `live` sem isso é **rebaixada** a "síntese do modelo" e **não exibe data de coleta**. Contexto com mais de 60 dias é marcado como defasado; entrada vencida some.
- **Não mexe em número (`affectsCalculations:false`):** nada aqui roda ou altera cenário, plano ou comparação (teste: o mesmo cenário antes e depois tem as mesmas premissas e métricas). Em vez disso aponta **quais premissas editáveis** o dono pode querer revisitar — as do `ScenarioEngine`, reaproveitadas via `kinds()` — e faz **perguntas**, nunca conclusão (RN-F4-8).
- **Texto externo é dado não confiável:** limpo de caracteres de controle, truncado (resumo ≤600; ≤5 fatores de ≤160) e marcado `untrusted:true`.
- **Confiança só `baixa`/`media`:** `media` apenas com ao menos uma fonte viva datada.
- Gestor lê (decisão estratégica). `test:external-decision-context` (29, mutação verificada em 7 regras — e o teste achou uma lacuna própria na mutação da data de coleta, corrigida).
- **O que NÃO entrega:** **benchmark entre empresas** (a parte de "plataforma" do RN-F4-9) — exigiria amostra mínima e anonimização cross-tenant e fica fora; o sistema **não pesquisa sozinho** (o conteúdo depende do admin master publicar); sem UI; sem validação com a TOULON; o conteúdo só existe se alguém publicar pesquisa do nicho `moda`.
