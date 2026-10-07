# ADR-204 — ZapFlow Fase 3: Gestão Autônoma Progressiva, Inteligência Preditiva e Aprendizado do Negócio

**Estado:** **FASE 3 ENCERRADA em 2026-10-07 por decisão do dono, COM PENDÊNCIAS DECLARADAS** (modelo do ADR-203 §7) — ver **§28**. Todo o código que dependia do time de engenharia está em produção (F3.1–F3.10 + D4 + telas); **o piloto TOULON (F3.11) NÃO foi realizado** e nada da Fase 3 foi validado por uso real. Histórico por fatia: §9–§27.
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
- **D4** — **Consentimento na base do PDV**: `retail_pdv_customers` não tem coluna de consentimento. Definir a regra (LGPD) antes de qualquer campanha preditiva. **DECIDIDA pelo dono: o cliente precisa aprovar** → ver §24 (registro + gate do sink; captura pro cliente ainda pendente).
- **D5** — Ordem: F3.1 primeiro (piso); compras (F3.9-compras) por último e só análise. *(recomendo sim)*
- **D6** — Piloto da Fase 2 (celular, vendedor, medição de uso) **antes** da F3.4 em diante, ou em paralelo? Previsão em cima de superfícies não validadas é risco.
- **D7** — Quantos meses de vendas **com horário** a TOULON tem? Decide a viabilidade da F3.4.

## 6. Critérios de aceite (PRD §47) → onde cada um é provado

normalidade por loja (F3.4) · desvio relevante sem ruído técnico (F3.3) · causa com evidência (F3.5) · ação específica (F3.5) · fato × hipótese (todas) · política de autonomia respeitada (F3.1) · **nunca** executa financeiro restrito (F3.1, regressão) · executa ação aprovada pelos motores existentes (F3.6) · esperado × realizado (F3.7) · aprende eficácia (F3.7) · explica por que recomendou/executou (F3.1c) · FalaTu conduz o fluxo (F3.6) · histórico e auditoria preservados (F3.1c) · dado desatualizado bloqueia automação (F3.1d) · regras TOULON respeitadas (F3.2) · RBAC preservado (todas) · **zero regressão Fases 1 e 2** (suíte inteira por fatia).

## 7. Checklist por fatia (PRD §48) — responder no PR

Decisão que melhora · fonte e frescor · como o parcial é indicado · fato/estimativa/hipótese · nível de autonomia aplicado · quem autoriza · limite financeiro · reversível? · auditoria criada · "por que" visível · aprendizado separado de regra confirmada · a IA pode desfazer/corrigir · kill switch · rollback · nenhum motor duplicado · métrica de impacto · testes de cenário extremo · testes passaram · evidências anexadas.

## 8. Limites desta F3.0

Doc-only: nenhuma linha de código alterada. Auditoria sem execução; pontos não lidos em profundidade estão listados em `ANALISE-PRD-FASE3-vs-CODEBASE.md` §6 e devem ser reconfirmados por cada fatia antes de implementar.

## 9. Status F3.1a — FECHADA (piso de autonomia, PR #1834)
Primeira sub-fatia da F3.1 (a F3.1 inteira é grande demais p/ 1 PR: b = snapshot da política + "por que", c = gates no `execute` + kill switch, d = tela Empresa→IA). **Decisões do dono:** D1 (níveis 0–4 como mapa derivado, sem Nível 4), D2 (`dispatchGoverned` mantém mensagens, recusa tipo do piso), D5 (F3.1 primeiro, compras só análise).
**Entrega:** `ApprovalPolicyService.isHumanOnly/humanOnlyTypes/isSystemActor/autonomyLevel`; piso imposto em `DecisionActionService.propose/approve`, `CommandExecutorService.execute` (recusa auditada `human_approval_missing`) e `dispatchGoverned`; rotas `GET /api/actions/autonomy-floor` e `/autonomy-level`. `test:autonomy-floor` (55). Runbook `docs/runbook/autonomia-operacao.md`.
**Decisões de desenho:** piso por **TIPO** (o domínio `finance` carrega cobrança, que segue livre); `refund`, `asaas_pix_charge`, `collection*`, `prepare_purchase` e `retail_transfer` ficam FORA de propósito (runbook). **D8 (nova, em aberto):** travar `refund` no piso também?
**Mudança deliberada de comportamento:** banda `allow` deixa de auto-aprovar **compra** (`create_purchase_order`); `test-autonomy-contract` teve 1 asserção ajustada com comentário. Nada mais mudou.
**Checklist PRD §48:** decisão melhorada = nunca comprometer dinheiro/pessoas/contrato sem pessoa · fonte = `agent_policies`+`action_approvals` · nível aplicado = ≤2 p/ o piso · quem autoriza = pessoa (RBAC/ADR-159 preservado) · limite financeiro = n/a (o piso não depende de valor) · reversível = reverter o commit · auditoria = `action_execution_log.error_code` · kill switch/gates stale/snapshot = **F3.1b/c** · motor duplicado = nenhum (estende `ApprovalPolicyService`).

## 10. Status F3.1b — FECHADA (snapshot da política + "por que o ZapFlow fez isso?", PR #1835)
Segunda sub-fatia da F3.1 (PRD §35/§36/§37, RN-F3-8). **Entrega:** coluna aditiva `decision_actions.policy_snapshot_json` gravada no `propose` (`ApprovalPolicyService.snapshot`: origem da regra, aprovações exigidas, piso aplicado, nível 0–3; best-effort, nunca bloqueia a proposta); `ExecutionTraceService.explain` + `GET /api/actions/:id/why` (recomendação+base+confiança · sinal de origem em linguagem de negócio · regra que governou · quem autorizou, pessoa × automática · executada ou "não executei porque…" · resultado); `trace` passa a trazer `policy_snapshot`. `test:action-why` (31). Runbook: seção F3.1b.
**Decisões de desenho:** a foto é a **da época** (mudar a política depois não a altera); ação anterior ao registro **diz que não tem foto** e não é reconstruída com a política de hoje; aprovação por rótulo de sistema é dita **automática** (não finge pessoa); dinheiro role-gated e domínio invisível → 404 (reusa `ContextProjectionService`, sem regra nova de RBAC); a recusa do executor vira texto de negócio (`REFUSAL_TEXT`) — é o "Não executei porque…" do PRD §37 **visível**; o **bloqueio** por dado desatualizado/baixa confiança/teto financeiro (que gera novas recusas) é a **F3.1c**.
**D8 segue em aberto** (`refund` fora do piso). **Checklist PRD §48:** decisão melhorada = o dono sabe por que cada ação aconteceu · fonte = `decision_actions`+`action_approvals`+`action_execution_log`+`business_signals` · parcial/desatualizado = ação legada declarada sem foto · fato/estimativa/hipótese = a base da ação é mostrada · autonomia = o nível da época · quem autoriza = mostrado · reversível = reverter o commit (coluna nullable) · auditoria = a própria explicação · motor duplicado = nenhum (estende `ExecutionTraceService`/`ApprovalPolicyService`/`UxPresentationService.confidenceBand`/`presentSignal`).

## 11. Status F3.1c — EM PR (kill switch + travas de segurança no `execute`)
Terceira sub-fatia da F3.1 (PRD §37, RN-F3-7/RN-F3-10). **Decisões do dono:** as travas são **opt-in, desligadas por padrão** (nenhuma automação que roda hoje muda) e o kill switch é **só do dono** (e do admin master da plataforma).
**Entrega:** `AutonomyKillSwitchService` + tabela `autonomy_pauses` (pausa da empresa ou de um tipo; motivo obrigatório; auditada; histórico preservado) e a guarda no `CommandExecutorService.execute` (recusa com `autonomy_paused`, inclusive de ação já aprovada e via `dispatchGoverned`); travas por tipo em `agent_policies.config_json.gates` — `minConfidence`, `maxExecuteAmount`, `maxDataAgeMinutes` — avaliadas por `ApprovalPolicyService.evaluateGates` (valor/idade **desconhecidos também recusam**); rotas `/api/actions/autonomy/{status,pause,resume,gates}`; `REFUSAL_TEXT` ganha 6 códigos (o "Não executei porque…" do PRD §37); o nível 0–3 enxerga a pausa e o snapshot (F3.1b) registra as travas. `test:autonomy-guard` (51). Runbook: seção F3.1c.
**Decisões de desenho:** pausa em tabela própria (não em `agent_policies`, para não mudar o `dispatchGoverned`); só EFEITO é bloqueado (propor/preparar/aprovar/explicar seguem); só empresa inteira ou um tipo (domínio sozinho não é suportado); travas só em tipo com política ativa; quem produz a ação precisa informar `dataAsOf` para a trava de idade (sem ele recusa — dado de idade desconhecida não é dado fresco).
**Fora desta fatia:** tela Empresa→IA (F3.1d). D8 (`refund` no piso) segue em aberto.
**Checklist PRD §48:** kill switch = sim, por empresa e por tipo · rollback = reverter o commit (tabela nova, sem migração) / retomar · reversível = pausa reversível, histórico preservado · limite financeiro = `maxExecuteAmount` (opt-in) · fonte desatualizada bloqueia = `maxDataAgeMinutes` (opt-in) · "não executei porque" = 6 códigos novos auditados · motor duplicado = nenhum (camada consultada pelo mesmo executor).

## 12. Status F3.1d — EM PR (tela Empresa → Autonomia da IA) — F3.1 COMPLETA
`ApprovalPolicyService.overview` + `GET /api/actions/autonomy/overview` (read-only, `canGovern`) e `AutonomyContractPanel` em Configurações → Governança (já alcançável pelo atalho "Autonomia da IA" de Empresa). Dono pausa/retoma/ajusta travas; demais leem. Sem controle de elevar autonomia (RN-F3-3). `test:autonomy-overview` (16). Verificado em Chromium com API simulada (desktop + celular + modo leitura); **não** verificado contra o app completo com auth real. Com isso o piso, a explicação, o kill switch/travas e a tela da F3.1 estão entregues.

## 13. D8 — `refund` entra no piso (decisão do dono)
Nova categoria `reembolso` em `HUMAN_ONLY_CATEGORIES` (`refund`, `issue_refund`, `customer_refund`, `chargeback_refund`). Banda `allow` não auto-aprova mais reembolso; `deny` segue valendo. Muda o comportamento antes preservado pela ADR-159 (anotado no runbook).

## 14. Status F3.2 — EM PR (memória empresarial)
`PatternMemoryService.decide/decisions/requestConfirmations/stageOf` + `BusinessMemoryService.overview` + `GET /api/insights/memory` + `POST /patterns/:id/decision` + botões na aba "Padrões aprendidos". Padrão só vira regra com confirmação de uma pessoa (RN-F3-4); rejeitado não alerta; `learn` não toca a decisão; pergunta "considera uma regra?" vai pro `business_signals` (máx. 3, sem R$). `test:business-memory` (60); 60 suítes de padrões/aprendizado/sinais sem regressão. **Não feito:** semear "SKU esgotado não recompra" (decisão do gestor), responder pelo FalaTu, e usar regras nas recomendações (F3.5). Decisões D3/D4/D6/D7 seguem abertas e não bloqueiam esta fatia.

## 15. Status F3.3 — EM PR (radar contextual do varejo)
`RetailRadarService` + pack `retail_radar` no `AnomalyDetectorRegistry` (campo opcional `signalClass`: technical|business|opportunity) + rotas `/api/retail/radar*` + `RetailRadarService.pass()` no Scheduler (opt-in `retail_radar_enabled`). **Decisão do dono (D7, 2026-10): a data da venda é confiável, a HORA não** → normalidade só por loja × dia da semana, só dia fechado; o radar não lê `sale_time`; dado atrasado silencia os desvios de loja; histórico < 6 dias → "insuficiente". `test:retail-radar` (39) + 182 suítes de varejo/anomalia/radar/sinais sem regressão. **Consequência para a F3.4:** a previsão intradiária (faixa por hora) está **bloqueada** até a hora do PDV ser confiável; a previsão por dia/semana é viável (precisa de histórico por loja). D7 respondida; D3/D4/D6 seguem abertas.

## 16. Status F3.4 — EM PR (previsão do mês por loja)
`RetailForecastService` + `retailCalendar` + `GET /api/retail/forecast`. Base = fechamentos oficiais por dia; **sem intradiário** (hora do PDV não confiável). Faixa ≈80%, chance de bater a meta (5%–95%), falta, por-dia-que-falta, confiança com motivos; datas especiais fora do padrão e alargando a faixa; gate de dados (≥12 semanas — Bangu fica "histórico insuficiente"); meta só lida (meta mensal → soma das cotas → nada). **D7 respondida:** só Bangu tem < 3 meses; **meta mensal por loja já existe no ZapFlow** (Carioca R$ 60.000). `test:retail-forecast` (38) + 150 suítes de varejo/fechamento/meta sem regressão. **Não feito:** previsão do dia/por hora, sell-through da coleção (catálogo sem dimensão de coleção), tela/aviso proativo, calibração com dado real.

## 17. Status F3.5 — EM PR (por que provavelmente + plano de 14 dias do vendedor)
`SellerRecommendationService` + `SellerPlanTaskService` + `GET /api/retail/seller-plan/:id` + `POST .../tasks`; `SellerDiagnosisService` ganhou `driver`/`deltasPct` (aditivo). Liga diagnóstico + meses abaixo da meta + atendimentos num texto com evidência (fato × hipótese) e num plano de 14 dias com checkpoint; **a IA só recomenda — tarefas são criadas só por pessoa** (plano recalculado no servidor, idempotente, auditado). Referência = o próprio período anterior (sem meta inventada); atendimentos fora da calibração e sem ranking. `test:seller-plan` (55) + suítes de varejo/tarefas/vendedor sem regressão. **Decidido (usuário):** plano = sugestão escrita; cada item vira tarefa quando o gestor aprova. **Não feito:** redistribuição por baixo giro (F3.5c — mexe em estoque), tela, medição esperado × realizado (F3.7), calibração dos limiares com dado real.

## 18. Status F3.6a — EM PR (FalaTu multi-ação)
`FalaTuMultiActionService` + ramo no início de `FalaTuAskService.converse` + `POST /api/falatu/multi/:planId/{confirm,cancel}` + cartão na tela. Uma frase com ≥2 pedidos de registro vira lista (pré-visualização sem escrita) e **uma** confirmação prepara cada item pelo caminho de sempre (proposta governada / Inbox); a confirmação não aprova nada. Divisão reusa `classify` (sem vocabulário novo); vírgula de valor nunca corta; >6 pedidos recusado; plano em memória 15 min; idempotente; dinheiro role-gated; auditoria sem texto. **Decidido (usuário):** um resumo com a lista e um "confirma", cada ação removível. `test:falatu-multi-action` (38) + suítes de FalaTu/conversa/UX sem regressão. **Não feito:** decomposição de objetivo por loja (F3.6b), WhatsApp, resolução de dependência/pronome entre itens, ações além de registro.

## 19. Status F3.6c — EM PR (dependência entre itens da multi-ação)
Compromisso que depende de cadastro da mesma frase fica `waiting` até o cadastro ser aprovado; `POST /multi/:planId/continue` ("Tentar agora", 2 h) retoma. Pronome só resolve com um único cadastro antes. Inclui correção de `parseAppointment` com acentos. Sem tabela/coluna nova. WhatsApp e decomposição de objetivo (F3.6b) seguem fora.

## 20. Status F3.7 — EM PR (Learning Loop: eficácia por intervenção)
`InterventionEffectivenessService` + `GET /api/executive/intervention-effectiveness` + seção na aba "O que funciona". Esperado × realizado por (domínio, tipo de ação), só `assured` + só `fact`, amostra mínima 5, banda de Wilson, R$ role-gated. **Fora desta fatia (declarado):** "% do objetivo" (sem elo ação→meta) e estratégia de mensagem (depende de D4). Sem tabela/coluna nova.

## 21. Status F3.8 — EM PR (Impact Ledger 2.0, sem holdout)
`action_outcomes.intervention_cost` + `confidence` (aditivos), `ledger().totals.{net,confidence,causality}`, `ExecutionResultsService.results().impactReading` e leitura na tela Resultados. Custo desconhecido ≠ 0; líquido só com fato+custo conhecido; tudo rotulado "associado" (sem controle). **Holdout/incremental (RN-F3-9) segue pendente da D3** e de campanha com grupo de controle; nada grava custo automaticamente ainda.

## 22. Status F3.10 — EM PR (briefings semanal e mensal)
`PeriodicBriefingService` + sinal sem dinheiro na espinha (entrega pelos canais existentes) + `GET /api/ux/briefing/:period` + bloco em Resultados + `Scheduler` (opt-in `periodic_briefing_enabled`). Compõe fontes existentes; role-gated; seção sem dado explica por quê. **Fora (declarado):** margem confiável, estoque, clientes/campanhas; impacto é acumulado, não por período. Empilhada sobre a F3.8 (usa custo/associado).

## 23. Status F3.9 (compras) — EM PR (cenários de compra, só análise)
`PurchaseScenarioService` + `POST /api/health-center/simulate/purchase-scenarios` + modo no Simulador de decisões. 3 cenários ligando caixa (13 semanas) + cobertura/encalhe + reserva saudável; orçamento máximo recomendado; rascunho de contraproposta NÃO enviado; nunca executa (RN-F3-14). **Fora (declarado):** plano sazonal completo e campanha preditiva (D4). Sem schema novo.

## 24. Status D4 — EM PR (consentimento dos clientes do PDV)
`PdvConsentService` + `retail_pdv_consents` (append-only; última decisão vale; revogar vence) + rotas `/api/retailops/pdv-consent*` + o `OutboundConsentGuardService` passa a tratar cliente do PDV (casado pelo celular) como sujeito a consentimento quando `outbound_consent_required=1`. Sem registro = sem consentimento. **Destrava** o desenho da campanha preditiva (F3.9), que deve usar `assertContactable`; **não a implementa**. **Pendente:** tela/link de opt-in pro cliente e captura em massa; decisão de quando ligar a flag.

## 25. Status D4b — EM PR (tela de captura do consentimento)
Cartão de cobertura + coluna "Consentimento" + registro por cliente na aba **Clientes do PDV** (Retail). `GET /pdv-customers` devolve `consent` por cliente (`statusMany`) e `canRecordConsent`. Sem registro = "Sem registro" (nunca autorizou). **Pendente:** link/QR de opt-in pro cliente e importação em massa; ligar `outbound_consent_required` só depois da captura.

## 26. Status F3.6b — EM PR (objetivo da rede → lojas)
`NetworkObjectiveService` + rotas `/api/retailops/network-objective*` + card em Operação da Rede. Decisão do dono: rede → lojas. Parte da projeção F3.4; +X% proporcional por loja; R$/dia útil e esforço (premissa não calibrada); loja sem projeção fica de fora; tarefas só por pessoa; meta oficial intocada. **F3.5c (redistribuição por baixo giro): ADIADA por decisão do Bruno (2026-10-07) — não será feita agora.**
## 27. Status (telas) — EM PR (Previsão e alertas)
Aba **"Previsão e alertas"** em Operação da Rede (grupo Vendas e metas) com Previsão do mês (F3.4), Radar (F3.3) e Plano do vendedor (F3.5), só renderizando as rotas existentes; `GET /sellers` devolve `id`. Fecha o item "telas só na API" da ADR. **Não coberto:** uso real em navegador/celular; calibração dos limiares com dado da TOULON.

## 28. ENCERRAMENTO DA FASE 3 (2026-10-07) — entregue × pendente, sem maquiagem

**Decisão do dono (2026-10-07):** encerrar a Fase 3 **com pendências declaradas**, no mesmo modelo da Fase 2 (ADR-203 §7). "Encerrada" aqui significa **código entregue e testado**, NÃO "validada na loja". A diferença é a principal ressalva desta seção.

### 28.1 Entregue (em produção, mergeado)
| Fatia | O que é | Teste (`npm run`) |
| --- | --- | --- |
| F3.1a–d | Piso de autonomia imposto em código (ações só-humanas, inclusive `refund` — D8) · níveis 0–3 derivados · snapshot da política + "por que o ZapFlow fez isso" · kill switch e travas (opt-in) · tela Empresa → Autonomia da IA | `test:autonomy-floor` · `test:autonomy-guard` · `test:autonomy-overview` |
| F3.2 | Memória empresarial: padrão só vira regra com confirmação de uma pessoa | `test:business-memory` |
| F3.3 | Radar contextual do varejo (técnico × negócio × oportunidade), opt-in | `test:retail-radar` |
| F3.4 | Previsão do mês por loja (faixa, chance de bater a meta) | `test:retail-forecast` |
| F3.5 | "Por que provavelmente" + plano de 14 dias do vendedor (tarefas só por pessoa) | `test:seller-plan` |
| F3.6a / F3.6c | FalaTu multi-ação + dependência cadastro → compromisso | `test:falatu-multi-action` |
| F3.6b | Objetivo da REDE ("+X%") dividido por loja (rede → lojas, decisão do dono) | `test:network-objective` |
| F3.7 | Eficácia por intervenção (esperado × realizado; só `assured`; Wilson) | `test:intervention-effectiveness` |
| F3.8 | Impact Ledger 2.0: custo e confiança; tudo rotulado "associado" (sem controle) | `test:impact-ledger-v2` |
| F3.9 (só compras) | Cenários de compra conservador/base/otimista; só análise | `test:purchase-scenarios` |
| F3.10 | Briefings semanal e mensal por exceção + interruptor | `test:periodic-briefing` |
| D4 / D4b | Consentimento dos clientes do PDV (livro append-only + gate no sink + tela de captura) | `test:pdv-consent` |
| Telas | Aba "Previsão e alertas" (previsão, radar, plano do vendedor) | `test:forecast-alerts-screens` |
| Docs | Roteiro de treinamento/suporte dos vendedores | `docs/runbook/piloto-vendedores-passo-a-passo.md` |

### 28.2 NÃO feito ou NÃO validado — e quem resolve
| # | Pendência | Por quê | Dono |
| --- | --- | --- | --- |
| 1 | **Piloto TOULON (F3.11)** — nunca rodou: nenhum vendedor/gerente usou nada no celular | Depende de uso real; é também a validação pendente da Fase 2 | **Dono/supervisor** |
| 2 | **Nada foi testado em navegador/celular** — só por código, rotas e testes de fonte | Limite do ambiente de desenvolvimento | Piloto (#1) |
| 3 | **Calibração com dado real**: limiares do radar, rótulos de esforço (≤10% leve · ≤25% moderado) e faixas de previsão são escolhas minhas, sem base da TOULON; Bangu tem < 3 meses de histórico | Sem dado real | Piloto, depois de semanas de uso |
| 4 | **Holdout/incremental (D3)**: nada é "causado", tudo é "associado"; **"% do objetivo"** não existe (falta elo ação → meta); custo da intervenção só é registrado à mão | D3 sem decisão; sem campanha com grupo de controle | Dono (D3) + nova fatia |
| 5 | **Campanha preditiva e plano sazonal NÃO existem.** D4 deu o registro/gate de consentimento, mas **não há link/QR de opt-in** para o cliente, **nenhum consentimento real registrado**, e a flag `outbound_consent_required` está **desligada** (ligar bloqueia envios a cliente do PDV sem consentimento) | Falta captura real | Dono (capturar) + nova fatia |
| 6 | **F3.5c** (redistribuição por baixo giro) — **adiada por decisão do Bruno** | Decisão de negócio | Bruno |
| 7 | **FalaTu multi-ação no WhatsApp** — só funciona na tela do FalaTu | Não sabido se será usado | Decidir depois do piloto |
| 8 | Briefing: **margem confiável, estoque, clientes e campanhas** fora; impacto é acumulado (não por período) | Sem fonte consolidada / D4 | Nova fatia |
| 9 | **Sell-through de coleção**: o catálogo não tem a dimensão "coleção" | Falta dado | Dono (cadastro) |
| 10 | **D6** (piloto da Fase 2 antes das fatias seguintes) **ficou sem decisão** — a Fase 3 avançou sem ele, sobre superfícies não validadas | Risco assumido | — |
| 11 | Débito técnico conhecido: `parseReceivable` ainda usa `at[ée]\b` (acento) — o bug análogo de `parseAppointment` foi corrigido na F3.6c, este não; busca de cliente por celular no sink de mensagens varre a base da empresa (sem índice) | Fora de escopo | Engenharia |
| 12 | F3.6b não usa o planejador reverso do Mission OS (ele é de receita da empresa, não por loja); o objetivo ainda não aparece em Hoje/Executando | Decisão de desenho | Eventual fatia |

### 28.3 Decisões do dono — estado final
D1 (níveis 0–4 como mapa derivado, sem Nível 4), D2 (`dispatchGoverned` recusa o piso) e D5 (compras por último e só análise) foram **adotadas ao seguir as recomendações** (o dono mandou seguir "com as recomendações"; não houve resposta separada por item) · **D3** sem decisão (holdout não implementado) · **D4** decidida (o cliente precisa aprovar) · **D6** sem decisão (piloto não rodou) · **D7** respondida (a **data** da venda é confiável, a **hora** não → nada lê `sale_time`) · **D8** decidida (`refund` entra no piso).

### 28.4 Garantias que valem mesmo sem o piloto
- **Dinheiro e pessoas nunca sem pessoa:** o piso é imposto em `propose`/`approve`/`execute`/`dispatchGoverned`, independente de política semeada; a IA só recomenda e uma pessoa cria tarefa/aprova.
- **Estimativa ≠ fato ≠ promessa:** previsão com faixa e confiança; impacto "associado"; hipótese rotulada; ausência de dado = "sem dado", nunca 0.
- **Meta oficial nunca é alterada** pela IA (testado em F3.4/F3.6b); alertas só em `business_signals`; dinheiro role-gated; escopo de loja (ADR-173) respeitado.
- **Tudo aditivo e reversível:** radar, briefings, kill switch/travas e o gate de consentimento são **opt-in (default desligado)**; as mudanças de schema são só **aditivas** (ex.: `retail_pdv_consents`, `action_outcomes.intervention_cost`/`confidence`, `periodic_briefing_enabled`, `retail_radar_enabled`); nada foi removido.

### 28.5 Condição para abrir uma Fase 4 (ou qualquer fatia nova de "inteligência")
1. **Piloto evidenciado**: roteiro `piloto-vendedores-passo-a-passo.md` + `fase2-piloto-toulon.md` executados, com fichas de ocorrência e prints, por pelo menos 2 semanas.
2. **Calibração** dos limiares com o que o piloto mostrou (alertas úteis × ruído).
3. **Decisão explícita** sobre D3 (holdout) e sobre quando ligar `outbound_consent_required`, com consentimentos reais já capturados.
Sem isso, qualquer nova camada de previsão/campanha seria construída sobre números que ninguém conferiu no mundo real.

### 28.6 Errata (2026-10-07, após revisão do dono) — o que a §28.2 disse e precisa ser lido com estas correções
- **#1 (piloto):** o texto "nenhum vendedor/gerente usou nada" estava **amplo demais**. O dono confirma que o ZapFlow (Operação da Rede: cotas, boletas, informe diário, menu simplificado) **está em uso nas lojas e atualiza todo dia**. O que **continua sem evidência** é o uso, pelos vendedores no **celular**, das telas **da Fase 3** (Previsão e alertas, plano do vendedor, briefings) e a medição de uso do menu (painel "Como a equipe está usando o menu"). Quem consulta o painel e confirma é o dono; esta sessão não acessa a base de produção.
- **#5 (consentimento):** o link/QR de opt-in agora existe (§29, PR #1855). Continuam faltando consentimentos reais registrados; `outbound_consent_required` segue **sem rota/tela para ligar** (só `OutboundConsentGuardService.setEnabled` em código).
- **#8 (briefing):** margem, estoque, clientes e campanhas **existem no ZapFlow**; é o **serviço de briefing que ainda não os lê**. O texto "sem fonte consolidada" referia-se a isso, não à inexistência do dado.
- **#9 (coleção):** a dimensão é capturada do ERP em `products_services.metadata_json.alterdata.colecao` quando o Alterdata envia; falta confirmar se a TOULON preenche e **usar** o campo (nenhum cálculo de sell-through por coleção existe).
- **#10 (D6):** a Fase 3 avançou sem o piloto porque o dono respondeu "seguir com a recomendação" e a recomendação foi seguir; o risco foi registrado, não resolvido. A lacuna de D6 é a **evidência de uso** das superfícies da Fase 2, não código.
- **#11:** o débito `parseReceivable` (`at[ée]\b`) foi corrigido no PR #1856.

## 29. D4c — Link de consentimento pro cliente decidir sozinho (2026-10-07)

Fecha a pendência do §28 "o cliente aprovar sozinho". O operador gera, na tela Clientes (PDV), um link PESSOAL e TEMPORÁRIO (`/consentimento/:token`); o cliente abre, e toca **Autorizo** ou **Não autorizo** (botões iguais, nada pré-marcado). A decisão cai no MESMO livro `retail_pdv_consents` (origem nova `link`, ator `customer:link`) — não há 2º registro de consentimento.

- Token 32 bytes; só o hash SHA-256 fica no banco (`retail_pdv_consent_links`); 1 link ativo por cliente; validade padrão 14 dias (1–60); pode ser reaberto pra mudar de ideia até vencer.
- Página pública mostra o mínimo (empresa, 1º nome, final do celular). Rotas `/api/public/consent/:token` (GET/POST `decision`) fora do `requireAuth`, no-store, limite por IP; erros: 404 desconhecido/revogado, 410 vencido.
- **O sistema NÃO envia o link** (pedir consentimento por mensagem a quem não autorizou é o que o consentimento evita): QR/URL na tela pro operador entregar.
- Pendente/hipóteses: página não testada em celular real; TTL de 14 dias e link reutilizável são suposições a confirmar; `APP_URL` precisa estar configurada pro QR ser absoluto. Teste: `test:pdv-consent-link` (31).

## 30. D4d — Interruptor do bloqueio de envio sem consentimento (2026-10-07)

Antes só existia `OutboundConsentGuardService.setEnabled` em código; o dono não tinha como ligar `outbound_consent_required`. Agora há `GET/PUT /api/retailops/pdv-consent/guard` (owner/admin) e um painel no cartão de consentimento de Clientes (PDV).

- **O achado que justifica o cuidado:** o gate está no **sink** (`MessageProviderService.sendMessage`), então, ligado, ele recusa **qualquer** mensagem a um `contact` sem consentimento `comunicacoes` registrado e a cliente do PDV sem autorização — **inclusive resposta de atendimento e cobrança automática**, não só campanha. Nenhum chamador trata `OutboundBlockedError` (só o gate e o sink a referenciam). Por isso a **prévia de impacto** traz os dois números (contatos do WhatsApp/Instagram sem consentimento · clientes do PDV com celular sem autorização).
- **Ligar exige `acknowledge:true` no servidor** (a tela sozinha não basta), é auditado (`OUTBOUND_CONSENT_GUARD_ON/OFF` em `auth_audit_logs`, só contagens) e desligar é livre. Padrão segue desligado (0-regressão).
- `OutboundConsentGuardService.impact` espelha `evaluate` (mesma regra de `hasConsent`); read-only. `test:outbound-consent-switch` (17).
- **Não decidido por mim:** *quando* ligar. Recomendação: só depois de olhar a prévia na TOULON; se o nº de contatos sem consentimento for alto, ligar bloquearia respostas de atendimento até que esses consentimentos existam.
