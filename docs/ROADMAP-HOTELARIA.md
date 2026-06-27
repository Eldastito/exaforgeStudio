# Roadmap Estratégico — Vertical Hotelaria (1ª vertical)

> Decisão: **Hotelaria é a primeira vertical.** Menor caminho até cliente real e
> receita, maior reaproveitamento do que já existe, e o melhor campo para validar
> o **Diretor Executivo IA** com dados reais. Supermercado é a 2ª — só após validação.

## Posicionamento

> **ZappFlow Hotel AI** — o Diretor Executivo IA para hotéis, pousadas e espaços
> de eventos. Uma central inteligente para **encher a ocupação, recuperar
> oportunidades perdidas e melhorar o atendimento** do seu hotel.

## Por que Hotelaria primeiro (resumo da decisão)

- Já existe **piloto completo** no código (reservas estruturadas, eventos,
  orçamentos rastreáveis, concierge via RAG, recuperação, painel das 5 métricas).
- Dores claras e mensuráveis: ocupação, reservas, eventos, atendimento, recuperação.
- O Diretor IA gera valor rápido e dá pra **demonstrar em 1 semana de uso**.
- **Pouca dependência de ERP/PDV** (ao contrário de supermercado).

## O que já está pronto (reaproveitado)

Reservas estruturadas · Eventos & Grupos (pipeline) · Orçamentos rastreáveis +
follow-up · Concierge (RAG) · Recuperação (cadências, carrinho/orçamento, PIX
progressivo, NPS, indicação) · Conector PMS genérico (planilha + webhook) ·
Quick-Start de Hotelaria · Painel das 5 métricas do piloto.

## Entregue agora (este tijolo)

- **Diretor Executivo IA verticalizado p/ hotelaria**: fala ocupação, reservas,
  eventos, no-show, recuperação; e cruza dados reais de reservas + pipeline de
  eventos + orçamentos no panorama.
- **Fundação de Skills** (`SkillRegistry` + `/api/skills`): cada módulo vira uma
  capacidade instalável; base para a "Loja de Skills".

## Próximos passos (priorizados)

1. **Loja de Skills (UI)** — catálogo visual instalável (usa `/api/skills`), com
   skills recomendadas da vertical em destaque.
2. **Métricas hoteleiras no Diretor** — RevPAR/ocupação % reais (precisa do total
   de quartos/capacidade cadastrado por recurso) e taxa de no-show.
3. **Concierge proativo** — lembrete pré-estadia (check-in/transfer/pet) via cadência.
4. **Adaptador PMS real** — quando o 1º hotel disser qual PMS usa, plugar no
   conector genérico que já existe.
5. **Demo comercial** — roteiro de 1 semana mostrando o Diretor + recuperação.

## Métricas de validação (o que provar com o 1º hotel)

- Tempo de 1ª resposta ↓ · % de orçamentos recuperados ↑ · consultas de evento
  convertidas ↑ · ocupação influenciada por recuperação · NPS pós-estadia.

## Depois da validação

Supermercado como 2ª vertical — **gate**: ter o conector ERP/PDV e regras por
loja/região (já mapeado em `docs/READINESS-VERTICAIS.md`).
