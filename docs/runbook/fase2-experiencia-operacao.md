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
