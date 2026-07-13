# ADR-085 — Impact Ledger: valor operacional desde o dia 1 + prova de adoção (uso correto)

- **Status:** Proposto (decisão para ponderação; implementação em fases próprias)
- **Data:** 2026-07
- **Contexto de origem:** posicionamento do ZappFlow como "gestor de dados que ajuda o empresário a **não fechar**". Necessidade de **provar em R$**, desde o primeiro dia, o ganho gerado — e de **provar adoção** (que o cliente e a equipe usam as ferramentas do jeito certo), sem a qual não há resultado a atribuir.
- **Relacionadas:** RIC — Revenue Intelligence Center (`RevenueIntelligenceService`, `docs/PRD-REVENUE-INTELLIGENCE-CENTER.md`), ADR-084 (composição de capacidades / modo de estoque), ADR-083 (Retail Ops), ADR-082 (Continuity/offline).

## Contexto

O ZappFlow **já mede valor desde o dia 1** — mas só no eixo comercial. O RIC entrega hoje:

- **Relógio de auditoria de 14 dias** que começa quando a empresa **conecta o 1º canal** ("conecta → mede ao vivo", `getTrialStatus`);
- **Perda Estimada** ("potencial em risco") por fonte (resposta lenta, orçamento parado, abandono, inativo) = `count × probabilidade × ticket`;
- **Receita Recuperada** **atribuída** a ações do ZappFlow (lembrete de PIX, nudge de abandono, cadência), com **atribuição única por pedido** (anti-inflação);
- **ROI** = recuperado ÷ custo do plano; **snapshots diários** (`ric_daily_snapshots`) e série histórica;
- **Princípio de honestidade** embutido: conservador, premissa visível, "nunca inventa" — cada R$ rastreia a uma linha do banco do tenant.

**Duas lacunas** para cumprir a promessa completa:

1. **Valor operacional não é medido em R$.** "Menos dinheiro parado em estoque", "correções de operação", "economia" — a dimensão que o dono descreveu — não vira número. O RIC mede atendimento/comercial, não estoque/operação.
2. **Não há prova de adoção.** Não dá para afirmar honestamente "o ZappFlow gera resultado" sem medir se o empresário e a equipe **estão usando as ferramentas do jeito certo**. E, quando o resultado não vem, é preciso **distinguir "produto não entregou" de "cliente não usou"** — e apontar **onde** ele usa errado para **corrigir/orientar** (não punir).

## Decisões

### D1. **Estender o RIC** com um "Impact Ledger" — não criar sistema novo
O Impact Ledger é uma **camada aditiva** sobre o RIC, com a MESMA mecânica: **baseline no dia 0 → eventos auditáveis → acumulado**, e a MESMA guarda de honestidade. Reusa `ric_daily_snapshots`, o relógio do dia 1 e o padrão de atribuição já existente (`recoveredRevenue`, `ric_recovery_actions`).

### D2. **Baseline do dia 0** (o "desde o primeiro dia")
No onboarding, tirar um **retrato inicial** da operação — capital total em estoque (`Σ avg_cost × qtd`), itens sem giro, divergências abertas, pendências acumuladas — como marco zero contra o qual todo ganho é medido (antes → depois). Idempotente; um snapshot por org.

### D3. Categorias **operacionais** de valor (cada R$ rastreável a uma evidência)

| Categoria | Cálculo | Fonte do dado (já existe salvo indicado) | Tipo |
|---|---|---|---|
| Capital parado liberado | `avg_cost × qtd` de itens sem giro escoados | `inventory_items.avg_cost` + `stock_movements` | estimado |
| Estoque negativo corrigido | valor da divergência de saldo resolvida | `retail_stock_alerts` (resolvidos) | comprovado |
| Divergência de fechamento apurada | soma dos desvios de caixa detectados | `retail_daily_closings.variance_amount` | comprovado |
| Divergência de comissão corrigida | `divergence_amount` prévia × informado | `retail_commission_items` | comprovado |
| Tempo devolvido ao gestor | nº de ações automatizadas × tempo médio/tarefa | `retail_store_daily_tasks`, `messages` (bot), audit log | estimado |
| Perdas de perecível evitadas | itens perto do vencimento sinalizados a tempo | validade/lote (capacidade nova, ADR-084) | estimado |

### D4. Separação **inegociável** entre valor **comprovado** e **estimado**
Nunca somar os dois num único número inflado.
- **Comprovado** = dinheiro que mudou de mão ou divergência real apurada → pode virar manchete.
- **Estimado** = ruptura/perda evitada, capital liberado → sempre **com a premissa à vista** ("assumindo ticket X / margem Y").
Espelha o RIC ("potencial em risco" ≠ "recuperado") e o ADR-083 (a IA nunca inventa valor). É o que dá **credibilidade** ao número.

### D5. Camada de **ADOÇÃO / uso correto** — sinal determinístico, IA só narra
Um **Índice de Adoção** por organização, montado sobre **eventos determinísticos** (não sobre "achismo da IA):
- **Etapas de implantação cumpridas?** canal conectado, pack aplicado, lojas cadastradas, números de WhatsApp por loja, cotas lançadas, regras de comissão definidas (ADR-084/083).
- **Uso recorrente correto?** fechamentos chegando por loja/dia, equipe respondendo dentro do SLA, cobranças sendo respondidas, orçamentos não ficando parados, pendências sendo baixadas.
- **Antipadrões de uso** (onde ele erra): loja sem número → cobrança não sai; canal caindo; pack não aplicado → automações desligadas; cotas ausentes → sem desvio; gestor aprovando tudo sem conferir; etc.

**Papel da IA (opcional, econômico):** o sinal-base é 100% determinístico (barato, sem token). A IA entra **só para narrar em linguagem simples**, **priorizar a correção** e **gerar a mensagem de orientação** ("Percebi que a Loja Carioca não recebeu as cobranças porque falta o número de WhatsApp dela — quer cadastrar agora?"). Mesma filosofia do RIC: número determinístico, IA narra.

### D6. **Qualificação do resultado pela adoção** — a prova honesta
O painel cruza **Impact Ledger (valor realizado)** com **Índice de Adoção**, e mostra também o **valor deixado na mesa por não-uso** (ex.: "40 cobranças não enviadas por falta de número; ~R$X em fechamentos não conferidos"). A matriz de leitura:
- **Adoção alta + valor alto** → sucesso, provado.
- **Adoção baixa + valor baixo** → **explicado**: o resultado não veio porque as ferramentas não foram usadas — e o painel aponta **exatamente onde** (a lista de antipadrões de D5) para corrigir.
- **Adoção alta + valor baixo** → sinal para **nós**: é problema de produto/ajuste, não do cliente — investigar.

Isso responde diretamente "como provar que ele não teve resultado por não usar certo, e onde corrigir".

### D7. Guardas de honestidade e ética
- A IA de adoção **orienta, não pune**: tom de parceiro ("vamos destravar isso"), nunca de auditoria hostil. Objetivo declarado é o cliente **prosperar**, não "provar que a culpa é dele".
- Conservador por padrão; toda estimativa com premissa visível; **isolamento por `organization_id`** e auditoria (`logAuthEvent`); respeito à LGPD (sinais de uso agregados, sem exposição indevida de conteúdo de conversa).

### D8. Encaixe no ADR-084 (capacidade universal; funciona no modo supervisor)
Impact Ledger + Adoção são **capacidade universal** do modelo de composição: todo comércio ganha o eixo comercial (RIC); as **linhas operacionais acendem conforme as capacidades ativas** (estoque nativo → capital parado; Retail Network Ops → divergência de fechamento; perecível → perdas evitadas). Funciona no **modo supervisor** — a TOULON vê valor **antes** de migrar para o nativo ("resultado antes da migração" virando número).

## O que este ADR **não** decide (fica para ADRs de implementação)
- Esquema das tabelas do ledger (`impact_ledger_events`, baseline) e do índice de adoção.
- Fórmula exata do tempo médio por tarefa (para "tempo devolvido") e das premissas de cada categoria estimada.
- Pesos do Índice de Adoção e o catálogo final de antipadrões.
- Onde a IA narra (Diretor IA existente × novo card) e o gatilho de orientação proativa.

## Consequências

**Positivas**
- Prova de valor **em R$ desde o dia 1** nos dois eixos (comercial já existe; operacional é a extensão), reusando o motor do RIC.
- **Prova de adoção** que protege os dois lados: explica ausência de resultado por não-uso **e** flagra problema real de produto quando o uso está correto.
- Reduz churn: o mesmo painel que cobra virou o que **orienta** o cliente a prosperar.

**Trade-offs / riscos**
- Algumas categorias estimadas dependem de capacidades net-new do ADR-084 (perecível/validade) — entram quando a capacidade existir.
- O "tempo devolvido" e "capital liberado" são estimativas — exigem premissa transparente para não soarem infladas.
- A camada de adoção precisa de **muito cuidado de tom** — mal comunicada, parece que estamos "terceirizando a culpa" ao cliente.

## Guardas
- Comprovado nunca somado a estimado; toda estimativa com premissa visível.
- Sinal de adoção **determinístico**; IA só narra/prioriza/orienta (economia de token e confiança).
- Baseline do dia 0 idempotente; isolamento por `organization_id`; auditoria em toda ação.
