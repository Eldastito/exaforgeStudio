# ADR-204 — ZapFlow Fase 3: Gestão Autônoma Progressiva, Inteligência Preditiva e Aprendizado do Negócio

**Estado:** **F3.0 FECHADA (doc-only: análise + este plano)** · demais fatias **NÃO iniciadas** · aguardam aprovação do dono (§5).
**Cliente-piloto:** TOULON. **Base:** Fases 1 e 2 (Fase 2 encerrada por decisão do dono em 2026-10-05 **com o piloto não evidenciado** — ADR-203 §7).
**Análise:** `docs/prd/ANALISE-PRD-FASE3-vs-CODEBASE.md` (matriz PRD→código, com evidência de arquivo e achados verificados).

## 1. Contexto

O PRD da Fase 3 pede que o ZapFlow passe de explicar/recomendar para **antecipar, planejar e executar com autonomia controlada**: detectar → interpretar → prever → recomendar → executar → medir → aprender, sem virar um agente que decide dinheiro sozinho. A regra estrutural do PRD (§43/§44) é **não criar módulo/motor/dashboard/CRM/estoque/financeiro/tarefas/Diretor novos**. A F3.0 provou que o §45 do PRD (F3.1–F3.8) descreve motores que **já existem** (ADR-159 contrato de autonomia, `ProgressiveAutonomyService`, `UnifiedImpactLedgerService`, `PatternMemoryService`/ADR-166, fio por `correlation_id`/ADR-158, `Recovery*`, `CashForecastService`). Logo: a Fase 3 é **estender por lacuna**, não construir F3.1–F3.8 como descritas.

## 2. Decisões

1. **Superfície ≠ motor** (herda ADR-203 §2.1). FalaTu, Hoje, Executando, Resultados e Empresa continuam as únicas superfícies; nenhuma tela/menu/"Objetivos IA" novo (PRD §43).
2. **Piso antes de teto.** Nenhuma capacidade de execução nova entra antes do **piso de autonomia em código** (F3.1): a lista "sempre exige humano" do PRD §4 hoje é só `enforced:false`/advisória e `dispatchGoverned` auto-aprova (análise §2).
3. **Níveis 0–4 são um MAPA DERIVADO de `autonomy_level × execution_mode × banda`, não um enum novo** (RN-F3-1). O **Nível 4 (autonomia avançada) NÃO é implementado** nesta fase — o PRD exige "nunca padrão"; permanece como estado alcançável só por `ProgressiveAutonomyService` + aceite explícito, e fica fora do piloto.
4. **Aprender ≠ regra.** Padrão observado só vira regra com **confirmação do gestor** (PRD §6) — corrige a promoção automática `validated` (F3.2).
5. **Estender os motores existentes** (lista na matriz da análise); cada fatia declara "o que reutiliza" e "o que NÃO cria".
6. **Fato × estimativa × hipótese** em toda saída (`Metric`/`basis`, herdado de RN-F2-6); null ≠ 0; faixa + confiança, nunca falsa precisão (PRD §7).
7. **Compras e dinheiro: só análise** (PRD §4/§21–23/§29): nada de "pode comprar"; nenhuma transferência de dinheiro, pagamento, crédito ou acordo, mesmo com integração bancária futura.

## 3. Guardrails (RN-F3)

RN-F3-1 níveis derivados, sem enum novo · RN-F3-2 a lista de ações sempre-humanas é imposta **em código** (propose + execute + `dispatchGoverned`), independente de bandas e de política semeada · RN-F3-3 IA nunca eleva a própria autonomia (herda ADR-159 RN-014) · RN-F3-4 padrão ≠ regra sem confirmação do gestor · RN-F3-5 sem histórico/hora confiável → "histórico insuficiente" (não inventa faixa) · RN-F3-6 meta oficial nunca é alterada pela IA (só ritmo/projeção/necessidade de recuperação) · RN-F3-7 execução bloqueada por dado desatualizado, baixa confiança, divergência relevante ou teto financeiro excedido, **com mensagem "não executei porque…"** (PRD §37) · RN-F3-8 toda ação executada guarda política que permitiu + dados usados + recomendação original + ator + automática?, e é explicável em evidência de negócio (PRD §35/§36), não em cadeia de raciocínio · RN-F3-9 causado × associado: sem controle declarado e com amostra mínima, só "receita associada" (PRD §31) · RN-F3-10 kill switch por org e por (domínio, ação) + rollback/correção declarados por fatia · RN-F3-11 dinheiro role-gated (§73) · RN-F3-12 alertas só em `business_signals` (convenção nº 12), sem tabela de alerta paralela · RN-F3-13 consentimento/LGPD antes de qualquer campanha sobre base sem consentimento registrado · RN-F3-14 compras: analisar/simular/preparar; nunca comprometer.

## 4. Plano (1 fatia = 1 PR draft + teste + runbook + rollback; reordenado por lacuna — ver matriz)

| Fatia | Entrega (estende o quê) | Gate / dependência |
| --- | --- | --- |
| **F3.1 Piso de autonomia** | (a) lista sempre-humana do §4 **imposta em código** em `ApprovalPolicyService`/`DecisionActionService.propose`/`CommandExecutorService.execute` e **dentro de `dispatchGoverned`** (que passa a recusar tipos restritos, preservando os chamadores atuais de mensagem); (b) mapa derivado de níveis 0–4 exposto (sem enum novo); (c) persistir o **snapshot da política/banda que permitiu** na ação (coluna aditiva) e expô-lo no `ExecutionTraceService` ("por que fez isso" em evidência); (d) gates no `execute`: dado stale, `confidence` mínima, teto financeiro, com "não executei porque…" auditado; (e) kill switch por org e por (domínio, ação) + fila de revisão. Políticas visíveis/editáveis em Empresa→IA. | **Pré-requisito de todas as demais.** Não cria motor/policy novo. |
| **F3.2 Memória empresarial** | Estende `PatternMemoryService`: estados observado→hipótese→**confirmado pelo gestor** (colunas aditivas; a promoção automática deixa de contar como regra); read-model "memória empresarial" que COMPÕE regras confirmadas + preferências (`UxPreferencesService`, briefing) + políticas + padrões + hipóteses + aprendizados validados; regra TOULON "SKU esgotado não recompra" como regra confirmada (já é estratégia `collection_sellout`). Pergunta "identifiquei isso em 8 de 9 semanas — considerar?" via FalaTu. | Sem tabela de RAG nova; sem 2º Context Engine. |
| **F3.3 Radar contextual** | Detectores que faltam no `AnomalyDetectorRegistry`: preço absurdo/zerado, venda duplicada, integração atrasada (sinal próprio), comissão estranha; campo que separa **anomalia técnica × oportunidade**; normalidade por loja/horário. | Sinais só em `business_signals`. |
| **F3.4 Forecast** | Estende `RetailAfternoonBriefService`: **faixa** + confiança por loja/dia da semana, projeção de fechamento do dia, probabilidade de bater meta, "falta estimada"; calendário de feriados/eventos do varejo; **sell-through** da coleção. Meta oficial intocada (RN-F3-6). | **Gate de dados:** só ativa por loja com histórico de hora confiável suficiente (RN-F3-5); o dono informa quantos meses a TOULON tem. |
| **F3.5 Recomendação** | "Por que provavelmente" do vendedor: liga `SellerGoalStreakService` + `SellerDiagnosisService` + `RetailFloorAnalyticsService` num texto de causa com evidência (fato×hipótese); **plano de 14 dias** do Coach → tarefas ao gerente via `TaskService` (governado, aprovado por Bruno); redistribuição por demanda/baixo giro (estende `RetailTransferService`, hoje só loja zerada). | Coach segue advisório para o vendedor (ADR-202); tarefas só após aprovação. |
| **F3.6 Execution Orchestrator** | **Sem orquestrador novo.** FalaTu multi-ação (uma frase → N ações coordenadas, **uma** confirmação) sobre `DecisionAction→ApprovalPolicy→CommandExecutor`; decomposição de objetivo ("+10% Carioca") sobre `BusinessGoalService`/`MissionReversePlanner`/Mission OS, por loja; mostra em Hoje/Executando/Resultados. | Depende de F3.1. |
| **F3.7 Learning Loop** | Eficácia por **intervenção** (esperado × realizado × % do objetivo) sobre `OutcomeMeasurementService`/`PatternLearningFromAssuranceService`; alimenta a aba **"O que funciona"** (hoje vazia) com amostra mínima e banda de Wilson; aprende estratégia de mensagem só com amostra declarada. | Só `assured` ensina forte (herdado). |
| **F3.8 Impact Ledger 2.0** | Estende `UnifiedImpactLedgerService`/`OutcomeMeasurementService`: **custo da intervenção** e **confiança** no outcome; **controle/holdout opcional** em campanha; separação causado × associado; Resultados mostra "incremental estimado" só quando há controle, senão "receita associada". | Poder estatístico: abaixo do mínimo → só "associada" (RN-F3-9). |
| **F3.9 Planejamento comercial** | Plano sazonal ("Black Friday") **compondo** estoque (`stockCapital`/sell-through) + clientes + campanhas + caixa (`CashForecastService`) + equipe, com orçamento máximo recomendado; **campanha preditiva** (janela de inatividade por cliente + estratégia novidade×desconto); **cenários de compra** (conservador/base/otimista, caixa mínimo, payback, encalhe) ligando `DecisionSimulatorService.buyStock` + `CashForecastService` + reserva saudável (ADR-201); preparar contraproposta ao fornecedor **sem enviar**. | **D4 (consentimento do PDV) bloqueia campanha preditiva.** Compras = **último** e **só análise** (RN-F3-14). |
| **F3.10 Rotina e briefings** | Briefing **semanal** comercial e **mensal** (faturamento, meta, lojas, vendedores, margem confiável, estoque, clientes, campanhas, impacto, prioridades) sobre as fontes existentes; entrega pelos canais já existentes (push/WhatsApp/e-mail). | Depende de F3.7/F3.8 para "impacto". |
| **F3.11 Piloto TOULON** | Autonomia progressiva: **recomendação → preparar-para-aprovação → autonomia seletiva**, nas 6 automações do PRD §46 (vendedor abaixo da meta, cobrança de fechamento, briefings, diagnóstico de estoque negativo, oportunidade de transferência, campanha preparada). | Roteiro + evidências; ver D6. |

## 5. Decisões pendentes do dono

- **D1** — Aceitar níveis 0–4 como **mapa derivado** (sem enum novo) e **não implementar o Nível 4** nesta fase. *(recomendo sim)*
- **D2** — `dispatchGoverned` mantém o comportamento atual para mensagens (cobrança/recuperação/prospecção), mas passa a **recusar** qualquer tipo da lista sempre-humana. *(recomendo sim)*
- **D3** — Holdout/controle em campanha: aceitar que, sem amostra mínima, o sistema só mostra "receita associada". *(recomendo sim)*
- **D4** — **Consentimento na base do PDV**: `retail_pdv_customers` não tem coluna de consentimento. Definir a regra (LGPD) antes de qualquer campanha preditiva.
- **D5** — Ordem: F3.1 primeiro (piso); compras (F3.9-compras) por último e só análise. *(recomendo sim)*
- **D6** — Piloto da Fase 2 (celular, vendedor, medição de uso) **antes** da F3.4 em diante, ou em paralelo? Previsão em cima de superfícies não validadas é risco.
- **D7** — Quantos meses de vendas **com horário** a TOULON tem? Decide a viabilidade da F3.4.

## 6. Critérios de aceite (PRD §47) → onde cada um é provado

normalidade por loja (F3.4) · desvio relevante sem ruído técnico (F3.3) · causa com evidência (F3.5) · ação específica (F3.5) · fato × hipótese (todas) · política de autonomia respeitada (F3.1) · **nunca** executa financeiro restrito (F3.1, regressão) · executa ação aprovada pelos motores existentes (F3.6) · esperado × realizado (F3.7) · aprende eficácia (F3.7) · explica por que recomendou/executou (F3.1c) · FalaTu conduz o fluxo (F3.6) · histórico e auditoria preservados (F3.1c) · dado desatualizado bloqueia automação (F3.1d) · regras TOULON respeitadas (F3.2) · RBAC preservado (todas) · **zero regressão Fases 1 e 2** (suíte inteira por fatia).

## 7. Checklist por fatia (PRD §48) — responder no PR

Decisão que melhora · fonte e frescor · como o parcial é indicado · fato/estimativa/hipótese · nível de autonomia aplicado · quem autoriza · limite financeiro · reversível? · auditoria criada · "por que" visível · aprendizado separado de regra confirmada · a IA pode desfazer/corrigir · kill switch · rollback · nenhum motor duplicado · métrica de impacto · testes de cenário extremo · testes passaram · evidências anexadas.

## 8. Limites desta F3.0

Doc-only: nenhuma linha de código alterada. Auditoria sem execução; pontos não lidos em profundidade estão listados em `ANALISE-PRD-FASE3-vs-CODEBASE.md` §6 e devem ser reconfirmados por cada fatia antes de implementar.
