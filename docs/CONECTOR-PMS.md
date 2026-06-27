# Conector genérico (PMS / OTA / ERP) — Fase A (camada agnóstica)

> Destrava o gap nº 1 da hotelaria (preço/disponibilidade reais) sem amarrar a um
> PMS específico. A camada é **agnóstica**: vale CSV hoje e qualquer PMS amanhã
> (um adaptador só precisa fazer POST no endpoint de entrada).

## Por que agnóstico

Existem dezenas de PMS no Brasil (Desbravador, HITS, CM, Opera, etc.), cada um com
API diferente. Construir um adaptador específico no escuro = risco de fazer para o
PMS errado. Esta fase entrega o **contrato genérico** (importação + ingestão de
disponibilidade/preço por data). Quando o 1º hotel disser qual PMS usa, basta um
adaptador fino que chama este endpoint — nada do core muda.

## O que entra

### 1. Importar recursos por planilha (valor imediato)
- Tela **Reservas › Importar / PMS**: cola/sobe um CSV `nome; preço; capacidade; unidade`.
- `ReservationService.importResources` faz **upsert por nome** (idempotente).

### 2. Override de disponibilidade/preço por data
- Tabela `resource_availability (resource_id, date, available_units, price_override)`.
- `ReservationService.availability()` passa a usar o **menor `available_units`**
  informado nas datas do período como TETO de unidades vendáveis (ainda subtrai as
  reservas internas, evitando overbooking pelo nosso lado).
- `ReservationService.ratedTotal()` soma o **preço por diária** (override quando
  houver, senão o preço-base) — o total da reserva reflete a tarifa real do dia.
- Sem override: comportamento idêntico ao anterior (capacidade interna + preço base).

### 3. Entrada autenticada por TOKEN (o "adaptador agnóstico")
- `organization_settings.integration_token` (gera/rotaciona na UI).
- Rota pública `POST /api/connector-in/availability` (auth por `x-connector-token`
  ou `?token=`) — qualquer PMS/OTA/middleware empurra:
  ```json
  { "rows": [ { "resource": "Quarto Standard", "date": "2026-07-01", "available": 4, "price": 380 } ] }
  ```
- `POST /api/connector-in/resources` — sincroniza recursos pelo mesmo token.
- Fora do JWT (sistemas externos) e isenta de rate-limit (tráfego de máquina).

## Rotas

| Rota | Auth | Uso |
|---|---|---|
| `GET /api/connector/token` | JWT | obtém token + caminho de entrada |
| `POST /api/connector/token/rotate` | JWT | gera token novo |
| `POST /api/connector/resources/import` | JWT | importa recursos (UI) |
| `POST /api/connector/availability` | JWT | override manual (UI) |
| `POST /api/connector-in/availability` | token | PMS empurra disponibilidade/preço |
| `POST /api/connector-in/resources` | token | PMS sincroniza recursos |

## Próximo passo (quando houver hotel)
Escrever o **adaptador do PMS específico** do 1º cliente: um job que lê a API
do PMS e faz POST em `/api/connector-in/availability` periodicamente. O core já
está pronto — é só o adaptador. O mesmo padrão serve depois para ERP/PDV (mercado).
