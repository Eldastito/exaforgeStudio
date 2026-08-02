# ADR-150 — Retail Floor: Atendimento de Loja, Lista da Vez e Consulta de Estoque

- **Status:** Implementação completa — 10 fatias + CLI de ativação do piloto.
  Ativar a TOULON = rodar NO SERVIDOR: `node dist/pilot-retail-floor.cjs
  --find toulon` → `--org <id>` (diagnóstico) → `--org <id> --apply
  --calibration-days 30 [--store 1005 --manager-email <email>] [--digest]`.
  O `plan` imprime o checklist de prontidão (gerente, vínculos de vendedor,
  canal, sync Alterdata) — nada é cobrado do time até a calibração vencer.
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
   **UI (Fatia 7):** o caminho `/loja/*` do PRD JÁ pertence à vitrine pública
   (storefront) — a tela vive como aba `retailfloor` do app autenticado
   (Sidebar gateada pelo módulo; `organization_settings.default_landing_view`
   pode apontar direto pra ela). Realtime por POLLING curto (8s) — snapshot
   barato; upgrade pra socket.io (sala `org:*` existente) se o piloto pedir.
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
- **RN-150-012 (ordem dura da fila):** só o "próximo" derivado (RN-150-003)
  entra em atendimento livremente. Iniciar qualquer outro (furar a fila) exige
  liberação EXPLÍCITA do gestor via `allowSkip` no `start` — a conta gestora
  sozinha NÃO basta, porque no modo quiosque (Fatia 12) o tablet loga sempre
  como gestor; a liberação é o PIN, que a UI traduz em `allowSkip`. Sem o flag,
  o start fora da vez é rejeitado (`not_your_turn` para o próprio vendedor,
  `not_next` para terceiro) mesmo para conta gestora. Furar continua sendo
  override auditado (RN-150-005).

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

**Matching (Fatia 6) — decisão:** `retail_erp_seller_sales` é AGREGADO DIÁRIO
por (filial, matrícula) — não existe venda a venda no sync (ADR-105). Então o
matching é por COBERTURA DE VALOR no nível (loja, vendedor, dia): sem ERP →
todos `unmatched`; com ERP → confirma na ordem de `started_at` enquanto a soma
declarada cabe em `erpValor × 1.05`; declarado sem valor é confirmado quando o
PDV tem venda no dia (não consome orçamento). Idempotente e SÓ-PROMOVE (o já
confirmado consome o orçamento no re-run; ERP atrasado promove
`unmatched→confirmed`); rebaixar `confirmed` é exclusivamente humano (override
do gestor, auditado). Job: tick horário do Scheduler, hoje+ontem, após o sync
Alterdata.

## Sinais publicados (`business_signals`, domain `retail_floor`)

`queue_delay`, `long_service`, `unmet_demand`, `out_of_assortment`,
`declared_vs_pdv_gap`, `conversion_drop`, `network_recovery` — todos com
`dedupe_key = {tipo}|{store}|{dia}[|{chave}]`, `basis='fact'` e evidência com
as contagens que sustentam o sinal (RN-150-006).

**Definições (Fatia 8):** `queue_delay` = minutos do dia com o roster INTEIRO
em atendimento simultâneo (proxy honesto — não rastreamos fila de clientes),
≥15min. `long_service` = atendimentos ≥45min. `declared_vs_pdv_gap` = valor
dos `unmatched` (não o total do dia, que incluiria pendentes).
`conversion_drop` = conversão CONFIRMADA 7d×7d, amostra mínima 20+20, queda
relativa ≥20%, dedupe pela semana. `network_recovery` = scan com
reserva/transferência em peça sem estoque local. Sweep no tick horário do
Scheduler (hoje+ontem, após a conciliação) + `POST /signals/scan` sob demanda.

## Fatias

| Fatia | Entrega | Status |
|---|---|---|
| 1 | ADR + módulo/gate + migração DB (6 tabelas + aditivo) + settings + contexto por escopo (owner/gerente/vendedor) + teste | **MERGED (PR #711)** |
| 2 | Turno (abrir/fechar) + fila (join/status/pausa) + posição derivada round-robin | **MERGED (PR #712)** |
| 3 | Atendimento start/finish com transação atômica (1 ativo por vendedor) + auto-encerramento | **MERGED (PR #713)** |
| 4 | Taxonomia de desfecho hierárquica + política de retorno à fila | **MERGED (PR #714)** |
| 5 | Scan no atendimento: estoque local + rede agregada + `last_sync_at` + `unmet_demand` | **MERGED (PR #715)** |
| 6 | Conciliação declarado × PDV (matching multi-critério + job diário + override manual) | **MERGED (PR #716)** |
| 7 | UI (Kanban + encerramento + consulta de peça + conciliação; polling 8s) | **MERGED (PR #717)** |
| 8 | Sinais para o Orquestrador (7 tipos) | **MERGED (PR #718)** |
| 9 | Analytics da loja + modo calibração + piloto TOULON | **MERGED (PR #719)** |
| 10 | Pós-piloto: comparativo de rede (owner/admin) + resumo diário da loja por WhatsApp (opt-in, ADR-108 como destinatários) | **MERGED (PR #720)** |
| Ops | CLI de ativação do piloto (`pilot-retail-floor`): find/plan/apply idempotente + checklist de prontidão | **ENTREGUE (PR #721)** |
| 11 | UI/UX: redesign ZappFlow (Kanban DnD + KPIs, PR #723) + onboarding guiado (loja → equipe → turno) + cadastro de equipe com FOTO (`retail_sellers.photo_url` + `POST/PUT /sellers`) + escala do dia ao abrir turno | **MERGED (PRs #724–#726)** |
| 12 | Modo quiosque: vendedor vê SÓ a Lista da Vez; funções de gestão (conciliação, indicadores, rede, fechar turno, equipe, troca de loja) atrás do PIN da gerência por loja (molde Clínica Fase 28: sha256(salt+pin) + timingSafeEqual + lockout 5×/15min); loja FIXA na 1ª escolha do aparelho | **MERGED (PR #727)** |
| 13 | Analytics v2: ticket médio + PA (declarado × confirmado), ruptura em R$, walkout por hora, série por dia, conversão com × sem consulta de peça, taxa de auto-encerrados; ops via audit (`/analytics/ops`): fila furada autorizada, pausas por vendedor, destino pós-atendimento | **MERGED (PR #731)** |
| 14 | Gráficos do dono: funil de venda (loja + rede consolidada), comparativo visual por loja na Rede (conversão/ticket/ruptura), mapa de escala (heatmap dia-da-semana × hora, `byWeekdayHour`), Pareto de perdas com % acumulado | **PR desta fatia** |

## Fatia 14 — Gráficos do dono

Quatro visuais sobre dados existentes (único aditivo de API: `byWeekdayHour`
no `/analytics/store` e `declaredCount`/`confirmedCount` nas linhas da rede).
Sem lib de gráfico — divs puros como os gráficos da Fatia 13 (leve pro
tablet, sem dependência nova).

1. **Funil de venda** (loja e rede): atendimentos → com desfecho → venda
   declarada → confirmada no PDV, cada barra com % sobre o degrau ANTERIOR.
   Degrau decidido→declarada encolhendo = problema de conversão; declarada→
   confirmada = gap com o PDV (conciliação ou declaração sem venda).
2. **Lojas lado a lado** (aba Rede): barras horizontais por loja — conversão
   confirmada, ticket confirmado e ruptura em R$. Ordem alfabética; o texto
   da aba segue explícito: a comparação é do humano (RN-150-006).
3. **Mapa de escala**: heatmap dia-da-semana × hora de início — o "por hora"
   agregado mistura terça com sábado e esconde o padrão de escala; o heatmap
   mostra onde precisa de gente.
4. **Pareto de perdas**: a lista "por que não converteu" ganhou barra
   proporcional + % acumulado (o 80/20 visível).

## Fatia 13 — Analytics v2 (métricas sobre dados já gravados)

Zero migração de schema: tudo é agregação nova sobre o que o módulo já
grava, mantendo as regras duras da Fatia 9 (dois números rotulados
declarado × confirmado — RN-150-004; nada ranqueia vendedor — RN-150-006).

1. **Painel da loja** (`/analytics/store`) ganhou: `ticketDeclared`/
   `ticketConfirmed` e `piecesPerSaleDeclared`/`piecesPerSaleConfirmed`
   (média só sobre linhas com o dado preenchido); `unknownCount`/`unknownPct`
   (higiene: auto-encerrado alto = cronômetro mal usado, números sem
   confiança); `byHour` com `walkouts` (entrou-e-saiu no pico = loja
   subdimensionada); `byDay` (série de tendência com contagens honestas);
   `scanSplit` (conversão com × sem consulta de peça — mede o valor do
   leitor); `unmetLostValue` (R$ da ruptura via preço do catálogo; peça sem
   produto resolvido conta em `unpricedCount` — não fingimos precisão).
2. **Rede** (Fatia 10) carrega `ticketConfirmed`, `unknownPct` e
   `unmetLostValue` por loja.
3. **Ops via audit** (`RetailFloorOpsMetricsService`, `GET /analytics/ops`,
   escopo gestor): métricas de governança derivadas do `auth_audit_logs`,
   sem tabela nova — fila furada AUTORIZADA (starts `override=true` da
   RN-150-012: total/por dia/por vendedor beneficiado), pausas por vendedor
   (pareamento entrada→saída do status; pausa em aberto conta na frequência
   e NÃO nos minutos) e destino pós-atendimento (returnTo fila × pausa).
   Escopo por loja resolvido via `shiftId` dos metadados; o audit do
   `finish` passou a carregar `shiftId`/`storeId` (aditivo) — eventos
   antigos ficam de fora e a métrica conta do deploy em diante (honesto).
4. **UI**: 2ª fileira de KPIs (ticket, PA, entrou-e-saiu, auto-encerrados,
   ruptura em R$, fila furada), split de consulta de peça, walkout empilhado
   no gráfico por hora, série por dia e cards de pausas/furos por vendedor
   (alfabético).

## Fatia 12 — Modo quiosque + PIN da gerência (feedback TOULON)

O app roda num tablet/PC compartilhado da loja, logado numa conta com
poderes de gestão. Sem trava, qualquer vendedor no balcão acessaria
conciliação, indicadores e fechamento de turno. Entregue:

1. **PIN da gerência por loja** — aditivos `retail_stores.manager_pin_*`;
   `setManagerPin` (4-8 dígitos; trocar/remover exige o PIN atual — quem
   está com o tablet na mão não troca a fechadura) + `verifyManagerPin`
   (códigos estáveis PIN_NOT_SET/REQUIRED/INVALID/LOCKED; lockout 5×/15min;
   tudo auditado) + reset de lockout owner/admin. Rotas em
   `/api/retail-floor/stores/:id/manager-pin[/verify|/reset-lockout]`.
2. **UI em dois modos** — travado (padrão): só a Lista da Vez, nome da loja
   fixo, botões Fechar turno/Equipe pedem PIN ao toque; destravado (PIN):
   abas de gestão aparecem por 5 min (auto-trava) com botão "Gerência" pra
   travar antes. A verificação é NO SERVIDOR; a conta do quiosque já tem os
   direitos — o PIN é a trava de balcão auditada, não substitui RBAC.
3. **Loja fixa do aparelho** — 1ª escolha persiste (localStorage); trocar
   exige PIN. Sem PIN configurado, o 1º destravo guia a criação.
4. **Operação continua livre** — abrir turno com escala, fila, atendimento,
   bipe e "Entrar na vez" não pedem PIN (é o trabalho do salão).

## Fatia 11 — UI/UX (feedback do cliente TOULON)

O cliente pediu explicitamente: vendedores com **foto nos cards**, lojista
**cadastra a equipe** e **associa ao turno**, e a tela abrindo **direto no
Kanban com KPIs**. Entregue:

1. **Foto do vendedor** — aditivo `retail_sellers.photo_url`; upload reusa
   `POST /api/uploads/image` (multer → `/media/*`); `photoUrl` exposto no
   contexto, na fila (`ordered`) e no card (Avatar cai em iniciais sem foto).
2. **Cadastro de equipe pela UI** (`POST /sellers`, `PUT /sellers/:id`,
   escopo `assertAnyManager` — gestor de alguma loja ou owner/admin).
   Matrícula do PDV é opcional no cadastro: sem ela geramos placeholder
   `LV-xxxxxx` (trocável depois SEM perder histórico — id preservado);
   a conciliação PDV continua usando a matrícula real quando existir.
3. **Onboarding guiado** — sem loja: cria a primeira loja inline
   (owner/admin) em vez do erro críptico "storeId é obrigatório"; sem
   equipe: CTA de cadastro; com equipe: abrir turno.
4. **Escala do dia** — "Abrir turno" pergunta *quem trabalha hoje?*
   (multi-select com fotos) e já coloca os selecionados na lista da vez —
   o vínculo vendedor↔turno que o cliente pediu, sem prender o vendedor
   à loja no cadastro (mantém ADR-150 §"Vínculo vendedor↔loja").

## Fatia 10 — pós-piloto (entregue)

1. **Comparativo de rede** (`RetailFloorNetworkAnalytics.network` +
   `GET /analytics/network`, owner/admin; aba "Rede" na UI): uma linha por
   loja ativa com os mesmos números honestos do painel — ordem alfabética,
   a comparação é do humano, não ranking do sistema (RN-150-006).
2. **Resumo diário da loja por WhatsApp** (`RetailFloorDigestService`,
   opt-in `daily_digest_enabled` + `digest_hour` BRT): a mensagem-exemplo do
   PRD com fatos do próprio módulo (conversão confirmada × média 28d,
   principal perda com %, peça mais pedida, pico + minutos de fila cheia do
   sinal da Fatia 8, unmatched/pendentes). Destinatários:
   `retail_store_responsibles` (ADR-108) + número da loja; dedupe por
   (org, loja, dia) em `retail_floor_digest_log`; best-effort no passe
   horário do Scheduler; `GET /digest/preview` pro gestor conferir o texto.
3. **Upgrade do realtime pra socket.io segue FORA** — só se o piloto mostrar
   que o polling de 8s não basta.

## O que ficou explicitamente de fora

- Comissão baseada em conversão confirmada (proibida no piloto — RN-150-011).
- PWA mobile dedicado do vendedor (a UI da Fatia 7 é responsiva web).
- Mensagem pós-atendimento ao CLIENTE via WhatsApp (ADR próprio se puxarem —
  o resumo da Fatia 10 é interno, pro gestor).
- Upgrade do realtime pra socket.io (documentado na Fatia 7/10).
