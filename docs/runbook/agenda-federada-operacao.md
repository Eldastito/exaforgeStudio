# Runbook — Agenda Federada / Professional Network (ADR-180)

Operação da **Agenda Federada**: agendar o atendimento de um especialista que atende em
**várias clínicas** sem depender de contato manual, respeitando a disponibilidade real dele.
Aditivo/reversível e isolado por `organization_id`; **sem** motor/scheduler/policy/confirmation
paralelo (§184) — reusa a espinha existente.

> Fronteira central (§90 / RN-PN-1): **o profissional pertence ao ECOSSISTEMA, não a uma
> clínica.** A clínica tem RELACIONAMENTO + permissões sobre ele, não propriedade sobre a
> identidade. Materializa dois precedentes já validados: identidade↔vínculo
> (`retail_sellers`+assignments) e camada global↔bridge por-org
> (`vertical_intelligence`+`organization_contextualization`).
>
> Invariantes duros: **AGENDADO ≠ ATENDIDO** (RN-PN-5) · **descoberta ≠ conexão** (RN-PN-11)
> · **nunca inventa vaga/dinheiro/lei** (RN-PN-4).

## Mapa dos serviços (por bloco)

| Bloco | Serviço | Papel |
| --- | --- | --- |
| Identidade (F1) | `ProfessionalService` | Identidade GLOBAL (`professionals`, sem org; chave conselho+registro); idempotente, nunca sobrescreve com vazio |
| Vínculo (F1) | `ClinicProfessionalRelationshipService` | Bridge por-org (`clinic_professional_relationships`): convite→aceite→revogação, permissões, comissão |
| Config (F2) | `ProfessionalScheduleConfigService` | Serviços ofertados (`clinic_professional_offerings`, +sala exigida F5.1) + janelas (`clinic_professional_windows`) |
| Motor (F3) | `ProfessionalAvailabilityService` | `availableSlots` (janela×hold×appointment×Google×sala×deslocamento) + `hold` atômico + `confirm`/`release`/`sweepExpired` |
| Booking (F4) | `ProfessionalBookingService` | Ferramentas de IA aterradas (`getAvailability`/`holdSlot`/`confirmBooking`) + `waitlist` + `autoBook` (governado) + push/cancel Google (F6.3) |
| AutoBooking (F4) | `AutoBookingCommandHandler` | Efeito real do `auto_booking` no MESMO registry do executor (§184) |
| Google (F6) | `ProfessionalGoogleService` | Conexão GLOBAL por `professional_id` (`professional_google_connections`, tokens cifrados AES-GCM, escopo calendar-only); `busyIntervals`/`createEvent`/`deleteEvent` |
| Finanças (F8) | `ProfessionalFinanceService` | Read-model (RN-004): `settlement`/`statement`/`forecast` — split, imposto retido, realizado×previsto; nunca inventa dinheiro |
| Webapp auth (F7) | `ProfessionalAuthService` | Magic-link passwordless (`professional_auth_tokens` global) → sessão JWT escopada `professional_portal` (nunca toca `users`) |
| Webapp leitura/escrita (F7) | `ProfessionalSelfService` | Por-profissional cross-org: overview/agenda/finance + `setWindows` + accept/decline appointment |
| Demanda (F9) | `ProfessionalDemandService` | Read-model de demanda não atendida (waitlist+recusa × atendido) + `publishGaps` proativo self-healing |
| Descoberta (F10) | `ClinicDiscoveryService` | Lado-clínica: flag `network_discoverable` + `soughtSpecialties` (dos demand_gap) + `publicProfile` (tier público) |
| Descoberta (F10) | `ProfessionalDiscoveryService` | Match bidirecional (`specialistsFor`/`clinicsSeeking`) especialidade+região + `inviteSpecialist`/`requestJoin` |

Motores/serviços REUSADOS (nunca duplicados): `DecisionAction → ApprovalPolicy (Autonomy
Contract) → CommandExecutor → ConfirmationEngine` (AutoBooking governado), `business_signals`+
`attention` (waitlist / demand_gap / booking_declined / join_request), `SupplyNetworkService`
(Haversine + `geocode_cache`), `GoogleOAuthService`/`EncryptionService` (mecânica OAuth),
`ClinicAgendaService.findConflicts`/`checkRoomCapacity` (sala).

## Rotas

**Clínica — `/api/clinic/professional-network/*`** (gate server-side pela flag
`professional_network_enabled`, RN-PN-8; escrita `owner`/`admin`):

| Rota | Papel |
| --- | --- |
| `GET/PUT /settings` | Liga a rede + AutoBooking (`ProfessionalNetworkSettingsService`, único ponto NÃO gated) |
| `GET /professionals/search`, `/by-registration` | Busca de identidade p/ convite |
| `GET /relationships[/:id]` · `POST /relationships` (invite) · `/:id/{accept,revoke}` · `PUT /:id/permissions` | Ciclo do vínculo + acordo financeiro + deslocamento |
| `GET/POST /relationships/:id/offerings` · `DELETE /offerings/:id` · `GET/PUT /relationships/:id/windows` | Serviços ofertados (+sala) + janelas |
| `GET /relationships/:id/availability` · `POST /:id/holds` · `POST /holds/:id/{confirm,release,booking}` | Vagas provadas → hold → confirm → agendamento |
| `POST /relationships/:id/{waitlist,autobook}` · `POST /autobook/:actionId/execute` · `POST /appointments/:id/cancel` | Waitlist · AutoBooking governado · cancelamento |
| `GET/POST /relationships/:id/access-link[/revoke]` | Magic-link do profissional (F7.2) |
| `GET/POST /relationships/:id/google/{status,login-url,disconnect}` | Google Calendar do profissional (F6) |
| `.../finance/statement` · `/appointments/:id/finance` · `/finance/forecast` | Financeiro (role-gated §73) |
| `GET /demand` · `GET/PUT /discovery` · `GET /discovery/specialists` · `POST /discovery/specialists/:pid/invite` | Demanda + descoberta (F9/F10) |

**Profissional — `/api/public/professional/*`** (FORA do `requireAuth`; `requireProfessional`
valida a sessão escopada):

`POST /session` (troca magic-link) · `GET /overview` · `GET /agenda` · `GET /finance` ·
`GET/PUT /relationships/:relId/windows` · `POST /appointments/:apptId/{accept,decline}` ·
`GET/PUT /discovery-profile` · `GET /discovery/clinics` · `POST /discovery/clinics/:orgId/request`.

Callback Google público em `server.ts`: `GET /api/integrations/google/professional-callback`.

## Fluxo ponta-a-ponta

1. **Cadastro** — a clínica ativa a rede → convida (identidade global reusada/criada) →
   aceita → configura serviços ofertados (+sala exigida) e janelas de trabalho.
2. **Agendar** — `getAvailability` prova as vagas (janela − holds − appointments − Google busy
   − sala ocupada − deslocamento de outras clínicas) → `holdSlot` (atômico, AC-012) →
   `confirmBooking` cria o appointment federado + push best-effort pra agenda Google do
   profissional. Sem vaga → `waitlist` (nunca fabrica). **AGENDADO ≠ ATENDIDO**: o
   comparecimento arma `ConfirmationEngine.expect(booking_confirmation)`.
3. **AutoBooking** (opt-in `autobooking_enabled`) — `autoBook` PROPÕE `decision_action`
   `auto_booking` → `DecisionAction→ApprovalPolicy→CommandExecutor→Confirmation`; nunca
   agenda direto fora da banda de autonomia.
4. **Profissional** (webapp `/profissional/:token`) — vê a agenda federada de todas as
   clínicas, o que recebe (F8), edita a própria disponibilidade, aceita/recusa (recusa
   publica `booking_declined`).
5. **Demanda** — o Scheduler publica `demand_gap` quando uma especialidade aperta (proativo,
   self-healing).
6. **Descoberta** — clínica e profissional (ambos opt-in) se acham por especialidade+região →
   `invite`/`requestJoin` → o vínculo segue pelo aceite (descoberta ≠ conexão).

**Passes do `Scheduler.tick`** (best-effort, isolados por org): `professionalHoldSweepPass`
(holds vencidos → expired) · `ProfessionalDemandService.pass` (demand_gap das orgs com a rede
ligada). Timeouts de confirmação: `confirmationTimeoutPass`.

## Guardrails (RN-PN-1..11)

- **RN-PN-1** identidade é do ecossistema (global, zero dado por-org em `professionals`).
- **RN-PN-2** isolamento cross-org — toda query do bridge filtra `organization_id`. Exceção
  MÍNIMA e consciente: o deslocamento (F5.2) lê SÓ o bloco de tempo de atendimentos em outras
  orgs, nunca a clínica de origem nem detalhes.
- **RN-PN-3** sem propriedade — revogar/desligar remove permissões/visibilidade, nunca apaga a
  identidade global.
- **RN-PN-4** disponibilidade é a fonte da verdade — só oferece o que o motor prova; nunca
  inventa vaga, dinheiro (impact null sem prova) nem lei.
- **RN-PN-5** confirmação ≠ agendamento; **AGENDADO ≠ ATENDIDO** (`confirmed`×`completed`).
- **RN-PN-6** AutoBooking é comando GOVERNADO (default exige aprovação humana).
- **RN-PN-7** sem motor/scheduler/policy/confirmation paralelo; sinais em `business_signals`.
- **RN-PN-8** opt-in reversível (`professional_network_enabled`/`autobooking_enabled` default 0).
- **RN-PN-9** descoberta é opt-in dos DOIS lados (default OFF; desligar tira do diretório).
- **RN-PN-10** a projeção da descoberta carrega só o tier público (identidade+especialidade+
  região grossa); NUNCA paciente, financeiro, contagem crua de demanda ou o grafo de vínculos.
- **RN-PN-11** descoberta ≠ conexão — o diretório só surface; o vínculo é sempre invite→accept.

## Flags & env

- `organization_settings.professional_network_enabled` (default 0) — liga a rede na clínica.
- `organization_settings.autobooking_enabled` (default 0) — libera o AutoBooking governado.
- `organization_settings.network_discoverable` (default 0) — clínica visível na descoberta.
- `professionals.discoverable` (default 0) — profissional visível na descoberta.
- `clinic_professional_relationships.{commission_percent,commission_beneficiary,tax_withholding_percent,travel_buffer_min}` — acordo financeiro + deslocamento (opt-in).
- Google (F6): `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`APP_URL` (mesma config do
  `GoogleOAuthService`); sem elas, o Google degrada honesto (`google_not_configured`).
- Sessão do profissional: `JWT_SECRET` (escopo `professional_portal`, TTL 12h).

## Rollout (sugerido, por org)

1. `professional_network_enabled = 1` → cadastrar profissional + serviços + janelas.
2. Operar em HOLD→CONFIRM manual (sem AutoBooking) até a agenda estabilizar.
3. Ligar o Google do profissional (F6) → a disponibilidade passa a respeitar a agenda real.
4. `autobooking_enabled = 1` só depois — o AutoBooking nasce exigindo aprovação (Autonomy
   Contract); libere a banda gradualmente.
5. Descoberta por último: `network_discoverable`/`professionals.discoverable` quando quiser
   crescer a rede. Demanda (F9) só rende após dias acumulando (§103).

## Troubleshooting

- **`hold_expired` no confirm** — o hold estourou o TTL (default 15min) entre sugerir e
  confirmar, ou o relógio injetado (testes) não foi threaded no `confirmBooking` (passe
  `nowISO`). Em produção use o fluxo hold→confirm em sequência.
- **`slot_taken`** — corrida na mesma vaga (esperado; só 1 hold vence, AC-012). Reofereça.
- **`outside_working_window`** — a vaga pedida não cai numa janela ativa; revise a config F2.
- **`room_taken`** — a sala exigida (F5.1) está ocupada no horário; escolha outra vaga.
- **Vaga não aparece / a menos que o esperado** — cheque as 5 fontes que a subtraem: holds,
  appointments do vínculo, Google busy (F6.2), sala exigida (F5.1), deslocamento cross-clínica
  (F5.2, `travel_buffer_min`).
- **Google não conecta** — `google_not_configured` (env ausente) ou token vencido sem
  refresh; reconecte via `/relationships/:id/google/login-url`.
- **Profissional não abre o link** — token revogado/expirado (30d); a clínica regenera em
  `/relationships/:id/access-link`. A sessão nunca carrega `organizationId` (é recusada se
  carregar).
- **Financeiro null** — sem preço combinado (`network_service_price`) → gross null; sem
  comissão → split null; sem imposto configurado → líquido = bruto. **null ≠ 0** (nunca inventa).
- **Descoberta vazia** — algum lado não optou (RN-PN-9), a especialidade não casa, ou a região
  filtrou; sem demanda ainda → `insufficient_data`.

## Testes (contrato de regressão)

`test:professional-network` (23) · `test:professional-schedule-config` (20) ·
`test:professional-availability` (27) · `test:professional-booking` (23) ·
`test:professional-network-settings` (11) · `test:professional-finance` (24) ·
`test:professional-finance-forecast` (23) · `test:professional-google` (20) ·
`test:professional-availability-google` (6) · `test:professional-google-sync` (9) ·
`test:professional-rooms` (8) · `test:professional-travel` (10) ·
`test:professional-selfservice` (19) · `test:professional-access-link` (11) ·
`test:professional-availability-write` (8) · `test:professional-booking-response` (10) ·
`test:professional-demand` (10) · `test:professional-demand-gap` (8) ·
`test:professional-discoverability` (9) · `test:clinic-discovery` (11) ·
`test:professional-discovery` (12) · `test:professional-discovery-connect` (11).

ADR: `docs/adr/ADR-180-professional-identity-federated-calendar.md`. Auditorias:
`docs/professional-network/codebase-audit.md` (F0) · `f10-discovery-audit.md` (F10.0).
