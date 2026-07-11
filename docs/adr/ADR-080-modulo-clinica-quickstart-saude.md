# ADR-080 — Módulo Clínica + Quick-Start Saúde / Clínica 2.0

**Status:** Aceito (implementação em fases A–E, ver plano abaixo).

**Origem:** PRD "Quick-Start Saúde / Clínica 2.0 / 2.1" (Agenda Clínica Inteligente + Convênios + Autorização de Procedimentos), a partir de dores reais de uma clínica: sistema de agenda que apaga o paciente quando excede o tempo, ausência de aviso "o paciente continuará?", impossibilidade de editar o plano sem apagar e recriar o paciente, e a necessidade de operar com muitos profissionais (agenda por link, impressão manual). O PRD propõe transformar o Quick-Start Saúde num setup operacional de clínica.

---

## Contexto

### O que o inventário mostrou (antes de escrever código)

O PRD assume que "a fundação técnica já existe" e trata a evolução como `ALTER TABLE` + um retoque no pack Saúde. O código conta outra história:

- **Quick-Start / `OnboardingTemplateService`**: só sabe semear **áreas, cadências, automações (flags em `organization_settings`) e FAQ→RAG**, idempotente por nome. Não cria telas, ficha de paciente nem fluxo de autorização. A rota `/api/quickstart/apply` **não tem RBAC** — qualquer usuário autenticado aplica um pack. O pack `saude` hoje: 2 áreas (Recepção, Pós-consulta), 2 cadências (`agendado`, `entregue_concluido`), automações genéricas, 1 FAQ.
- **Agenda**: é uma **lista simples** (`AgendaView.tsx`), não um agendador. Sem grade dia/semana, sem colunas por profissional, sem filtros, sem impressão. `appointments.assigned_to` **está morto** (nunca é escrito; o `PATCH` nem o expõe). **Não existe "sala"**. Duração é **global da org** (`agenda_slot_minutes`), não por consulta. Não há check-in/início/fim. Conflito só por **capacidade agregada da org** (`AppointmentService.isFree`), e a criação nem valida.
- **Cadências**: `trigger_stage` é uma **string acoplada ao `stage` do ticket**. Os gatilhos clínicos do PRD (`autorizacao_pendente`, `autorizacao_aprovada`, `documentacao_pendente`, `retorno_recomendado`) não são estágios de ticket — cadastrar a cadência **não a faz disparar** sem código no ponto de transição.
- **Infra transversal pronta e reaproveitável**: `EncryptionService.encrypt/decrypt/hash` (ADR-054) para credenciais de operadora; `logAuthEvent` → `auth_audit_logs` para auditoria; padrão de portal público por token aleatório + SHA-256 + expiração (`RadarPublicService`) para o portal do profissional; `ReportPdfService` (pdfkit) para impressão; **socket.io** (salas `org:`) para tempo real.
- **TISS / TUSS / convênio / autorização de procedimento**: **greenfield total** — nada existe.
- **Roles**: `owner`/`admin`/`agent`. Não existe tipo "profissional". A agenda está atrás do módulo `agenda`, que a vertical `saude` já habilita.

### Restrição de produto

Clínica lida com **dado sensível de saúde** (LGPD Art. 11): CPF, carteirinha, plano, procedimento. Isso eleva o rigor de isolamento, criptografia, auditoria de leitura/exportação e acesso por token sem dado em URL.

## Decisão

### D1. Um módulo `clinica` novo; o Quick-Start é o interruptor + a semente, não o dono da funcionalidade

O `OnboardingTemplateService` **não** vira o lar da agenda/ficha/autorização. Criamos um **módulo opcional `clinica`** (registrado em `OPTIONAL_MODULES`, `ModuleService.MODULE_BY_ROUTE`, e no preset da vertical `saude`), gated como os demais. O **Quick-Start Saúde 2.0** passa a **ativar o módulo e semear o conteúdo inicial** (áreas, cadências, FAQ, flags `clinic_*`). A funcionalidade (agenda clínica, ficha, autorização) vive no módulo, com suas tabelas, rotas e telas.

### D2. Profissional é entidade própria (`clinic_professionals`), desacoplada de login

Clínica tem muitos profissionais, a maioria **sem** conta no painel. Criamos `clinic_professionals` (nome, especialidade, cor, ativo) **desacoplada de `users`**, com **link opcional** para um `user` quando o profissional precisar do portal. Não reusar `users` (evita gastar `users_limit` do plano e misturar quem opera o sistema com quem só aparece na agenda). `appointments.assigned_to` (morto) é substituído por `professional_id` referenciando essa tabela, com snapshot de nome.

### D3. Nunca apagar por tempo; alerta de permanência derivado no cliente

O ZappFlow **já** é seguro quanto a "apagar paciente por tempo excedido" — nenhum job toca o ciclo do agendamento por tempo. O trabalho é **duração por consulta** (coluna nova, sem teto de 150 min) + status `over_time` (nunca exclusão). O **alerta visual** ("faltam 15 min / excedeu") é **calculado no navegador** a partir de `scheduled_end` num timer local — **sem job no Scheduler**. O socket.io só empurra mudanças quando outra recepção faz check-in/estende. A cadência de WhatsApp de autorização é assunto separado.

### D4. Autorização assistida primeiro; TISS depois, em ADR próprio

O MVP de convênios é **autorização assistida/manual**: `procedure_authorization_requests` (registro + máquina de status + checklist de documentos + acompanhamento de protocolo), operadoras e procedimentos/TUSS cadastrados manualmente. **Sem** XML/WebService/API no começo. Credenciais de operadora cifradas com `EncryptionService`. Conectores TISS (XML/WebService/API por operadora, com certificado digital A1/A3) ficam para um ADR futuro — é o Nível 2/3 do gateway do PRD, com peso de segurança próprio. Promessa comercial honesta: "centralizamos e preparamos a autorização; onde houver integração, enviamos; onde não, deixamos pronto para envio manual".

### D5. Gatilhos clínicos precisam de ponto de disparo, não só cadastro

As cadências novas (`documentacao_pendente`, `autorizacao_pendente`, `autorizacao_aprovada`, `autorizacao_negada`, `retorno_recomendado`) exigem **código** que, na transição de status da autorização/documentação, chame `CadenceService.startForTicket(...)` com o gatilho. O dropdown `STAGE_LABELS` (`CadencesView.tsx`), hoje dessincronizado dos estágios reais, é atualizado para expor os novos gatilhos.

### D6. Snapshot de plano é imutável

`appointments.patient_plan_snapshot` **congela** o plano no momento da autorização (auditoria do que foi cobrado). A troca de plano atualiza a **ficha** (`patient_profiles`, fonte da verdade) e registra `patient_plan_history`; agendamentos futuros leem o plano atual até serem autorizados, quando congelam. O snapshot nunca "muta" retroativamente.

### D7. Guardrails de IA e dado sensível

A IA pode coletar dados, listar documentos necessários, identificar pendências, resumir status e preparar a solicitação para revisão. A IA **não** dá diagnóstico, não interpreta exame, não promete cobertura/autorização, não inventa TUSS e **não envia autorização sem revisão humana no MVP**. Ficha em tabela satélite; credenciais cifradas; portal por token (sem dado sensível em URL); auditoria em criação/edição/troca de plano/autorização/check-in/extensão/finalização/impressão-exportação.

### D8. RBAC no Quick-Start (corrige bug pré-existente)

`/api/quickstart/apply` passa a exigir `requireRole("owner","admin")` — aplicar um setup clínico (que sobrescreve automações e semeia áreas) não pode ficar aberto a qualquer `agent`.

### D9. Plano de implementação em fases (substitui o "tudo de uma vez" do PRD)

- **Fase A — Pack Saúde 2.0 (pequena, valor imediato):** 4–5 áreas com persona (Recepção Clínica, Convênios e Autorizações, Pós-consulta/Retorno, Financeiro/Particular, Coordenação de Agenda), 7 cadências (textos), FAQ ampliado, flags `clinic_*` em `organization_settings`, RBAC do Quick-Start, sincronização do `STAGE_LABELS`. Idempotência mantida (não duplica por nome; automações sobrescrevem flags, nunca dados clínicos).
- **Fase B — Ficha do Paciente:** `patient_profiles` + `patient_plan_history`; editar plano/convênio sem apagar contato nem agendamento; histórico e auditoria. Mata a dor mais citada.
- **Fase C — Agenda Clínica (o item grande):** `clinic_professionals`; duração por consulta (sem teto, opção "sem previsão"); check-in/início/`over_time` (nunca excluir); alerta de permanência client-side; conflito por profissional/sala.
- **Fase D — Multi-profissional e operação:** grade/colunas por profissional, filtros (profissional, sala, status, plano, data), impressão/PDF (via `ReportPdfService`), portal do profissional por token (molde `RadarPublicService`).
- **Fase E — Autorização assistida:** operadoras, procedimentos/TUSS (cadastro manual), `procedure_authorization_requests` com status/checklist, dispatch das cadências clínicas, guardrails de IA.
- **Fase F (futuro, ADR próprio):** conectores TISS XML/WebService/API por operadora.

A dependência é estrita: a Agenda Clínica (C) é pré-requisito das visões multi-profissional e da autorização vinculada a consulta. A ordem começa pelo que entrega valor com menor risco (A, B) antes do subsistema pesado (C).

## Consequências

**Positivas:**
- O grosso do valor imediato (pack + ficha) sai cedo e barato, sem depender do subsistema pesado de agenda.
- A funcionalidade clínica nasce como módulo gated — sem inchar quem não é clínica, respeitando planos.
- Zero risco jurídico novo de integração: TISS fica para ADR próprio, com o tempo de tratar certificado digital com seriedade.
- Reaproveita criptografia, auditoria, portal por token, PDF e socket.io existentes — pouca infra nova.

**Trade-offs aceitos:**
- A Agenda Clínica (Fase C) é praticamente um agendador novo — é o maior item e o maior risco; assumido conscientemente e isolado numa fase própria.
- `clinic_professionals` desacoplada de `users` significa um segundo cadastro de pessoas no sistema (profissional ≠ usuário) — aceito em troca de não gastar licença e não misturar operação com quem só aparece na agenda.
- Autorização manual no MVP não "envia sozinha" — comunicado como promessa honesta, não como limitação escondida.
- Gatilhos clínicos custam código de disparo (não só cadastro) — reconhecido em D5.

## Testes

- Fase A: teste do pack `saude` 2.0 (idempotência por nome, flags aplicadas, RBAC bloqueando `agent`).
- Fase B: `patient_profiles`/`patient_plan_history` — editar plano preserva contato/agendamentos e registra histórico; isolamento multi-tenant; auditoria.
- Fase C: duração por consulta sem teto; transição de status nunca exclui; conflito por profissional; cálculo de `over_time` determinístico.
- Fase D/E: token do portal resolve só a agenda do próprio profissional (nunca de outro/tenant); autorização respeita guardrails de IA e audita cada transição.
- Regressão: suítes existentes de isolamento/RBAC/auditoria não regridem.
