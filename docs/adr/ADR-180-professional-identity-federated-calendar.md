# ADR-180 — Professional Identity & Federated Calendar (Agenda Federada)

- **Status:** ABERTO — F0 (auditoria + ADR, doc-only). Plano F0–F4 (MVP) + fatias diferidas.
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
- **F1 — Identidade cross-org + relacionamento.** Tabelas `professionals` (global) +
  `clinic_professional_relationships` (bridge). Convite/aceite/revogação.
  `ProfessionalService` + `ClinicProfessionalRelationshipService`. Flag
  `professional_network_enabled`. Testes de isolamento cross-org.
- **F2 — Serviços + janelas de disponibilidade.** Quais serviços o profissional presta em
  cada clínica; janelas de trabalho + buffers por profissional/clínica.
- **F3 — Availability Engine + Hold + confirm atômico.** Estende
  `ClinicScheduleSessionService.availability` com janelas/buffers; `clinic_slot_holds`;
  confirm atômico (template `addParticipant`); teste de concorrência (2 confirms na mesma vaga).
- **F4 — UI da clínica + ferramentas de IA + AutoBooking.** Ferramentas
  `getProfessionalAvailability` / `holdSlot` / `confirmBooking`; Fala Tu; AutoBooking via
  handler `auto_booking` na espinha de governança; waitlist em `business_signals`;
  teste anti-alucinação (IA nunca oferece vaga inexistente).

**DEFERIDO (fora do MVP):**

- **F5** — Recursos (salas/equipamentos) + deslocamento entre clínicas.
- **F6** — Google Calendar por profissional (escopo calendar-only, eventos próprios, `getBusy`).
- **F7** — Webapp de autoatendimento do profissional (login, agenda própria).
- **F8** — Finanças (comissão split clínica×profissional, impostos retidos, previsão de receita).
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
