# ADR-043 — Batch: SLA por prioridade/segmento, EAN por foto, CRM da consultoria do Radar, Google Sheets live sync

**Status:** Implementado.

**Origem:** Continuação do backlog pós-ADR-042. Quatro itens que o dono aprovou delegando as decisões de produto ao time técnico ("faça o que for melhor para o lojista"). Cada um resolve uma lacuna concreta identificada em pesquisa no código real.

---

## 1. SLA de primeira resposta por prioridade e segmento (VIP)

**Problema:** o SLA existente (ADR-026, "SLA por canal") é read-time, agregado no IVC e keyed só por canal — não há promessa acionável por ticket nem alerta quando um atendimento vai estourar.

**Decisão:** estender a régua para **prioridade** (`tickets.priority`, que já existe: baixa/média/alta) e **segmento**, derivando VIP do valor do cliente (`contacts.total_spent >= sla_vip_min_spent`). Regra de resolução: a meta efetiva é a **mais apertada** entre a meta da prioridade e — se VIP — a meta VIP (um VIP com prioridade alta recebe a promessa mais rápida das duas, nunca a mais frouxa).

- Config em `organization_settings` (opt-in: `sla_monitor_enabled = 0` por padrão): `sla_priority_{alta,media,baixa}_seconds` (defaults 30min/4h/24h), `sla_vip_seconds` (15min), `sla_vip_min_spent` (R$ 1000; 0 desliga a distinção VIP).
- Serviço determinístico `TicketSlaService` (nunca IA decide a régua). Monitor no **passe rápido do Scheduler (5 min)** — uma meta de 30 min não pode ser vigiada de hora em hora. Persiste `sla_due_at/sla_breached/sla_first_response_at/sla_segment` por ticket e notifica o responsável **uma vez** no 1º estouro sem resposta (dedupe por ticket, 24h).
- Primeira resposta é derivada das mensagens (`sender_type` contact vs bot/agent), mesmo padrão do ConversionVelocityService — sem tocar nos caminhos de envio.
- UI: selo de SLA (estourado/em risco) e VIP no card do Kanban, filtro "SLA em risco", e painel de configuração das metas. O estado do selo é recalculado **ao vivo** no `GET /api/tickets` (não depende do último tick).

## 2. Detecção de código de barras (EAN) por foto

**Problema:** a coluna `ean` (ADR anterior) só era preenchida via XML de NF-e ou manualmente. A foto de produto do Smart Scan não lia o código de barras.

**Decisão:** estender o prompt de visão (`extractProductFromImage`) para também devolver `ean`, **validando com o dígito verificador GTIN** (`eanUtil.isValidGtin`, vale GTIN-8/UPC-A/EAN-13/GTIN-14) antes de aceitar. A IA de visão (gpt-4o) não transcreve dígitos com exatidão garantida; o checksum rejeita quase toda leitura errada. **Um EAN errado é pior que EAN ausente** — então só autopreenchemos o que "fecha". Sem biblioteca nova de barcode.

- Fluxo web (Smart Scan) e conversacional (WhatsApp) carregam o EAN validado até o INSERT do produto. No WhatsApp, um EAN válido também vira **match exato** de catálogo (mais confiável que a similaridade de nome).

## 3. CRM da solicitação de consultoria do Radar

**Problema:** o `request-consultation` (do PR anterior) salvava o pedido numa tabela que ninguém lia — sem notificação, sem tarefa, score não anexado ao lead.

**Decisão:** quando há organização de destino (`RADAR_LEADS_ORGANIZATION_ID`, o funil da própria ZappFlow), a solicitação agora **cria uma tarefa de follow-up** (prioridade alta, com score/maturidade/contato/mensagem no corpo) e **notifica o consultor**; a linha é vinculada à org (`organization_id`, `task_id`). Rotas autenticadas `GET/PATCH /api/radar/consultation-requests` e painel no RadarView deixam o consultor **ver e tratar** (pending → contacted → closed). Isolado por tenant.

## 4. Google Sheets live sync

**Problema:** só existia export one-shot e um log append-only de pedidos que **nunca reflete mudança de status**.

**Decisão:** um **painel vivo** (planilha com abas Vendas/Estoque/Resumo) que o Scheduler **reescreve de hora em hora** com o estado atual — pedidos com status/pagamento correntes, níveis de estoque e KPIs de 30 dias. Novos helpers `sheetsCreateWithTabs`/`sheetsReplaceTab` (limpa + grava, não append) no GoogleOAuthService; escopo Sheets já autorizado na conexão. Opt-in (`google_sync_enabled`), com toggle e "Sincronizar agora" na tela de Integrações. Best-effort — uma conexão Google expirada não derruba as demais orgs.

---

## Alternativas descartadas

- **Biblioteca de barcode (zxing/quagga):** decodificação nativa de foto arbitrária é frágil em Node e não garante precisão; o par visão-IA + checksum entrega precisão alta sem dependência nova.
- **SLA num modelo de segmentação novo por ticket:** reaproveitar `priority` (já existe) + valor do cliente evita inventar um esquema de segmentos pesado.
- **Sheets sync via append (como o log de pedidos):** não reflete status; o clear+write espelha o estado real, que é o que dá valor de dashboard.

## Testes

`scripts/test-sla-barcode-consult-sheets.ts` — 59 verificações (checksum EAN, buildLiveSheetData, consultoria CRM com tarefa/notificação/listagem/isolamento, resolução e monitor de SLA). Regressão completa nas suítes de Radar, inventário, isolamento e velocidade de conversão sem quebras.
