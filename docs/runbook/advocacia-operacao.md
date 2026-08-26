# Runbook — Vertical Advocacia (ADR-191)

Operação da vertical **Escritório de Advocacia**. Vertical de 1ª classe que **COMPÕE**
módulos existentes (agenda + CRM + documentos + financeiro + tarefas) com duas bordas
novas de engenharia: **contagem de prazos em dias úteis** e a **entidade processo (CNJ)**.
Tudo isolado por `organization_id`, aditivo/reversível, opt-in.

## Mapa dos serviços

| Fatia | Serviço | Papel | Reuso |
| --- | --- | --- | --- |
| F1 | `verticals.ts` (`advocacia`) | preset da vertical + consentimentos (`dados_pessoais`/`comunicacoes`/`sigilo_profissional`) | `ModuleService.applyVertical` |
| F2 | `src/lib/legalTerms.ts` | terminologia (cliente/advogado/área/processo/prazo/audiência), gate `isLegal` | espelha `clinicTerms` |
| F3 | `LegalPracticeService` | áreas do direito + advogados (OAB validada) | `clinic_specialties` + `clinic_professionals` (composição pura, 0 tabela) |
| F4 | `LegalCaseService` | **processo** (`legal_cases`) + número **CNJ validado** (mód. 97) | modelado no `clinic_care_episodes` |
| F5 | `LegalDeadlineService` | **prazos** em dias úteis + feriados forenses + sinal fatal | `tasks` (materialização) + `business_signals` |
| F6 | `LegalHearingService` | **audiências/reuniões** amarradas ao processo | `appointments` (`legal_case_id`/`hearing_type`) |
| F7 | `LegalDocumentService` | **documentos** (petição/contrato/procuração) congelados | `computeDocumentHash`/`verifyPin`/PDF do `ClinicDocumentsService` |
| F8 | `LegalFeeService` | **honorários** fixo/avença | `receivables` (`FinancialLedgerService`) + `subscriptions` (`SubscriptionService`) |
| F9 | `LegalPrivilegeService` | **sigilo** profissional (gate LGPD opt-in nos documentos) | `contact_consents` via `LgpdService` |

## Rotas (`/api/advocacia/*`, montadas em `server.ts`)

- **Áreas/advogados**: `GET/POST /practice-areas`, `/practice-areas/seed-defaults`, `GET/POST /lawyers`, `GET/PUT /lawyers/:id/areas`.
- **Processos**: `GET /cases[/:id]`, `POST /cases`, `/cases/:id/{transfer,phase,close,reopen}`.
- **Prazos**: `GET/POST /holidays`, `/holidays/seed/:year`, `POST /deadlines/preview`, `GET/POST /deadlines`, `/deadlines/:id/{complete,cancel}`.
- **Audiências**: `GET /hearings[/:id]`, `POST /hearings`, `/hearings/:id/{reschedule,complete,cancel}`.
- **Documentos**: `GET /documents[/:id]`, `POST /documents`, `PUT /documents/:id`, `/documents/:id/{issue,cancel}`, `GET /documents/:id/pdf`.
- **Honorários** (role-gated, owner/admin): `GET /fees`, `/fees/statement`, `POST /fees/{fixed,retainer}`, `/fees/:id/{pay,cancel}`.
- **Sigilo** (owner/admin): `GET /privilege`, `POST /privilege/enable`, `GET /clients/:contactId/sigilo`, `POST /clients/:contactId/sigilo/{grant,revoke}`.

## Passes do Scheduler (best-effort, só orgs `vertical='advocacia'`)

- `LegalDeadlineService.pass()` → sinaliza prazos fatais vencendo/vencidos (`business_signals`, domain `legal`, `deadline_due`).
- `LegalHearingService.pass()` → sinaliza audiências próximas/passadas sem baixa (`business_signals`, `hearing_upcoming`).

Ambos com **self-heal**: concluir/cancelar resolve o sinal (`resolveByDedupe`).

## Fluxo típico

1. Dono escolhe a vertical `advocacia` → preset + consentimentos semeados.
2. Cadastra áreas do direito (ou `seed-defaults`) e advogados (OAB validada).
3. Abre o **processo** (`legal_cases`) — CNJ opcional, **validado pelo dígito verificador**; cliente/área/advogado do CRM.
4. Registra **prazos** a partir da publicação/intimação → data-fim **derivada** (dias úteis) + **tarefa** materializada pro responsável. Prazo fatal perto → aparece na atenção.
5. Agenda **audiências** amarradas ao processo (reuso da agenda). Audiência próxima → atenção.
6. Redige **documentos**; ao **emitir**, congela snapshot + hash (opcional PIN do advogado).
7. Lança **honorários** (fixo→recebível / avença→assinatura); acompanha o **extrato** por processo/cliente.
8. (Opcional) Liga o **sigilo**: conteúdo dos documentos só é exposto com o consentimento do cliente.

## Guardrails RN-ADV (codificados em `test:advocacia-hardening`)

1. **Isolamento multi-tenant** — toda query filtra `organization_id`.
2. **Nunca inventa prazo** — sem calendário carregado → `holidaysLoaded=false` (a UI avisa; humano confirma).
3. **Prazo em dias úteis** — CPC 219/224: exclui o começo, inclui o vencimento, protrai p/ dia útil; feriados forenses (fixos + móveis via Páscoa + recesso art. 220).
4. **Prazo fatal na espinha** — vencimento próximo/vencido publica `business_signals` (convenção nº 12), nunca alerta paralelo.
5. **Sigilo profissional** — documentos do caso gated por consentimento (opt-in `advocacia_sigilo_enabled`).
6. **Documento congelado** — petição/contrato emitido congela snapshot + hash; renomear cliente/negócio depois não altera o doc.
7. **Nunca inventa dinheiro** — honorário sem valor acordado é rejeitado; extrato sem honorário → totais `null`, nunca R$ 0,00.
8. **CNJ validado, não inventado** — dígito verificador (mód. 97); DV errado ou dígitos≠20 rejeitados; ausente fica `null`.
9. **Aditivo/reversível/opt-in** — tudo por flag; desligar preserva histórico (nunca DELETE; cancelamento é UPDATE).

## Diferidos (não bloqueiam o núcleo)

- Honorário **por-hora** (timesheet) · honorário de **êxito** (success fee).
- **Federação OAB** (ADR-180 — advogado global, agenda federada entre escritórios).
- **Integração com tribunais** (PJe/e-SAJ — depende de terceiro).

## Troubleshooting

- **Prazo com data-fim "suspeita"** → confira `holidays_loaded`: se `false`, o ano não tem calendário semeado (`POST /holidays/seed/:year`).
- **CNJ recusado** → dígito verificador não confere ou não tem 20 dígitos; conferir o número na fonte (nunca fabricar).
- **PDF/documento retorna 403** → sigilo ligado e cliente sem consentimento; conceder em `POST /clients/:id/sigilo/grant`.
- **Extrato com totais `null`** → não há honorário ativo (comportamento honesto — não inventa R$ 0,00).
- **Conflito ao agendar audiência** → advogado já tem compromisso no horário; `force=true` mantém.
