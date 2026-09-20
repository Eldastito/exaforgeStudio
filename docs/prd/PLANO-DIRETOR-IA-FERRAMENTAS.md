# PLANO — Diretor IA com Ferramentas de Consulta Aterradas (F0)

**Origem** (20/09/2026, dono): "toda vez que o dono precisar de uma informação da base
de dados das lojas, eu vou ter que cadastrar aqui?" — hoje sim: o Diretor IA responde
só do PANORAMA fixo (texto pré-montado), e cada domínio novo de pergunta exige um bloco
novo em código (a fatia de vendas por loja, #1721/#1722, foi exatamente isso).

**Tese**: em vez de texto fixo, a IA ganha um CARDÁPIO de consultas prontas e seguras
(as mesmas funções que alimentam as telas) e escolhe qual executar conforme a pergunta.
Uma ferramenta "vendas por loja/período" responde centenas de variações ("ontem",
"semana passada", "setembro", "Carioca vs Grande Rio") sem código novo. Domínio de dado
totalmente novo ainda vira ferramenta — UMA vez, não por pergunta.

## Auditoria (o que existe — compor, não inventar)

- `chat()` (`llm.ts:145`) já tem modo `json:true`. **Não existe** function-calling no
  repo — e não vamos introduzir: a seleção de ferramenta é uma chamada `chat(json)`
  pequena (pergunta + cardápio → `{tool, args}`), padrão mais simples e testável.
- Precedente de "ferramenta de IA aterrada": ADR-180 F4 (`getAvailability`/`holdSlot`/
  `confirmBooking` — a IA nunca inventa vaga, só executa função real).
- Precedente de intent determinístico: `GestorCommandService.parse` (saldo/aprovações/
  etc. por regex, sem IA) — o roteador novo vem ANTES do LLM, mesma filosofia.
- Fontes de dado prontas (read-only, org-scoped): `RetailDashboardService`
  (daily/dailyInforme/monthly), `retail_daily_closings`/`retail_stores`/
  `retail_store_inventory`, `BusinessGoalService.progress`, `RetailCommissionService`,
  queries do Controller (caixa/a receber), `ExecutiveAdvisorService.retailStoresBlock`.
- Restrição de ambiente: OpenAI da org com **TPM 30k** — prompts têm que ser PEQUENOS.
  O desenho de 2 chamadas curtas (seleção + resposta final com só o resultado da
  ferramenta) respeita isso; o panorama gordo vira fallback, não caminho principal.

## Guardrails (RN-DIR — no header dos services + hardening F6)

1. **Ferramenta é código determinístico** — o modelo NUNCA gera SQL, só escolhe
   ferramenta e argumentos validados (datas, nome de loja com match determinístico).
2. **Org sempre da sessão** — argumento de organização não existe; cross-tenant é bug.
3. **Dinheiro por papel (§73)** — cada ferramenta declara `money:true/false`;
   `canSeeMoney:false` nem lista as ferramentas de dinheiro no cardápio.
4. **Sem ferramenta que responda → admite** ("não tenho esse dado") — nunca inventa,
   nunca "vou verificar com a equipe".
5. **Determinístico antes de LLM** — roteador por palavra-chave tenta casar ferramenta
   antes de gastar a chamada de seleção.
6. **Resposta final cita SÓ o resultado da ferramenta** (+ pergunta) — prompt pequeno,
   número vem do sistema, não da memória do modelo.
7. **Aditivo/0-regressão** — pergunta sem ferramenta cai no `ask()` atual (panorama);
   nada do fluxo de hoje muda de comportamento.

## Fatias (1 fatia = 1 PR)

| Fatia | Entrega | Estado |
|---|---|---|
| **F0** | Este plano | este doc |
| **F1** | `ExecutiveQueryToolsService`: registry + 4 ferramentas de VAREJO — `vendas_por_loja` (loja?/período: dia, faixa, mês; venda×cota→bateu/faltou, reusa a régua do #1722: pending/futuro nunca é venda) · `fechamentos_status` (pendentes/divergências por loja/dia) · `estoque_loja` (por loja/produto, `retail_store_inventory`) · `metas_progresso` (reusa `BusinessGoalService.progress`). Resolução determinística de nome de loja (normaliza acento/caixa, substring; ambíguo → pergunta de volta) e de período ("ontem"/"semana passada"/"setembro" → datas no fuso do negócio). Sem LLM nesta fatia — teste unitário puro (`test:diretor-tools`) | |
| **F2** | Roteador no `ExecutiveAdvisorService.ask`: (1) match determinístico por palavra-chave → (2) senão, `chat(json)` escolhe do cardápio (prompt pequeno) → (3) executa a ferramenta → (4) resposta final com `chat()` usando SÓ pergunta+resultado → (5) sem ferramenta → fluxo atual do panorama (0-regressão). Gate §73 aplicado no cardápio. `test:diretor-router` com LLM mockado (seleção certa, dinheiro invisível pra papel restrito, fallback honesto) | |
| **F3** | Mesmo roteador nos outros pontos de entrada do gestor: comando "Zapp" do orquestrador delega pergunta de CONSULTA pro mesmo `ask` (fonte única, sem 2º motor) + paridade Fala Tu/tela Diretor IA (já chamam `ask`, ganham de graça — teste de fiação) | |
| **F4** | +Ferramentas de mais domínios: `caixa_resumo` e `a_receber` (reusa as queries do Controller, owner/admin) · `comissao_estimada` (`RetailCommissionService`) · `catalogo_produto` (preço/estoque geral). Cada uma com gate de papel e teste | |
| **F5** | Lacunas viram guia: pergunta sem ferramenta registra `DIRETOR_QUERY_MISS` no audit (pergunta minimizada — sem telefone/CPF, padrão LGPD do help) + `GET /api/decision-intelligence/diretor-tools/gaps` (gestor) lista o que foi perguntado e não coberto — é o backlog REAL das próximas ferramentas, em vez de adivinhação | |
| **F6** | Hardening: `test:diretor-tools-hardening` codifica os RN-DIR como regressão (modelo nunca passa SQL · cross-tenant 404 · dinheiro gated · sem ferramenta → admite · prompts sob teto de chars · pending/futuro nunca vira venda) + atualização deste doc | |

**Fora de escopo (dizer não agora)**: ferramentas de ESCRITA (a IA continua não
executando nada por pergunta — execução segue governada pelos fluxos existentes);
SQL livre/geração de query pelo modelo (nunca); dashboard novo (as telas já existem —
isto é a via de PERGUNTA).

**Critério de sucesso**: "Zapp, como foram as vendas de ontem da Avenida Brasil?",
"e na semana passada?", "tem estoque da referência X na Carioca?", "quanto falta pra
meta do mês?" — respondidas com número do sistema, sem código novo entre uma pergunta
e outra; pergunta sem cobertura → resposta honesta + lacuna registrada.
