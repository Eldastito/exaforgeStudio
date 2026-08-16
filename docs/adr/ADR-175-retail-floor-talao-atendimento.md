# ADR-175 — FLOOR: Talão da venda no atendimento (conciliação venda-a-venda)

- **Status:** Implementado (1 fatia).
- **Data:** 2026-08-16
- **Origem:** PRD "ZapFlow Moda/TOULON — Melhorias v1.0", frente FLOOR.
- **Relacionadas:** ADR-150 (Retail Floor — lista da vez/atendimento),
  ADR-083 Fase C3 (`RetailBoletaService` — boletas em tempo real).

## Contexto

Na ADR-150 a conversão do atendimento é declarada em 2 tempos (RN-150-004):
`outcome=converted` grava `reconciliation_state='pending'` com valor/peças
DECLARADOS, e a conciliação com o PDV promove para `confirmed`/`unmatched`. Mas
o PDV da TOULON (`retail_erp_seller_sales`) é **agregado diário por filial+
matrícula** — "não existe venda a venda". O matching é por COBERTURA DE VALOR no
nível vendedor/dia; um atendimento convertido não carrega nenhuma âncora que o
ligue a UMA venda específica.

Paralelamente, o `RetailBoletaService` (ADR-083 C3) já registra a HORA real de
cada venda pelo nº do talão manuscrito (`retail_boleta_events`), e casa esses
cliques com o PDV pelo nº da boleta. Os dois mundos — atendimento (quem vendeu,
lista da vez) e talão (qual venda, que hora) — não se falavam.

## Decisão

O atendimento convertido passa a carregar, **opcionalmente**, o **nº do talão**
da boleta manuscrita. Isso liga lista-da-vez → talão → boleta/PDV e abre o
caminho da conciliação **venda-a-venda**, sem mudar a rotina do papel.

1. **Coluna aditiva** `retail_floor_attendances.boleta_number TEXT` + índice
   único parcial `(organization_id, shift_id, boleta_number)` — dois
   atendimentos não reivindicam o mesmo talão no mesmo turno.
2. **`RetailFloorAttendanceService.finish`** aceita `boletaNumber`:
   - só vale em `converted` (rejeita nos demais desfechos, como `declaredValue`);
   - normaliza (só dígitos, preservando os zeros à esquerda no display "017752");
   - **unicidade no turno** por chave sem zeros à esquerda ("017752" ≡ "17752");
   - grava no audit (`RETAIL_FLOOR_ATTENDANCE_FINISH`).
3. **Casamento DERIVADO (RN-004)**: `RetailFloorReconciliationService.summary`
   deriva, por leitura, se o talão do atendimento bate com um **clique de boleta
   ATIVO do dia** (`retail_boleta_events`). É **advisório**: a ausência de clique
   NÃO invalida a venda (o clique da boleta é paralelo/opcional) — sinaliza
   "talão sem hora real registrada" (`boletaClickMatched: true|false|null`).
   Totais `withBoleta`/`boletaClickMatched` no resumo.
4. **UI**: campo "Nº do talão" no encerramento (venda realizada) do
   `RetailFloorView`; coluna "Talão" com ✓/⚠ no painel de conciliação.

## Regras de Negócio

- **RN-175-001 (tenant/escopo):** herda RN-150-001; toda query filtra
  `organization_id`; o talão é único por `shift_id`.
- **RN-175-002 (opt-in, não bloqueante):** talão é opcional; sem ele o fluxo da
  ADR-150 é idêntico (0-regressão). O casamento com o clique é advisório.
- **RN-175-003 (derivado, nunca mutável):** o casamento talão↔boleta↔PDV é
  DERIVADO por query na leitura — nunca coluna de vínculo mutável (RN-004).
- **RN-175-004 (só em conversão):** talão só se aplica a `converted`.

## Consequências

- Conciliação ganha âncora venda-a-venda (talão) sobre a agregada por valor,
  sem quebrar o matching existente.
- Aditivo/retrocompatível; isolado por organização; sem tabela nova nem motor
  paralelo (reusa `retail_boleta_events`).

## Fora desta fatia

- **Reposição na ruptura**: atalho no atendimento `not_converted` (category=
  product, com estoque na rede) pra disparar transferência/reposição — fatia
  própria (a demanda não atendida e o `transfer_requested` já existem).
- Promover automaticamente `pending→confirmed` quando talão + clique + PDV
  fecham venda-a-venda — evolução da conciliação (hoje o sinal é exibido).

Teste: `scripts/test-retail-floor-talao.ts` (12 checks).
