# ADR-064 — CampaignService + CadenceService — disparo em massa e follow-up

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit. Sem esses dois módulos, o SaaS vira "só atendente inteligente" e perde o ROI de reativação (base fria virando venda) e nurturing (lead morno virando cliente). Campanha faz o hotel/loja lembrar do cliente parado; cadência faz o cliente lembrar do orçamento aberto. Os dois entraram em produção sem ADR — este documento fecha a lacuna e amarra as regras anti-ban, anti-spam e de aprovação humana.

---

## Contexto

Dois problemas distintos, mesma superfície (WhatsApp):

- **Campanha** = disparo *one-shot* para um **segmento** calculado no momento (temperatura, tag, lead score mínimo, inativos há N dias, top compradores). Casos: black friday, promo de fim de mês, reativação de quem não compra há 90 dias.
- **Cadência** = **sequência** de N mensagens, espaçadas por horas, disparadas por **evento de ticket** (entrou no estágio `proposta`, `abandono`, `pos_venda`). Casos: 3 lembretes escalonados após envio de orçamento; nurturing pós-compra.

Restrições reais do WhatsApp Cloud/Evolution que os dois módulos precisam respeitar:

- **Ban por rajada** — envios paralelos ou em intervalo fixo derrubam o número. Precisa de *jitter* aleatório e uma campanha por vez por org.
- **Opt-out** (`contacts.marketing_opt_out`) — a mesma flag vale para os dois. Ignorar significa ganhar denúncia e cair no filtro.
- **Limite mensal do plano** (PlanService) — enviar sem *gating* é vender mais do que o plano cobre.
- **Aprovação humana quando a IA propõe** — o Zapp gestor não pode disparar campanha sozinho.

## Decisão

### CampaignService (`src/server/CampaignService.ts`)

- **Schema:** `campaigns` (status `draft`/`running`/`paused`/`completed`, `sent_count`, `failed_count`, `total_targets`) + `campaign_recipients` (materializados no ato da criação — `resolveSegment` roda **uma vez** e congela a lista, evita drift de segmento durante o envio).
- **Segmentação** em `resolveSegment`: `temperature`, `tag` (LIKE em `contacts.tags`), `minLeadScore` (clamp 0..100), `inactiveDays` (baseado em `last_purchase_at`), `topBuyers` (ordena por `total_spent`). Filtro base **sempre** aplica `marketing_opt_out = 0` e exige `identifier` válido.
- **Anti-ban:** `runLoop` roda em background com `delay` aleatório entre `CAMPAIGN_MIN_DELAY_MS` (4s) e `CAMPAIGN_MAX_DELAY_MS` (9s), limite diário `CAMPAIGN_DAILY_LIMIT` (300, pausa automática ao atingir), **uma campanha por org por vez** (`running: Set<orgId>`). Re-checa `marketing_opt_out` a cada destinatário (opt-out pode ter mudado depois da criação).
- **Personalização mínima:** `{nome}` → primeiro nome (fallback `"tudo bem"`) para tirar aparência de mensagem robótica em massa.
- **Integração com o Zapp gestor (aprovação humana):** o `AIOrchestratorService` **nunca** dispara direto. Quando o gestor pede uma campanha, o Orquestrador chama `resolveSegment` para preview, salva `pending_manager_actions` com `action_type = 'create_campaign'` e responde pedindo `SIM/NÃO`. O `SIM` cai em `executePendingAction` → `createCampaign` + `startCampaign`. Expiração de 1h no *pending* impede confirmação atrasada de virar disparo indevido (`AIOrchestratorService.ts:361, 904`).
- **Reuso pelo RIC:** `createCampaignForContacts` recebe lista explícita de `contactIds` (usado por `RevenueIntelligenceService.ts:654`), cria em **`draft`** e **não dispara** — exige revisão humana na UI. Cap de 500 IDs por vez.

### CadenceService (`src/server/CadenceService.ts`)

- **Schema:** `cadences` (com `trigger_stage`, `active`, `min_lead_score`) + `cadence_steps` (ordenados por `step_order`, `delay_hours`, `message`) + `contact_cadences` (instância viva: `current_step`, `next_send_at`, `status ∈ active/completed/cancelled`).
- **Gatilho:** `startForTicket(orgId, ticketId, contactId, stage)` chamado pelo `webhookProcessor` quando o AI muda estágio do ticket (`webhookProcessor.ts:443, 640`) e pelo `PaymentService` no pós-venda (`PaymentService.ts:390`). Cancela qualquer cadência ativa anterior do mesmo ticket antes de criar a nova (idempotente).
- **Gating por lead score:** `min_lead_score` na cadência — contatos abaixo do mínimo não entram. Evita queimar follow-up em lead frio.
- **Cancelamento automático:** `cancelForTicket` chamado quando o contato responde (`webhookProcessor.ts:227`) — regra sagrada do follow-up ("parou de perseguir quando responderam"). `touchContactMessage` atualiza timestamp de referência.
- **Scheduler:** `processTick(io)` roda de hora em hora pelo `Scheduler.ts:75`. JOIN em `contact_cadences` × `cadence_steps` filtra apenas `status='active' AND next_send_at <= now()`. Envia, calcula próximo `next_send_at` (ou marca `completed` se acabou), emite `cadence_followup_sent` via Socket.IO para a UI.

### O que **vale para os dois**

- Ambos usam `MessageProviderService.sendMessage` — mesma pilha de canal (Evolution/Cloud) e mesma trava de rate-limit downstream.
- Ambos respeitam `marketing_opt_out` no filtro inicial (campanha) e no gatilho (cadência não dispara para quem não tem identifier/canal).
- Ambos são **background** — nunca bloqueiam a request HTTP que os iniciou.

## Consequências

**Positivas:**
- Reativação e nurturing viram feature nativa do produto, não script manual.
- Aprovação humana no caminho do Zapp gestor (`SIM/NÃO`) elimina a classe de bugs "IA disparou campanha errada para 800 contatos".
- Materialização da lista no `createCampaign` torna o envio determinístico — a campanha envia para quem estava no público **naquele momento**, não para quem entrou depois.
- Cancelamento automático de cadência quando o contato responde evita o pior UX de follow-up (ser cobrado depois de já ter respondido).
- Throttle aleatório + limite diário + uma-por-org protegem o número do WhatsApp na base instalada atual.

**Trade-offs aceitos:**
- **Sem A/B teste** de mensagem — não dá para saber se a variante B converte mais. Aceitável enquanto o volume por org for pequeno (< 1k envios/mês); revisitar quando alguma org passar disso.
- **Sem otimização de horário por lead** — respeita apenas o `CAMPAIGN_DAILY_LIMIT` e o throttle, não aprende o melhor horário de cada contato. Um envio às 23h para quem só abre WhatsApp de manhã é jogado fora.
- **Sem tracking pixel / link encurtado com atribuição** — `sent_count` sabe que saiu, não sabe se foi lido/clicado. Métrica de conversão hoje depende do ticket que volta a se mover.
- **Sem janela de horário permitido** por org (ex: "só entre 9h e 21h") — o loop dispara 24/7 respeitando só o throttle. Se o gestor iniciar 2h da manhã, envia 2h da manhã.
- **Sem gating explícito por `PlanService.monthlyMessageLimit`** dentro do `runLoop` — o gating existe no envio unitário via `MessageProviderService`, mas a campanha não pré-checa se cabe no plano. Pode começar e ser cortada no meio.
- **`resolveSegment` congelado no create** — se um contato pedir opt-out **depois** da criação da campanha, o loop reconfere e pula, mas se um contato **novo** entrar no segmento no meio do envio, ele não recebe. Trade explícito em favor de determinismo.
- **`contact_cadences.next_send_at`** é calculado a partir do `Date.now()` do envio anterior, não do `last_contact_message_at` — reinício do processo pode atrasar follow-up em até 1h (granularidade do tick).

## Testes

**Cobertura direta hoje: nenhuma.** Não existe `scripts/test-campaign-service.ts` nem `scripts/test-cadence-service.ts`. O que temos é cobertura indireta:

- `scripts/test-ai-orchestrator.ts` — exercita o caminho `campaign_intent` → `pending_manager_actions` → `SIM` → `createCampaign` do lado do Zapp gestor.
- `scripts/test-plan-gating-autofill-alerts.ts` — toca no gating de plano que a campanha consome via `MessageProviderService`.

**Lacunas honestas** que deveriam existir:

- `resolveSegment` com cada combinação de filtro (`temperature`, `tag`, `minLeadScore`, `inactiveDays`, `topBuyers`) contra base fixture — hoje só é testado por inspeção manual.
- Throttle: fake do `MessageProviderService` medindo distribuição do delay entre `MIN` e `MAX`.
- `runLoop` respeitando pausa mid-flight (`UPDATE status='paused'` durante o envio) e limite diário.
- Cadência: `startForTicket` idempotente (chamar 2×  não duplica linha em `contact_cadences`), `cancelForTicket` quando o contato responde, `processTick` avançando `current_step` corretamente e marcando `completed` na última etapa.
- Cadência com `min_lead_score` filtrando corretamente.

Enquanto esses testes não existirem, qualquer mudança nos dois serviços exige revisão manual dos consumidores listados em `grep -rn 'CampaignService\.\|CadenceService\.' src/server`.
