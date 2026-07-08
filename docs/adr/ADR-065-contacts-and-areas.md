# ADR-065 — Contatos e Áreas de atendimento — dedup e roteamento por persona

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit de duas decisões que já rodam em produção há meses e nunca foram documentadas: (a) como o webhook identifica que "isto é o mesmo contato de antes" e (b) como uma organização com várias frentes de atendimento (Vendas / Suporte / Cobrança) divide um único número de WhatsApp entre elas sem que a IA prometa transferências que nunca acontecem. Os dois assuntos são inseparáveis porque a área "mora" no ticket, o ticket "mora" no contato, e o contato só existe porque o webhook decidiu dedupar.

---

## Contexto

**Contatos.** Toda mensagem que entra em `webhookProcessor.ts` gera ou atualiza uma linha em `contacts` (`src/server/db.ts:35`). O schema é enxuto no núcleo (`id`, `organization_id`, `channel_id`, `name`, `identifier`, `profile_pic_url`) mas foi crescendo por `ALTER TABLE` até virar o coração do CRM: `lead_temperature`, `lead_score`, `tags` (CSV livre), `notes`, `purchase_count`, `total_spent`, `avg_ticket`, `last_contact_at`, `last_purchase_at`, `marketing_opt_out`, `memory_facts`/`memory_summary` (ADR de memória), `ai_purchase_probability` / `ai_funnel_stage` / `ai_next_step` (análise de vendas), `is_supplier` / `supplier_categories`, `referred_by_contact_id`, `anonymized_at` (LGPD). Um contato é hoje o *dossier* do cliente na organização.

**Dedup.** A chave é `UNIQUE(organization_id, channel_id, identifier)` (`db.ts:44`). Em `webhookProcessor.ts:172` o lookup é literal — `WHERE organization_id = ? AND channel_id = ? AND identifier = ?` — com o `identifier` gravado exatamente como o webhook manda (`payload.senderId`, ex.: `5511987654321@s.whatsapp.net` ou o número cru do Evolution/Baileys). **Não há normalização no caminho de dedup.** Existe `phoneMatch.ts` (com/sem 9º dígito BR, com/sem DDI 55), mas ele é usado **só** pelo `CoordenadorService`/gestores autorizados (`AIOrchestratorService.ts:824`) — nunca para casar contatos. A escolha foi consciente: o provedor de WhatsApp entrega o `remoteJid` já canonicalizado (`5521999998888@s.whatsapp.net`), então dois formatos diferentes só apareceriam se dois provedores distintos escrevessem no mesmo canal, o que não é o modelo.

**Áreas.** Uma organização pode ter várias frentes compartilhando o mesmo número — `service_areas` guarda `name`, `description`, `persona` (texto livre injetado no prompt), `assigned_user_id`, `position`, `active`. `tickets.area_id` prende a conversa numa área depois do menu inicial. `AttendanceAreaService` faz: `buildMenu` (numera as áreas ativas), `match` (número curto OU nome/keyword normalizado sem acento), `wantsSwitch` (regex de "trocar de área / voltar ao menu / me transfere"), `welcomeMessage` (saudação sensível ao horário via `APP_TIMEZONE`), e `personaText` — o bloco que a IA recebe. Esse bloco lista as **outras** áreas ativas e ensina o roteamento via `route_to_area`, que é o campo JSON que o `AIOrchestrator` extrai (`AIOrchestratorService.ts:449`) para efetivar a transferência **no ato**, sem prometer no texto.

## Decisão

1. **Dedup por `(organization_id, channel_id, identifier)`** — literal, sem normalização, garantida por UNIQUE no schema. Confia no `remoteJid` canonicalizado do provedor. Trocar de canal (ex.: cliente muda do WhatsApp Business API para Evolution) cria contato novo — é o comportamento esperado.
2. **Sem dedup por e-mail nem por telefone "cru".** A coluna `email` existe (`db.ts:981`) mas é só metadado; nenhum caminho de escrita faz lookup por ela.
3. **Áreas são por org, independentes**, com `persona` como texto livre (até 8000 chars) que vira parte do system prompt via `AttendanceAreaService.personaText`. Persona nova ou vazia é sugerida pela IA em `POST /api/areas/ai/persona`.
4. **Roteamento no ticket, não no contato.** `tickets.area_id` é o que define de qual área a IA fala agora — o mesmo contato pode passar por Vendas e depois Suporte no mesmo dia, e o histórico do ticket preserva isso.
5. **`route_to_area` é a única forma de transferir.** A IA nunca escreve "vou te transferir" em texto solto; ou preenche `route_to_area` com o nome exato de outra área ativa e o servidor faz a troca antes de enviar a resposta, ou responde como a área atual. Isso mata o bug histórico do "prometi e não transferi".
6. **Match do menu tolera número curto ou palavra-chave**; `wantsSwitch` funciona como *escape hatch* declarativo do cliente para voltar ao menu.
7. **Excluir uma área** faz `UPDATE tickets SET area_id = NULL` (`routes/areas.ts:88`) — na próxima mensagem o cliente vê o menu de novo, em vez de ficar preso numa área fantasma.

## Consequências

**Positivas:**
- Um `INSERT` por webhook, um `SELECT` indexado; dedup O(log n) na chave UNIQUE.
- Áreas isoladas por org — persona de um tenant nunca "vaza" para outro no prompt.
- Roteamento honesto: a IA transfere ou não transfere; nunca finge que vai.
- O menu se autoconstrói a partir de `service_areas WHERE active = 1 ORDER BY position` — mudanças no painel refletem na próxima mensagem sem redeploy.

**Trade-offs assumidos:**
- **Sem match de contato por e-mail.** Cliente que fala pelo WhatsApp e depois compra pelo storefront com o mesmo e-mail vira dois registros — reconciliar é manual (via `PATCH /api/contacts/:id`).
- **Sem merge de duplicatas.** Se o mesmo humano aparece com dois `identifier` diferentes (número trocado, JID reescrito por bug de provedor, mudança de canal), viram dois contatos com dois `lead_score`, dois `memory_summary`, dois `total_spent`. Não existe rota de merge; a única saída hoje é `DELETE` num e refazer.
- **Sem histórico de temperatura.** `CustomerProfileService.recomputeTemperature` sobrescreve `contacts.lead_temperature` (`CustomerProfileService.ts:59`). Não dá para responder "quando este lead esfriou?" sem cruzar `last_contact_at` na mão.
- **`tags` é CSV livre** (`tags LIKE '%x%'`), não uma tabela normalizada. Filtro rápido e barato, mas tag `"vip"` casa com `"vip-frio"`; renomear tag em massa é `UPDATE ... SET tags = REPLACE(...)` cru.
- **Persona da área é texto livre injetado no prompt** — um texto mal escrito degrada a resposta silenciosamente, e não há validação além do `slice(0, 8000)`.
- **`route_to_area` casa por nome** (case-sensitive na UI, tolerante no matcher). Duas áreas com nomes muito parecidos ("Vendas" e "Vendas Corp") podem confundir a IA; a mitigação hoje é curadoria humana dos nomes.

## Testes

**Cobertura direta hoje: nenhuma.** Não existe `scripts/test-contacts-dedup.ts` nem `scripts/test-attendance-area.ts`. O que se aproxima:

- `scripts/test-phone-match.ts` — exercita `phoneMatch.ts`, mas esse utilitário serve ao `CoordenadorService` (gestores), **não** ao dedup de `contacts`. Cobre o caso vizinho, não o caso em questão.
- `scripts/test-ai-orchestrator.ts` — passa por `areaId` e pode acionar o caminho de `route_to_area`, mas não é um teste focado do roteador.
- `scripts/test-tenant-isolation.ts` — garante que áreas de uma org não vazam para outra na leitura, o que valida indiretamente a decisão 3.

**Lacunas honestas** que deveriam virar scripts próprios:
- `test-contacts-dedup.ts`: duas webhooks com o mesmo `(org, channel, identifier)` produzem um único contato; `identifier` diferente por 1 char produz dois; troca de `channel_id` produz dois (comportamento aceito, mas precisa estar coberto para não regredir).
- `test-attendance-area-match.ts`: número curto (`"2"`), nome exato, keyword parcial, mensagem longa contendo dígito (`"vou chegar às 3h"` **não** pode casar como opção 3), `wantsSwitch` para as variações regex.
- `test-attendance-area-routing.ts`: IA respondendo com `route_to_area` válido troca `tickets.area_id`; `route_to_area` de área inexistente ou inativa é ignorado (não pode quebrar a conversa); DELETE de área ativa solta os tickets (`area_id = NULL`).
- `test-persona-injection.ts`: `personaText` com N áreas ativas gera bloco de OUTRAS ÁREAS listando N-1 itens; com 1 área ativa só, não lista nada (não faz sentido oferecer transferência para si mesma).

Enquanto essas suítes não existirem, qualquer mexida em `webhookProcessor.ts:170-190`, `AttendanceAreaService.ts` ou no schema de `contacts` exige revisão manual dos 11 consumidores listados em `grep -rn "INSERT INTO contacts\|UPDATE contacts" src/server`.
