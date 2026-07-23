# ADR-131 — Tutor de Gestão no WhatsApp (empurrar a inteligência para o dono)

- **Status:** Completa — Fatias 1–4 (manhã + meio-dia + fim do dia + loop conversacional determinístico; opt-in, testado).
- **Data:** 2026-07
- **Origem:** auditoria de veracidade da apresentação "ZappFlow Sobrevivência". A Central de Saúde (ADR-126) já interpreta o negócio e destila as 3 prioridades do dia, mas a entrega era **pull/in-app** — o dono só via se abrisse a tela. A apresentação promete o oposto: o ZappFlow encontra o empreendedor **onde ele já trabalha, no WhatsApp**.
- **Relacionadas:** ADR-126 (Central de Saúde — fonte do conteúdo), ADR-125 (Motor de Caixa/KPIs), ADR-088 D5 (frugal/zero-token), Scheduler (passes proativos), ADR-091 §6 (IA sugere, humano decide).

## Contexto

O agendador (`Scheduler`) já dispara WhatsApp sozinho, mas exclusivamente para **clientes** (cobrança, reativação, NPS…). Não havia nenhum envio proativo de **gestão para o dono**. Esta ADR abre essa trilha começando pela mensagem de maior valor: o **resumo da manhã** com as prioridades do dia.

## Decisões

### D1 — Conteúdo determinístico, reaproveitando a Central de Saúde
`BusinessTutorService.morningBrief(orgId)` monta o texto a partir de `BusinessHealthService.overview()` (status + síntese + top-3 prioridades com impacto em R$ + KPIs de caixa). **Zero-token** — nada de LLM no caminho quente; roda no CI sem `OPENAI_API_KEY`.

### D2 — Envio proativo agendado, opt-in, deduplicado
`Scheduler.tutorPass()` roda no tick horário: para cada org com `tutor_wa_enabled=1`, resolve o canal (evolution preferido) uma vez e delega a `BusinessTutorService.runMorningPass` e `runMiddayPass`. Cada serviço decide **janela** (manhã 7–12h; meio-dia 12–16h de São Paulo — resiliente a um tick perdido), **dedupe** por data SP e por janela (`tutor_wa_last_morning` / `tutor_wa_last_midday`: uma vez por dia cada) e **número do dono** (`tutor_wa_phone`; senão o telefone do usuário `owner`/`admin`). A data só é marcada **após** o envio — se falhar (ou se pular), retenta no próximo tick.

### D2b — Meio-dia: só quando há ponto de equilíbrio a reportar (Fatia 2)
`middayBrief()` usa `ComigoHealthService.breakEven()` (já testado): "você já fez R$ X — Y% do ponto de equilíbrio; faltam R$ Z (~N pedidos)". Só é **aplicável** quando há custo fixo informado e breakeven > 0; sem isso o passe **pula sem enviar** e **não marca a data** (o breakeven pode ficar pronto mais tarde no mesmo dia). Evita mandar um "0% do ponto de equilíbrio" sem sentido para quem não configurou custos.

### D2c — Fim do dia: o fechamento (Fatia 3)
`eveningBrief()` fecha o dia com vendas + margem estimada (do dia, via `ComigoHealthService.rangeResult`) e o que **entrou no caixa** + o que **ficou a receber** (via `FinancialLedgerService.summary`): "vendeu R$ X, entrou R$ Y, margem R$ Z; ainda há R$ W a receber". Janela da noite (18–22h SP), dedupe `tutor_wa_last_evening`. Diferente do meio-dia, **sempre envia** quando ligado — é o ritual de fechamento, não depende de breakeven. O "amanhã cedo eu te lembro de cobrar" é uma frase (soft); o loop conversacional de resposta ("sim, cobre amanhã") fica para a Fatia 4.

### D2d — Loop conversacional determinístico (Fatia 4)
O "fim do dia", quando há a receber, abre uma **oferta** (`tutor_collect_offer_at`) e pede "responda *SIM*". A resposta do dono chega no canal de atendimento; o `webhookProcessor` chama `BusinessTutorService.handleOwnerReply` **antes** de criar contato/ticket. A interpretação é **determinística por palavra-chave** (zero-token): só age se o remetente é o número do dono **E** há oferta recente (hoje/ontem); "sim/cobrar/ok/1…" agenda o lembrete para a manhã seguinte (`tutor_collect_scheduled_for`) e responde "Combinado!"; "não…" cancela; **resposta ambígua não é capturada** (o fluxo normal segue — nunca sequestra uma conversa do dono como cliente). Na manhã agendada, `runCollectPass` envia o lembrete de cobrança (aponta para a Caderneta, onde a cobrança cortês já existe) e limpa o agendamento. O "sim" do dono **é** a decisão humana (ADR-091 §6); o tutor não cobra clientes sozinho.

### D3 — Envio testável sem rede
`runMorningPass`/`sendNow` recebem a função `send` injetada. O Scheduler injeta o envio real (`MessageProviderService.sendMessage`); o teste injeta um capturador. O serviço decide só o **quê** e o **quando**.

### D4 — Controle do dono na própria Central de Saúde
`GET/PUT /api/health-center/tutor` (liga/desliga + número) e `POST /api/health-center/tutor/test` (envia agora, ignorando janela/dedupe). Na `HealthCenterView`, um cartão "Receber este resumo no WhatsApp toda manhã": toggle, número (com fallback ao do dono), prévia da mensagem e "Enviar teste".

### D5 — Frugal e multi-tenant
Determinístico, isolado por `organization_id`, opt-in (nada é empurrado sem o dono ligar).

## Consequências
**Positivas:** fecha a lacuna mais visível da apresentação (o tutor que fala no WhatsApp), reusando a inteligência que já existe; sem custo de token; testado.

**Escopo:** completo — manhã (prioridades) + meio-dia (ponto de equilíbrio) + fim do dia (vendeu/recebeu/margem/pendências) + loop conversacional ("sim, cobre amanhã" → agenda o lembrete da manhã). O loop é **determinístico por palavra-chave**; entender linguagem livre com IA (com `isAIConfigured` + guardrails) fica como evolução futura, se desejado.

## Guardas
- IA sugere, humano decide: o tutor **informa e recomenda**; nenhuma ação é executada sozinha.
- Opt-in explícito; determinístico; isolado por `organization_id`.

## Testes
`test:business-tutor` — fuso de São Paulo; texto determinístico do resumo (bom dia + situação + KPIs); número do dono (configurado × fallback para o usuário dono, nunca o agente); manhã envia 1×/dia e deduplica; fora da janela/desligado não envia; ligado sem número não envia e não marca a data (retenta); **meio-dia**: sem custo fixo não se aplica (no_breakeven, sem marcar), com custo fixo + vendas envia o % do ponto de equilíbrio, deduplica no dia e respeita a janela; **fim do dia**: traz vendas/caixa/margem, envia na janela da noite, deduplica, respeita a janela e envia mesmo sem custo fixo; **loop conversacional**: fim do dia com a receber abre a oferta; resposta de não-dono e resposta ambígua não são capturadas; "SIM" do dono agenda a cobrança do dia seguinte e responde; o lembrete é enviado na manhã agendada e não repete; "não" cancela; `sendNow` ignora janela/dedupe; isolamento por org.
