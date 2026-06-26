# ZappFlow Supply — Ecossistema de Compras & Reposição

> Visão: cada cliente do ZappFlow (hotel, restaurante, mercado, comércio local) é
> ao mesmo tempo **comprador** e **fornecedor potencial** de outro. Ao perceber
> estoque crítico, a Orquestradora aciona o **Agente de Compras**, que monta a
> lista, cota com fornecedores, compara preço × disponibilidade × prazo e gera
> um **relatório para aprovação humana**. Resultado: hotel não fica sem produto,
> fornecedor vende mais, comércio local entra na rede.

## Como isso "retroalimenta" o ZappFlow

- **Hotel** ganha gestão automática de estoque, garantia de fornecimento e
  melhor preço entre quem realmente tem em estoque pronto pra entregar.
- **Fornecedor** recebe pedidos qualificados via WhatsApp, com janela de
  entrega, sem disputa de mercado aberto.
- **Comércio local** (mercado, farmácia) vira opção em emergências e em itens
  perecíveis/de última hora.
- **ZappFlow** vende para os 3 lados: passa de "ferramenta por cliente" para
  **rede com efeito de rede** (cada lado puxa o outro).

## Onde isso encaixa no que já existe (não reinventar)

| Peça da visão | No ZappFlow hoje |
|---|---|
| Estoque, custo, reserva/baixa, movimentações | ✅ `InventoryService`, `inventory_items`, `stock_movements` |
| Limite crítico por item + alerta | ✅ `inventory_items.low_stock_threshold` + `NotificationService.lowStock` |
| Orquestradora (Zapp gestor) e padrão de agente especialista | ✅ `AIOrchestratorService` |
| Cotação / proposta para aprovação humana | ✅ Padrão de `campaign_intent` (proposta → confirmação SIM/NÃO) |
| Áreas/handoff/notificações | ✅ `AttendanceArea`, `Notifications` |
| Gating por módulo opcional / vertical | ✅ `verticals.ts` + `ModuleService` |

➡️ A Fase 1 **não precisa de rede ainda**: já dá pra entregar valor enorme com o
que existe, sem depender de fornecedor estar no ZappFlow.

## Arquitetura proposta

```
[Estoque cai abaixo do mínimo crítico (low_stock_threshold)]
        │
        ▼
[PurchaseRequisitionService]  ── consumo médio (saídas/30d) ──►  sugere QTD
        │
        ▼
[Requisição de compra rascunho]  → aprovação humana (1 clique)
        │
        ├──(Fase 1)── relatório enviado pro responsável (chat/notificação/PDF)
        │
        ├──(Fase 2)── ProcurementAgent dispara a lista pros fornecedores conhecidos
        │              (cadastrados como contatos), coleta respostas no WhatsApp,
        │              monta o comparativo de preço × prazo × disponibilidade
        │
        └──(Fase 3)── Rede ZappFlow: fornecedores na plataforma c/ estoque ao vivo,
                       matching geo + estoque, PO + entrega agendada, emergência.
```

## Modelo de dados (Fase 1 — só o necessário agora)

Tudo **aditivo e opt-in**. Reusa `inventory_items.low_stock_threshold` que já existe.

```sql
-- Requisição de compra (rascunho gerado pela IA p/ humano aprovar).
CREATE TABLE purchase_requisitions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  status TEXT DEFAULT 'draft', -- draft | approved | dismissed | ordered
  created_by TEXT,             -- 'ai' | user_id
  approved_by TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  approved_at DATETIME
);

CREATE TABLE purchase_requisition_items (
  id TEXT PRIMARY KEY,
  requisition_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  product_service_id TEXT NOT NULL,
  variant_id TEXT,
  current_stock INTEGER,          -- estoque vendável no momento da geração
  threshold INTEGER,              -- mínimo crítico
  suggested_qty INTEGER,          -- sugestão da IA (consumo médio × cobertura)
  avg_daily_consumption REAL,     -- saídas/30d ÷ 30
  days_of_cover REAL              -- cobertura atual (estoque ÷ consumo médio)
);

-- Opt-in por org: liga a reposição automática + alvo de cobertura em dias.
ALTER TABLE organization_settings ADD COLUMN procurement_enabled INTEGER DEFAULT 0;
ALTER TABLE organization_settings ADD COLUMN procurement_target_days INTEGER DEFAULT 14;
```

## Fases — ordem que evita o cold start de marketplace

**Fase 1 — Reposição inteligente intra-cliente (este PR).**
- Scheduler.procurementPass: a cada hora varre os `inventory_items` com
  `quantity_available - quantity_reserved <= low_stock_threshold`.
- Agrupa numa **requisição rascunho** (única por org até ser aprovada/descartada).
- Calcula consumo médio diário (saídas em `stock_movements` nos últimos 30d) e
  sugere QTD = max(threshold − atual, consumoDiário × `procurement_target_days`).
- Notifica o gestor; tela "Compras" lista, exibe e tem botões **Aprovar** /
  **Descartar**. Ao aprovar, a requisição vira `approved` (e — futuramente — vira
  um PO e dispara a Fase 2).
- ➡️ Valor imediato pro hotel, **zero dependência de fornecedores na plataforma**.

**Fase 2 — Cotação com fornecedores conhecidos (próximo PR).**
- Cadastro de fornecedores como **contatos com tag `supplier`** (sem inventar
  schema novo); número de WhatsApp + categorias atendidas.
- ProcurementAgent dispara a lista da requisição aos fornecedores e parseia as
  respostas (preço, disponibilidade, prazo). Monta o comparativo e gera o
  **relatório de compra** (com 1 clique p/ confirmar com o vencedor).

**Fase 3 — Rede ZappFlow (efeito de rede).**
- Fornecedores são orgs no ZappFlow (catálogo + estoque vivo) com **geo + raio
  de entrega**.
- Matching automático "quem tem X, perto, em estoque, melhor preço/prazo".
- Pedido de Compra (PO) + entrega agendada + **busca de emergência**.

## Princípios

- **Aprovação humana sempre** (Fase 1 e 2). A IA propõe; o humano confirma.
- **Nunca inventa estoque/preço do fornecedor**: na Fase 1 só sugere com base no
  consumo real do próprio cliente; na Fase 2/3 só com base em resposta/dado vivo.
- **Aditivo e opt-in** (módulo `compras` no gating; `procurement_enabled`).
- **Não trava por canal**: começa por WhatsApp (que já temos); voz/e-mail entram
  como reuso quando existirem.
