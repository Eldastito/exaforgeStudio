# ADR-144 — Módulo Escola: a camada que conecta a escola à família (resumo diário no WhatsApp)

**Status:** Aceito — Fatia 1 em implementação (resumo diário ao responsável + 1 sinal de coordenação). Fatias 2–5 planejadas.

**Data:** 2026-07

**Origem:** levantamento de uma nova vertical de educação. A tese não é "mais um sistema escolar" (a escola já tem diário de classe, sistema acadêmico e financeiro) — é a **camada de conexão** que pega o que a escola já produz e **entrega para a família, no WhatsApp, todo dia**, de forma personalizada por aluno; e devolve à **coordenação** os sinais que exigem ação. Posicionamento: **conectar, não substituir**.

**Relacionadas:** ADR-080 (Módulo Clínica — molde de módulo opcional + ficha satélite de `contacts` + entidade própria desacoplada de `users`), ADR-131 (Tutor no WhatsApp — molde do passe proativo determinístico, opt-in, dedupe por dia SP, envio injetável), ADR-060 (AppointmentService — agenda base), ADR-056 / lgpd-vertical-consent (LGPD — consentimento por contato), ADR-136 / ADR-132 (Sinais → Pareto → ação), ADR-067 (Gemini RAG — regimento/FAQ), ADR-064 (Cadências), ADR-072 (ModuleService), ADR-074 (Scheduler), ADR-092 (distribuição por vertical).

---

## Contexto

### O que o inventário mostra (antes de escrever código)

A plataforma já é, onde importa, **agnóstica de domínio** — e a vertical `educacao` já existe como preset de módulos. O que **existe e se reaproveita**:

- **Push proativo para uma pessoa, determinístico e testável** — `BusinessTutorService` (ADR-131): monta texto zero-token, resolve o número, decide **janela** (hora de São Paulo via `spParts`), **dedupe por dia** (colunas em `organization_settings`) e recebe a função `send` **injetada** (testável sem rede). O `Scheduler` já roda passes horários. É o molde exato do "resumo diário", mas a chave passa a ser **por aluno**, não por org.
- **Ficha satélite 1:1 com `contacts`, dado sensível separado** — `PatientService` + `patient_profiles` (ADR-080): o paciente **é** um contato do CRM; a ficha guarda o dado sensível à parte, escopada por `organization_id` e auditada (`logAuthEvent`). É o molde exato do **aluno**.
- **Módulo opcional como unidade de entrega** — ADR-080 D1: um módulo novo registrado em `OPTIONAL_MODULES`, `ModuleService.MODULE_BY_ROUTE` e no preset da vertical; o **Quick-Start** vira o interruptor + a semente (áreas, cadências, FAQ→RAG, flags), não o dono da funcionalidade.
- **Entidade própria desacoplada de `users`** — ADR-080 D2 (`clinic_professionals`): muitos profissionais sem conta no painel. Vale igual para **professores**.
- **Agenda base** — `AppointmentService` / tabela `appointments` (ADR-060) e o padrão da Agenda Clínica (profissionais↔salas↔horários por cima da agenda base) — molde para a **agenda do professor / grade da turma**.
- **Sinais → Pareto → ação** — `BusinessSignalService` / `ImpactPrioritizationService` (ADR-132/136): `domain` é string livre; um domínio `education` pontua e entra no briefing/Pareto sem tocar no kernel. É o **painel da coordenação**.
- **LGPD** — consentimento por contato + categorias + export/forget (ADR-056). **RAG** — regimento/FAQ da escola respondido no WhatsApp (ADR-067). **Import** — SmartImport + sync de Google Sheets (ADR-066) para a entrada de dados sem integração.

### O que é greenfield (trabalho novo, delimitado)

O inventário é honesto: **não é só configuração**. Três peças são novas de verdade, ainda que delimitadas:

1. **Modelo aluno / turma / responsável** — não existe. Modelado como o `patient_profiles`: o aluno é um contato satélite; o responsável é outro contato (com telefone → WhatsApp); um vínculo aluno→responsável(is).
2. **Motor de resumo diário** — montar 1 resumo **por aluno** e enviar a **cada responsável**, idempotente, na janela da manhã. Reusa o mecanismo do tutor, mas iterando por aluno.
3. **Consentimento de menor** — hoje o consentimento LGPD é "a pessoa por si mesma". Aqui o **responsável consente pelo aluno**. É um registro de consentimento na relação responsável↔aluno, verificado como **porta** antes de qualquer envio.

### Restrição de produto

Dado de **menor de idade** (LGPD Art. 14 — o tratamento deve ser no melhor interesse da criança, com consentimento **de um dos pais ou responsável**). Isso eleva o rigor: **nada é enviado sem consentimento explícito do responsável para aquele aluno**, isolamento por `organization_id`, e o direito de o responsável **desativar** o recebimento a qualquer momento.

### Onde projetos assim morrem

**Integração com o sistema acadêmico/financeiro de cada escola** é o buraco: cada fornecedor tem API/arquivo/webhook diferente, é caro e variável. **Decisão de escopo:** a MVP **não depende de integrar nenhum sistema específico**. A entrada de dados começa pelo que a escola entrega fácil (planilha/Google Sheets + a nossa própria agenda + input rápido de secretaria/coordenação). Conectores reais (API/webhook por fornecedor) entram **por cliente, depois** (Fatia 5) — nunca como pré-requisito do valor.

---

## Decisão

### D1 — Módulo opcional `escola`; o Quick-Start é o interruptor + a semente

Seguindo ADR-080 D1: um módulo `escola` registrado em `OPTIONAL_MODULES`, `ModuleService.MODULE_BY_ROUTE` e no preset da vertical `educacao`, gated como os demais. O Quick-Start `educacao` **ativa o módulo e semeia** o conteúdo inicial (áreas de secretaria/coordenação, cadências, FAQ→RAG do regimento, flags `escola_*`). A funcionalidade (aluno, responsável, agenda, resumo) vive no módulo, com suas tabelas, rotas e telas.

### D2 — Aluno é ficha satélite de `contacts`; responsável é contato; vínculo explícito

Seguindo ADR-080 D2 e o molde do `PatientService`:

- **`student_profiles`** (1:1 com um `contacts`): `full_name`, `birth_date`, `turma` (classe/série), `enrollment_code` (matrícula), `status` (`active`/`inactive`), `notes`. Escopado por `organization_id`, auditado.
- **Responsável** é um `contacts` normal (tem `identifier`/telefone → canal WhatsApp). Não gasta o molde de `users` (ADR-080 D2: quem só recebe não precisa de login).
- **`student_guardians`** (vínculo N:N aluno↔responsável): `student_contact_id`, `guardian_contact_id`, `relationship` (mãe/pai/responsável), `is_primary`, e o **consentimento** desta relação: `digest_consent` (0/1), `digest_consent_at`, `digest_consent_by`. É aqui que mora o **consentimento-de-menor** (D3).

Trocar de turma **não apaga** o aluno nem seu histórico — atualiza a ficha (mesma lição do "trocar plano não apaga o paciente" do ADR-080 D6).

### D3 — Consentimento do responsável pelo aluno é uma PORTA, não um aviso

Nenhum resumo é montado ou enviado para uma relação responsável↔aluno sem `digest_consent = 1`. O consentimento é registrado por relação (não global do contato), com data e autor, e pode ser **revogado** a qualquer momento (o responsável responde uma palavra-chave de saída, ou a secretaria desliga). Sem consentimento → o passe **pula sem enviar** e não marca dedupe (o consentimento pode chegar depois). Isolado por `organization_id`.

### D4 — Resumo diário: determinístico, por aluno, envio injetável (molde do tutor)

`SchoolDigestService` (novo), espelhando `BusinessTutorService`:

- **`dailyDigest(orgId, studentContactId)`** → texto **zero-token** determinístico a partir da **agenda do dia** do aluno/turma (via `AppointmentService`/`appointments`) + avisos pendentes (ex.: autorização, saída). Nada de LLM no caminho quente — roda no CI sem chave.
- **`runDigestPass(orgId, { now, send })`** → para cada aluno ativo com responsável **consentindo**, dentro da **janela da manhã** (SP, via `spParts`), **ainda não enviado hoje** (dedupe por dia SP por relação), envia a cada responsável consentindo. `send` é **injetado** (Scheduler injeta `MessageProviderService.sendMessage`; o teste injeta um capturador). A data só é marcada **após** o envio (retenta no próximo tick se falhar).
- **`sendNow(...)`** → botão "enviar teste" que ignora janela/dedupe.

A mensagem-alvo da Fatia 1 (a "mensagem diária ideal"):

> ☀️ *Bom dia, Juliana!* Resumo de hoje do *Lucas* (3º ano B):
> • 5 aulas — 1ª aula 7h30
> • Futsal (extracurricular) às 16h
> • 📌 Autorização do passeio de História: **pendente**
> • Saída prevista: 17h30
> Dúvidas? Responda por aqui. Para não receber mais, responda *SAIR*.

### D5 — Um sinal de coordenação no domínio `education`

`SchoolDigestService`/coordenação emite um sinal de domínio `education` (Fatia 1: **faltas** — aluno ausente sem justificativa) via `BusinessSignalService`, que o `ImpactPrioritizationService` já leva ao Pareto/briefing da coordenação sem alteração no kernel. Prova a trilha "sinal → prioridade → ação" na vertical.

### D6 — Frugal, multi-tenant, opt-in

Determinístico (zero-token no caminho quente), isolado por `organization_id`, opt-in por consentimento do responsável. Nada é empurrado sem consentimento explícito.

---

## Faseamento (cada fatia = um PR fechado e testado)

| Fatia | Entrega | Novo × reuso |
|---|---|---|
| **1 — Resumo diário ⭐ (esta ADR)** | modelo aluno/responsável + consentimento-porta + resumo diário ao responsável (da nossa agenda) + 1 sinal de coordenação (faltas) | modelo NOVO; envio/consentimento/sinais REUSO |
| **2 — Agenda do professor** | professores (entidade própria) + grade por turma; "resumo antes da aula" + confirmação pós-aula | ADAPTA Agenda Clínica |
| **3 — Extracurriculares** | matrícula/vagas/lista de espera/presença + aviso ao responsável | ADAPTA `reservations` |
| **4 — Painel da coordenação** | mais sinais (nota não lançada, turma sem professor…) no Pareto/briefing | REUSO do kernel de sinais |
| **5 — Conectores reais** | import de planilha estruturada + 1º webhook/API por cliente | por cliente |
| **Pack Quick-Start `educacao`** | personas (secretaria/coordenação) + cadências + FAQ do regimento | autoria (sem código) |

A Fatia 1 sozinha prova a tese: reusa envio, consentimento, priorização e RAG **sem tocar no kernel**, e entrega valor demoável (a mensagem diária ao responsável).

---

## Consequências

**Positivas:** posiciona a vertical como camada de conexão (não concorre com o sistema acadêmico); reusa ~70% da plataforma (push, consentimento, sinais, RAG, agenda, import); valor demoável já na Fatia 1; caminho de integração desacoplado do valor (não morre no conector).

**Escopo/limites:** Fatia 1 é resumo diário + 1 sinal. Sem agenda de professor, extracurricular, nem conectores reais (fatias seguintes). O conteúdo do resumo vem da **nossa** agenda + inputs manuais até os conectores existirem — promessa comercial honesta: "conectamos o que a escola já produz e entregamos à família; onde houver integração, puxamos automático; onde não, a secretaria alimenta em segundos".

## Guardas

- **Consentimento de menor é porta, não aviso** (D3): sem consentimento do responsável, nada é enviado.
- **IA sugere, humano decide:** o resumo **informa**; nenhuma ação automática sobre o aluno.
- Opt-in explícito; determinístico; isolado por `organization_id`; revogável (SAIR).

## Testes

`test:escola-digest` (novo): fuso de São Paulo e janela da manhã; consentimento como porta (sem `digest_consent` não envia e não marca dedupe); texto determinístico do resumo (bom dia + nome do aluno + agenda do dia); envia 1×/dia por relação responsável↔aluno e deduplica; fora da janela/desligado não envia; múltiplos responsáveis do mesmo aluno recebem; `sendNow` ignora janela/dedupe; sinal de faltas emitido no domínio `education`; isolamento por `organization_id`.
