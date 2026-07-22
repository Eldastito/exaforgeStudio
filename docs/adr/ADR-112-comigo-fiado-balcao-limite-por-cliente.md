# ADR-112 — Comigo/Balcão: venda no fiado com limite por cliente (caderneta digital)

- **Status:** Proposto (escopo aprovado na conversa; implementação por PR focado)
- **Data:** 2026-07
- **Origem:** pedido de campo — "vender fiado no PDV com controle de limite por cliente". É a **caderneta** que o autônomo já usa no papel, digitalizada com trava de limite.
- **Relacionadas:** ADR-111 (módulo `copiloto`/Comigo — Balcão + orders; este ADR estende o modelo de pedidos), ADR-088 (visão Comigo; D4 pay-first — reconciliação abaixo), contatos (`contacts` reusada como identidade do cliente).

## Contexto e a tensão a reconciliar

O ADR-088 D4 desenhou o **pay-first** do Mesa/QR justamente para **eliminar calote/fiado esquecido**. Fiado parece contradizer isso. A reconciliação:

> **Fiado é decisão do OPERADOR, no Balcão — nunca no autoatendimento.** O Mesa/QR continua pay-first (o cliente sozinho não "se dá" fiado). No Balcão, o dono conhece o cliente e escolhe fiar — mas agora com o saldo e o limite na cara, não na memória.

Fiado é a caderneta: informal, relacional, parte do negócio do autônomo. O produto não moraliza — ele **dá controle** (limite, saldo, histórico) ao que já acontece.

## Decisões

### D1 — Fiado é forma de fechamento do Balcão, exige cliente identificado
No "cobrar" do Balcão, além de *Pix "recebi"* e *Dinheiro*, entra **Fiado**. Fiado **exige** um cliente (não pode ser só apelido de sessão): o operador informa **nome + telefone**; se não existir em `contacts`, **cria o contato na hora** (reusa a tabela, atrito mínimo). Venda à vista segue podendo usar só o apelido de sessão.

### D2 — Limite por cliente com **aviso + liberação do dono** (não bloqueio duro)
Cada cliente tem um `credit_limit`. Ao fechar no fiado, calcula-se o **saldo projetado** = saldo atual + total do pedido. Se ultrapassar o limite, o Balcão **avisa com os números** (*"Fulano já deve R$X, limite R$Y — essa venda passa em R$Z"*) e o **dono confirma para liberar mesmo assim**. A liberação acima do limite é **registrada** (`over_limit=1` + auditoria). Limite não é grade de crédito bancário — é guarda do dono; ele manda, mas informado.

Limite default de novos clientes de fiado vem de `organization_settings.comigo_fiado_default_limit` (o dono ajusta por cliente).

### D3 — Fiado é "a receber", não caixa (protege o termômetro)
Distinção que sustenta o north star ("quanto sobra **de verdade**"):
- **Venda/ticket médio/margem:** o fiado **conta** como venda no ato (regime de competência) — o `unit_cost_snapshot` é gravado igual, a margem é real.
- **"Quanto entrou no bolso" (caixa):** **só** o recebido (à vista + fiado **quitado**). Fiado em aberto aparece como **A RECEBER**, em bloco separado. Vender muito no fiado **não** faz o termômetro de caixa subir — senão ele mente.

### D4 — Caderneta: saldo, histórico e recebimento (inclusive parcial)
Tela **Caderneta** (sub-aba do Comigo): lista de clientes com saldo em aberto, limite e status (dentro/estourado). Por cliente: histórico de dívidas (pedidos) + pagamentos, e botão **Receber** que registra pagamento **total ou parcial** (*"abateu R$20 hoje"*). Saldo do cliente = Σ dívidas − Σ pagamentos.

## Modelo de dados (estende ADR-111)

- **`comigo_orders`**: `paid_via` ganha o valor `'fiado'`; pedido fiado carrega `contact_id` (obrigatório) e permanece como **recebível em aberto** até quitação (não conta no caixa).
- **`comigo_customer_credit`** — `id, organization_id, contact_id, credit_limit, created_at, updated_at`, `UNIQUE(organization_id, contact_id)`.
- **`comigo_fiado_ledger`** — `id, organization_id, contact_id, order_id?, kind ('debt'|'payment'), amount, over_limit (0/1, só em debt liberado acima do limite), note?, created_by, created_at`. Saldo = Σ(debt) − Σ(payment). Índice por `(organization_id, contact_id)`.

`comigo_fiado_default_limit` em `organization_settings`.

## Escopo (encaixe nos PRs da Fatia 1)
- **PR #1 (schema do Comigo):** já cria `comigo_orders` com `paid_via` incluindo `'fiado'` + as tabelas `comigo_customer_credit` e `comigo_fiado_ledger`.
- **PR #3 (Balcão):** botão Fiado → identificação do cliente (nome+telefone, cria contato) → checagem de limite com aviso+override → grava debt no ledger.
- **PR #4 (novo, Caderneta):** tela de saldos + recebimento total/parcial + a separação caixa × a receber no resumo do dia.

## Consequências
**Positivas:** digitaliza a caderneta (dor real e universal do autônomo) sem contrariar o pay-first do Mesa/QR; dá o número que faltava ("quem me deve e quanto"); a separação caixa × a receber mantém o termômetro honesto; reusa `contacts` (identidade) e o ledger já serve de base para cobrança/lembrete de fiado no futuro.

**Trade-offs / riscos:** fiado é risco de inadimplência do próprio autônomo — o produto informa, não garante; limite "avisa e libera" pode ser ignorado (aceito: é a caderneta do dono); dado de dívida do cliente é sensível (LGPD) — auditoria em toda escrita e isolamento por `organization_id`.

## Guardas
- Fiado **só** no Balcão (operador); **nunca** no Mesa/QR (pay-first intacto).
- Liberação acima do limite **sempre registrada** (auditoria + `over_limit`).
- Caixa conta só o recebido; fiado é a receber (não infla saúde/termômetro).
- LGPD: saldo devedor do cliente é dado sensível — transparência e isolamento por tenant.

## Testes (a criar junto do código)
`test:comigo-fiado` — cria contato de nome+telefone no ato; fecha pedido no fiado gera debt; saldo = debts−payments; estouro do limite avisa e, com override, grava `over_limit=1`; pagamento parcial abate saldo; fiado bloqueado no fluxo Mesa/QR; fiado em aberto NÃO entra no caixa do dia mas conta no ticket/venda.

## Aprovação
Comportamento do limite (avisa+libera) e identidade (nome+telefone cria contato) aprovados na conversa. Implementação junto da Fatia 1 do ADR-111, na ordem de PRs acima.
