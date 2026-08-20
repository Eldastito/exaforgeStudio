# ADR-180 — Professional Identity & Federated Calendar (Agenda Federada)

- **Status:** MVP FECHADO — F0 (auditoria + ADR, MERGED PR #1231) · F1 (identidade cross-org +
  relacionamento, MERGED PR #1232) · F2 (serviços ofertados + janelas, MERGED PR #1233) ·
  F3 (Availability Engine + hold atômico, MERGED PR #1234) · F4-backend (booking federado
  + AutoBooking governado, MERGED PR #1235) · F4b (UI do operador na Clínica, MERGED PR #1236).
  Plano F0–F4 (MVP) entregue ponta-a-ponta. **Finanças (F8) FECHADO** (#1237/#1238/#1239).
  **Google Calendar (F6) FECHADO** (#1240/#1241/#1242/#1243). **F5 (recursos +
  deslocamento) FECHADO** (F5.1 #1244 · F5.2 #1245 · F5b #1246). **Agora F7 — webapp de
  autoatendimento do profissional (COM escrita, decisão do dono): F7.1 (auth passwordless +
  leitura por-profissional, EM PR).** Como F1–F3, cada
  backend fecha primeiro com teste como contrato e a UI vem como fatia fina.
- **Data:** 2026-08-20
- **Contexto de origem:** dor real do cliente petshop/clínica veterinária — especialistas
  (cirurgião de aves, cardiologista, etc.) atendem em VÁRIAS clínicas; quando aparece um
  pet que precisa da especialidade, a clínica **entra em contato, aguarda resposta e fica
  refém da agenda do profissional**. Objetivo: o ZapFlow agenda o atendimento do
  especialista **sem depender de contato manual**, respeitando a disponibilidade real dele.
- **Auditoria:** `docs/professional-network/codebase-audit.md` (F0).
- **PRD de referência:** "ZapFlow Professional Network & Agenda Federada" (100 seções).

## Decisão central (a fronteira)

> **O profissional pertence ao ECOSSISTEMA ZapFlow, não a uma clínica específica.**
> Uma clínica tem um **relacionamento** e **permissões** sobre o profissional (quais
> serviços pode agendar, comissão, status do vínculo) — **não propriedade** sobre a
> identidade dele. (§90 do PRD.)

Isso se materializa espelhando dois precedentes JÁ VALIDADOS no repo:

1. **Identidade separada do vínculo** — como `retail_sellers` (identidade) +
   `retail_seller_store_assignments` (atribuição por loja).
2. **Camada global sem `organization_id` + bridge por-org isolado** — como
   `vertical_intelligence` (GLOBAL) + `organization_contextualization` (bridge POR-ORG,
   never-write-back, RN-156-1).

### Modelo de dados (aditivo, CREATE-then-ALTER)

- `professionals` — **GLOBAL, sem `organization_id`**. Identidade do profissional no
  ecossistema, chaveada por conselho + registro (ex. `CRMV-SP 12345`, UNIQUE). Campos:
  nome, conselho, registro, especialidades, contato (telefone/e-mail), estado.
  **Zero dado por-org aqui.**
- `clinic_professional_relationships` — **bridge POR-ORG** (`organization_id` +
  `professional_id`). É onde vive TUDO que é da relação clínica↔profissional: status do
  convite (`pending`/`accepted`/`revoked`), quais serviços a clínica pode agendar,
  comissão, janelas de trabalho **naquela** clínica. Isolado por org; uma clínica NUNCA
  lê a relação de outra.
- `clinic_slot_holds` — hold temporário atômico (org + professional + intervalo + TTL +
  status). Impede corrida de dois agendamentos na mesma vaga entre "sugerir" e "confirmar".

### Por que NÃO tratar o profissional como usuário (`users`) agora
`users.email` é UNIQUE e o sistema assume **1 usuário = 1 org**. Um profissional que
atende em 5 clínicas quebraria esse invariante. No MVP o profissional é uma **ENTIDADE
agendável**, operada pela clínica; o **webapp de autoatendimento do profissional (login,
ver/editar a própria agenda, finanças) é DEFERIDO (F7)** — evita colidir com o modelo de
auth atual e não bloqueia o valor central (agendar sem depender de contato manual).

## Guardrails (RN-PN)

- **RN-PN-1 — Identidade é do ecossistema.** `professionals` é global, sem `organization_id`
  nem PII por-org; toda relação/permissão vive no bridge por-org.
- **RN-PN-2 — Isolamento cross-org.** Toda query do bridge filtra `organization_id`. Uma
  clínica só vê o relacionamento dela. Cross-tenant é bug de segurança (convenção nº 1).
- **RN-PN-3 — Sem propriedade.** Revogar o vínculo remove as permissões da clínica, mas
  **não apaga** a identidade global do profissional (ele segue em outras clínicas).
- **RN-PN-4 — Disponibilidade é a fonte da verdade.** O ZapFlow só oferece horários que o
  motor de disponibilidade prova estarem livres (janela × conflito × buffer × hold);
  **nunca inventa** vaga (RN-004 / RN-151).
- **RN-PN-5 — Confirmação ≠ agendamento.** Uma vaga proposta vira agendamento só após
  `hold` atômico + confirm dentro de transação (padrão AC-012). `booking_confirmation`
  arma SLA; timeout publica sinal, não trava a vaga para sempre.
- **RN-PN-6 — AutoBooking é comando GOVERNADO.** Agendar automaticamente atravessa
  `DecisionAction → ApprovalPolicy (Autonomy Contract) → CommandExecutor → Confirmation`.
  Nunca agenda direto fora da banda de autonomia; default exige aprovação humana.
- **RN-PN-7 — Sem motor/scheduler/policy/confirmation paralelo (§184).** Reusa a espinha
  existente; sinais em `business_signals` (nunca tabela de alerta paralela, convenção nº 12).
- **RN-PN-8 — Opt-in reversível.** Tudo atrás de `organization_settings.professional_network_enabled`
  (default 0) e `autobooking_enabled` (default 0). Legado sem a flag opera intocado.

## Plano de fatias

**MVP (F0–F4):**

- **F0 — Auditoria + ADR (esta fatia, doc-only).** `codebase-audit.md` + ADR-180.
- **F1 — Identidade cross-org + relacionamento. FECHADA (em PR).** Tabelas
  `professionals` (GLOBAL, sem `organization_id`) + `clinic_professional_relationships`
  (bridge por-org, UNIQUE(org, professional)) + flag `professional_network_enabled`
  (opt-in, default 0). `ProfessionalService` (identidade global idempotente pela chave
  do conselho, NUNCA sobrescreve com vazio — RN-PN-3) + `ClinicProfessionalRelationshipService`
  (ciclo convite `pending`→aceite `accepted`→revogação `revoked`; revogar não apaga a
  identidade global; reconvite reativa). Rotas `/api/clinic/professional-network/*`
  (busca de identidade, relationships CRUD/accept/revoke/permissions), gate server-side
  pela flag (RN-PN-8 — recusa 403 sem opt-in). `test:professional-network` (23) cobre
  idempotência, não-sobrescrita, ciclo, isolamento cross-org (RN-PN-2) e revogação.
- **F2 — Serviços + janelas de disponibilidade. FECHADA (em PR).** Config presa ao
  VÍNCULO (por-org): `clinic_professional_offerings` (serviços ofertados na clínica +
  override de duração, fallback pro catálogo `products_services`; valida serviço no
  catálogo da org — não inventa) + `clinic_professional_windows` (janelas semanais
  0..6 em minutos-do-dia + buffer; replace-all atômico validado). `ProfessionalScheduleConfigService`
  só configura vínculo não revogado da org (RN-PN-2). Rotas
  `/api/clinic/professional-network/relationships/:id/{offerings,windows}` +
  `/offerings/:offeringId`. `test:professional-schedule-config` (20). É a config que o
  Availability Engine (F3) consome.
- **F3 — Availability Engine + Hold + confirm atômico. FECHADA (em PR).**
  `ProfessionalAvailabilityService`: `availableSlots` gera vagas das janelas (F2)
  respeitando duração + buffer, subtrai holds vivos/confirmados + appointments do
  vínculo e descarta o passado (nunca inventa vaga — RN-PN-4); `hold` reserva com
  guarda ATÔMICA (SELECT COUNT dentro da transação antes do INSERT — padrão AC-012),
  então duas reservas na mesma vaga → só uma vence (`slot_taken`); TTL + `sweepExpired`
  (holds vencidos não bloqueiam); `confirm` trava a vaga durável (idempotente); `release`
  libera. Tabela `clinic_slot_holds` + hook aditivo `appointments.network_relationship_id`
  (populado na F4). Só sobre vínculo ACEITO; isolado por org (RN-PN-2). Rotas
  `/professional-network/relationships/:id/{availability,holds}` +
  `/holds/:holdId/{confirm,release}`. `test:professional-availability` (27) — geração de
  vagas, buffer, corrida na mesma vaga, TTL/expiração, confirm/release, subtração de
  appointment e isolamento cross-org.
- **F4 — Booking federado + ferramentas de IA + AutoBooking. FECHADA (backend, MERGED PR #1235).**
  `ProfessionalBookingService` reúne as três ferramentas ATERRADAS que qualquer superfície
  de IA (Fala Tu / assistente) chama: `getAvailability`/`holdSlot`/`confirmBooking` — a IA
  só oferece o que o Availability Engine (F3) prova; **nunca inventa vaga** (RN-PN-4).
  `confirmBooking` confirma o hold atômico e CRIA o agendamento federado amarrado ao
  vínculo (`appointments.network_relationship_id`) + snapshot do nome do especialista (o
  profissional da rede NÃO é `clinic_professionals` local), **idempotente por hold**
  (UNIQUE parcial `(org, slot_hold_id)` → nunca 2 appointments). Sem vaga: `waitlist`
  publica `professional_network/waitlist` em `business_signals` (convenção nº 12 — nunca
  tabela paralela, RN-PN-7). **AutoBooking é COMANDO GOVERNADO** (RN-PN-6): `autoBook`
  PROPÕE uma `decision_action` (commandType `auto_booking`, nasce `awaiting_approval` por
  default) que atravessa `DecisionAction → ApprovalPolicy (Autonomy Contract) →
  CommandExecutor`; o efeito real vive no `AutoBookingCommandHandler` (registrado no MESMO
  registry, §184) — procura a 1ª vaga provada na janela, segura, confirma e cria o
  appointment; **AGENDADO ≠ ATENDIDO** (RN-PN-5): arma `ConfirmationEngine.expect(method
  `booking_confirmation`)` com SLA (timeout publica sinal via `sweepTimeouts`). 2ª flag
  opt-in `autobooking_enabled` (default 0). Sweep de holds vencidos plugado no Scheduler
  (`professionalHoldSweepPass`). Rotas `/professional-network/holds/:holdId/booking`,
  `/relationships/:id/{waitlist,autobook}`, `/autobook/:actionId/execute`.
  `test:professional-booking` (23) — grounding, idempotência durável, recusa de hold
  inexistente/expirado/de-outra-org (anti-alucinação), AutoBooking governado (propõe→
  aprova→executa + `booking_confirmation`) e sem-vaga→waitlist com ZERO appointment.
- **F4b — UI do operador na Clínica. FECHADA (EM PR).** Aba **"Rede"** na `ClinicAgendaView`
  (lazy `ProfessionalNetworkPanel`, self-gated pela flag — mostra o convite de ativação
  quando a rede está off): ativar a rede (opt-in) → convidar/aceitar/revogar profissional
  (identidade global + vínculo) → configurar serviços ofertados + janelas de trabalho →
  **ver as vagas provadas (F3) e agendar** (hold atômico → confirm → appointment federado;
  `slot_taken` avisado e recarrega) → fila (waitlist) sem vaga → AutoBooking (propõe o
  comando governado, só quando `autobooking_enabled`). Escrita é owner/admin no servidor —
  a UI mostra o erro, não esconde o botão. Backend mínimo desta fatia:
  `ProfessionalNetworkSettingsService` (get/set das duas flags — ÚNICO ponto NÃO gated,
  senão nunca se ligaria a rede; coerência autobooking⇒rede, rede-off⇒autobooking-off) +
  rotas `GET/PUT /professional-network/settings` (owner/admin). Serviços do catálogo vêm de
  `/api/products` (filtrando `type='service'`, sem endpoint novo). `test:professional-
  network-settings` (11) — default off, coerência das flags e isolamento por org.

Com a F4b, o MVP (F0–F4) está fechado ponta-a-ponta: o operador da clínica agenda um
especialista da rede sem contato manual, respeitando a disponibilidade real dele.

**DEFERIDO (fora do MVP):**

- **F5 — Recursos (salas/equipamentos) + deslocamento entre clínicas.** Fatiada:
  - **F5.1 — Sala exigida na disponibilidade (EM PR).** A oferta (serviço×vínculo) pode
    EXIGIR uma sala da própria clínica (`clinic_professional_offerings.required_room_id`,
    aditivo, validado contra `clinic_rooms` ativa da org — não inventa recurso). A
    disponibilidade subtrai a 4ª fonte de ocupação: a sala tomada por QUALQUER atendimento
    da org (`requiredRoomBusy`, conservador). O `confirmBooking` VALIDA a sala livre antes
    de confirmar o hold (reusa `ClinicAgendaService.findConflicts`/`checkRoomCapacity` — a
    integridade de sala da org) e RESERVA (`appointments.room_id`); sala tomada → `room_taken`
    (o hold segue vivo). Sem sala exigida → 0-regressão. `test:professional-rooms` (8).
  - **F5.2 — Deslocamento entre clínicas (EM PR).** O profissional é GLOBAL: um atendimento
    federado dele em OUTRA clínica o impede de estar aqui no mesmo horário. Opt-in por
    `clinic_professional_relationships.travel_buffer_min` (nullable: NULL = desligado,
    0-regressão; um valor incl. 0 = LIGA — bloqueia a sobreposição + margem de deslocamento
    de cada lado). `ProfessionalAvailabilityService.crossClinicBusy` é a 5ª fonte de
    ocupação: lê SÓ o bloco de tempo dos atendimentos do profissional em `a.organization_id
    != orgId` (join por `professional_id` global), expandido pelo buffer — PRIVACIDADE
    (exceção mínima à RN-PN-2): nunca a clínica de origem nem detalhes. Config via
    `setPermissions({travelBufferMin})`. `test:professional-travel` (10); regressão
    `test:professional-availability` 27/27 e `test:professional-network` 23/23.
  - **F5b — UI (EM PR).** No `ProfessionalNetworkPanel` (aba "Rede"): o `OfferingsEditor`
    ganha um seletor de **sala exigida** (opcional, das `clinic_rooms` da clínica) no form
    de oferta e mostra a sala em cada linha; novo `TravelBufferControl` liga/desliga o
    **deslocamento entre clínicas** e define a margem (min) via `PUT .../permissions`
    (`travelBufferMin` null = desligado). UI-only sobre as rotas F5.1/F5.2; tsc + build
    (vite) verdes. **Fecha o F5.**
- **F6 — Google Calendar por profissional.** Decisão de fronteira (§90): a conexão é
  GLOBAL, chaveada por `professional_id` (uma agenda que TODAS as clínicas respeitam), não
  por `relationship_id`. Fatiada backend-first:
  - **F6.1 — Conexão per-profissional (EM PR).** `ProfessionalGoogleService` + tabela GLOBAL
    `professional_google_connections` (chave `professional_id`, tokens CIFRADOS
    `EncryptionService` AES-GCM, escopo CALENDAR-ONLY least-privilege — sem Drive/Sheets/Gmail).
    Reusa a mecânica OAuth do `GoogleOAuthService` mas com `state` assinado carregando
    professionalId+orgId e callback próprio `/api/integrations/google/professional-callback`
    (público, em `server.ts`). `busyIntervals` (freeBusy ESTRUTURADO → {start,end} ms),
    `createEvent`/`deleteEvent` (best-effort). `fetchFn` INJETÁVEL → teste determinístico sem
    rede. Rotas na clínica gated por VÍNCULO ACEITO (`/relationships/:id/google/{status,
    login-url,disconnect}`, owner/admin). Coluna aditiva `appointments.network_google_event_id`
    (registry de evento próprio, populado na F6.3). `test:professional-google` (20).
  - **F6.2 — Disponibilidade subtrai o Google busy (EM PR).** `availableSlots` ganha
    `opts.externalBusy` (3ª fonte, além de holds+appointments) — mantém o núcleo SÍNCRONO e
    puro; o fetch async do Google vive na borda: `getAvailability` (async) resolve o
    profissional do vínculo, busca `ProfessionalGoogleService.busyIntervals` do dia e passa
    o busy → a IA/operador nunca vê vaga em cima de compromisso do Google. O AutoBooking
    também subtrai (uma busca de freeBusy pra toda a janela). Best-effort (falha no Google
    nunca derruba a agenda); sem conexão → 0-regressão. O `hold()` atômico segue só com
    holds+appointments (DB) — o Google é subtraído na SUGESTÃO, não no lock. Rota
    `/availability` passa a `await getAvailability`. `test:professional-availability-google`
    (6); regressão `test:professional-availability` 27/27 e `test:professional-booking` 23/23.
  - **F6.3 — Empurra o atendimento federado pra agenda do profissional (EM PR).** O
    `confirmBooking` segue SÍNCRONO (muitos callers + testes de erro dependem do throw
    síncrono); o push é um passo async SEPARADO: `pushToGoogle` (best-effort, IDEMPOTENTE —
    pula se `network_google_event_id` já setado ou sem conexão) cria o evento na agenda do
    profissional e guarda o id. Chamado pelos callers assíncronos (rota `/holds/:holdId/
    booking` e `AutoBookingCommandHandler.execute`) DEPOIS do confirm. `cancelBooking` marca
    `cancelled` (preserva histórico, convenção nº 9) e `removeFromGoogle` apaga o evento +
    limpa o vínculo. Nunca lança pro caller (o agendamento já existe; o Google é aditivo).
    Rota `POST /professional-network/appointments/:id/cancel`. `test:professional-google-sync`
    (9); regressão `test:professional-booking` 23/23.
  - **F6b — UI (EM PR).** `GoogleCalendarPanel` no detalhe do vínculo (aba "Rede",
    `ProfessionalNetworkPanel`): estado da conexão (conectado + e-mail, ou "conectar"),
    botão **Conectar Google** (abre a URL de consentimento; recarrega o status ao voltar o
    foco) e **Desconectar** (com confirmação); honesto quando o servidor não tem o Google
    configurado. UI-only sobre as rotas da F6.1; tsc + build (vite) verdes. **Fecha o F6.**
- **F7 — Webapp de autoatendimento do profissional (COM escrita — decisão do dono).** O
  profissional é GLOBAL (§90) e não cabe em `users` (UNIQUE por e-mail + preso a 1 org).
  **Auth PASSWORDLESS por magic-link** reusando o molde `ClinicPortalService` numa tabela
  GLOBAL. Fatiada:
  - **F7.1 — Auth + leitura por-profissional (EM PR).** Tabela GLOBAL `professional_auth_tokens`
    (chave `professional_id`, SEM `organization_id`; token 32 bytes devolvido UMA vez, no
    banco só hash SHA-256 + TTL + active; resolve por hash). `ProfessionalAuthService`
    (generate/revoke/status/resolveToken + `startSession`→JWT escopado `professional_portal`
    SEM organizationId + `verifySession` que RECUSA token com organizationId ou escopo
    errado — nunca toca `users`). `ProfessionalSelfService` — leitura DERIVADA por
    profissional (fan-out sobre vínculos aceitos cross-org): `overview` (identidade +
    clínicas), `agenda` (atendimentos federados de TODAS as clínicas), `finance` (agrega
    `ProfessionalFinanceService.statement` por clínica + total realizado×previsto). Rotas
    PÚBLICAS `/api/public/professional/{session,overview,agenda,finance}` (fora do
    `requireAuth`; `requireProfessional` valida a sessão escopada). `test:professional-selfservice`
    (19). Privacidade: o profissional só vê os PRÓPRIOS vínculos (join por professional_id).
  - **F7.2 — Magic-link: a clínica gera e compartilha o acesso (EM PR).** Política de
    emissão em `ProfessionalAuthService.issueForRelationship/statusForRelationship/
    revokeForRelationship` — só um vínculo ACEITO da org emite (isolamento RN-PN-2); o
    token é GLOBAL (uma identidade, um acesso — serve pra todas as clínicas do profissional);
    devolve a URL `${APP_URL}/profissional/:token` pronta pra compartilhar (a clínica já
    fala com o profissional pelo canal dela — molde ClinicPortalService: entrega manual).
    Rotas `GET/POST /relationships/:id/access-link` + `/access-link/revoke` (owner/admin).
    UI `AccessLinkPanel` na aba "Rede" (gerar/copiar/revogar + status/último acesso).
    `test:professional-access-link` (11) — só aceito emite, pendente/de-outra-org não,
    revogar mata o acesso, reemissão gera token novo.
  - **F7.3 — Escrita: o profissional edita a PRÓPRIA disponibilidade por clínica (a fazer).**
  - **F7.4 — Escrita: o profissional ACEITA/RECUSA agendamentos (a fazer).**
  - **F7b — Página `/profissional/:token` (a fazer).**
- **F8 — Finanças (comissão split clínica×profissional, impostos retidos, previsão de receita).**
  Fatiada backend-first (visão original do dono: *"quanto vai receber, o percentual da clínica
  e dele separados, previsão de receitas a receber"*):
  - **F8.1 — Split derivado (MERGED PR #1237).** `ProfessionalFinanceService` — READ-MODEL DERIVADO
    (RN-004, sem contador mutável, sem ledger paralelo §184/RN-PN-7): cada atendimento
    federado (`appointments.network_relationship_id`) vira um acerto calculado de
    `network_service_price` (snapshot do preço ACORDADO no agendamento — espírito da
    convenção nº 3, congela o combinado; 2 colunas aditivas `network_service_id`/
    `network_service_price` populadas no `confirmBooking`) × `relationship.commission_percent`
    (parte do profissional) × STATUS do appointment (`completed`=ATENDIDO/`fact` ×
    `confirmed`=AGENDADO/`estimate` — AGENDADO ≠ ATENDIDO, RN-PN-5). `settlement` (um
    atendimento) + `statement` (extrato do profissional, realizado × previsto). Honestidade
    dura (RN-PN-4 / não inventa dinheiro): sem preço → `gross=null`; sem comissão →
    `professionalAmount=null` (nunca assume 0/100%). Dinheiro role-gated (§73 — só
    owner/admin). Rotas `/professional-network/relationships/:id/finance/statement` e
    `/appointments/:appointmentId/finance`. `test:professional-finance` (24).
  - **F8.2 — Direção do split ABERTA + imposto retido + previsão (MERGED PR #1238).** O dono decidiu
    *"cada parte define o seu percentual combinado"* → o % do vínculo é de UM lado
    (`commission_beneficiary` = `professional` (default, 0-regressão) | `clinic`) e o outro
    fica com o RESTO; o financeiro sempre mostra os DOIS. Imposto RETIDO na fonte sobre o
    bruto do profissional, opt-in por vínculo (`tax_withholding_percent`; sem config →
    `taxAmount=null`, nunca inventa CLT/ISS — RN-PN-4; líquido = bruto − retido). `forecast`
    = receita A RECEBER por profissional (previsto = agendado ainda não atendido), com o
    "quando" (`nextServiceDate` = 1º atendimento previsto) + `totalNetProfessional`. `totals`
    endurecido (cada campo null quando nenhum evento o tinha — null ≠ 0). 2 colunas aditivas
    em `clinic_professional_relationships`. Rota `/professional-network/finance/forecast`.
    `test:professional-finance-forecast` (23); regressão `test:professional-finance` 24/24 e
    `test:professional-network` 23/23.
  - **F8b — UI do financeiro (EM PR).** Seção **"Financeiro"** no detalhe do vínculo
    (`ProfessionalNetworkPanel`): configurar o acordo (direção do split
    profissional/clínica + comissão % + imposto retido %) → `PUT .../permissions`; extrato
    **realizado × previsto** em dois cards (bruto/profissional/clínica/imposto/líquido) +
    lista de atendimentos (atendido/agendado). E um card **"Previsão a receber"**
    (`ForecastPanel`, visível quando nenhum profissional está selecionado) com o líquido
    previsto por profissional + o "quando" (1º atendimento) + total. BRL honesto (null →
    "—", nunca R$ 0,00 inventado). UI-only sobre endpoints já testados (F8.1/F8.2); tsc +
    build (vite) verdes. **Fecha o F8.** As demais diferidas (F5/F6/F7/F9/F10) seguem abertas.
- **F9** — Inteligência (padrões de demanda por especialidade, sugestão de nova clínica).
- **F10** — Rede/marketplace (profissional descobre clínicas, clínica descobre especialistas).

## Reuso vs. novo (resumo)

- **Reusar:** `findConflicts`/`checkRoomCapacity`, padrão atômico `addParticipant`,
  `GoogleOAuthService`+`oauth_connections`+`EncryptionService` (F6), toda a espinha
  `DecisionAction/ApprovalPolicy/CommandExecutor/ConfirmationEngine`, `business_signals`+
  `attention`, `TaskReminderService`, precedentes `retail_sellers`/`vertical_intelligence`.
- **Estender:** `ClinicScheduleSessionService.availability` (janelas/buffers/hold).
- **Criar (aditivo, mínimo):** `professionals` (global), `clinic_professional_relationships`
  (bridge), `clinic_slot_holds` (hold), handler `auto_booking`.

Nenhum motor, scheduler, policy, confirmation, learning ou pipeline paralelo (§184).
