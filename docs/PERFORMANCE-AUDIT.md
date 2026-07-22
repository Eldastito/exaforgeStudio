# Auditoria de Performance & Segurança — 2026

Auditoria dirigida por evidências (isolamento multi-tenant, auth/governança,
performance). Este documento registra os achados e o que foi corrigido.

## Segurança & isolamento — resumo
- **Isolamento multi-tenant: sem anomalias.** Todo acesso é escopado por
  `organization_id` derivado do JWT verificado; rotas públicas usam slug/token
  assinado; nenhum caminho aceita `orgId` do cliente (exceto master admin, por
  design). Notas LOW de defesa-em-profundidade registradas, sem risco atual.
- **Auth/governança: postura sólida, sem HIGH.** 5 anomalias MED tratadas em PR
  separado de hardening (usuário bloqueado com token válido; auditoria dos atos
  de master admin; escalonamento de papel; token da Evolution em log; config
  global da Evolution).

## Performance — o que foi corrigido (este PR)

### 1. Índices nas tabelas mais quentes (ganho principal)
As tabelas `messages`, `tickets`, `contacts`, `products_services`,
`inventory_items`, `appointments`, `audit_logs`, `order_items` estavam **sem
índices de cobertura** nas queries mais frequentes (inbox, histórico do chat,
lookup por contato a cada mensagem recebida, leitura de catálogo). Adicionados 11
índices **puramente aditivos** (não mudam resultado; SQLite constrói sem lock
relevante nesta escala):

| Índice | Serve |
|---|---|
| `idx_messages_ticket_created` | histórico do chat + última mensagem do inbox (mais quente) |
| `idx_messages_org_sender` | agregações org-wide (ConversionVelocity, LGPD) |
| `idx_tickets_org_status_updated` | lista do inbox |
| `idx_tickets_org_contact_created` | "último ticket do contato" (toda msg recebida) |
| `idx_tickets_org_assignee` | filtro por atendente |
| `idx_contacts_org_identifier` | lookup do contato por número a cada mensagem |
| `idx_products_org_type_active` | leitura do catálogo (`type='product' AND active=1`) |
| `idx_inventory_org_product` | JOIN por produto + estoque baixo |
| `idx_appointments_org_status_start` / `idx_appointments_org_contact` | agenda/conflito |
| `idx_audit_logs_org_created` | tabela de crescimento ilimitado |
| `idx_order_items_org` | mais vendidos por org |

**Comprovação:** `EXPLAIN QUERY PLAN` da lista do inbox passou de `SCAN tickets`
para `SEARCH tickets USING INDEX idx_tickets_org_status_updated`.

### 2. Bug de colunas no FundamentalsChecklistService (correção)
A checagem de cobertura de estoque referenciava colunas inexistentes
(`products_services.status`, `inventory_items.product_id`, `stock_quantity`) —
a query lançava e a checagem sempre voltava "unknown". Corrigido para as colunas
reais (`active`, `product_service_id`, `quantity_available`).

## Recomendações (não aplicadas — precisam de decisão/UI)
- **`LIMIT` no histórico do chat** (`routes/messages.ts`): hoje retorna o histórico
  inteiro do ticket a cada abertura. Um `LIMIT` (com paginação) reduz muito o
  payload em conversas longas — mas muda o contrato da tela, então precisa de
  ajuste no front junto.
- **Memoização do catálogo** no `WhatsAppInventoryIntake` e do bloco de contexto
  no `BusinessContextService` (TTL curto por org) para caminhos de IA que hoje
  re-consultam/re-varrem a cada mensagem.
