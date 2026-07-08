# ADR-066 — Google Integration — OAuth, Calendar e envio de e-mail

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit. O lojista pequeno já tem uma conta Google grátis (Gmail + Calendar). Plugar essa conta no ExaForge dá **automação sem custo adicional**: confirmação de pedido/agendamento por e-mail (sem contratar SendGrid), evento no Calendar (sem cron próprio) e leitura de agenda para a IA não marcar em cima de compromissos. O código entrou como um par: `GoogleOAuthService` (protocolo + APIs REST) e `GoogleAutomationService` (regras de negócio em cima delas). Este ADR fecha a lacuna documental dos dois.

---

## Contexto

Diferente do login do Firebase — que vive só no navegador e some quando o dono fecha a aba — aqui o servidor precisa agir com a conta Google do dono **enquanto ele está offline**: mandar e-mail quando um pedido é fechado no storefront às 2h da manhã, marcar evento no Calendar quando a IA confirma um horário no WhatsApp. Isso exige OAuth 3-legged com `access_type=offline` e `prompt=consent` (garante o `refresh_token` mesmo em reconexões) e um `refresh_token` guardado por organização.

Os tokens ficam em `oauth_connections`, cifrados por [ADR-054](ADR-054-encryption-service-segredos.md) (`EncryptionService.encrypt` no insert, `decrypt` transparente em `getConnection`). O `state` do OAuth é HMAC-assinado com `JWT_SECRET` + TTL de 10 min — mesma receita do Instagram, anti-CSRF. Se o Google não devolver `refresh_token` no callback (raro, mas acontece em reconexões), preservamos o antigo em vez de sobrescrever com `NULL` — evita quebrar a conexão silenciosamente.

O escopo pedido é **mínimo para o caso de uso**: `calendar.events` (não `.readonly` porque precisamos criar/patch/delete), `gmail.send` (não `.readonly`, não `.compose` — só enviar), `drive.file` (só arquivos criados pelo app, nunca o Drive inteiro), `spreadsheets` e `openid/email/profile` para exibir "conectado como fulano@…". Reduzir escopo é literalmente reduzir o raio de dano se o token vazar.

A `GoogleAutomationService` é a camada de **política**: lê `organization_settings` (`google_email_appointments`, `google_email_orders`, `google_log_orders`, `google_sync_enabled`), decide se dispara, monta o corpo do e-mail e delega o transporte para a `GoogleOAuthService`. Toda automação é chamada com `.catch(() => {})` pelos callers (`routes/storefrontPublic.ts:404-405`, `routes/appointments.ts:106`, `OrdersService.ts:107-108`, `webhookProcessor.ts:502`) — nunca bloqueia o fluxo principal.

## Decisão

**Regras invioláveis:**

1. **Escopo mínimo por feature.** Adicionar escopo novo exige nova rodada de consentimento do usuário — o preço é justo pelo aumento de superfície. Não pedimos `gmail.readonly` porque não lemos e-mail; não pedimos `drive` sem `.file` porque não vasculhamos o Drive do dono.
2. **Refresh silencioso com margem de 60s.** `getAccessToken` renova quando `expires_at < now + 60s`. Sem margem, uma request de 2s que começa com token válido pode chegar ao Google já expirado (relógios dessincronizados). Se o refresh falhar (usuário revogou, por exemplo), devolvemos `null` e o caller trata como "não conectado".
3. **Toggle por tipo de evento** (`emailAppointments`, `emailOrders`, `logOrders`, `syncEnabled`) — o dono liga cada automação separadamente. Ligar Google **não** liga nada por si só; o default é tudo desligado. Isso respeita o dono que só quer usar Google Login sem que a gente comece a mandar e-mail em nome dele.
4. **Fallback silencioso.** Toda função pública da `GoogleAutomationService` começa com `if (!GoogleOAuthService.getConnection(orgId)) return;`. Se o dono desconectar o Google, os pedidos continuam sendo criados, as reservas continuam sendo confirmadas — só param os efeitos colaterais (e-mail, evento no Calendar, linha na planilha). Nada quebra, nada trava, nada avisa (o dono desconectou de propósito).
5. **Anexo `.ics` de confirmação de agendamento** no e-mail — o cliente adiciona à agenda dele com um toque. Usa `content` (UTF-8) para texto; anexos binários (PDF do ADR-026) usam `contentBase64`. São dois campos distintos porque `Buffer.from(pdf, "utf-8")` corrompe bytes.
6. **Cache de busy events (`getBusyText`) de 5 min por org.** A IA consulta a agenda em toda mensagem — sem cache, cada turno do WhatsApp geraria uma request ao `freeBusy`. Trade-off honesto: se o dono acabou de marcar algo manualmente no Google, a IA pode oferecer esse mesmo horário por até 5 min.
7. **Sincronização de agendamento é best-effort e idempotente.** `syncAppointment` só cria se ainda não há `google_event_id`; `syncAppointmentUpdate` cria se não existe, senão faz `PATCH`; `removeAppointmentEvent` aceita 410 (já removido) como sucesso. Nenhuma dessas lança — só loga.
8. **`From:` do Gmail = e-mail da conta conectada** (`account_email`), com fallback `"me"`. Assunto codificado em MIME `=?UTF-8?B?…?=` para não perder acentos em clientes antigos.

## Consequências

**Positivas:**
- Zero custo de infraestrutura para envio de e-mail transacional — usa a cota gratuita do Gmail do dono.
- A IA para de marcar em cima de compromissos pessoais do dono (`getBusyText` prefixa o system prompt com "horários JÁ OCUPADOS — NUNCA ofereça…").
- Fluxo do storefront/WhatsApp resiliente a Google offline: automações são `catch(() => {})` no chamador, nunca bloqueiam venda ou agendamento.
- Escopo enxuto reduz o "vale a pena revogar tudo" quando o dono clica em "gerenciar acesso" no Google — só verá permissões que fazem sentido.

**Trade-offs aceitos:**
- **Sem retry de envio.** Se o Gmail devolver 5xx transitório, o e-mail simplesmente não sai — não temos fila de retentativa (nem `job_queue` para isso). Aceitável enquanto o volume for baixo e a alternativa (SendGrid) tem custo. Revisitar quando um tenant reclamar "cliente não recebeu confirmação".
- **Cache de busy events curto pode desatualizar.** 5 min é o balanço entre custo (1 request por turno de IA sem cache) e frescor. Se o dono marca algo no Google e a IA oferece o mesmo horário nesse intervalo, o `syncAppointment` posterior vai criar um segundo evento em cima — o Google não bloqueia conflitos.
- **Revogar o OAuth quebra tudo silenciosamente.** O dono revoga no `myaccount.google.com`, no ExaForge o `status` ainda mostra "conectado" (só descobrimos no próximo `getAccessToken`, que devolve `null`). Não há webhook do Google para "seu token foi revogado". O caminho de recuperação é o dono reconectar manualmente — o UI de integrações não avisa proativamente.
- **Uma conexão Google por organização.** O `handleCallback` faz `DELETE` antes do `INSERT`. Se o dono conectar a conta pessoal e depois quiser trocar pela conta comercial, funciona — mas não dá para ter as duas ao mesmo tempo.
- **`refresh_token` sem rotação nossa.** Cifrado pelo ADR-054, sim, mas se vazar a `ENCRYPTION_KEY` **e** o banco, o atacante tem acesso a Gmail/Calendar/Drive/Sheets de todos os tenants conectados até revogação manual no Google. Escopo mínimo é o que atenua o dano.
- **Sem observabilidade.** Falhas de envio logam com `console.error` e somem. Não há métrica de "taxa de e-mails enviados vs falhados" por org.

## Testes

**Cobertura direta hoje: parcial.** `scripts/test-sla-barcode-consult-sheets.ts` exercita `GoogleAutomationService.buildLiveSheetData` (função pura, sem I/O) e os toggles `setLiveSync`/`getSettings`. É honesto e útil — testa a lógica de montar as abas Vendas/Estoque/Resumo sem depender do Google.

**O que NÃO é testado (e por que):**
- `GoogleOAuthService.handleCallback`, `getAccessToken` (refresh), `gmailSend`, `calendarCreateEvent`, `driveUpload`, `sheetsCreate*` — todos exigem hit real na API do Google (ou um mock de `fetch` que ninguém escreveu ainda). Rodam em produção, não em CI.
- `GoogleAutomationService.confirmAppointment`/`confirmOrder` — dependem de `gmailSend`. Mesma razão.
- Fluxo de OAuth ponta-a-ponta (`authUrl` → `handleCallback` → `disconnect`) — exige navegador e conta Google real.
- Preservação do `refresh_token` quando o Google não reenvia — regressão silenciosa se alguém mexer no upsert em `handleCallback`.
- `getBusyText` cache de 5 min — invisível para teste sem mockar o relógio.

**Lacunas honestas** que devem virar `scripts/test-google-oauth.ts` e `scripts/test-google-automation.ts`:
- Mock de `fetch` para simular refresh bem-sucedido, refresh falho (token revogado) e 5xx transitório.
- `getBusyText` com `busyCache` populado deve retornar do cache mesmo com `fetch` mockado a lançar.
- `confirmAppointment` com `emailAppointments=false` **não** deve chamar `gmailSend` (verifica com espião).
- `handleCallback` com `refresh_token` ausente na resposta preserva o antigo (regressão do bug #TBD).

Enquanto esses testes não existirem, qualquer mudança nos dois arquivos exige verificação manual do fluxo de OAuth em ambiente com Google real e um agendamento/pedido de ponta-a-ponta.
