# Runbook — Piloto do Mission OS (ADR-189)

Como rodar o **primeiro piloto real** do Mission Layer numa org, com dado de verdade, do "ligar"
ao "medir resultado", de forma reversível e sem risco pra base existente.

> Pré-requisitos: a org tem canal conectado (WhatsApp) e algum histórico (pedidos/contatos) — o plano
> reverso deriva ticket médio e base desses dados. Sem eles, o plano fica honesto (`premissa faltante`)
> e o próximo passo vira "registre a premissa", nunca um número inventado.

## 0. Princípios (não violar)

- **Opt-in / reversível.** Tudo atrás de `mission_layer_enabled` (default OFF). Desligar NUNCA apaga
  missões — só some da navegação (histórico preservado, convenção nº 9).
- **Shadow-first.** Nenhuma missão nasce em autopilot; autonomia sobe só com evidência.
- **Resultado ≠ execução.** Uma missão só é "Concluída" quando o critério de NEGÓCIO é confirmado
  (Outcome Assurance) — nunca porque "a ação foi enviada".
- **Nunca inventa.** Sem dado, o sistema é honesto (`premissa faltante`, `—`), não fabrica número.

## 1. Ligar o Mission Layer (habilitação)

A rota de habilitação fica **antes** do gate da flag (senão o dono nunca alcançaria a rota) — owner/admin:

```
GET  /api/missions/enablement        → { enabled, proactiveMode, missionCount }
PUT  /api/missions/enablement        { "enabled": true }   → liga o piloto
```

Depois de ligado, o item **"Missões"** aparece na navegação (funde com "Executando", net-zero — §25).

## 2. Rodar o ciclo (o que o operador faz)

1. **Declarar o objetivo** — cria a missão (ex.: *"atingir R$ 30 mil de faturamento no mês"*), com
   métrica-alvo (`revenue`/`appointments`) + valor + prazo. Ou deixe o ZapFlow **propor** a partir de
   um objetivo em texto (`POST /api/missions/intent`) ou dos sinais do negócio (Proactive, shadow).
2. **Plano** — botão *Plano*: o plano reverso mostra a cadeia (receita → vendas → oportunidades →
   contatos), o **gargalo** (caminho crítico) e o **último momento seguro** pra começar.
3. **Prontidão** — botão *Prontidão*: canal/dados/risco antecedente (Pre-Mortem light). Verde = pode ir.
4. **Próximo passo** — botão *"O que eu faço agora?"*: deriva do gargalo uma alavanca **governada**
   (campanha, ou "registre a premissa"), aterrada só em comando que existe. *Propor ação (governada)*
   encaminha pra aprovação — **nunca executa direto**; com autonomia `off`, orienta a ligá-la.
5. **Aprovar** — a ação proposta aparece como pendência (Smart Inbox / aprovações). O dono aprova; o
   executor governado dispara o efeito real e arma a confirmação.
6. **Trajetória** — botão *Trajetória*: planejado × realizado × tempo → `on_track`/`at_risk`/`off_track`.
   O passe horário do Scheduler publica sinal `mission/at_risk` quando desvia (self-healing ao voltar).
7. **Concluir + aprender** — quando o resultado de NEGÓCIO confirma, a missão vira *Concluída*; o
   *Debrief* resume as lições e alimenta o **motor único** (`PatternMemory`) — só `achieved` ensina forte.

## 3. Critério de sucesso do piloto

O operador expressa UM objetivo e, sem depender de conhecimento técnico, chega a:
resultado observável (meta medida) **ou** uma trajetória honesta com o gargalo e o próximo passo claros —
com toda ação passando pela governança (aprovação/Autonomy Contract) e **nenhum** número inventado.

## 4. Rollback

`PUT /api/missions/enablement { "enabled": false }` — o item some da navegação; as missões e o
histórico ficam intactos. Religar retoma exatamente de onde parou. Zero migração, zero perda.

## 5. Mapa técnico

| Etapa | Serviço | Rota |
| --- | --- | --- |
| Habilitação | `MissionService.setEnabled/settings` | `GET/PUT /api/missions/enablement` |
| Contrato | `MissionService` | `/api/missions` (CRUD) |
| Intenção→Missão | `MissionIntentService` | `POST /api/missions/intent` |
| Plano reverso | `MissionReversePlanner` | `POST /api/missions/:id/plan` |
| Prontidão | `MissionReadinessService` | `POST /api/missions/:id/readiness` |
| Próximo passo | `MissionNextStepService` | `POST /api/missions/:id/next-step[/propose]` |
| Execução governada | `MissionRuntimeService` → DecisionAction→ApprovalPolicy→CommandExecutor | `POST /api/missions/:id/actions` |
| Trajetória | `MissionCheckpointService` | `GET /api/missions/:id/checkpoint` |
| Debrief + aprendizado | `MissionDebriefService` → `PatternMemoryService` | `GET /api/missions/:id/debrief` · `POST /learn` |
| Proativa (shadow) | `MissionProactiveService` | `/api/missions/proactive/*` |

Testes: `test:mission-*` (contract/intent/reverse-plan/readiness/runtime/checkpoint/next-step/home/nav/
legacy-reduction/debrief/proactive/enablement/golden-path/hardening). Guardrails RN-MOL em `test:mission-hardening`.
