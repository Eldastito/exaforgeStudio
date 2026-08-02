# ADR-150 — Retail Floor: Atendimento de Loja, Lista da Vez e Consulta de Estoque

- **Status:** Em implementação — Fatia 1
- **Data:** 2026-08-02
- **Origem:** PRD "Módulo Atendimento de Loja, Lista da Vez e Consulta de Estoque" v2.0 (piloto TOULON).
- **Relacionadas:** ADR-083 (Retail Ops — lojas/fechamento), ADR-084 (modo de estoque D4), ADR-087 (multiloja), ADR-095 (RBAC granular), ADR-105 (conector Alterdata/ModaUp), ADR-136 (Decision-Action Ledger / `business_signals`), ADR-137 (Comprador IA — consome demanda não atendida), ADR-142 (memória de padrões do varejo).

## Contexto

A TOULON opera lojas físicas onde a "lista da vez" (ordem de atendimento dos
vendedores) é informal e não auditável; o tempo de espera/atendimento não é
medido; os motivos de não conversão não são estruturados; e as vendas são
lançadas no PDV **no fim do dia**, desconectadas do atendimento que as gerou.
Resultado: indicadores de conversão por vendedor não existem ou mentem, e a
ruptura (cliente pediu, loja não tinha) evapora sem virar decisão de compra ou
transferência.

## Decisão de arquitetura

**Novo módulo opcional `retail_floor`** — NÃO um sistema separado:

1. Mesmo login/JWT/sessão/organização do ZappFlow. Rota `/api/retail-floor/*`,
   gateada por `ModuleService.MODULE_BY_ROUTE["retail-floor"] = "retail_floor"`.
2. `retail_floor` entra em `ADDON_MODULES` (nenhuma vertical liga sozinha) e em
   `PLAN_FREE_ADDONS` (o dono liga em Configurações › Módulos, como o Retail
   Ops — é operacional do piloto TOULON, billing mockado).
3. **Não existe role nova `store_manager`.** O escopo do gerente vem de
   `retail_stores.manager_user_id` (ADR-083). Owner/admin gerenciam todas as
   lojas; um usuário que é `manager_user_id` de uma loja gerencia SÓ ela; um
   usuário mapeado em `retail_sellers.user_id` opera como vendedor. A UI enxuta
   (`/loja/atendimento`) esconde o resto do app, mas **a segurança está no
   backend** (gate de módulo + escopo por loja em toda rota).
4. Estoque, produto, vendas do PDV e sincronização **continuam onde estão**:
   `retail_store_inventory` (sombra por loja), `products_services`,
   `retail_erp_seller_sales` (vendas por vendedor via Alterdata),
   `alterdata_sync_cursors` (última sincronização). O módulo só LIGA o
   atendimento a esses dados.
5. Sinais para o Orquestrador via `business_signals` (ADR-136) com
   `dedupe_key` — **sem outbox própria** (a PRD sugeria `retail_floor_event_outbox`;
   o ledger de sinais já é o contrato único de eventos do produto).

### Vínculo vendedor↔loja

`retail_sellers` não tem `store_id` de propósito (vendedor pode cobrir outra
loja). O vínculo do dia é o **roster do turno**: entrar na fila do turno da
loja X é o que coloca o vendedor na loja X naquele dia. A conciliação com o
PDV usa `matricula` + `filial` (que já resolvem para `store_id` no sync).

## Regras de Negócio (RNs duras — testadas)

- **RN-150-001 (tenant):** toda função de service recebe `orgId` como 1º arg;
  toda query filtra `organization_id`. Escopo adicional por `store_id` quando a
  operação é de loja.
- **RN-150-002 (cronômetro server-side):** tempo de espera/atendimento é SEMPRE
  derivado de `joined_at`/`started_at`/`ended_at` gravados pelo servidor.
  Nenhum tempo vem do cliente.
- **RN-150-003 (posição derivada):** a posição na lista da vez é DERIVADA por
  query (política + `joined_at` + atendimentos do turno), nunca coluna mutável
  de posição (mesma lição do RN-004 da ADR-145).
- **RN-150-004 (conversão em 2 tempos):** `outcome=converted` gera
  `reconciliation_state='pending'`. Só a conciliação com o PDV promove para
  `confirmed` (ou rebaixa para `unmatched`). Nenhum indicador trata declarado
  como confirmado.
- **RN-150-005 (override auditado):** reordenar fila, pular vendedor, encerrar
  atendimento de terceiro ou linkar venda manualmente é ação de gestor
  (owner/admin ou `manager_user_id` da loja) e SEMPRE audita via
  `logAuthEvent`.
- **RN-150-006 (IA explica, não inventa):** sinais publicados são fatos
  calculados (contagens, tempos, gaps). A IA nunca atribui causa não medida,
  nunca ranqueia vendedor por conversão bruta.
- **RN-150-007 (estoque com carimbo):** toda resposta de consulta de estoque
  carrega `last_sync_at` do cursor Alterdata. UI marca "desatualizado" quando
  > 24h.
- **RN-150-008 (LGPD):** atendimento é anônimo por padrão. Identificar o
  cliente é opt-in e segue as bases legais existentes (`dados_pessoais`;
  histórico de compra exige consentimento). `maskIdentifier` em metadata de
  auditoria.
- **RN-150-009 (demanda vem de scan):** `retail_floor_unmet_demand` nasce de um
  scan/consulta registrado no atendimento — nunca digitada solta (sem
  evidência não há sinal de compra).
- **RN-150-010 (retenção):** atendimento/turno nunca é DELETE. Cancelamento e
  auto-encerramento são UPDATE de status (`outcome='unknown'` quando o
  vendedor esqueceu aberto).
- **RN-150-011 (calibração):** durante o piloto, `calibration_until` (settings)
  marca o período em que os indicadores NÃO alimentam cobrança/comissão. A API
  de analytics expõe o flag para a UI avisar.

## Entidades (6 novas + 1 aditivo)

| Tabela | Papel |
|---|---|
| `retail_floor_settings` | 1 linha por org: `queue_policy` (`round_robin`\|`fifo`), `auto_close_minutes`, `calibration_until`, `anonymous_default` |
| `retail_floor_shifts` | turno por loja/dia; unique parcial: 1 turno `open` por loja |
| `retail_floor_queue_state` | 1 linha por (turno, vendedor): status + timestamps; posição derivada |
| `retail_floor_attendances` | atendimento: turno, vendedor, started/ended, outcome, motivo hierárquico (JSON), `reconciliation_state`; unique parcial: 1 ativo por vendedor |
| `retail_floor_attendance_scans` | leituras de EAN durante o atendimento (produto, estoque local/rede, `last_sync_at`, ação) |
| `retail_floor_unmet_demand` | ruptura evidenciada: attendance + produto/EAN + motivo (`no_assortment`\|`no_local_stock`\|`no_network_stock`\|`missing_size`\|`missing_color`\|`missing_category`) |

Aditivo: `retail_erp_seller_sales.attendance_id` (link após conciliação).

Estados da fila: `offline → waiting → next → serving → closing → waiting`
(+ `break`, `unavailable`, `skipped`).

Desfechos: `converted` | `not_converted` | `walkout` | `unknown`
(auto-encerrado). Motivo de `not_converted` é hierárquico (nível 1:
`product`|`price`|`size_fit`|`service_time`|`other`; nível 2 quando `product`:
taxonomia da `unmet_demand`).

Conciliação (`reconciliation_state`): `pending` → `confirmed` |
`unmatched`; `not_converted`/`unknown` não entram.

## Sinais publicados (`business_signals`, domain `retail_floor`)

`queue_delay`, `long_service`, `unmet_demand`, `out_of_assortment`,
`declared_vs_pdv_gap`, `conversion_drop`, `network_recovery` — todos com
`dedupe_key = {tipo}|{store}|{dia}[|{chave}]`, `basis='fact'` e evidência com
as contagens que sustentam o sinal (RN-150-006).

## Fatias

| Fatia | Entrega | Status |
|---|---|---|
| 1 | ADR + módulo/gate + migração DB (6 tabelas + aditivo) + settings + contexto por escopo (owner/gerente/vendedor) + teste | **ENTREGUE (PR desta fatia)** |
| 2 | Turno (abrir/fechar) + fila (join/status/pausa) + posição derivada round-robin | pendente |
| 3 | Atendimento start/finish com transação atômica (1 ativo por vendedor) + auto-encerramento | pendente |
| 4 | Taxonomia de desfecho hierárquica + política de retorno à fila | pendente |
| 5 | Scan no atendimento: estoque local + rede agregada + `last_sync_at` + `unmet_demand` | pendente |
| 6 | Conciliação declarado × PDV (matching multi-critério + job diário + override manual) | pendente |
| 7 | UI `/loja/atendimento` (Kanban realtime via SSE + fallback polling) | pendente |
| 8 | Sinais para o Orquestrador (7 tipos) | pendente |
| 9 | Analytics da loja + modo calibração + piloto TOULON | pendente |

## O que ficou explicitamente de fora

- Comissão baseada em conversão confirmada (proibida no piloto — RN-150-011).
- Dashboard regional comparativo (pós-piloto).
- PWA mobile dedicado do vendedor (a UI da Fatia 7 é responsiva web).
- Mensagem pós-atendimento ao cliente via WhatsApp (ADR próprio se puxarem).
