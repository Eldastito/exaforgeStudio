# Autonomia da IA — operação (ADR-204 · Fase 3)

Runbook da governança de autonomia. Cresce uma seção por fatia da Fase 3; hoje cobre a **F3.1a — piso de autonomia**.

## F3.1a — o que a IA NUNCA faz sozinha

Existe uma lista de tipos de ação que **sempre exigem a aprovação de uma pessoa** (PRD Fase 3 §4): compras, pagamentos e transferência de dinheiro, contratação/demissão, salário, comissão consolidada, desconto relevante e preço, empréstimo, compromisso contratual e comunicação jurídica. Fonte única: `ApprovalPolicyService.humanOnlyTypes()` (`GET /api/actions/autonomy-floor`).

O piso vale **acima** de qualquer configuração:
- **Proposta (`propose`)**: nunca nasce aprovada — nem com banda "permitido", nem com política "automática", nem com teto de automação. O contrato do dono (bandas) continua podendo **endurecer** (bloquear/escalar); não afrouxa abaixo do piso.
- **Aprovação (`approve`)**: só por **pessoa**. Rótulo de sistema (`runtime`, `rule`, `ai`, `scheduler`, `agent:…`) é recusado.
- **Execução (`execute`)**: exige ao menos uma aprovação humana registrada. Ação restrita "aprovada" sem pessoa (legado) é **recusada e auditada** (`error_code = human_approval_missing` em `action_execution_log`).
- **`dispatchGoverned`** (a costura que semeia política e auto-aprova, feita para mensagens): **recusa** tipo do piso — não cria ação, não semeia política, não tem efeito.

A IA ainda pode **analisar e preparar** (rascunho/`prepare`) essas ações — só não as compromete.

### Níveis 0–4 (mapa derivado, sem enum novo)
`GET /api/actions/autonomy-level?domain=…&actionType=…` devolve o nível e o porquê:

| Nível | Quando |
| --- | --- |
| 0 observar | política `observe` |
| 1 recomendar | sem política, ou `suggest` |
| 2 preparar | `prepare`; ou `execute` sem efeito liberado; ou `execute` sem limite pré-autorizado (a pessoa aprova) |
| 3 executar dentro de limites | `execute` + `approved_execution` + limite/banda "permitido" do dono |
| 4 autonomia avançada | **não habilitado nesta fase** — `autonomous` aparece como 3 com `level4Blocked` |

Tipos do piso ficam **travados em ≤ 2**, sejam quais forem a política e o teto.

### Fora do piso de propósito
- `refund`: a banda configurada pelo dono (ADR-159) segue valendo. **Decisão D8 em aberto** (travar também?).
- `prepare_purchase`, `send_quote_request`: rascunho/cotação — nível 2.
- `asaas_pix_charge`, `collection*`: cobrar cliente é **receber**, não compromete dinheiro da empresa. (`domain = finance` também carrega cobrança — por isso o piso é por **tipo**, não por domínio.)
- `retail_transfer`: transferência de **estoque**, não de dinheiro.

### Mudança de comportamento que o dono vai notar
Quem tinha banda "permitido" para **compra** (`create_purchase_order`) via compra pequena ser auto-aprovada. A partir da F3.1a ela **aguarda aprovação**. É o objetivo do PRD (compras = só analisar/preparar).

### Adicionar um tipo novo ao piso
Qualquer ação nova que comprometa dinheiro, pessoas ou contrato **deve** entrar em `HUMAN_ONLY_ACTION_TYPES` (`ApprovalPolicyService.ts`) e ganhar um check em `scripts/test-autonomy-floor.ts`. Não existe detecção automática por nome.

### Rollback
Aditivo e sem migração: reverter o commit restaura o comportamento anterior. Nenhuma coluna/tabela nova nesta sub-fatia.

## F3.1b — "por que o ZapFlow fez isso?"

Cada ação nova guarda, na hora da proposta, uma **foto da política que a governou** (`decision_actions.policy_snapshot_json`): de onde veio a regra (faixa do dono / política da empresa / regra padrão), quantas pessoas precisavam aprovar, se a trava de segurança (piso, F3.1a) apertou a regra e o nível de autonomia 0–3. É a foto **da época**: se o dono mudar a política depois, a explicação continua mostrando o que valia quando a ação nasceu.

`GET /api/actions/:id/why` responde, em linguagem de negócio (não cadeia de raciocínio):
1. **O que foi proposto** + base (fato / estimativa / influência) + confiança em palavras.
2. **De qual ponto de atenção nasceu** (o sinal, traduzido; nunca o identificador técnico).
3. **Qual regra governou** (a foto).
4. **Quem autorizou**: pessoa pelo nome, ou "automaticamente, dentro da política" (nenhuma pessoa precisou aprovar). Aprovação por rótulo de sistema (`runtime`) é dita como automática — nunca finge ter sido pessoa.
5. **Executada** ou **"Não executei porque…"** — o motivo real da recusa do executor (sem aprovação de pessoa, sem política ativa, autonomia só recomenda, modo de teste, já executada antes…).
6. **Resultado medido** (esperado × realizado).

Regras: dinheiro **role-gated** (§73) — sem visão ampla do negócio os valores vêm `null` + `restricted:true` e o texto não os repete; domínio invisível ao papel → **404** (não vaza existência); isolado por empresa. `GET /api/decision-intelligence/trace/:correlationId` passa a trazer `policy_snapshot` em cada ação.

**Ação anterior à F3.1b** não tem foto: a explicação diz "não há foto do que valia na época" e **não** reconstrói a regra com a política de hoje.

Aditivo (1 coluna nullable), sem migração de dados; reverter o commit restaura o comportamento anterior.

## F3.1c — kill switch e travas de segurança

### Kill switch (pausa da autonomia)
Enquanto estiver ativo, o executor **recusa todo efeito externo** — inclusive de ação já aprovada por pessoa e via `dispatchGoverned` — e a recusa fica **auditada** (`error_code = autonomy_paused`) com o "Não executei porque o dono pausou a autonomia". Propor, preparar, aprovar e explicar **continuam funcionando**: pausar não esconde nada.

| Ação | Rota | Quem |
| --- | --- | --- |
| Ver pausas ativas + histórico | `GET /api/actions/autonomy/status` | qualquer usuário da empresa |
| Pausar (empresa inteira, ou um tipo com `domain`+`actionType`) | `POST /api/actions/autonomy/pause` `{reason, domain?, actionType?}` | **dono** ou admin master |
| Retomar | `POST /api/actions/autonomy/resume` `{domain?, actionType?}` | **dono** ou admin master |

O **motivo é obrigatório** (vai para a auditoria: `AUTONOMY_PAUSED`/`AUTONOMY_RESUMED`). Pausar de novo a mesma abrangência é idempotente. Retomar só marca `resumed_at` — **nada é apagado** (tabela `autonomy_pauses`). Pausar só um domínio não é suportado: ou a empresa inteira, ou um tipo de ação. O nível 0–3 (`/autonomy-level`) passa a mostrar `paused:true` e a explicar.

Por que tabela própria e não uma linha em `agent_policies`: inserir política para pausar mudaria o que o `dispatchGoverned` faz quando o tipo ainda não tem política e deixaria uma linha restritiva ao retomar.

### Travas de segurança (opt-in — **desligadas por padrão**)
Configuradas por tipo de ação, **só em tipos que já têm política ativa** (criar uma política só para guardar a trava mudaria o `dispatchGoverned`). Sem trava = comportamento de sempre, nenhuma automação existente muda.

| Trava | Recusa quando | Código |
| --- | --- | --- |
| `minConfidence` (0–1) | a confiança da ação é menor — ou desconhecida | `confidence_below_min` |
| `maxExecuteAmount` (≥ 0) | o valor da ação é maior — **ou desconhecido** (não se prova que cabe no limite) | `amount_above_limit` / `amount_unknown` |
| `maxDataAgeMinutes` (> 0) | o dado é mais velho — **ou a ação não informa a data** (`dataAsOf` no comando ou na evidência) | `data_stale` / `data_freshness_unknown` |

`PUT /api/actions/autonomy/gates` `{domain, actionType, minConfidence?, maxExecuteAmount?, maxDataAgeMinutes?}` (**só dono**; `null` limpa uma trava, as outras ficam) · `GET /api/actions/autonomy/gates?domain=&actionType=`. Quem produz a ação precisa carregar `dataAsOf` (ISO) no comando ou na evidência para que a trava de idade funcione — sem ele a ação é recusada, de propósito. As travas vigentes entram na foto da política (F3.1b) e a explicação diz "Travas de segurança ativas…".

### Rollback
Aditivo: 1 tabela nova, sem colunas nem migração de dados. Desligar as travas = `null` em cada uma; reverter o commit restaura o comportamento anterior.

## F3.1d — Tela "O que a IA pode fazer sozinha" (Configurações → Governança, atalho Empresa → "Autonomia da IA")
`AutonomyContractPanel` só RENDERIZA `GET /api/actions/autonomy/overview` (piso por categoria em linguagem de dono · cada tipo com nível 0–3 em palavras, travas e pausa · pausa da empresa inteira) e chama as rotas já testadas de pausa/retomada/travas. Dono (ou admin master) vê os botões Pausar/Retomar/Travas; os demais veem tudo em leitura com aviso. **Não existe controle de elevar autonomia** — o nível mostrado é derivado (RN-F3-3). Dinheiro: só o teto que o próprio dono configurou.

### Rollback
Só front + 1 rota de leitura; remover o `<AutonomyContractPanel />` do `SettingsView` esconde a tela sem tocar no comportamento.

### Ainda NÃO feito
Elevação de autonomia guiada por evidência (F3.7 — `ProgressiveAutonomyService` só propõe; humano aceita). Verificação da tela contra o app completo com autenticação real (feita só em Chromium com API simulada).
