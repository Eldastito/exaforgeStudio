# Auditoria F0 — Federação OAB para a vertical Advocacia (ADR-191 × ADR-180)

**Natureza:** doc-only. Mapeia como o **advogado** da vertical Advocacia (hoje um
`clinic_professional` por-org, ADR-191 F3) se conecta à **identidade global federada**
da Agenda Federada (ADR-180), permitindo que o MESMO advogado trabalhe em VÁRIOS
escritórios com uma disponibilidade única que todos respeitam. Diferido nº 3 do ADR-191.

> **Decisão de fronteira herdada (ADR-180 §90):** o profissional pertence ao ECOSSISTEMA,
> não a um escritório. O escritório tem RELACIONAMENTO + permissões, não propriedade.
> Espelha o precedente da clínica veterinária (especialistas que atendem em várias clínicas).

---

## 1. O que JÁ existe (a ADR-180 está fechada e é reusável)

A dor da federação OAB é **estruturalmente idêntica** à da clínica vet, e a ADR-180
resolveu-a por completo. **Veredito: ~90% composição — a chave natural já bate.**

| Peça da ADR-180 | Papel | Aproveitamento p/ Advocacia |
| --- | --- | --- |
| `professionals` (GLOBAL, sem `organization_id`) — chave `UNIQUE(council, registration_number)` | Identidade do profissional no ecossistema | **DIRETO** — a OAB é exatamente `council='OAB'` + `registration_number`; a chave natural já é a mesma que a ADR-191 F3 grava em `clinic_professionals` |
| `ProfessionalService.upsertIdentity` / `findByRegistration` | Find-or-create idempotente por conselho+registro (RN-PN-3: nunca sobrescreve com vazio) | **DIRETO** — recebe `{council:'OAB', registrationNumber, name}` |
| `clinic_professional_relationships` (bridge por-org) + `ClinicProfessionalRelationshipService` (`invite`/`accept`/`revoke`/`setPermissions`) | Relação escritório↔advogado (convite→aceite→revogação; revogar não apaga a identidade) | **DIRETO** — a tabela é genérica (não é clínica-específica no vocabulário) |
| `ProfessionalScheduleConfigService` (janelas + buffer + ofertas) | Disponibilidade configurada do profissional por vínculo | **COMPÕE** — as "ofertas" seriam os serviços jurídicos; janelas semanais idem |
| `ProfessionalAvailabilityService` (`availableSlots` + `hold` atômico + TTL) | Vagas provadas (janela × conflito × buffer × deslocamento × Google) | **COMPÕE** — núcleo síncrono/puro, agnóstico de vertical |
| `ProfessionalBookingService` (`getAvailability`/`holdSlot`/`confirmBooking`/`autoBook` governado) | Agendamento federado aterrado, anti-alucinação | **COMPÕE** — cria `appointment` amarrado ao vínculo |
| `ProfessionalFinanceService` (read-model de comissão/split) | Acerto por atendimento federado | **COMPÕE** — já existe (F8 da ADR-180) |
| `ProfessionalDiscoveryService` / `ProfessionalDemandService` | Descoberta cross-org + demanda | **COMPÕE** (opt-in) |
| `ProfessionalGoogleService` / `ProfessionalSelfService` / `ProfessionalAuthService` | Google Calendar global · portal do profissional · magic-link | **COMPÕE** |
| Flags `professional_network_enabled` + `autobooking_enabled` (`ProfessionalNetworkSettingsService`) | Opt-in por-org, default 0 | **DIRETO** — os mesmos gates |

**Conclusão:** não há motor novo a construir. Federação OAB = **LIGAR o advogado da
Advocacia à identidade global** (a única peça que falta é a *ponte* entre
`clinic_professionals` da Advocacia e `professionals` global) e **expor as superfícies
federadas na `AdvocaciaView`**.

## 2. A única lacuna real — a ponte de identidade

Hoje o advogado da Advocacia (ADR-191 F3) é criado por `LegalPracticeService.createLawyer`
→ `ClinicAgendaService.createProfessional` com `council='OAB'` + `registration_number` em
`clinic_professionals`. Isso é um registro **por-org**, sem link com `professionals` global.

A ADR-180 nasceu na clínica vet, onde `professionals` global e o `clinic_professional`
per-org convivem via o bridge `clinic_professional_relationships`. **Não há hoje uma
função que, dado um `clinic_professional` com OAB, garanta a identidade global e o
vínculo.** Essa é a ponte a construir (uma, pequena):

- `LegalProfessionalFederationService.federate(orgId, lawyerId)`:
  1. lê o `clinic_professional` (valida `council='OAB'` + `registration_number` presentes);
  2. `ProfessionalService.upsertIdentity({council:'OAB', registrationNumber, name})` → identidade global (idempotente);
  3. `ClinicProfessionalRelationshipService.invite/accept` para ESTE org → vínculo `accepted`;
  4. devolve `{professional, relationship}`. Idempotente (re-federar não duplica).
- `status(orgId, lawyerId)` → `{federated, professionalId, relationshipId}`.
- `defederate(orgId, lawyerId)` → `revoke` do vínculo (RN-PN-3: **não** apaga a identidade global; o advogado continua existindo pro ecossistema e pros outros escritórios).

Nada disso é motor novo — é orquestração das peças da ADR-180.

## 3. Decisões (D1–D6)

- **D1** — Federação COMPÕE a ADR-180 inteira; a única peça nova é a *ponte de identidade* (§2). Zero motor/scheduler/policy/confirmation novo (§184).
- **D2** — Chave natural = **OAB** (`council='OAB'` + `registration_number`), idêntica à `UNIQUE(council,registration_number)` global. Advogado sem OAB válida NÃO federa (RN-ADV-08 já valida a OAB na F3).
- **D3** — Opt-in por `professional_network_enabled` (default 0). Desligado, a Advocacia opera 100% como hoje (advogado per-org). 0-regressão.
- **D4** — Federar é **aditivo e reversível**: o `clinic_professional` per-org continua sendo o que a agenda/processos referenciam; a federação só ADICIONA o link global + vínculo. `defederate` revoga o vínculo, nunca apaga identidade (RN-PN-3).
- **D5** — A disponibilidade federada (janelas, hold, autobooking) reusa `ProfessionalAvailabilityService`/`ProfessionalBookingService` SEM fork; as "ofertas" mapeiam pros serviços jurídicos (áreas/consultas). Autobooking segue GOVERNADO (RN-PN-6).
- **D6** — Privacidade cross-org herda RN-PN-2 (o vínculo de um escritório nunca vaza paciente/cliente/financeiro pro outro); a exceção mínima é o bloco de tempo pro cálculo de conflito (já implementado na ADR-180 F5.2).

## 4. Guardrails (herdados RN-PN-1..11)

1. Identidade global sem `organization_id` (RN-PN-1) — já é assim.
2. Relação isolada por org (RN-PN-2) — bridge já isola.
3. Revogar vínculo ≠ apagar identidade (RN-PN-3) — `defederate` respeita.
4. Nunca inventa vaga (RN-PN-4) — `availableSlots` já prova.
5. AGENDADO ≠ ATENDIDO (RN-PN-5) — status do appointment.
6. Autobooking é COMANDO GOVERNADO (RN-PN-6) — DecisionAction→ApprovalPolicy→CommandExecutor.
7. Demanda sem vaga → `business_signals`, nunca fabrica (RN-PN-7).
8. Gate server-side pela flag (RN-PN-8).
9. Descoberta é opt-in dos 2 lados (RN-PN-9), nunca vaza privado (RN-PN-10), descoberta ≠ conexão (RN-PN-11).
+ RN-ADV-08 (OAB validada, nunca inventada) na entrada da ponte.

## 5. Plano de fatias (proposto)

- **OAB-F0** auditoria + esta doc (**esta fatia**, doc-only).
- **OAB-F1** `LegalProfessionalFederationService` (`federate`/`status`/`defederate`) — a ponte de identidade (§2) + `test:legal-federation` (idempotência, OAB obrigatória, defederate preserva identidade, isolamento). Rotas `/api/advocacia/lawyers/:id/federation*`.
- **OAB-F2** ofertas + janelas do advogado federado na Advocacia (reuso `ProfessionalScheduleConfigService`), mapeando serviços jurídicos.
- **OAB-F3** disponibilidade + agendamento federado a partir da Advocacia (reuso `ProfessionalAvailabilityService`/`ProfessionalBookingService`), amarrado a `legal_cases` quando aplicável.
- **OAB-F4** UI: seção "Rede/OAB" no detalhe do advogado (Configuração) — federar/ver status/defederar + (quando F2/F3) janelas e vagas.
- **OAB-F5** hardening (`test:advocacia-federation-hardening` codifica RN-PN no contexto advocacia) + nota no runbook.

**Diferidos do diferido:** portal do advogado (self-service ADR-180 F7) para a Advocacia · descoberta cross-escritório (ADR-180 F10) para a Advocacia — só quando o núcleo OAB-F1..F3 provar valor.

## 6. Pré-condições e riscos

- **Pré-condição atendida:** a ADR-180 está FECHADA (F0–F10 + finanças) e as peças estão importáveis.
- **Risco baixo:** a ponte é pequena e reusa `upsertIdentity` (idempotente, RN-PN-3 embutido) + o bridge; o resto é composição já provada.
- **Risco a vigiar:** o vocabulário do bridge (`clinic_professional_relationships`, "permissions.services") é clínico; para a Advocacia isso é só rótulo — NÃO renomear a tabela (aditivo estrito). A UI usa a terminologia `legalTerms`.
- **Sem dependência de terceiro** (diferente da integração com tribunais). É trabalho autocontido.
