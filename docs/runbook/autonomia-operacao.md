# Autonomia da IA — operação (ADR-204 · Fase 3)

Runbook da governança de autonomia. Cresce uma seção por fatia da Fase 3; hoje cobre a **F3.1a — piso de autonomia**.

## F3.1a — o que a IA NUNCA faz sozinha

Existe uma lista de tipos de ação que **sempre exigem a aprovação de uma pessoa** (PRD Fase 3 §4): compras, pagamentos e transferência de dinheiro, contratação/demissão, salário, comissão consolidada, desconto relevante e preço, empréstimo, compromisso contratual e comunicação jurídica. Fonte única: `ApprovalPolicyService.humanOnlyTypes()` (`GET /api/actions/autonomy-floor`).

O piso vale **acima** de qualquer configuração:
- **Proposta (`propose`)**: nunca nasce aprovada — nem com banda "permitido", nem com política "automática", nem com teto de automação. O contrato do dono (bandas) continua podendo **endurecer** (bloquear/escalar); não afrouxa abaixo do piso.
- **Aprovação (`approve`)**: só por **pessoa**. Rótulo de sistema (`runtime`, `rule`, `ai`, `scheduler`, `agent:…`) é recusado.
- **Execução (`execute`)**: exige ao menos uma aprovação humana registrada. Ação restrita "aprovada" sem pessoa (legado) é **recusada e auditada** (`error_code = human_approval_missing` em `action_execution_log`).
- **`dispatchGoverned`** (a costura que semeia política e auto-aprova, feita para mensagens): **recusa** tipo do piso — não cria ação, não semeia política, não tem efeito.

A IA ainda pode **analisar e preparar** (rascunho/`prepare`) essas ações — só não as compromete.

### Níveis 0–4 (mapa derivado, sem enum novo)
`GET /api/actions/autonomy-level?domain=…&actionType=…` devolve o nível e o porquê:

| Nível | Quando |
| --- | --- |
| 0 observar | política `observe` |
| 1 recomendar | sem política, ou `suggest` |
| 2 preparar | `prepare`; ou `execute` sem efeito liberado; ou `execute` sem limite pré-autorizado (a pessoa aprova) |
| 3 executar dentro de limites | `execute` + `approved_execution` + limite/banda "permitido" do dono |
| 4 autonomia avançada | **não habilitado nesta fase** — `autonomous` aparece como 3 com `level4Blocked` |

Tipos do piso ficam **travados em ≤ 2**, sejam quais forem a política e o teto.

### D8 — reembolso no piso (decisão do dono, 2026-10)
`refund`/`issue_refund`/`customer_refund`/`chargeback_refund` agora SEMPRE exigem uma pessoa (categoria "Reembolso e estorno ao cliente"). Uma banda `allow` ou `max_auto_amount` não os auto-aprova mais; `deny` do dono continua bloqueando. Mudança de comportamento: quem tinha banda `allow` p/ refund passa a ver a ação em "aguardando aprovação".

### Fora do piso de propósito
- `prepare_purchase`, `send_quote_request`: rascunho/cotação — nível 2.
- `asaas_pix_charge`, `collection*`: cobrar cliente é **receber**, não compromete dinheiro da empresa. (`domain = finance` também carrega cobrança — por isso o piso é por **tipo**, não por domínio.)
- `retail_transfer`: transferência de **estoque**, não de dinheiro.

### Mudança de comportamento que o dono vai notar
Quem tinha banda "permitido" para **compra** (`create_purchase_order`) via compra pequena ser auto-aprovada. A partir da F3.1a ela **aguarda aprovação**. É o objetivo do PRD (compras = só analisar/preparar).

### Adicionar um tipo novo ao piso
Qualquer ação nova que comprometa dinheiro, pessoas ou contrato **deve** entrar em `HUMAN_ONLY_ACTION_TYPES` (`ApprovalPolicyService.ts`) e ganhar um check em `scripts/test-autonomy-floor.ts`. Não existe detecção automática por nome.

### Rollback
Aditivo e sem migração: reverter o commit restaura o comportamento anterior. Nenhuma coluna/tabela nova nesta sub-fatia.

## F3.1b — "por que o ZapFlow fez isso?"

Cada ação nova guarda, na hora da proposta, uma **foto da política que a governou** (`decision_actions.policy_snapshot_json`): de onde veio a regra (faixa do dono / política da empresa / regra padrão), quantas pessoas precisavam aprovar, se a trava de segurança (piso, F3.1a) apertou a regra e o nível de autonomia 0–3. É a foto **da época**: se o dono mudar a política depois, a explicação continua mostrando o que valia quando a ação nasceu.

`GET /api/actions/:id/why` responde, em linguagem de negócio (não cadeia de raciocínio):
1. **O que foi proposto** + base (fato / estimativa / influência) + confiança em palavras.
2. **De qual ponto de atenção nasceu** (o sinal, traduzido; nunca o identificador técnico).
3. **Qual regra governou** (a foto).
4. **Quem autorizou**: pessoa pelo nome, ou "automaticamente, dentro da política" (nenhuma pessoa precisou aprovar). Aprovação por rótulo de sistema (`runtime`) é dita como automática — nunca finge ter sido pessoa.
5. **Executada** ou **"Não executei porque…"** — o motivo real da recusa do executor (sem aprovação de pessoa, sem política ativa, autonomia só recomenda, modo de teste, já executada antes…).
6. **Resultado medido** (esperado × realizado).

Regras: dinheiro **role-gated** (§73) — sem visão ampla do negócio os valores vêm `null` + `restricted:true` e o texto não os repete; domínio invisível ao papel → **404** (não vaza existência); isolado por empresa. `GET /api/decision-intelligence/trace/:correlationId` passa a trazer `policy_snapshot` em cada ação.

**Ação anterior à F3.1b** não tem foto: a explicação diz "não há foto do que valia na época" e **não** reconstrói a regra com a política de hoje.

Aditivo (1 coluna nullable), sem migração de dados; reverter o commit restaura o comportamento anterior.

## F3.1c — kill switch e travas de segurança

### Kill switch (pausa da autonomia)
Enquanto estiver ativo, o executor **recusa todo efeito externo** — inclusive de ação já aprovada por pessoa e via `dispatchGoverned` — e a recusa fica **auditada** (`error_code = autonomy_paused`) com o "Não executei porque o dono pausou a autonomia". Propor, preparar, aprovar e explicar **continuam funcionando**: pausar não esconde nada.

| Ação | Rota | Quem |
| --- | --- | --- |
| Ver pausas ativas + histórico | `GET /api/actions/autonomy/status` | qualquer usuário da empresa |
| Pausar (empresa inteira, ou um tipo com `domain`+`actionType`) | `POST /api/actions/autonomy/pause` `{reason, domain?, actionType?}` | **dono** ou admin master |
| Retomar | `POST /api/actions/autonomy/resume` `{domain?, actionType?}` | **dono** ou admin master |

O **motivo é obrigatório** (vai para a auditoria: `AUTONOMY_PAUSED`/`AUTONOMY_RESUMED`). Pausar de novo a mesma abrangência é idempotente. Retomar só marca `resumed_at` — **nada é apagado** (tabela `autonomy_pauses`). Pausar só um domínio não é suportado: ou a empresa inteira, ou um tipo de ação. O nível 0–3 (`/autonomy-level`) passa a mostrar `paused:true` e a explicar.

Por que tabela própria e não uma linha em `agent_policies`: inserir política para pausar mudaria o que o `dispatchGoverned` faz quando o tipo ainda não tem política e deixaria uma linha restritiva ao retomar.

### Travas de segurança (opt-in — **desligadas por padrão**)
Configuradas por tipo de ação, **só em tipos que já têm política ativa** (criar uma política só para guardar a trava mudaria o `dispatchGoverned`). Sem trava = comportamento de sempre, nenhuma automação existente muda.

| Trava | Recusa quando | Código |
| --- | --- | --- |
| `minConfidence` (0–1) | a confiança da ação é menor — ou desconhecida | `confidence_below_min` |
| `maxExecuteAmount` (≥ 0) | o valor da ação é maior — **ou desconhecido** (não se prova que cabe no limite) | `amount_above_limit` / `amount_unknown` |
| `maxDataAgeMinutes` (> 0) | o dado é mais velho — **ou a ação não informa a data** (`dataAsOf` no comando ou na evidência) | `data_stale` / `data_freshness_unknown` |

`PUT /api/actions/autonomy/gates` `{domain, actionType, minConfidence?, maxExecuteAmount?, maxDataAgeMinutes?}` (**só dono**; `null` limpa uma trava, as outras ficam) · `GET /api/actions/autonomy/gates?domain=&actionType=`. Quem produz a ação precisa carregar `dataAsOf` (ISO) no comando ou na evidência para que a trava de idade funcione — sem ele a ação é recusada, de propósito. As travas vigentes entram na foto da política (F3.1b) e a explicação diz "Travas de segurança ativas…".

### Rollback
Aditivo: 1 tabela nova, sem colunas nem migração de dados. Desligar as travas = `null` em cada uma; reverter o commit restaura o comportamento anterior.

## F3.1d — Tela "O que a IA pode fazer sozinha" (Configurações → Governança, atalho Empresa → "Autonomia da IA")
`AutonomyContractPanel` só RENDERIZA `GET /api/actions/autonomy/overview` (piso por categoria em linguagem de dono · cada tipo com nível 0–3 em palavras, travas e pausa · pausa da empresa inteira) e chama as rotas já testadas de pausa/retomada/travas. Dono (ou admin master) vê os botões Pausar/Retomar/Travas; os demais veem tudo em leitura com aviso. **Não existe controle de elevar autonomia** — o nível mostrado é derivado (RN-F3-3). Dinheiro: só o teto que o próprio dono configurou.

### Rollback
Só front + 1 rota de leitura; remover o `<AutonomyContractPanel />` do `SettingsView` esconde a tela sem tocar no comportamento.

### Ainda NÃO feito
Elevação de autonomia guiada por evidência (F3.7 — `ProgressiveAutonomyService` só propõe; humano aceita). Verificação da tela contra o app completo com autenticação real (feita só em Chromium com API simulada).

## F3.2 — Memória empresarial: padrão só vira REGRA com uma pessoa (RN-F3-4)
Estágios (derivados, nunca gravados): **observado** (candidato) → **hipótese** (a recorrência validou, `status='validated'`, ninguém decidiu) → **regra da empresa** (`manager_decision='confirmed'`). O gestor também pode **rejeitar** ("não é regra": o padrão para de alertar, mesmo que a recorrência suba) e **revogar** (volta a hipótese).
- **Quem decide:** `POST /api/insights/patterns/:id/decision` `{decision: confirmed|rejected|revoked, note?}` (owner/admin). Rótulo de sistema (`runtime`/`ai`/`rule`…) é recusado — a IA não confirma o próprio aprendizado. Dormente não se confirma.
- **O `learn` não toca a decisão:** reavalia a recorrência (e pode adormecer o padrão), mas `manager_decision` é coluna à parte; uma regra confirmada continua regra mesmo dormente. Histórico append-only em `business_pattern_decisions` + auditoria (`PATTERN_CONFIRMED/REJECTED/REVOKED`).
- **A pergunta** "Identifiquei isso N vezes desde DD/MM — considera uma regra da empresa?" vai pro ledger (`business_signals`, domínio `memory`, `basis=hypothesis`, severidade info, sem R$), no máximo 3 abertas por empresa, só hipótese sem decisão; some ao decidir e volta ao revogar. N é a contagem real de ocorrências do motor — não inventa "X de Y semanas".
- **Leitura:** `GET /api/insights/memory` (`BusinessMemoryService`, read-model sem tabela de RAG nova): regras · hipóteses · observados · rejeitados · preferências · políticas de autonomia · aprendizados assegurados. O limiar de alerta (R$) só aparece p/ quem vê dinheiro. `GET /api/insights/patterns/:id/decisions` = histórico.
- **Tela:** Insights → "Padrões aprendidos": "validado" agora aparece como **hipótese**; botões "Sim, é regra" / "Não é regra" / "Desfazer decisão".

### Mudanças de comportamento
- O rótulo na tela deixa de dizer "validado" (passa a "hipótese"); o alerta do padrão validado continua igual.
- Padrão **rejeitado** não publica mais alerta (antes não existia a rejeição).

### Rollback
Aditivo: 4 colunas nullable em `business_patterns` + 1 tabela de histórico. Reverter o commit restaura tudo; as colunas ficam inertes.

### Ainda NÃO feito (F3.2)
- A regra TOULON "SKU esgotado não recompra" NÃO foi semeada como regra confirmada: confirmar é decisão do gestor (RN-F3-4), não nossa. Hoje ela existe como estratégia `collection_sellout`, não como padrão.
- Responder "sim" pelo FalaTu (hoje a pergunta aparece no radar/atenção e a confirmação é na tela de Insights).
- Confirmar uma regra ainda não muda o comportamento de nenhum motor: ela é MEMÓRIA consultável. Usar regras confirmadas nas recomendações é a F3.5.

## F3.3 — Radar contextual do varejo (anomalia técnica × desvio de negócio × oportunidade)
`RetailRadarService` olha o dia **FECHADO** (ontem, em SP) e publica só o que merece atenção em `business_signals` (domínio `retail_radar`). A classe vai em `evidence.signalClass`, declarada no `AnomalyDetectorRegistry` (pack `retail_radar`).

| Detector | Classe | O que dispara |
| --- | --- | --- |
| `retail_store_day_below_normal` | negócio | dia da loja ≥30% abaixo da mediana dos MESMOS dias da semana (12 semanas) **e** abaixo de tudo que já houve nesse dia (−10%) |
| `retail_store_day_above_normal` | oportunidade | ≥40% acima **e** acima do máximo histórico (+10%) — info, "vale entender o que funcionou" |
| `retail_price_anomaly` | técnica | preço zerado (provável brinde → info) ou ≥10× / ≤1/10 da mediana do próprio produto (≥5 vendas em 90 dias → atenção) |
| `retail_duplicate_sale` | técnica | boletas com valor, peças, operador e pagamento idênticos no dia — **hipótese** |
| `retail_integration_late` | técnica | cursor de vendas sem sincronizar há >36h (>72h = risco); sem cursor: nenhuma venda nova há >3 dias (hipótese) |
| `retail_commission_strange` | técnica | comissão do ERP > venda, sem venda, ou >2,5× a mediana da rede (precisa de ≥10 lançamentos de base); sinal **sem R$** |

**Regras duras:** (1) a **hora da venda NÃO é confiável** (informado pelo dono) → o radar nem lê `sale_time`; só loja × dia da semana, só dia fechado. (2) Menos de 6 mesmos-dias-da-semana → "histórico insuficiente" (não inventa faixa). (3) Dia sem nenhuma venda nunca é lido como queda. (4) **Dado velho nunca vira "queda de venda"**: com a integração atrasada o radar publica só o sinal técnico e se cala sobre as lojas (e retira os desvios já publicados). (5) Nunca inventa dinheiro (`impactAmount` sempre null; texto em %).

**Ligar:** opt-in por empresa — `PUT /api/retail/radar/enabled {enabled}` (dono/admin sem trava de loja). Desligado: o Scheduler não publica nada. `GET /api/retail/radar[?asOf=]` = só leitura (mostra o que seria dito, sem publicar); `POST /api/retail/radar/scan` publica. O Scheduler roda `RetailRadarService.pass()` a cada ciclo, só p/ empresas ligadas com vendas no PDV; é idempotente (dedupe) e os sinais de estado se auto-curam.

### Rollback
Aditivo: 1 coluna (`organization_settings.retail_radar_enabled`, default 0) e nenhuma tabela. Desligar a flag silencia tudo; reverter o commit remove o serviço.

### Ainda NÃO feito (F3.3)
- **Normalidade por hora**: não existe, de propósito (hora do PDV não confiável). Só volta se o dono corrigir a origem da hora e informar a janela confiável (F3.4 intradiária).
- Não há tela do radar: os sinais aparecem pelo caminho já existente (atenção/Smart Inbox/Fala Tu). A separação técnica × negócio × oportunidade está no dado (`signalClass`); a UI ainda não filtra por ela.
- Não calibrei os limiares (30%/40%/36h/2,5×) com dado real da TOULON — são valores iniciais prudentes. Rode primeiro em preview (`GET /radar`) e ajuste.
- Detectores de preço/duplicidade olham o PDV da última venda ingerida; não cruzam com a tabela de preços do ERP.

## F3.4 — Previsão do mês por loja (faixa · chance de bater a meta · quanto falta)
`GET /api/retail/forecast[?asOf=YYYY-MM-DD&month=YYYY-MM]` (dono/admin sem trava de loja; só leitura). Para cada loja ativa: o que já fechou no mês (**fato**), a faixa de fechamento (**estimativa**, ≈80%: 10%–90%), a chance de bater a meta, o que falta e quanto por dia de funcionamento (aritmética sobre a meta, comparada ao dia típico da loja) e a confiança com os motivos.

**Base:** os **fechamentos oficiais por dia** (`retail_daily_closings`, a mesma base do "Mês X / R$ meta" do fechamento da noite). **Não é intradiário**: a hora da venda não é confiável (dono, 2026-10), então não existe "projeção do dia" nem faixa por hora — é loja × dia da semana × mês.

**Modelo (determinístico, sem LLM):** fechado até ontem + soma, nos dias de funcionamento que faltam, da média do próprio dia da semana nas últimas 12 semanas (feriados e datas comerciais ficam FORA do padrão). Faixa = ±1,28σ com dias independentes; chance de bater a meta = aproximação normal, arredondada de 5 em 5 e **nunca 0% nem 100%**. Dias em que a loja fecha (folga na escala ou dia fixo de folga) não entram.

**Datas especiais** (`retailCalendar.ts`: feriados nacionais + Dia das Mães/Namorados/Pais/Crianças, Black Friday, véspera de Natal): se ainda vêm no mês, o dia usa a média do dia da semana (**não há fator inventado**), a faixa é alargada (σ ≥ 50% da média) e a confiança cai para baixa, listando-as. **Feriado municipal/estadual (ex.: São Jorge no RJ) NÃO está no calendário.**

**Gate de dados (RN-F3-5)** — estados: `ok` · `insufficient_history` (menos de 12 semanas de fechamentos — caso Bangu —, ou menos de 6 dias de funcionamento sem feriado de algum dia da semana que ainda vem) · `no_closings` · `stale_data` (mais de 2 dias de funcionamento do mês sem fechamento) · `month_complete`. 1–2 dias ainda sem fechamento entram como **incertos** (listados), nunca como fato.

**Meta (RN-F3-6):** é lida, nunca alterada. Ordem: meta mensal cadastrada → senão soma das cotas diárias do mês (declarado em `goal.source`) → senão nada (sem probabilidade/falta, nunca meta inventada).

**Rede:** só as lojas projetáveis (as outras aparecem em `storesExcluded` com o motivo); σ somado em quadratura (lojas independentes), então a faixa da rede é mais estreita que a soma das faixas.

### Rollback
Só leitura: 2 arquivos novos + 1 rota. Nenhuma tabela/coluna. Reverter o commit remove tudo.

### Ainda NÃO feito (F3.4)
- **Projeção do dia / faixa intradiária**: bloqueada até a hora do PDV ser confiável.
- **Sell-through da coleção**: NÃO existe dimensão de coleção/temporada no catálogo (`products_services`) — fazer isso seria inventar o agrupamento. Fica para quando o catálogo trouxer coleção (ou o dono definir como agrupar).
- A faixa mede só a variação normal de dia para dia; **não** cobre mudança de tendência, promoção, ruptura de estoque, nem o efeito real de feriado/Black Friday (sem dado próprio não se inventa fator).
- Sem tela e sem aviso proativo ("risco de não bater a meta"): é a base para o briefing semanal/mensal (F3.10) e para o plano de recuperação (F3.5). Os limiares de confiança (12 semanas, 6 amostras, 24 semanas p/ "alta") são iniciais e **não foram calibrados com dado real da TOULON**.

## F3.5 — "Por que provavelmente" + plano de 14 dias do vendedor (recomendação; tarefas só por pessoa)
`GET /api/retail/seller-plan/:sellerId[?date=]` (dono/admin; o gerente de loja só vê gente da PRÓPRIA loja — `seller_out_of_scope` 403). **Read-only**: não cria tarefa, ação nem alerta.

**O que liga (sem motor novo):** `SellerDiagnosisService` (vendas × nº de vendas × ticket × P.A. × dias escalados, 30 dias × 30 dias anteriores; ganhou os campos aditivos `driver` e `deltasPct`) + `SellerGoalStreakService` (meses seguidos abaixo da meta) + `RetailFloorAnalyticsService` (atendimentos da loja).

**Fator (`driver`) — vem dos números, é HIPÓTESE:** `days` (menos dias escalados, ticket estável) · `orders` (menos vendas fechadas, ticket estável) · `ticket` · `pa` · `unclear` (nenhum fator único) · `none` (vendas não caíram → **sem plano**) · `insufficient` (sem base → **sem plano**).

**Plano de 14 dias** (`plan14`, começa no dia seguinte; itens por fator; `unclear` = só a CONVERSA, não inventa intervenção; todo plano termina no **checkpoint do dia 14**: rodar o diagnóstico de novo e comparar). A referência de cada item é o **próprio período anterior da pessoa** — nunca meta inventada, nunca altera a meta oficial. `days` começa por **conferir a escala** ("não é desempenho da pessoa"). 3+ meses seguidos abaixo da meta acrescenta "levar o caso à gestão" (apoio, não punição).

**Atendimentos (Retail Floor)** só entram **fora da calibração** (RN-150-011) e com ≥10 atendimentos; comparam a pessoa com a média da PRÓPRIA loja (nunca ranking). Em calibração ou amostra pequena, `evidenceSources.floor` diz `calibration`/`low_sample` e eles não são usados.

**Tarefas só por decisão de uma pessoa:** `POST /api/retail/seller-plan/:sellerId/tasks {date, items:[chaves], assignedTo?}`. O servidor **recalcula** o plano (o cliente só escolhe chaves; chave fora do plano é recusada); quem aprova precisa ser pessoa (rótulo `runtime`/`ai`/`rule`… é recusado); responsável = gerente da loja (senão quem aprovou; fora da empresa → recusado); **idempotente** por `seller_plan14:<vendedor>:<data>:<item>` (repetir devolve `skipped`); a tarefa nasce no `TaskService` com prazo do item, `source: ia`, descrição com o porquê, o que acompanhar e o aviso, e fica na auditoria (`SELLER_PLAN14_TASKS_CREATED`). **Nada** toca comissão, salário, meta oficial ou cobrança.

**Texto:** descreve o NÚMERO, nunca o motivo humano — sem culpa/punição/desligamento. Aviso fixo: orienta uma conversa do gerente, não é avaliação formal.

### Rollback
Só leitura + 2 rotas + 2 serviços novos e 2 campos aditivos em `SellerDiagnosis`. Nenhuma tabela/coluna. As tarefas já criadas são tarefas normais (apagáveis pelo gerente).

### Ainda NÃO feito (F3.5)
- **Redistribuição por demanda/baixo giro** (estender `RetailTransferService`, hoje só loja zerada): mexe em estoque — fatia própria (F3.5c), propondo transferência governada.
- **Sem tela**: a recomendação e a aprovação das tarefas são por API; a tela do gerente fica para depois.
- **Eficácia do plano esperado × realizado** (F3.7): o checkpoint do dia 14 existe, mas nada mede ainda se o plano funcionou nem alimenta "O que funciona".
- Atendimentos só fazem sentido onde o módulo Retail Floor é usado; sem ele a recomendação segue só com vendas/escala/meta.
- Os limiares do fator (±15% de queda, ±10% de estabilidade) são os que o `SellerDiagnosisService` já usava; **não foram calibrados com dado real da TOULON**.

## F3.6a — FalaTu multi-ação: uma frase → N ações → UMA confirmação
"cadastra o cliente João e marca reunião com ele amanhã às 10h; anota ligar pro contador" é 3 pedidos. Antes o FalaTu entendia só o primeiro verbo. Agora a frase é dividida e o dono vê a **lista do que vai ser preparado** (cada item com checkbox, removível) e confirma **uma vez**.

**Como funciona (sem orquestrador novo, sem caminho de escrita novo):**
1. `POST /api/falatu/ask` → `FalaTuAskService.converse`. Se a frase tem ≥2 pedidos de **registro**, devolve `kind: "multi_action"` + `data.multiPlan {planId, items[], expiresAt}` — **pré-visualização, não escreve nada**.
2. `POST /api/falatu/multi/:planId/confirm {keep?: [ids]}` (default = todos os não bloqueados) prepara cada item mantido pelo **mesmo** `converse` de sempre (`noMulti`): cliente/despesa/venda/recebível/compromisso viram **proposta governada** (`DecisionAction → ApprovalPolicy`, onde a política e o piso da F3.1 decidem quem aprova); "anota…" vai pro **Inbox**. `POST /multi/:planId/cancel` descarta.
3. **A confirmação única é do PREPARO — não aprova nada no lugar de ninguém.** Despesa/venda continuam "aguardando aprovação" em *Aprovações*.

**Divisão (`FalaTuMultiActionService.split`)** reusa `FalaTuAskService.classify` — sem vocabulário novo: um pedaço só é ação se o classificador de sempre o reconhece como registro. Fronteiras: `;`, "e (depois|também)", "depois", "também", vírgula — **nunca vírgula entre dígitos** (R$ 1,50). Pedaço que não é ação ("leite" em "anota comprar pão e leite") é **colado** no anterior (texto original, nunca recomposto). Pergunta misturada com ação, uma ação só, ou >6 pedidos → **não é multi** (segue o caminho de antes; >6 pede pra mandar menos).

**Regras:** dinheiro role-gated (§73) — item de despesa/venda/recebível aparece 🔒 e é barrado no confirm de quem não vê dinheiro (o `converse` barra de novo); item que o motor não consegue preparar (cliente não encontrado, faltou valor) volta com o **motivo** — nunca finge; plano em **memória** (15 min, por empresa+usuário; sem texto em banco — LGPD; reiniciar o servidor ou passar o prazo "esquece" e pede pra repetir); confirmar 2× devolve o mesmo resultado (idempotente); outro usuário/empresa não confirma; auditoria `FALATU_MULTI_CONFIRMED` só com quantidade/tipos — **sem o texto do dono**.

**UI** (`FalaTuView`, aba Perguntar): cartão com checkbox por ação + um botão "Preparar N ação(ões)" + Cancelar; depois de confirmar mostra o resumo e o destino de cada item.

### F3.6c — dependência entre itens (cadastro → compromisso)
"cadastra o cliente João e marca reunião com ele amanhã": o compromisso só pode ser preparado quando o cliente EXISTE, e o cadastro só existe depois de aprovado. Por isso `linkDependencies` liga o compromisso ao cadastro **anterior** da mesma frase (nome citado, com acento/caixa normalizados, ou "com ele/ela" quando há **exatamente um** cadastro antes — ambíguo não adivinha). No confirm, o compromisso fica `waiting` (não finge que fez, não cria nada). Depois de aprovar o cadastro, "Tentar agora" (`POST /api/falatu/multi/:planId/continue`) roda de novo só os que esperam: se o cliente já existe, prepara; se não, segue esperando com o motivo. Vale por 2 h; nada esperando → recusa (idempotente). Auditoria `FALATU_MULTI_CONTINUED`.
Correção embutida: `parseAppointment` não cortava "amanhã"/"às" (o `\b` não enxerga acento) e o nome saía errado → "Não achei o cliente". Agora usa limites com letras acentuadas.

### Rollback
Só código: 1 serviço novo, 1 ramo no início de `converse` (desligável com `noMulti`), 2 rotas, UI. Nenhuma tabela/coluna. Reverter o commit restaura o comportamento anterior.

### Ainda NÃO feito (F3.6)
- **Decomposição de objetivo** ("+10% na Carioca" → ações por loja) sobre `BusinessGoalService`/Mission OS: fatia própria (**F3.6b**).
- **WhatsApp** (`FalaTuWhatsAppService`) segue o caminho antigo (não divide frases); só a tela do FalaTu.
- **Dependência entre itens**: "cadastra o cliente João e marca reunião com ele" — o cliente só é *proposto* (aguardando aprovação), então o compromisso não o encontra e volta "não preparei". Honesto, mas o dono precisa aprovar o cadastro e repetir o agendamento. Pronomes ("com ele") não são resolvidos.
- Só pedidos de **registro** entram (cliente, despesa, venda, recebível, compromisso, anotação). Tarefas para outras pessoas, campanhas, transferências e demais ações governadas não são decompostas ainda.
- Em "Hoje/Executando/Resultados" o que aparece são as propostas/aprovações já existentes; não há visão própria do plano.

## F3.7 — Learning Loop: eficácia por intervenção ("O que funciona")
`InterventionEffectivenessService.summary` (read-only, sem tabela) agrupa o Impact Ledger por **(domínio, tipo de ação)** e responde "isso costuma atingir o esperado?". Rota `GET /api/executive/intervention-effectiveness[?domain=]`; seção nova na aba **O que funciona** do Diretor IA (a lista de padrões de antes fica intacta).

**Regras:** só ação `assured` (efeito confirmado + impacto medido, PRD 8) entra na taxa — medida sem confirmação vira só contagem (`measuredNotAssured`); só base `fact` (estimativa nunca soma, `estimateOnly`); "atingiu" = realizado ≥ esperado e só com esperado > 0 (sem meta → fora da amostra, null≠0). **Amostra mínima = 5** casos com meta: abaixo, sem taxa nem veredito. Com amostra: taxa + banda de Wilson 95% + veredito pela banda (`works` piso ≥ 50% · `weak` teto < 50% · `inconclusive`). Veredito é evidência pro gestor, nunca regra automática. R$ (esperado/realizado) só com permissão de dinheiro (§73); taxa e contagens sempre.
**Não coberto:** "% do objetivo" (falta elo ação → meta); estratégia de mensagem por amostra (precisa de dado de campanha, depende de D4/LGPD).
**Rollback:** só código (1 serviço, 1 rota, 1 seção de UI). Sem schema.

## F3.8 — Impact Ledger 2.0: custo, confiança e "associado × causado"
**Decisão (D3 ainda aberta, seguindo a recomendação):** esta fatia NÃO tem holdout/grupo de controle — por isso tudo é rotulado **associado**, nunca "causado/incremental" (`totals.causality = { basis:"associated", incremental:null }`). Holdout fica pra quando o dono definir a regra (D3) e existir campanha com controle.

**O que entrou (aditivo, 2 colunas em `action_outcomes`):** `intervention_cost` (R$; **NULL = desconhecido, nunca 0**; negativo/NaN/vazio → NULL; `0` declarado é aceito) e `confidence` (`high|medium|low`; fora do enum → NULL). `POST /api/actions/:id/outcomes` aceita `interventionCost`/`confidence`; `OutcomeMeasurementService.record` valida.
**Líquido** (`ledger().totals.net`): Σ realizado − Σ custo **só de FATO com custo conhecido**; custo desconhecido vira `costUnknownCount` (fora da conta, não zero); estimativa/atribuído nunca entram; sem nenhum custo conhecido → `net:null`. `totals.confidence` conta high/medium/low/`unreported`.
**Resultados:** `ExecutionResultsService.results().impactReading` e a tela Resultados mostram "valores associados (sem grupo de controle)", líquido só quando há custo, e quantas medições ficaram sem custo/com confiança baixa. R$ do líquido só pro gestor (§73); rótulos e contagens sempre.
**Legado:** outcomes antigos (sem custo/confiança) seguem idênticos; `realized`/`expected`/categorias não mudaram. **Rollback:** colunas ignoráveis; reverter o commit restaura tudo.
**Não feito:** holdout/controle, "incremental estimado", poder estatístico (RN-F3-9) — dependem da D3 e de campanha com grupo de controle; nenhum caminho existente grava custo automaticamente (hoje só manual/rota).

## F3.10 — Briefings semanal (comercial) e mensal
`PeriodicBriefingService.compose(orgId, user, {period})` (read-only, sem tabela/motor/canal novo) compõe o que já existe: resultado × meta da rede (`ResultsStoryService`), lojas abaixo, previsão do mês (`RetailForecastService`, só no semanal), equipe que mais caiu (fato), metas fora do ritmo, impacto (F3.8 "associado" + F3.7 "o que funciona") e prioridades. **Semanal** olha ontem/a semana; **mensal** olha o mês **fechado** anterior. Seção sem dado diz o motivo (`available:false` + `reason`); nunca preenche.

**Entrega pelos canais existentes:** `publish` grava UM sinal **sem dinheiro** em `business_signals` (`weekly_commercial_briefing` / `monthly_briefing`, idempotente por período, só quando há algo notável: loja abaixo, meta fora do ritmo ou prioridade) — flui pro Smart Inbox/"Hoje"/push/WhatsApp com quiet-hours e limiar do `FalaTuProactiveService`. O texto completo é lido sob demanda em **Resultados → Briefing** (`GET /api/ux/briefing/{week|month}`), role-gated (§73): sem visão completa, os números viram "do gestor". `Scheduler`: segunda (SP) publica o semanal; dias 1–3 o mensal. **Opt-in** `organization_settings.periodic_briefing_enabled` (default 0; `GET/PUT /api/ux/briefing/enabled`, owner/admin).
**Não coberto (declarado no próprio briefing):** margem confiável, estoque, clientes e campanhas (sem fonte consolidada / dependem da D4). O impacto é acumulado (o ledger não é por período).
**Ligar/desligar pela tela:** em Resultados → Briefing há um interruptor "Avisar quando o briefing estiver pronto" — só aparece pra dono/admin (a UI consulta `GET /api/ux/briefing/enabled`, que responde 403 aos demais); a gate real continua no servidor.
**Rollback:** desligar a flag (default já é off); só código + 1 coluna ignorável.

## F3.9 (compras) — cenários de compra, SÓ ANÁLISE
`PurchaseScenarioService.analyze(orgId, {amount, minCash?, payInWeeks?})` — `POST /api/health-center/simulate/purchase-scenarios` (só gestor com visão completa; §73) e modo **"Cenários de compra"** no Simulador de decisões (Central de Saúde). Liga o que existe: caixa de 13 semanas (`CashForecastService`, compra como saída na semana escolhida), cobertura/encalhe (`DecisionSimulatorService.buyStock` + `stockCapital`) e reserva saudável (ADR-201, só contexto). Três cenários: conservador/base/otimista = ±30% na velocidade de venda e nos recebíveis (**premissa declarada**, não dado medido).

**Nunca executa (RN-F3-14):** `executes:false`; não cria pedido/requisição/ação, não paga, não fala com fornecedor. A única escrita é a sincronização idempotente de vendas pagas no caixa que o motor de caixa já faz ao projetar. A **contraproposta é um RASCUNHO** de texto ("não enviado — você decide"), só quando a compra passa do orçamento máximo; não inventa fornecedor nem condição.
**Veredito (conselho):** `not_recommended` se o caixa conservador fura o mínimo ou a cobertura base passa de 120 dias; `attention` se encosta no mínimo, cobertura > 60, reserva do mês fora do ideal ou ≥30% do estoque sem giro; `insufficient_data` sem caixa e sem velocidade; `ok` caso contrário. **Orçamento máximo** = o menor entre o que o caixa conservador aguenta e a cobertura de 120 dias com venda conservadora (a base usada é dita).
**Honestidade:** margem/giro/caixa ausentes → `null` + `caveats` (nunca 0); giro não medido → sem estimativa de encalhe; caixa mínimo não informado → R$ 0 declarado.
**Fora (declarado):** planejamento sazonal ("Black Friday") com clientes/campanhas/equipe e **campanha preditiva** — bloqueados pela D4 (consentimento na base do PDV). Sem tabela/coluna nova. **Rollback:** só código.

## D4 — Consentimento dos clientes do PDV (LGPD, escopo `comunicacoes`)
**Decisão do dono:** "eles precisam aprovar". `retail_pdv_customers` (base do ERP) não tinha consentimento — e o gate do sink de mensagens (`OutboundConsentGuardService`) só olhava `contacts`: um cliente do PDV era tratado como "contato desconhecido = mensagem de sistema" e **passava sem prova**. Esta fatia registra a aprovação e fecha esse buraco. **Não é campanha** e não envia nada.

- **Livro** `retail_pdv_consents` (APPEND-ONLY, chave = `codigo_n` do ERP): a **última** linha vale; **revogar é nova linha `granted=0` e sempre vence**. Cada registro leva origem (`balcao|whatsapp|formulario|telefone`), quem registrou, evidência curta (≤300, sem dado sensível) e é auditado (`PDV_CONSENT_GRANTED/REVOKED`, sem PII).
- **Sem registro = sem consentimento** (`unknown`): nunca inferido de compra, do ERP ou de ter celular. Só autoriza quem tem celular; só cliente que existe no PDV da org.
- `PdvConsentService.assertContactable` é a pergunta que **toda campanha futura deve fazer** (recusa `consent_unknown|consent_revoked|no_phone|inactive|customer_not_found`). `summary` dá a cobertura só em contagens (percentual `null` sem base — não 0%); `contactable` lista só quem autorizou.
- **Sink:** com `outbound_consent_required=1` (a flag que já existia; default off = 0-regressão), o destinatário que **é cliente do PDV** (casa pelo celular, tolerante a DDI/9º dígito) só recebe com consentimento; sem prova → `outbound_blocked:consent_missing` (mesmo código de antes, `source:"pdv"`). Número que não é cliente do PDV segue como mensagem de sistema.
- **Rotas** `/api/retailops/pdv-consent`: `GET /summary` (rede, só contagens) · `GET /contactable` · `GET/POST /:code` (owner/admin, com a trava de loja ADR-173).
- **Limites (declarados):** ainda **não há tela nem link de opt-in** pro cliente — o registro é via API/operador (ex.: balcão). Ligar a flag `outbound_consent_required` é decisão do dono e passa a barrar TODO envio a cliente do PDV sem consentimento (inclusive fluxos que hoje funcionam) — ligar só depois de capturar consentimento. A busca por celular no sink varre os clientes da org (sem índice): ok para milhares, a otimizar se a base for muito grande. Consentimento não é herdado de `contact_consents` (escopos separados).
**Tela (captura no balcão):** em Retail → **Clientes do PDV** há o cartão de **cobertura** (autorizaram × recusaram × sem registro; `null` sem base) e a coluna **Consentimento** (`Autorizou (origem)` / `Recusou/revogou` / `Sem registro` — nunca "autorizou" por omissão). Dono/admin vê **Autorizou / Recusou / Revogar** por cliente (o servidor decide: `canRecordConsent` na lista; "Autorizou" desabilitado sem celular); abre um formulário com **origem** + observação opcional e o aviso de que o registro **não pode ser apagado** (só revogado). Gerente restrito a loja só registra clientes da própria filial (ADR-173). `GET /pdv-customers` agora devolve `consent` por cliente (1 query, `statusMany`).
**Ainda não existe:** link/QR de opt-in pro próprio cliente aprovar (hoje o operador registra o que o cliente disse/assinou — a honestidade do registro depende de quem opera) e importação em massa.
**Rollback:** só código + 1 tabela aditiva; flag off restaura o comportamento anterior.

## F3.6b — Objetivo da REDE ("+10% no mês") dividido por loja
`NetworkObjectiveService` + `GET /api/retailops/network-objective?pct=&month=` + `POST /network-objective/tasks` (dono/admin) + card **"Objetivo da rede: quanto cada loja precisa a mais"** em Operação da Rede (junto da Meta mensal por loja). **Decisão do dono:** o objetivo é da **rede → lojas** (não loja → vendedores).

- **Ponto de partida = a PROJEÇÃO do mês (F3.4)** de cada loja (o que ela faz se nada mudar) — não a meta, não o ano passado. Cada loja recebe **+X% proporcional à própria projeção**; o serviço traduz isso em **R$ a mais por dia útil que falta** e compara com o **dia típico** da loja (esforço leve ≤10% · moderado ≤25% · alto acima — **premissa não calibrada**, declarada).
- **Loja sem projeção confiável** (histórico < 12 semanas, fechamento atrasado, mês fechado) fica **de fora com o motivo** e **não entra na soma da rede**. Nunca inventa número.
- **Só recomenda** (`executes:false`): a meta oficial é só LIDA (`retail_store_monthly_goals` intacta, testado). **Tarefa só por clique de uma PESSOA** (rótulo de sistema recusado), 1 por loja marcada, responsável = gerente da loja (senão quem clicou), idempotente por (mês, %, loja), plano **recalculado no servidor** (cliente só escolhe lojas), auditoria `NETWORK_OBJECTIVE_TASKS_CREATED`.
- **Escopo (ADR-173):** gerente restrito vê só a(s) loja(s) dele e **não recebe o total da rede**; só cria tarefa pra loja do alcance.
- **Limites:** estimativa, não promessa; divisão proporcional (não otimiza entre lojas); não usa o planejador reverso do Mission OS (ele é de receita da empresa, não por loja); não há "Hoje/Executando" ainda mostrando o objetivo.
**Rollback:** só código; sem schema.
## Telas: Previsão, Radar e Plano do vendedor (aba "Previsão e alertas")
Em **Operação da Rede → Vendas e metas → "Previsão e alertas"** (dono/admin sem trava de loja; o servidor recusa os demais). São telas SÓ de renderização sobre rotas já existentes — nada novo é calculado na tela e **nada altera meta, comissão ou cota**.
- **Previsão do mês por loja** (`GET /forecast`, F3.4): quanto já vendeu, **faixa** que deve fechar (não um número exato), chance de bater a meta, quanto falta por dia útil e a confiança com os motivos. Loja sem previsão mostra o **motivo** (histórico < 12 semanas, fechamento atrasado…); sem meta cadastrada, **não calcula a chance**. Rede soma só as lojas projetáveis.
- **Radar** (`GET /radar`, F3.3): o que fugiu do normal no último dia **fechado**, separado em Dado/integração × Negócio × Oportunidade. Interruptor "Avisar no sistema quando houver" (`PUT /radar/enabled`, opt-in) e botão **"Verificar e avisar agora"** (`POST /radar/scan`, só com o radar ligado). Dado atrasado → diz que não compara lojas. Desligado, só mostra a lista.
- **Plano de 14 dias do vendedor** (`GET /seller-plan/:id`, F3.5): escolha o vendedor; mostra o que mudou nos números (**fato × hipótese** rotulados) e o plano; **"Criar tarefas para o gerente"** só por clique (`POST /seller-plan/:id/tasks`). Não é avaliação de desempenho. `GET /sellers` agora devolve também o `id` do vendedor (campo aditivo).
**Limites:** a aba nova exigiu atualizar o teste dos grupos (19 → 20 abas); não foi testada em navegador/celular — só por código e rotas.


## D4c — Link de consentimento do cliente (PDV)
1. Em **Clientes (PDV)**, na coluna Consentimento, clique **Link** (só aparece p/ cliente com celular e ainda sem autorização; owner/admin).
2. Mostre o **QR** no balcão ou copie o link e entregue você mesmo. O ZapFlow não envia.
3. O cliente escolhe Autorizo / Não autorizo; aparece como "(link do cliente)". Vale até a data mostrada; gerar outro link invalida o anterior.
4. Requer `APP_URL` no servidor (senão o link é relativo e o QR não serve). Rota pública: `/api/public/consent/:token`.

## D4d — Interruptor do bloqueio de envio sem consentimento
1. Clientes (PDV) → cartão "Consentimento para receber mensagens" → **Bloqueio de envio sem consentimento** (só dono/admin).
2. **Ver impacto e ligar** mostra quantos contatos e clientes do PDV deixariam de receber mensagem. Ligado, o bloqueio vale para **todo envio** (inclui respostas de atendimento e cobranças automáticas), não só campanha.
3. Marque o aceite e **Ligar bloqueio**. Para reverter: **Desligar** (sem confirmação). Tudo fica auditado.
4. Se "contatos sem consentimento" for alto, **não ligue** antes de registrar consentimentos — o atendimento pode parar de responder esses contatos.
