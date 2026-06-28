# PRD — Revenue Intelligence Center (RIC)

> Produto enterprise de entrada (land & expand) do ZappFlow. Não vende "automação";
> entra mostrando, com metodologia transparente, **onde a empresa tem receita em
> risco, quanto pode recuperar e quais ações têm maior retorno** — e depois executa.
>
> Esta é a **linha de congelamento de escopo**: o MVP abaixo é fechado. Ideias novas
> entram na seção "Fora do MVP", não no MVP.

## Reposicionamento

O ZappFlow evolui de "Sistema Operacional Empresarial" para **Revenue Intelligence
Operating System** — quase todo módulo passa a responder à pergunta do CEO:
**"Onde estamos deixando dinheiro na mesa?"**

## Filtro de produto (vai para o Manifesto)

Toda funcionalidade deve responder a **pelo menos uma** destas 4 perguntas — senão,
provavelmente não deveria existir:
1. Onde a empresa **perde** dinheiro?
2. Onde ela pode **ganhar mais**?
3. O que **priorizar hoje**?
4. O que a IA consegue **executar automaticamente**?

## A verdade do esforço: 80% de infra ≠ 80% de produto

- **~80% da INFRAESTRUTURA** existe (Analytics, Orquestrador, BusinessContext, CRM,
  recuperação, Diretor IA). É o **motor**.
- **~30% do PRODUTO** existe. O que falta é a **camada de produto** que cria valor
  percebido e justifica ticket alto: metodologia financeira transparente, narrativa
  executiva, dashboards, simulador, relatório/PDF, UX e posicionamento.
> O foco do RIC é construir essa **camada de produto** sobre o motor existente.

## Índices (consolidados — disciplina anti-sopa-de-letrinhas)

Um CEO não acompanha 8 siglas. O RIC usa **um índice mestre + 3 drivers + 2 números
de dinheiro**, cada um **composição transparente** de métricas que já calculamos:

- **IQR — Índice de Qualidade da Receita** (mestre, 0–100): rolagem ponderada dos 3 drivers.
- Drivers (o que derruba o IQR):
  - **Atendimento** — 1ª resposta, sem-resposta, abandono, follow-up atrasado.
  - **Comercial** — conversão, orçamentos parados, leads sem retorno.
  - **Operacional** — carga por operador, horários críticos, canais congestionados.
- Números de dinheiro:
  - **IRR — Receita Recuperável**: da perda estimada, quanto ainda tem alta chance.
  - **RRI — Receita Recuperada**: quanto o ZappFlow **efetivamente** recuperou (nosso moat).

Regra: **não criar índice que não conseguimos popular** com dado real. Cada um abre
o "porquê" (ex.: "IQR caiu 6 pts porque Atendimento caiu — 1ª resposta subiu").

## Engine financeira (defensável > grande)

`Perda estimada = leads impactados × probabilidade de perda × ticket médio`
- Com orçamento real → usa o valor real; senão → ticket médio histórico.
- **Fórmula configurável por empresa** e **sempre rotulada como "potencial em risco"**,
  com a premissa visível. Número inflado mata a venda na diretoria.

## RRI — o diferencial ownable

A maioria audita; **só nós executamos a recuperação** (carrinho/orçamento abandonado,
follow-up, PIX progressivo, reativação, NPS — já em produção). Por isso o RIC mede e
**recupera**, e atribui a receita recuperada às ações do ZappFlow (atribuição por
janela: lead parado → ação nossa → resposta/compra no período). Vira a prova de ROI
recorrente que renova contrato.

## Revenue Digital Twin (simulador) — com guardrail de credibilidade

Simula impacto de decisões ("se responder em 5 min → +X% conversão → +R$Y/ano").
- **Regra de ouro:** quando houver dado, simular a partir da **curva histórica do
  próprio cliente** (conversão × tempo de resposta). Sem dado suficiente, mostrar um
  **cenário com premissas EDITÁVEIS e rotuladas** — nunca um número "duro" como
  certeza. Simulação empilha suposições; honestidade aqui protege a marca.

## Diretor Executivo IA (já existe) é a interface

Responde: "Quanto perdemos? Quanto dá pra recuperar? Quem precisa de ajuda? O que
faço hoje?" — usando os índices/numeros determinísticos (IA narra, não inventa).

## Como os dados treinam as IAs (sem fine-tuning)

1. **Calibra pesos** da probabilidade de perda/lead score por vertical (estatística
   sobre resultados reais, agregada).
2. **Playbooks de melhor-ação**: qual sequência recupera mais → o Orquestrador passa
   a recomendar a ação de maior taxa histórica.
3. **Priors/benchmark** anonimizados e **opt-in**, só com escala (resolve cold-start
   de cliente novo). Nunca conversa crua saindo do tenant (amarrado à LGPD/cripto/isolamento).

## MVP (escopo CONGELADO)

Canal: **WhatsApp** + CRM. Entregáveis:
1. Coleta/medição (já temos): 1ª resposta, sem-resposta, follow-up, conversão, AOV,
   motivos de perda, abandono, orçamentos.
2. **IQR + 3 drivers** (composição transparente).
3. **Perda estimada** (fórmula configurável, conservadora).
4. **IRR** (recuperável) e **RRI** (recuperado, dos nossos fluxos).
5. **Relatório de Auditoria** (10 seções) **exportável em PDF** + **plano 30/60/90**.
6. **Simulador leve** (1–2 alavancas: tempo de resposta, follow-up) com premissas editáveis.
7. **Diretor IA** já responde sobre tudo isso.
8. GTM: **auditoria-trial de 14 dias** (conecta, mede ao vivo, entrega o relatório).

## Fora do MVP (fases 2/3 — não construir agora)

Telefonia/multicanal (Instagram, e-mail, VoIP), benchmark Brasil (precisa escala +
anonimização), gamificação/ranking, predição/churn por ML, IRO/IRP e simulações
complexas, auditoria retroativa de 90 dias (precisa importar histórico).

## Disciplina

Este PRD **fecha o MVP**. Honrando o "congelar ideias": novas ideias vão para "Fora
do MVP" e só entram após o RIC MVP rodar com **1 cliente real** (Hotelaria).
