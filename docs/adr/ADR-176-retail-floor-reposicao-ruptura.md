# ADR-176 — FLOOR: Reposição na ruptura (transferência num toque)

- **Status:** Implementado (1 fatia).
- **Data:** 2026-08-16
- **Origem:** PRD "ZapFlow Moda/TOULON — Melhorias v1.0", frente FLOOR.
- **Relacionadas:** ADR-150 (Retail Floor — scan/demanda não atendida),
  ADR-136 (`business_signals`), ADR-084 (sombra de estoque por loja).

## Contexto

Na ADR-150 o scan do atendimento já detecta a ruptura RECUPERÁVEL: quando a peça
não tem saldo na loja mas EXISTE em outra loja da rede, a resposta lista as lojas
doadoras ("Disponível em"). Mas o "pedir" ficava implícito — o único traço era o
scan `action='transfer_requested'` que só reaparecia no dia seguinte como
agregado (`retail_floor_network_recovery`). Não havia ação IMEDIATA que avisasse a
loja doadora/operação a separar e enviar a peça.

## Decisão

Um **atalho de transferência num toque** durante o atendimento. Quando o scan
mostra estoque na rede, o vendedor toca na loja doadora → o servidor publica um
`business_signal` ACIONÁVEL (ADR-136, dedupe — **nunca** tabela de alerta
paralela, convenção nº 12) apontando loja doadora × peça, que flui pra atenção/
operação.

1. **`RetailFloorReplenishmentService.request(orgId, attendanceId, {scanId,
   targetStoreId?}, user)`** (novo, mínimo):
   - autorização herdada do atendimento (próprio vendedor ou gestor da loja);
   - carrega o scan (deve ter `product_id` — EAN fora do mix não vira
     transferência, é sortimento);
   - **recalcula estoque FRESCO** dos doadores (saldo positivo das outras lojas;
     re-resolve a variante pelo EAN, já que o scan guarda só o produto);
   - sem doador com saldo → **erro** (não inventa transferência; é demanda de
     compra, já coberta por `unmet_demand` → Comprador IA);
   - alvo = `targetStoreId` (validado como doador) ou o **maior doador**;
   - marca o scan `action='transfer_requested'` (alimenta o agregado diário
     `network_recovery` e reflete a intenção);
   - publica o sinal `retail_floor_replenishment_request` (dedupe por
     `atendimento|scan|doadora`) + audita.
2. **Rota** `POST /api/retail-floor/attendances/:id/replenishment`.
3. **UI**: no `ScanPanel`, quando a peça está sem estoque local mas com rede, as
   lojas doadoras viram **botões** "pedir transferência de …".

## Regras de Negócio

- **RN-176-001 (tenant/escopo):** `orgId` 1º arg; herda a autorização do
  atendimento (RN-150-005).
- **RN-176-002 (recuperável):** só transfere o que a rede TEM agora (saldo
  fresco). Sem doador → não inventa; vira compra.
- **RN-176-003 (fato + PUBLICADO ≠ REPOSTO):** o sinal é fato calculado (doadora,
  saldo) com evidência; `basis=fact` do PEDIDO, não do resultado — publicar o
  pedido não repõe a peça.
- **RN-176-004 (idempotência):** dedupe por `(atendimento, scan, doadora)` —
  tocar duas vezes atualiza o mesmo sinal.
- **RN-176-005 (sem peça, sem pedido):** EAN fora do mix não vira transferência.

## Consequências

- A ruptura recuperável vira ação IMEDIATA (transferência) sem sair do
  atendimento, complementando o agregado diário existente.
- Aditivo/retrocompatível; sem tabela nova nem motor paralelo (reusa
  `business_signals`, o scan e a sombra de estoque).

## Fora desta fatia

- Confirmar a transferência (a peça chegou/foi vendida) e fechar o loop
  reposição→outcome — evolução (hoje o sinal é o pedido).
- Reserva formal da peça na loja doadora (baixa de saldo) — depende do fluxo
  de transferência do ERP.

Teste: `scripts/test-retail-floor-replenishment.ts` (13 checks).
