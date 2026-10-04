# Runbook — Fase 2: Arquitetura de Experiência (ADR-203)

Operação e homologação por fatia. Cada item = 1 PR, com o que mudou, como conferir e o que ficou de fora. Análise: `docs/prd/ANALISE-PRD-FASE2-vs-CODEBASE.md`.

## F2.1 — Roteador de intenções do FalaTu (`test:falatu-intent-router`)

**Por quê.** O probe da F2.0 mostrou que o FalaTu errava a frase-âncora do PRD e que 9 das 19 frases obrigatórias não tinham rota determinística. Como a Fase 2 promove o FalaTu a porta principal, isso foi corrigido ANTES da navegação.

**O que mudou (só backend, aditivo):**
- **Regras únicas** em `ConversationalIntentRules` (puras): `isDecisionInquiry`, `isCampaignRequest`, `hasMoneyMarker`, `inactiveDaysFrom`. FalaTu e Diretor IA usam a MESMA definição (PRD §40).
- **Âncora corrigida:** "Estou pensando em comprar R$ 180 mil… o fornecedor quer 30% de entrada… Analisa" agora é **análise de decisão** (antes: o FalaTu entendia "despesa de R$ 180.000" por causa da palavra "fornecedor"). O "Analisa" também não joga mais a pergunta no LLM aberto. Registro explícito ("lança a despesa…", "paguei…") continua sendo registro.
- **"Crie uma campanha…" não é mais análise de decisão.** "90 dias" e "30%" deixaram de valer como dinheiro (só R$/reais/mil/milhão/k/milhar com ponto).
- **3 ferramentas novas** no cardápio do Diretor IA (que o FalaTu já usa para pergunta aberta): `ranking_lojas`, `produtos_parados`, `proposta_campanha`.
- **Cobertura determinística** das frases que caíam no LLM: "Como estão minhas lojas?" (sem "hoje"), "Quanto falta para a Grande Rio?", "Quanto a Carioca precisa vender hoje?", "O que está acontecendo na Grande Rio?", "Como fechou ontem?", "Como foi a semana?", "Tem problema no estoque?", "Quem vendeu mais esta semana?" (por vendedor, sem exigir a palavra), "Qual loja está com pior desempenho?", "Mostra os produtos parados."
- **Carimbo de frescor (RN-F2-7):** a venda "até agora" (meta do dia, dinheiro do dia) diz "Último dado do PDV confirmado às HH:MM" e **ATRASADO** quando passa de 90 min. Org sem sincronização de PDV não recebe carimbo.

**Honestidade das ferramentas novas:**
- `produtos_parados` só afirma "parado" com o giro **medido** (S9); senão diz que o sistema não recebe as saídas e **não lista**. Item sem custo mostra "—".
- `ranking_lojas` ordena pelo **% da meta mensal já FECHADA** (fechamentos enviados até ontem — `monthToDate`, S6), com o % do mês decorrido; loja sem meta ou sem fechamento vai à parte (nunca 0%); no 1º dia do mês não compara.
- `proposta_campanha` é **PRÉVIA**: conta quem já comprou e está há N dias sem comprar (contato válido, sem opt-out) e diz "nada foi criado nem enviado". Criar o rascunho segue em Campanhas (que nunca dispara sozinha).
- Dinheiro role-gated: `ranking_lojas` e `produtos_parados` somem para papel sem visão de dinheiro; `proposta_campanha` (sem R$) não.

**Como conferir na TOULON (Owner):** no FalaTu → Perguntar, mande as frases acima. Esperado: resposta do sistema com número (ou "não consigo afirmar" quando o dado não existe), nunca um lançamento de despesa por causa de "fornecedor".

**O que NÃO está nesta fatia (e por quê):**
- **Continuidade de conversa** ("Por quê?" depois do briefing; "pode criar" depois da prévia da campanha) — F2.8.
- **"Quanto falta para a Grande Rio?" usa a COTA DO DIA**; a TOULON usa meta mensal e hoje não cadastra cota diária — a resposta diz "cota do dia não cadastrada" em vez de inventar (decisão D4 do PRD).
- "Qual loja está pior" compara % da meta **fechada**, que pode estar incompleta no meio do mês; o texto avisa. Não é ranking de performance "corrigido por loja grande/pequena" — a meta mensal já normaliza o tamanho.
- A resposta final pode ainda ser reescrita pelo LLM (`phrase`), mas só sobre os fatos da ferramenta.

## F2.2 — Navegação simplificada atrás da flag (ADR-203)

**O que é:** menu de 1º nível com 5 superfícies (Hoje · FalaTu · Executando · Resultados · Empresa) + "Explorar" (todo o resto, agrupado, com busca). Só renderiza quando `organization_settings.simplified_navigation_enabled = 1`; com a flag OFF (default) o `Sidebar` legado é o mesmo de antes (0-regressão).

**Como ligar (só TOULON):** Configurações → Módulos → "Menu simplificado (piloto)" (owner/admin), ou `PUT /api/entitlements/simplified-navigation {"enabled":true}`. Desligar volta ao menu completo; nada é apagado.

**Destinos interinos (trocados nas F2.3–F2.6):** Hoje→tela própria (F2.3, cockpit por exceção) · FalaTu→FalaTu · Executando→Missões (com Mission Layer) ou Tarefas · Resultados→Diretor IA (ou Relatórios) · Empresa→Configurações (só gestor).

**Garantias:** `src/lib/navCatalog.ts` espelha cada tela do `Sidebar.tsx` com o MESMO gate (módulo/permissão/vertical/master/gestor); `test:simplified-navigation` falha se uma tela do legado sumir do catálogo ou mudar de gate. Item sem permissão some (nunca cadeado).

**Telemetria:** `src/lib/uxTelemetry.ts` envia `view_opened` (surface+tela, nunca conteúdo). O servidor só grava com `ux_telemetry_enabled` (opt-in LGPD) — a F2.2 NÃO liga essa flag; decisão do dono antes da F2.9.

## F2.3 — Hoje (cockpit por exceção)

`GET /api/ux/today` (`TodayCockpitService`) COMPÕE `FalaTuHomeService.home` + parcial do PDV (`RetailAfternoonBriefService`) + exceções do varejo (`RetailExceptionSignalService`) + `SignalLanguage.presentSignal`. Nada é recalculado (PRD §39). Tela: `TodayView` (viewMode `hoje`, destino do item "Hoje" da nav simplificada).

- **≤3 prioridades**, cada uma com título, **causa** (o fato que a gerou) e **verbo específico** ("Aprovar ou recusar", "Cadastrar a escala de Bangu"). O excedente vira só `moreCount`. Ordem: decisão que VOCÊ pode aprovar › risco crítico › risco › exceção operacional › meta atrasada › oportunidade.
- **Rede (D4):** meta do mês + já fechado + falta no mês (só soma quando TODAS as lojas com meta têm fechamento — senão "—", nunca "vendeu 0") + parcial do PDV do dia com "último dado às HH:MM" e aviso de ATRASADO (>90 min). Sem meta diária inventada.
- **Dinheiro role-gated:** `network` e valor recuperado só para visão completa do negócio; escopo de loja respeitado.
- **Gap conhecido:** "Resolvido automaticamente hoje" (PRD §4) NÃO é entregue — `business_signals` não grava a data da auto-resolução. A tela mostra "casos resolvidos nas últimas 24h" (ações concluídas). Adicionar a data exigiria coluna nova; decisão pendente.
- Flag desligada com `viewMode='hoje'` salvo: o app volta para a Central de Saúde.

## F2.4 — Executando (4 etapas)

`GET /api/ux/executing-board` (`ExecutingBoardService`) → tela `ExecutingView` (viewMode `executando`, destino do item "Executando" da nav simplificada; sempre presente). Fachada ÚNICA sobre ações/aprovações, processos por objetivo (`ExecutionResultsService.executing`), missões e tarefas. Missão = Tarefa = Ação: o mesmo cartão; o tipo interno só decide o link.

- **Precisa de você:** decisão que VOCÊ pode aprovar, missão aguardando aprovação, ação que FALHOU (falha é de 1ª classe).
- **Em andamento:** objetivos com processo ativo, ações aprovadas (sem duplicar o objetivo do mesmo fio), missões em andamento/em risco, tarefas "fazendo".
- **Aguardando:** executada esperando confirmação externa (`action_confirmations` pendente — NUNCA vai para Concluído), aprovação de outro perfil, missão bloqueada/pronta/planejando, tarefas "na fila" (prazo vencido sinalizado).
- **Concluído (7 dias):** com a garantia dita — "Resultado confirmado" só quando `OutcomeAssuranceService` prova; senão "Executado — resultado ainda não confirmado" (DONE ≠ RESULTADO).
- Escopo: missões só gestor + Mission Layer ligado; tarefa de outra pessoa só gestor; domínio invisível some; R$ só com visão completa (vendedor recebe `restricted`). Cada lane: até 8 itens + `total`.
- "Missões" continua inteira em Explorar e há atalho "Ver todas as missões" quando disponível (D1).

## F2.5 — Resultados (conclusão → rede → lojas → Entender) + "Atendimento Digital"

`GET /api/ux/results-story[?date=]` e `GET /api/ux/results-story/store/:storeId/understand` (`ResultsStoryService`) → tela `ResultsView` (viewMode `resultados`, destino do item "Resultados" da nav simplificada; sempre presente). COMPÕE `RetailDayBriefService.nightSnapshot` (fechamentos já enviados: dia/semana/mês, meta mensal), `SellerDiagnosisService` e `ExecutionResultsService.results` (o que o ZappFlow resolveu). Sem tabela/motor/flag nova. Data padrão = ontem (SP).

- **Conclusão primeiro**, derivada: "No mês, a rede está em X% da meta (R$ a de R$ b). N lojas ficaram abaixo da meta em DD/MM." Sem fechamento/meta do mês suficiente → sem conclusão + o motivo (nunca inventada).
- **Lojas** com quem precisa de atenção no topo: abaixo › sem dado › bateu. Loja sem fechamento OU sem cota do dia vai para "sem dado" — NUNCA para "abaixo"; sem fechamento = "—", nunca "vendeu 0".
- **Entender** (por loja): períodos dia/semana/mês + até 3 pessoas da equipe que mais caíram em 30 dias, com FATO × HIPÓTESE (hipótese nunca vira causa comprovada; sem culpa).
- Uma definição por indicador: aqui é o fechamento; o parcial do PDV continua só no Hoje.
- **Dinheiro role-gated:** sem visão completa → `restricted` (sem números do varejo), mas os resultados NÃO monetários do ledger seguem. **Escopo de loja:** gerente preso a lojas só vê as dele e NÃO recebe a leitura da rede inteira.
- **Rótulo:** o antigo "Dashboard" (tickets/leads/IA/handoffs — universo digital) agora se chama **"Atendimento Digital"** no menu legado, no menu simplificado, no cabeçalho e no título da tela. "Venda da rede" é outro indicador (RN-F2-5).
- Fora desta fatia: KPIs só-digitais dentro do Atendimento Digital (§21) — a tela segue como está, só o rótulo mudou. Estoque/financeiro no Resultados ficam para depois (a tela cobre rede→lojas→equipe).

## F2.6 — Empresa + Integrações/Canais em modo normal × avançado

`GET /api/ux/integration-status` (`IntegrationStatusService`) → tela `CompanyView` (viewMode `empresa`, destino do item "Empresa" da nav simplificada, só gestor). COMPÕE read-only `AlterdataReadinessService.compute` + `AlterdataConnectorService.publicSettings` + tabela `channels`. Sem tabela/motor/flag nova, sem chamada externa.

- **Modo normal (a tela Empresa):** por conexão — estado (🟢 Conectada · 🟡 Precisa de atenção · 🔴 Parada · ⚪ Não configurada), "última sincronização às HH:MM", o que chega (Estoque e compras · Preços · Vendas · Clientes…), "N filiais requerem atenção" e até 3 pendências com a ação sugerida. Canais: conectado × "desconectado — precisa reconectar".
- **Modo avançado = as telas técnicas que já existiam** ("Integrações" e "Canais e I.A."), preservadas (RN-F2-1) e a um clique ("Modo avançado (detalhes técnicos)"). Nada foi removido nem duplicado.
- **Honesto:** sem token = Parada; token ok mas NUNCA sincronizou = atenção ("Ainda não sincronizou"), nunca "Conectada"; sync com mais de 4× o intervalo (mín. 1h) = atenção + carimbo; módulo que a política do Alterdata não suporta nem aparece. "N filiais" conta filiais DISTINTAS com recurso falhando na última sync.
- **Sem segredos:** token, client id/secret, base URL e rede nunca saem (o técnico fica no modo avançado). **Só gestor** (owner/admin): os demais recebem `restricted`. Isolado por org.
- **Ajustes da empresa** (atalhos para abas de Configurações que já existem): Dados da empresa · Equipe e permissões · Autonomia da IA · Plano e cobrança · Módulos e menu.
- Fora desta fatia: o modo normal só cobre Alterdata + canais (os outros conectores — Sicredi, Google, etc. — seguem só no modo avançado); "objetivos" da empresa ainda não têm tela própria.

## F2.7 — Operação da Rede: 19 abas → 5 grupos

Só frontend (`src/lib/retailOpsGroups.ts` + `RetailOpsView`). **Com o menu simplificado ligado**, as 19 abas aparecem em 5 grupos por propósito e, ao escolher um grupo, só as abas dele (até 4). **Com a flag desligada, a lista plana de sempre** (0-regressão). Nenhuma aba foi removida, renomeada ou alterada; o conteúdo de cada uma é exatamente o mesmo.

| Grupo | Abas |
| --- | --- |
| Fechar o dia | Fechamento diário · Malote / Depósitos · Divergência · Recebíveis (cartão) |
| Vendas e metas | Resultado por loja · Mais vendidos · Metas do vendedor · Precificar |
| Equipe | Escala & cotas · Vendedores da loja · Comissão · Equipe & cobrança |
| Estoque e reposição | Estoque negativo · Reposição (grade) · Transferências · Loja virtual → PDV |
| Clientes e inteligência | Insights · Clientes (PDV) · Padrões (IA) |

- A aba padrão continua sendo "Insights" (grupo "Clientes e inteligência"); o grupo ativo sempre acompanha a aba aberta.
- `test:retail-ops-groups` falha se uma aba some, duplica, é inventada, ou se o grupo passa de 5 abas.
- Telemetria: troca de grupo/aba emite `view_opened` (`retailops_grupo` / `retailops_aba`) — grava só com `ux_telemetry_enabled`.
- Fora desta fatia: as abas internas continuam com a mesma complexidade (ex.: Fechamento diário); só a navegação entre elas foi simplificada.

## F2.8 — FalaTu: 2º nível, contexto, escopo por papel e continuidade

`FalaTuConversationService` (servidor) + `src/lib/falatuGroups.ts` + `FalaTuView`. Sem tabela/motor/flag nova; sem LLM nessas camadas (determinístico antes de IA).

**1) 1º nível (§11)** — com o menu simplificado ligado, as 9 abas do FalaTu aparecem em 4 grupos: **Conversar** (Perguntar) · **Para mim** (Inbox, Briefing) · **Organizar** (Tarefas, Agenda, Listas, Memória) · **Mais** (Plugues, Protocolos). Flag desligada = as 9 abas planas de sempre. Nada removido.

**2) Contexto corrente (§29)** — na aba Conversar, com 2+ lojas visíveis, aparece "Sobre: Todas as lojas · Grande Rio · Carioca · Bangu". A loja escolhida vai em `POST /api/falatu/ask {context:{storeId}}` e vira o padrão ("Quanto falta para bater a meta hoje?" → daquela loja). **Loja citada na frase vence o contexto; "rede/todas as lojas" ignora o contexto.** O servidor valida a loja (da org + no escopo do usuário) — nunca confia no cliente.

**3) Escopo por papel (§30), imposto no SERVIDOR** — quem está preso a lojas (`user_stores`, ADR-173): pergunta sem loja = a loja dele (1 loja) ou "De qual loja?" (várias); loja citada fora do escopo = recusa; **comparativos da rede** (`ranking_lojas`, `panorama_operacao`, `ranking_vendedores`, `vendedores_abaixo_meta`, `divergencia_estoque`, `produtos_parados`) = recusa ("é do dono ou do gestor da rede"). *Mudança de comportamento intencional:* antes, esses usuários recebiam respostas da rede inteira pelo FalaTu.

**4) Continuidade (§13)** — "Por quê?" (o **Entender** da F2.5: períodos da loja + quem mais caiu, fato × hipótese, sem culpa), "E a Bangu?" (mesma ferramenta, outra loja), "E hoje?/ontem/semana/mês" (outro período). Chips "Por quê?" e "E ontem?" aparecem sob a última resposta continuável. Sem resposta anterior, passou 20 min, ou mudou de assunto → **não continua** (volta a tratar como pergunta nova); "Por quê?" sem loja na resposta anterior PERGUNTA de qual loja.

**Limites honestos:** a memória da conversa é **do processo** (por org+usuário, 20 min, nada gravado em banco — LGPD) — reiniciar o servidor a esquece; "Por quê?" só existe para respostas de LOJA (ferramentas com `store`: meta do dia, dinheiro do dia, vendas, metas abaixo da cota, estoque); briefings (manhã/16h/noite) **dentro** do FalaTu e continuidade a partir do briefing (§12–§13) NÃO entraram; a loja do contexto é escolhida no chip do FalaTu — as demais telas não a compartilham (não há "loja corrente" global no app).

## F2.9 — Medição do piloto (consentimento + relatório) e correção dos nomes de tela

- **Consentimento (LGPD §84):** `PUT/GET /api/ux/telemetry/enablement` (owner/admin) + toggle "Medir o uso do menu (piloto)" em Configurações → Módulos. **Nasce desligado**; desligada = no-op (nada entra no banco); desligar não apaga o já coletado.
- **Relatório do piloto:** `GET /api/ux/pilot-report?days=14` (`UxPilotReportService`) → painel "Como a equipe está usando o menu" em **Empresa** (só gestor). Estados honestos: `disabled` (nenhum número) · `no_data` · `low_sample` (<30 aberturas ou <2 pessoas: mostra, avisa) · `ok`. Mostra telas mais abertas, % de acessos pelo Explorar, % do Hoje que viraram clique, perguntas ao FalaTu (só contagem) e buscas sem resultado. **Mede abertura e clique, não valor** — o painel diz isso.
- **Correção de um defeito da F2.2:** a abertura de tela passou a usar o **nome da tela** (`viewMode`, o mesmo que o `LegacyReductionService` compara), registrada UMA vez no App; antes, o legado aberto pelo Explorar saía como `explorar` e o aviso de retirada podia mostrar "pronto para retirar" sem ver o uso do legado. As telas agora só registram **cliques** (`trackAction`); como o usuário chegou fica em `nav_primario`/`nav_explorar`. Nunca vai texto digitado (busca = "busca"; pergunta ao FalaTu = "geral/com_loja/continuacao"). Id de sessão aleatório por aba.
- **Roteiro de validação da TOULON:** `docs/runbook/fase2-piloto-toulon.md` (ligar, validar por papel em desktop e celular, ler o painel, decidir, voltar atrás).

## F2.10 — o briefing vira conversa
Depois que o briefing das 16h, da noite ou da manhã sai por WhatsApp, o dono pode responder "Por quê?" (explica a loja destacada) ou "E a Carioca?" (mesma pergunta, outra loja) — o contexto vale por 4h e só para quem recebeu a mensagem. Se nenhuma loja está comprovadamente abaixo da meta, o FalaTu pergunta de qual loja (nunca escolhe uma). Memória em processo: um restart do servidor apaga o contexto e o FalaTu volta a perguntar a loja. Teste: `npm run test:briefing-conversation`.

## F2.11 — barra "Pergunte ou procure"
Só com o menu simplificado ligado. Digite uma pergunta ("quanto vendi hoje?") e Enter envia ao FalaTu (abre "Conversar" já com a resposta); digite o nome de uma tela ou aba ("comissão", "escala", "estoque") e Enter abre — a aba certa da Operação da Rede quando for o caso. Contatos continuam na lista. Se o usuário não tem FalaTu, a opção Perguntar não aparece. Teste: `npm run test:command-bar`.
