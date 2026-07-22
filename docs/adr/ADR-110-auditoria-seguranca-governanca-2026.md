# ADR-110 — Auditoria de segurança/governança e hardening (2026)

**Status:** Implementado (4 correções) + 1 achado adiado por decisão do produto.
**Origem:** revisão pedida antes do piloto TOULON — _"revisar a parte de
segurança e governança em busca de anomalias e caso precise faça refatoração
sem quebrar nada, foco em ganho de performance para o cliente"_.

## Contexto

Antes de expor o produto ao piloto real (TOULON), varremos três dimensões em
paralelo: **isolamento multi-tenant**, **autenticação/governança** e
**performance**. Regra de execução: refatoração **sem quebrar nada** — apenas
mudanças de baixo risco; qualquer alteração de regra de negócio é escalada.

## Resultado

### 🟢 Isolamento multi-tenant — limpo
Nenhum caminho permite um `organization_id` ler dados de outro. Coberto por
`test:isolation` (13/13).

### 🟡 Autenticação/governança — nenhum HIGH, 5 achados MED
Quatro corrigidos neste ciclo; o quinto adiado (ver abaixo).

| # | Achado | Correção |
|---|--------|----------|
| 1 | Revogação de usuário só valia na expiração do token (24h): um usuário `blocked`/`deleted` seguia acessando. | `requireOrganizationAccess` recheca `global_status` do usuário do JWT a cada requisição protegida (lookup por PK); `blocked`/`deleted` → 403 imediato. |
| 2 | Auditoria de atos de master admin nunca gravava: ordem de argumentos de `logAuthEvent` trocada (objeto ligado como `eventType`) → `INSERT` lançava, engolido pelo `try/catch`. | Chamadas corrigidas para `ADMIN_PASSWORD_RESET` / `ADMIN_USER_SOFT_DELETED` com metadata preservada. |
| 3 | Escalonamento de privilégio: qualquer perfil com `usuarios:write` podia se promover a `owner`. | `PUT /:id/role` valida entrada (400/404) e exige que o **ator** seja `owner` para conceder ou alterar o papel `owner`. |
| 4 | Token da instância Evolution logado em claro. | Log passa a exibir só o prefixo. |

Cobertura: `scripts/test-security-hardening.ts` (6/6). Regressão: isolation
13/13, admin-users 20/20, rbac-enforcement 15/15.

### 🟢 Performance — resolvida (ver ADR/PR de performance)
11 índices nas tabelas mais quentes (inbox/mensagens, tickets, contatos,
produtos, estoque, agenda, auditoria, itens de pedido) + correção de bug de
colunas no `FundamentalsChecklistService` (`status='active'`→`active=1`,
`product_id`→`product_service_id`, `stock_quantity`→`quantity_available`).
`EXPLAIN QUERY PLAN` confirmou uso de índice na caixa de entrada.

## Achado #5 — adiado por decisão do produto

**A configuração da instância Evolution (`server.ts`, setup do WhatsApp) opera
sobre estado global, não escopado por tenant.** Risco MÉDIO. A refatoração
(escopar por tenant) toca o **fluxo crítico de conexão do WhatsApp** — o mesmo
que a TOULON usa no piloto — e exige janela de validação antes de subir.

**Decisão:** _deixar como está por ora_ (Emerson, 2026-07). Fica sinalizado
aqui e no PR para reavaliação **após o go-live da TOULON**, quando houver
janela para validar o fluxo de conexão sem risco ao piloto.

## Consequências

- Revogação de acesso agora é efetiva na hora, não em até 24h.
- Atos administrativos sensíveis passam a ter trilha de auditoria real.
- O topo da organização (`owner`) não pode mais ser alcançado por
  auto-promoção.
- Um ponto de acoplamento global (Evolution) permanece conhecido e registrado,
  a ser tratado depois do piloto.
