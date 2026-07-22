# ADR-126 — Central de Saúde e Decisão (síntese: status + 3 prioridades do dia)

- **Status:** Em implementação. Fatia 1 (status determinístico + top-3 prioridades, só leitura, tela Central de Saúde) entregue. Fatia 2 (aplicar + histórico) e Fatia 3 (modo Tutor/Gestor + narrativa) pendentes.
- **Data:** 2026-07
- **Origem:** PRD "Central de Sobrevivência e Decisão" — Épico 1. Princípio: "menos dashboard, mais decisão". O dono tem dados espalhados (RIE, perdas, caixa, recebíveis), mas não uma tela que diga **o que mudou, por que importa e o que fazer primeiro** — e que **meça o resultado**.
- **Relacionadas:** ADR-125 (Motor de Caixa — ruptura, dias de sobrevivência, Impact Ledger), RIE/IQR (RevenueIntelligenceService — perda estimada, top ações), ADR-114 (margem de perda — diagnóstico por driver), Caderneta/fiado (a receber), Diretor Executivo IA (narrativa opcional), ADR-091 §6 (IA sugere, humano decide), ADR-088 D5 (frugalidade).

## Contexto

Depois do Motor de Caixa (ADR-125), o ZappFlow tem os **sinais** que faltavam. Mas sinal espalhado em várias telas não vira decisão. A Central de Saúde é a **camada de síntese** (não recalcula nada): lê os sinais que já existem, decide o **status geral** por regra determinística, e destila **no máximo 3 prioridades do dia** — cada uma com **impacto em R$** e **uma ação executável**. É a tela-início proposta pelo PRD, a principal interface com a IA gerencial.

Este ADR NÃO cria métricas novas: orquestra as que já temos. O placar composto 0-100 (Índice de Sobrevivência) fica para um ADR seguinte; aqui o status é uma regra simples e transparente.

## Decisões

### D1 — Status geral por REGRA determinística (não texto livre da IA)
O status (`saudavel | atencao | risco | critico`) é calculado por regra explícita e auditável (PRD §26.1.2), nunca por texto da IA:
- **crítico:** caixa já negativo, OU ruptura de caixa prevista em ≤ 2 semanas.
- **risco:** ruptura prevista no horizonte de 13 semanas, OU perda acima da margem aceitável (ADR-114), OU perda estimada do RIE relevante vs. faturamento.
- **atenção:** algum sinal fora da faixa (dias de sobrevivência curtos, recebíveis vencidos altos, IQR baixo) sem gatilho de risco.
- **saudável:** nenhum gatilho ativo.
A regra expõe **quais gatilhos** dispararam (transparência).

### D2 — No máximo 3 prioridades/dia, cada uma com R$ e ação (PRD §8, §26.1.3)
`BusinessHealthService.priorities(orgId)` coleta candidatos de cada fonte, cada um com **impacto estimado em R$** e **origem**, ordena por impacto e devolve o **top 3**:
- **Caixa (ADR-125):** ruptura prevista → impacto = rombo; ação = abrir o Plano de Caixa.
- **Recebíveis/fiado:** vencidos/em aberto altos → impacto = valor; ação = cobrar (Caderneta).
- **Perda (ADR-114):** driver dominante acima da meta → impacto = perda do mês; ação = ver diagnóstico/plano.
- **RIE:** perda estimada recuperável → impacto = IRR; ação = criar ação de recuperação (rascunho).
Só entram candidatos **ancorados em dado real**; cada prioridade indica se o número é **fato** ou **estimativa** (PRD §21).

### D3 — Explicação em blocos: fato → interpretação → risco → ação (PRD §26.1.6)
Cada prioridade traz o **fato** (número da fonte), a **interpretação** curta, o **risco** se ignorar e a **ação**. Frugal: textos são template (zero-token); a narrativa executiva rica continua no Diretor IA (opcional, sob demanda).

### D4 — Toda prioridade termina em ação medida (liga no Impact Ledger)
A ação de uma prioridade reusa o que já existe (Plano de Caixa/`cash_actions` da ADR-125, cobrança da Caderneta, recuperação do RIE, tarefas). O **resultado** é medido pelo Impact Ledger já criado na ADR-125 (esperado × realizado), que evolui para abranger todas as origens.

### D5 — Frugal e multi-tenant
Síntese 100% determinística (zero-token); isolamento por `organization_id`; a Central só **lê** os serviços existentes — não duplica cálculo nem dado.

## Escopo (faseamento)

- **Fatia 1 — Status + 3 prioridades (só leitura):** `BusinessHealthService.status()` (regra D1 + gatilhos) e `priorities()` (top-3 com R$, origem, fato/estimativa, ação-alvo). Nova tela **Central de Saúde** (candidata a home): status colorido, frase-síntese, 3 cards de prioridade com botão que **leva à ação** (navega para Caixa/Caderneta/RIE). `test:business-health`.
- **Fatia 2 — Aplicar + histórico:** botão "Aplicar" cria a ação (tarefa/cobrança/plano) e o **histórico de recomendações** (aceita/ignorada/concluída + resultado), unificando o Impact Ledger.
- **Fatia 3 — Modo Tutor/Gestor + narrativa:** explicação progressiva (iniciante × avançado), narrativa via Diretor IA sob demanda, checklist de qualidade dos dados.
- **ADRs seguintes:** Índice de Sobrevivência 0-100; DRE gerencial; Empresa × Proprietário.

## Consequências
**Positivas:** transforma sinais dispersos em decisão diária ("o que fazer primeiro"); reusa 100% do que já existe (caixa, RIE, perdas, recebíveis); determinístico e testável; base para virar a home e para o Índice de Sobrevivência.

**Trade-offs / riscos:** risco de "mais um dashboard" → mitigado pelo teto de 3 prioridades e por toda prioridade terminar em ação; status por regra pode simplificar demais → gatilhos ficam **explícitos** e o Índice 0-100 refina depois; dados incompletos → cada prioridade marca fato × estimativa e a Fatia 3 traz o checklist de qualidade.

## Guardas
- Status por **regra determinística** transparente (nunca texto livre da IA).
- Máx. **3 prioridades/dia**, cada uma com impacto em R$ e ação; fato × estimativa sempre marcados.
- IA sugere, humano decide (ADR-091 §6); resultado rastreável (Impact Ledger).
- Frugal (zero-token) e isolado por `organization_id`; a Central só lê, não recalcula.

## Testes
- `test:business-health` — regra de status por gatilho (crítico com ruptura ≤2 semanas; saudável sem gatilho); top-3 priorizado por R$; cada prioridade tem ação e marca fato/estimativa; isolamento por org; org vazia sem falso alarme.
