# ADR-139 — WhatsApp como interface de gestão (Controller Financeiro IA)

- **Status:** Epic 3 **COMPLETO** — Fatias 1 (autenticação + parser + leitura governada por RBAC), 2 (roteamento no processador de mensagens, opt-in), 3 (**aprovar/dispensar governados** pela política do Epic 2) e 4 (**preferências de briefing** + entrega idempotente) implementadas. Delegar/adiar/explicar e o wiring do briefing no Scheduler ao vivo ficam como refinamentos futuros.
- **Data:** 2026-07
- **Origem:** PRD "ZappFlow Enterprise Intelligence" (Epic 3, §14). "Pequenos empresários não consultarão vários dashboards diariamente. O WhatsApp deve ser a interface de gestão, mas os dados e comandos continuam no núcleo seguro." Aceite: "usuário sem permissão não recebe DRE ou retiradas"; "'aprovar 1' só aprova ação ainda válida e da mesma organização".
- **Relacionadas:** ADR-051/CoordenadorService (voz interna da EQUIPE — tarefas), ADR-138 (RBAC financeiro), ADR-136 (Decision & Action Ledger / política de aprovação), ADR-135 (Snapshot/prioridades). PRD §14.

## Decisões

### D1 — Persona separada do Coordenador
O `CoordenadorService` (ADR-051) é a voz da **equipe** (tarefas do colaborador). O **Controller Financeiro IA** é a voz do **gestor** (finanças/prioridades). São personas distintas; reusam o mesmo padrão de **autenticação por número** (`users.phone` + `phoneMatches`, tolerante a DDI/9º dígito) e a mesma regra de segurança "número desconhecido → aviso, nada executa".

### D2 — Determinístico e SÓ LEITURA nesta fatia
`GestorCommandService.parse` classifica o texto em intents determinísticos (sem IA): `saldo`/`caixa`, `a receber`, `a pagar`, `prioridades`, `menu`. As respostas vêm dos motores existentes (`FinancialLedgerService.summary`, `ImpactPrioritizationService`). **Nenhuma escrita** — comandos de ação (`aprovar/dispensar/delegar/adiar/explicar`) são reconhecidos (`acao_diferida`) mas respondem "use o Plano de Ação no painel"; a execução governada (sob a política do Epic 2) é a fatia seguinte.

### D3 — RBAC na disclosure financeira (aceite do PRD)
Toda consulta financeira exige `PermissionService.can(org, user, "financeiro", "read")` — independente do flag de rota do Epic 0, porque um canal externo (WhatsApp) que revela caixa/recebíveis é uma **disclosure sensível**. Assim, vendedor/atendente **não recebem** saldo/DRE/retiradas nem as prioridades (que tocam finanças). Owner/gerente/financeiro recebem. Sem perfil, o papel legado decide (owner→full, agent→none).

### D4 — Opt-in por organização + auditoria
Flag `organization_settings.wa_gestor_enabled` (default **0**): com a interface desligada, `handle` devolve `handled:false` e o webhook segue o fluxo normal (nada muda). Cada comando é auditado (`WA_GESTOR_COMMAND`; `WA_FINANCE_DENIED` na negação). Rotas de configuração/preview: `GET/PUT /api/gestor/flag`, `POST /api/gestor/preview` (gestor; simula a resposta sem enviar).

### D5 — Wiring no processador de mensagens (Fatia 2)
O `webhookProcessor`, no bloco do **canal interno** (`kind='internal'`), passa a **tentar o Controller antes do Coordenador**: chama `GestorCommandService.handle` e, se `shouldRoute` = true, envia a resposta e encerra; senão cai no `CoordenadorService` (fluxo atual). `shouldRoute` só é verdadeiro para intents de gestão claros (`saldo`/`a_receber`/`a_pagar`/`prioridades`/`acao_diferida`) de um **número de gestor conhecido** — greeting/menu/desconhecido e perguntas de tarefas do colaborador continuam no Coordenador, **sem duplicação**. Como `handle` devolve `handled:false` quando o flag da org está off, o parque legado não muda: o `shouldRoute` é falso e o Coordenador roda como hoje. O `prioridades` do parser foi **restringido** (frase clara: "prioridades"/"…atacar"/"foco do dia") para não sequestrar "o que tenho pra fazer hoje" (tarefas).

### D6 — Ações governadas por WhatsApp (Fatia 3)
O gestor lista as pendências (`aprovações`) — que o Controller **numera e memoriza** por (org, usuário), como o Coordenador faz — e responde **`aprovar 1`** / **`dispensar 2`**. O índice é resolvido contra a última lista; a ação aciona `DecisionActionService.approve`/`reject` (Epic 2) **respeitando a política** (single/role/`two_step` = 2 aprovadores distintos → "falta outra aprovação") e o **RBAC igual à rota** (`approval_role` exigido, senão owner/admin; só gestores operam). Cumpre o aceite do PRD: **só age em ação `awaiting_approval` da mesma org** — índice inválido / ação já resolvida → aviso, **nada muda**. Cada decisão/negação é auditada (`WA_ACTION_DENIED`). `delegar`/`adiar`/`explicar` seguem diferidos ao painel.

### D7 — Preferências de briefing + entrega idempotente (Fatia 4)
`briefing_preferences` (por org/usuário: canal, horário, dias da semana, domínios permitidos, modo) + `briefing_delivery` (`UNIQUE(org, dedupe_key)`). `BriefingService`: `getPrefs`/`setPrefs`; `scheduledForDay` (respeita dias/enabled); `buildMorning` monta o resumo **curto** com **≤3 prioridades** (reusa `ImpactPrioritizationService`), **filtrando por domínios permitidos e RBAC** — usuário sem permissão financeira **não recebe** as prioridades financeiras nem o rodapé de caixa (aceite do PRD); `deliver` é **idempotente** por `dedupe_key` = `usuário:slot:dia` (o **reenvio do Scheduler não duplica** — aceite). Não envia — devolve o texto e registra a entrega (o wiring no Scheduler é refinamento). Rotas: `GET/PUT /api/gestor/briefing-prefs`, `GET /api/gestor/briefing-preview`.

## Consequências
**Positivas:** o Epic 3 fica **completo** — o gestor **consulta, decide e é avisado** pelo WhatsApp, tudo com **autenticação + RBAC + política do Epic 2 + auditoria** e **sem duplicar** mensagens. O humano segue no controle e a mesma política/permissão do painel vale no canal. Sem risco ao fluxo atual (opt-in; flag off → Coordenador roda como hoje).

**Trade-offs / escopo:** `delegar`/`adiar`/`explicar` e o passe do briefing no Scheduler ao vivo (com os horários/dias configurados) ficam como refinamentos. O roteamento de comandos vale no **canal interno**; o gestor mensageando o canal comercial segue o fluxo de cliente.

## Guardas
- Autenticação por número (só `users.phone` ativos da própria org). Determinístico (zero-token). RBAC na disclosure financeira. Opt-in por org (default off). Auditável. Sem escrita/execução. Isolado por `organization_id`.

## Testes
`test:gestor-command` (Epic 3) — opt-in (desligado → `handled:false`); parser determinístico dos intents; **número desconhecido recusado**; owner autentica **por DDI/9º dígito** e recebe o saldo (auditado); **vendedor NÃO recebe** finanças nem prioridades (negação auditada — aceite do PRD); **fallback legado** (owner vê, agent não); **ação diferida** responde "Plano de Ação" e não executa; menu/desconhecido; isolamento por org. **Roteamento (Fatia 2)**: `shouldRoute` = true só para intent de gestão de número conhecido (inclui a negação do vendedor, que o Controller responde); false para menu/desconhecido/número desconhecido e com o flag off; `prioridades` não sequestra "o que tenho pra fazer hoje". **Ações (Fatia 3)**: `aprovações` lista/numera as pendências; `aprovar 1` fecha `single`; **aprovar de novo → "não está mais disponível"** (aceite); `dispensar 2` rejeita; índice inválido → aviso sem efeito; **vendedor não opera** aprovações; **`two_step` 1ª aprovação ainda aguarda**; **admin não aprova `change_price`** (exige owner); os novos intents entram no `shouldRoute`.

`test:briefing` (Fatia 4) — prefs default + upsert (horário/dias/domínios); `scheduledForDay` (dias/enabled); `buildMorning` ≤3 prioridades; **owner vê finanças, vendedor NÃO** (prioridade financeira filtrada + sem rodapé 💰 — aceite); domínios permitidos filtram; **entrega idempotente** (reenvio do mesmo dia → `deduped`, só 1 linha; outro dia entrega de novo); isolamento por org.
