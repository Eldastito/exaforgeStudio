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

### Ainda NÃO feito (próximas sub-fatias da F3.1)
Gates de dado desatualizado/baixa confiança/teto financeiro no `execute` (F3.1c) · kill switch por organização e por (domínio, ação) (F3.1c) · tela Empresa→IA (F3.1d).
