# ADR-139 — WhatsApp como interface de gestão (Controller Financeiro IA)

- **Status:** Epic 3 / Fatias 1 (autenticação do número + parser + consulta de leitura governada por RBAC) e 2 (roteamento no processador de mensagens, opt-in) implementadas. Ações (aprovar/dispensar/delegar/adiar) pela política do Epic 2 e as preferências de briefing vêm nas fatias seguintes.
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

## Consequências
**Positivas:** o gestor **consulta o negócio pelo WhatsApp de verdade** (roteado no webhook, opt-in) com **autenticação de número + RBAC + auditoria**, reusando os motores determinísticos existentes — sem risco ao fluxo atual (flag off → Coordenador roda como hoje). Fundação pronta para as ações governadas.

**Trade-offs / escopo:** só **leitura**; as ações (aprovar/dispensar via política do Epic 2) e as preferências de briefing/horários do §14 ficam para as próximas fatias. O roteamento vale no **canal interno** (onde mensagens de equipe/gestão chegam); o gestor mensageando o canal comercial segue o fluxo de cliente.

## Guardas
- Autenticação por número (só `users.phone` ativos da própria org). Determinístico (zero-token). RBAC na disclosure financeira. Opt-in por org (default off). Auditável. Sem escrita/execução. Isolado por `organization_id`.

## Testes
`test:gestor-command` (Epic 3) — opt-in (desligado → `handled:false`); parser determinístico dos intents; **número desconhecido recusado**; owner autentica **por DDI/9º dígito** e recebe o saldo (auditado); **vendedor NÃO recebe** finanças nem prioridades (negação auditada — aceite do PRD); **fallback legado** (owner vê, agent não); **ação diferida** responde "Plano de Ação" e não executa; menu/desconhecido; isolamento por org. **Roteamento (Fatia 2)**: `shouldRoute` = true só para intent de gestão de número conhecido (inclui a negação do vendedor, que o Controller responde); false para menu/desconhecido/número desconhecido e com o flag off; `prioridades` não sequestra "o que tenho pra fazer hoje".
