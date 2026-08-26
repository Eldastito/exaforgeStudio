# ADR-191 — Vertical Escritório de Advocacia

**Estado:** **F0–F4 FECHADAS (#1358–#1362). F5 (prazos / dias úteis) EM PR.**
**Data:** 2026-08-26.
**Natureza:** vertical de 1ª classe que **COMPÕE** módulos existentes (agenda + CRM + documentos +
financeiro + tarefas + o modelo longitudinal da clínica), sem motor novo onde já há um. Espelha o
precedente **Vertical Petshop** (que compôs varejo + clínica + serviços). Duas bordas
genuinamente novas exigem engenharia real: (a) **contagem de prazos em dias úteis** com calendário
de feriados forenses (crítico — perder prazo é erro profissional); (b) a **entidade processo**
(número CNJ + vocabulário processual + documentos jurídicos).
Convenções herdadas: isolamento por org, CREATE-then-ALTER estrito, opt-in por flag, aditivo/
reversível, `business_signals` (nunca alerta paralelo), nunca inventa (dado/lei/prazo/dinheiro).
**O CEO Operating Layer (ADR-190) é horizontal — a vertical o ganha de graça** (lê os mesmos
`business_signals`/metas/snapshot).

---

## 1. Auditoria F0 — o que já existe (matriz compõe × novo)

Reconhecimento sobre o monolito (`src/server/*.ts` + `db.ts`, tudo por `organization_id`).
**Veredito: ~80% composição.** Só duas áreas precisam de engenharia nova.

| # | Necessidade jurídica | Reuso | Veredito |
| --- | --- | --- | --- |
| 1 | Config da vertical | `src/server/verticals.ts` (`VERTICALS[]`, `CONSENT_BY_VERTICAL`, `ModuleService.applyVertical`) | **COMPÕE** — nova chave `advocacia` |
| 2 | Cliente | `contacts` (`db.ts:37`) — sujeito universal | **COMPÕE** (+ campos CPF/CNPJ opcionais) |
| 3 | Advogado | `clinic_professionals` (`db.ts:2603`; nome/especialidade/PIN/user_id) — o que a agenda/episódio referenciam. Federado OAB (`professionals` global, ADR-180, `council`+`registration_number`) fica como opção futura | **COMPÕE** (OAB como campo; federação depois) |
| 4 | Área do direito | `clinic_specialties` (`db.ts:2735`: name/code/color/duração) + N:N `clinic_professional_specialties` | **COMPÕE** (relabel via terminologia) |
| 5 | Processo/caso | `clinic_care_episodes` (`db.ts:2796`: longitudinal, status, profissional responsável, transferências) é o **análogo estrutural** | **NOVO edge** — tabela `legal_cases` modelada nela (não sobrecarregar a clínica); + número CNJ + vocabulário processual |
| 6 | Audiências/reuniões | `appointments` + `AppointmentService`/`ClinicAgendaService` | **COMPÕE** |
| 7 | **Prazo processual** | `tasks` + `TaskRecurrenceService` + `TaskReminderService` (materialização/lembrete) | **NOVO edge CRÍTICO** — a contagem em **dias úteis** com **feriados forenses** NÃO existe (grep zero por holiday/feriado/dia útil). Materializa em `tasks`, mas o CÁLCULO é novo |
| 8 | Documentos (petição/contrato/procuração) | Infra de `ClinicDocumentsService`: draft→issued, snapshot canônico, `computeDocumentHash` (SHA-256), assinatura por PIN, entrega HMAC signed-URL, PDF | **COMPÕE o motor; NOVO schema** — não há tabela genérica de templates; tipos jurídicos novos |
| 9 | Honorários | `receivables` (fixo) + `subscriptions` (avença mensal) + `FinancialLedgerService` | **COMPÕE** fixo/avença; **NOVO edge** por-hora (timesheet) + êxito (success fee) — DEFERIDOS |
| 10 | Sigilo profissional (LGPD) | `contact_consents` + `LgpdService.hasConsent` (gate `dados_sensiveis` é o mecanismo exato) | **COMPÕE o mecanismo; NOVA categoria** `sigilo_advogado_cliente` (base legal: exercício de direitos, não saúde) |
| 11 | Terminologia | `src/lib/clinicTerms.ts` (pura, pet/tutor × paciente/responsável) | **COMPÕE o padrão** — `legalTerms`: cliente/advogado/área/processo/encerramento |

## 2. Decisões (D1–D8)

- **D1** — Vertical COMPÕE; nada de motor novo onde já há um (agenda/CRM/financeiro/documentos/tarefas).
- **D2** — Processo = **nova tabela `legal_cases`** modelada em `clinic_care_episodes` (não sobrecarregar a clínica — o vocabulário processual difere do clínico). Número CNJ com validação de formato.
- **D3** — **Prazo processual = novo motor de contagem** (calendário de feriados + dias úteis) que MATERIALIZA em `tasks`/lembretes (reuso do runtime de tarefas). NUNCA inventa prazo: sem regra/base legal conhecida → exige entrada humana. Prazo fatal sinaliza em `business_signals` (nunca alerta paralelo).
- **D4** — Áreas do direito = `clinic_specialties` reusadas; advogados = `clinic_professionals` (OAB como campo). Federação OAB (ADR-180) fica pra depois.
- **D5** — Documentos jurídicos reusam a infra de hash/PIN/HMAC/PDF; schemas novos por tipo (petição/contrato/procuração).
- **D6** — Sigilo = nova categoria de consentimento reusando o gate; base legal jurídica (não saúde).
- **D7** — Honorário fixo→`receivables`, avença→`subscriptions`. Por-hora + êxito DEFERIDOS (bordas novas, não bloqueiam o núcleo).
- **D8** — CEO Operating Layer (ADR-190) é horizontal: a vertical o herda sem trabalho.

## 3. Guardrails RN-ADV-01..09

1. **Isolamento multi-tenant** — toda query filtra `organization_id`.
2. **Nunca inventa prazo** — sem regra/base legal → entrada humana obrigatória; a IA sugere, o advogado confirma.
3. **Prazo em dias úteis** — contagem respeita feriados forenses + suspensões; corridos só quando a lei manda.
4. **Prazo fatal na espinha** — vencimento próximo publica `business_signals` (convenção nº 12), nunca tabela de alerta paralela.
5. **Sigilo profissional** — documentos do caso gated por consentimento (mecanismo LGPD).
6. **Documento congelado** — petição/contrato emitido congela snapshot + hash (renomear cliente depois não altera o doc).
7. **Nunca inventa dinheiro** — honorário sem valor acordado → `null`, não 0.
8. **CNJ validado, não inventado** — número de processo valida formato; ausente fica em branco, nunca fabricado.
9. **Aditivo/reversível/opt-in** — tudo por flag; desligar preserva histórico.

## 4. Plano de fatias (F0–F10)

- **F0** auditoria + ADR (**esta fatia**, doc-only).
- **F1 (EM PR)** vertical `advocacia`: chave em `verticals.ts` (`VerticalKey` + preset prestador-de-serviço `agenda/vendas/pagamentos/campanhas/cadencias/areas/integracoes/assinaturas/diretor/rie/execucao` — sem varejo, sem `clinica`) + `CONSENT_BY_VERTICAL['advocacia']` = `dados_pessoais/comunicacoes/sigilo_profissional` (sigilo NÃO é `dados_sensiveis` — base é exercício de direitos + EOAB Art.34; gate na F9). Features legais são GATED pela vertical, não por módulo novo (padrão petshop). `test:advocacia-vertical` (15).
- **F2 (EM PR)** terminologia (`src/lib/legalTerms.ts`, função PURA espelhando `clinicTerms`): cliente/advogado/área do direito/processo/encerramento/prazo/audiência + gate `isLegal` (só `advocacia` ativa as features legais nas views, como `clinicTerms.isPet`). Só rótulos, 0 comportamento. `test:legal-terms` (14).
- **F3 (EM PR)** `LegalPracticeService` — COMPOSIÇÃO PURA (zero tabela nova): áreas do direito reusam `clinic_specialties` (via `ClinicSpecialtyService`, + seed de 8 áreas comuns idempotente) e advogados reusam `clinic_professionals` (via `ClinicAgendaService`) — a OAB cabe nas colunas `council`+`registration_number` já existentes (`council='OAB'`), VALIDADA (UF+número), nunca inventada; vínculo advogado↔área reusa o N:N `clinic_professional_specialties`. Rotas em `/api/advocacia/*` (namespace próprio — o `/api/legal` é a Consultora CDC/Trabalhista). `test:legal-practice-areas` (13).
- **F4 (EM PR)** `legal_cases` (processo) — 1ª borda nova: tabela PRÓPRIA modelada no `clinic_care_episodes` (D2, não sobrecarrega a clínica) com vocabulário processual. `LegalCaseService`: abrir/get/listar(cliente/advogado/status)/transferir/fase/encerrar/reabrir (histórico preservado, nunca DELETE). **Número CNJ validado pelo DÍGITO VERIFICADOR (módulo 97, ISO 7064 / Res. CNJ 65)** — DV errado ou dígitos≠20 rejeitados; ausente=null (consultivo/pré-processual); nunca inventado (RN-ADV-08). Unique parcial `(org, cnj_number)`. Cliente/área/advogado validados (reuso F3). Rotas `/api/advocacia/cases*`. `test:legal-case` (21).
- **F5 (EM PR)** **Prazos** — 2ª borda nova, a MAIS crítica: `legal_holidays` (calendário forense POR-ORG) + `legal_deadlines` + `LegalDeadlineService`. Motor de contagem em DIAS ÚTEIS (CPC 219/224: exclui o começo, inclui o vencimento, protrai p/ dia útil) a partir da publicação/intimação; modo `calendar` (corridos) tb. Feriados: seed determinístico nacionais fixos + MÓVEIS via Páscoa (Meeus) + recesso forense (art. 220), editável — nunca inventa (RN-ADV-02/03: sem cobertura → `holidaysLoaded=false`, a UI avisa). Cria → materializa `task` (reuso ADR-171) pro advogado responsável + `signalFatal`/`pass` publica `business_signals` (domain `legal`) no prazo fatal perto/vencido (self-heal ao concluir). Rotas `/api/advocacia/{holidays,deadlines}*` + preview. 2 tabelas novas. `test:legal-deadline` (22).
- **F6** audiências/reuniões (reuso agenda) amarradas ao processo. `test:legal-hearing`.
- **F7** documentos jurídicos (petição/contrato/procuração) reusando hash/PIN/HMAC/PDF. `test:legal-documents`.
- **F8** honorários fixo (`receivables`) + avença (`subscriptions`) por processo/cliente. `test:legal-fees`.
- **F9** sigilo (categoria de consentimento + gate nos documentos do caso). `test:legal-privilege`.
- **F10** hardening (`test:advocacia-hardening` codifica RN-ADV) + runbook `docs/runbook/advocacia-operacao.md`.

**Diferidos:** honorário por-hora (timesheet) · honorário de êxito (success fee) · federação OAB (ADR-180) · integração com tribunais (PJe/e-SAJ — depende de terceiro).

## 5. Defaults honestos adotados (o dono veta na revisão do F0)

`advogado` = modelo simples per-org (`clinic_professionals`), OAB como campo, federação depois ·
`processo` = nova `legal_cases` (não reusa episódio clínico) · `área do direito` = `clinic_specialties`
reusada · `prazo` = motor novo de dias úteis + feriados · `sigilo` = categoria de consentimento nova ·
honorário por-hora/êxito = diferidos (não bloqueiam o núcleo).
