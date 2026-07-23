# ADR-131 — Tutor de Gestão no WhatsApp (empurrar a inteligência para o dono)

- **Status:** Fatia 1 implementada (resumo da manhã, opt-in, determinístico, testado)
- **Data:** 2026-07
- **Origem:** auditoria de veracidade da apresentação "ZappFlow Sobrevivência". A Central de Saúde (ADR-126) já interpreta o negócio e destila as 3 prioridades do dia, mas a entrega era **pull/in-app** — o dono só via se abrisse a tela. A apresentação promete o oposto: o ZappFlow encontra o empreendedor **onde ele já trabalha, no WhatsApp**.
- **Relacionadas:** ADR-126 (Central de Saúde — fonte do conteúdo), ADR-125 (Motor de Caixa/KPIs), ADR-088 D5 (frugal/zero-token), Scheduler (passes proativos), ADR-091 §6 (IA sugere, humano decide).

## Contexto

O agendador (`Scheduler`) já dispara WhatsApp sozinho, mas exclusivamente para **clientes** (cobrança, reativação, NPS…). Não havia nenhum envio proativo de **gestão para o dono**. Esta ADR abre essa trilha começando pela mensagem de maior valor: o **resumo da manhã** com as prioridades do dia.

## Decisões

### D1 — Conteúdo determinístico, reaproveitando a Central de Saúde
`BusinessTutorService.morningBrief(orgId)` monta o texto a partir de `BusinessHealthService.overview()` (status + síntese + top-3 prioridades com impacto em R$ + KPIs de caixa). **Zero-token** — nada de LLM no caminho quente; roda no CI sem `OPENAI_API_KEY`.

### D2 — Envio proativo agendado, opt-in, deduplicado
`Scheduler.tutorMorningPass()` roda no tick horário: para cada org com `tutor_wa_enabled=1`, resolve o canal (evolution preferido) e delega a `BusinessTutorService.runMorningPass`. O serviço decide **janela** (manhã, 7–12h de São Paulo — resiliente a um tick perdido), **dedupe** (`tutor_wa_last_morning` por data SP: uma vez por dia) e **número do dono** (`tutor_wa_phone`; senão o telefone do usuário `owner`/`admin`). A data só é marcada **após** o envio — se o envio falhar, retenta no próximo tick.

### D3 — Envio testável sem rede
`runMorningPass`/`sendNow` recebem a função `send` injetada. O Scheduler injeta o envio real (`MessageProviderService.sendMessage`); o teste injeta um capturador. O serviço decide só o **quê** e o **quando**.

### D4 — Controle do dono na própria Central de Saúde
`GET/PUT /api/health-center/tutor` (liga/desliga + número) e `POST /api/health-center/tutor/test` (envia agora, ignorando janela/dedupe). Na `HealthCenterView`, um cartão "Receber este resumo no WhatsApp toda manhã": toggle, número (com fallback ao do dono), prévia da mensagem e "Enviar teste".

### D5 — Frugal e multi-tenant
Determinístico, isolado por `organization_id`, opt-in (nada é empurrado sem o dono ligar).

## Consequências
**Positivas:** fecha a lacuna mais visível da apresentação (o tutor que fala no WhatsApp), reusando a inteligência que já existe; sem custo de token; testado.

**Trade-offs / escopo:** Fatia 1 cobre **só a manhã**. Ainda **não** entrega o "durante o dia" (ex.: "atingiu 76% do ponto de equilíbrio") nem o "fim do dia" (resumo vendeu/recebeu/margem + "deseja que eu cobre amanhã?"), nem o loop conversacional de resposta ("sim, cobre amanhã"). Ficam para as Fatias 2 e 3.

## Guardas
- IA sugere, humano decide: o tutor **informa e recomenda**; nenhuma ação é executada sozinha.
- Opt-in explícito; determinístico; isolado por `organization_id`.

## Testes
`test:business-tutor` — fuso de São Paulo; texto determinístico do resumo (bom dia + situação + KPIs); número do dono (configurado × fallback para o usuário dono, nunca o agente); envia 1×/dia e deduplica; fora da janela/desligado não envia; ligado sem número não envia e não marca a data (retenta); `sendNow` ignora janela/dedupe; isolamento por org.
