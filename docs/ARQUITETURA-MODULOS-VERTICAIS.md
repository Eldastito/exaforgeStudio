# Arquitetura de Módulos Verticais + Gestor Supremo

> Plano para evoluir o ZappFlow de "um produto que serve vários nichos" para
> "um núcleo + módulos verticais especializados" (hotel, mercado, saúde…), com um
> **Gestor Supremo** para redes/franquias. Minha recomendação de sequência no fim.

## O que já existe (não reinventar)

O esqueleto modular já está pronto:
- **`src/server/verticals.ts`** — catálogo de verticais → presets de **módulos opcionais**.
- **`ModuleService`** — gating por organização (`enabled_modules`), aplica o preset da
  vertical no onboarding (`applyVertical`) e bloqueia rota/UI de módulo desligado.
- **Módulos opcionais atuais:** `agenda, catalogo, vendas, loja, pagamentos,
  campanhas, cadencias, areas, integracoes, reservas, assinaturas`.
- **Agente "Zapp" gestor** (orchestrator) + `BusinessContextService` (panorama).

➡️ A evolução é **adicionar módulos verticais "ricos"** sobre esse backbone e um
nível de **multi-unidade** (rede) por cima — não trocar a fundação.

## Modelo proposto

```
NÚCLEO (core, sempre on): atendimento, contatos, relatórios, configurações,
  IA/RAG, CRM/funil, omnicanal, handoff, pagamentos
        │
        ├── Módulos HORIZONTAIS opcionais (já existem): agenda, vendas, loja,
        │     reservas, campanhas, cadências, áreas, assinaturas, integrações
        │
        └── Módulos VERTICAIS (novos — bundles + lógica específica):
              • Hotelaria   → reservas avançadas, eventos/grupos, concierge, receita
              • Mercado     → catálogo por loja, pedido, entrega por região, ERP/PDV
              • Saúde/Clínica → triagem, agendamento, lembrete de exame, especialidades
              • (futuros: educação, food, serviços já parcialmente cobertos)
        │
        └── GESTOR SUPREMO (multi-unidade): consolida N unidades/orgs de uma rede —
              métricas comparadas, ranking, alertas, e o agente gestor multi-unidade
```

### Como um módulo vertical se difere de um horizontal
Um módulo vertical **compõe** módulos horizontais + adiciona: (a) campos/fluxos
próprios (ex.: hóspedes/crianças/pet na reserva), (b) intents específicos no
orquestrador, (c) métricas próprias, (d) trava de segurança do nicho. Tudo
**opt-in** e **aditivo** (mesma estratégia de migração que já usamos).

## Gestor Supremo (rede/franquia)

Para grupos com várias unidades (ex.: rede hoteleira, rede de mercados):
- **Hierarquia de organização**: unidades (orgs filhas) sob um grupo (org-mãe).
- **Painel consolidado**: KPIs por unidade lado a lado, ranking, alertas (unidade
  com 1ª resposta lenta, queda de conversão, NPS caindo).
- **Agente gestor multi-unidade**: o "Zapp" responde "como foi a unidade X vs Y?",
  "qual unidade está perdendo mais reserva?".
- **Padronização**: empurrar base de conhecimento/políticas/cadências para todas as
  unidades de uma vez.

> É o argumento de venda para **redes** (Louvre/Tulip, Hotelaria Brasil): controle
> e comparabilidade entre unidades. Faz mais sentido **depois** de 1–2 unidades
> rodando bem.

## Roadmap recomendado (sequência)

**Fase A — Hotelaria (começar aqui; GTM viva).**
1. ✅ *Em andamento neste PR:* captura estruturada da reserva (adultos, crianças,
   pet, pedidos especiais, orçamento).
2. Painel de métricas hoteleiras + **orçamento como objeto rastreável**
   (enviado/aceito/recusado, com follow-up).
3. Pipeline de **Eventos & Grupos** (qualificação consultiva).

**Fase B — Conector de integração genérico.**
4. Camada de integração reutilizável (HTTP/webhook + planilha/CSV) para
   disponibilidade/preço (PMS) e estoque/preço (ERP/PDV). Mesma base serve hotel e
   mercado — é o gap nº 1 para sair do piloto.

**Fase C — Mercado.**
5. Catálogo/preço por loja, entrega por região/raio, ofertas por bairro — sobre o
   conector da Fase B.

**Fase D — Gestor Supremo.**
6. Multi-unidade (org-mãe/filhas) + painel consolidado + agente gestor multi-unidade.

**Fase E — Saúde/Hospital e canais (telefone/OTAs).**
7. Triagem/filas/especialidades + LGPD saúde; módulo de Voz (já planejado) e OTAs.

## Princípios de execução

- **Aditivo e opt-in** sempre (migrações idempotentes; nada quebra para quem já usa).
- **Reusar o backbone** (`verticals.ts` + `ModuleService`) em vez de criar paralelo.
- **Segurança do nicho**: a IA nunca inventa preço/disponibilidade/estoque/regra —
  confirma na fonte (integração) ou aciona humano.
- **Entregar por tijolos pequenos e testáveis**, cada um com valor isolado.

## Por que começar pela Hotelaria (decisão)

1. Há **GTM real e imediata** (piloto de 60 dias em hotel-fazenda/resort).
2. A **readiness já está em ~80%** — ROI rápido.
3. Ela **exercita o padrão de módulo vertical** (reserva estruturada, eventos,
   métricas) que depois replicamos em mercado e saúde.
4. O **conector de integração** (Fase B) que a hotelaria exige é o mesmo que
   destrava mercado — então a ordem hotel→conector→mercado reaproveita trabalho.
