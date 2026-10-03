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
