# Plano de Implementação — Fase 2A: Motor de Reservas por Período

> Objetivo: permitir **reservar um recurso por um período** com controle de
> **disponibilidade/capacidade** — destrava hotéis, pousadas, pensões,
> restaurantes (mesa), aluguéis (temporada/equipamentos), quadras e salões.
>
> Encaixa direto no gating da Fase 1: vira o módulo opcional `reservas` (a
> vertical Hospitalidade liga; o plano cobra — monetização na Fase 2 de billing).

## 0. O que já existe a nosso favor (confirmado no código)

- `products_services` já tem o tipo `'reservation'` (db.ts L141) — hoje sem uso.
- `PaymentService.chargeForOrder` aceita **valor arbitrário** ⇒ cobrar **sinal**
  é trivial (PIX dinâmico/manual já prontos).
- Fluxo de pedido na **loja pública** (`storefrontPublic.ts`) e criação de
  agendamento pela **IA** (`new_appointment`) servem de molde para o booking.
- Sync com Google Calendar (`GoogleOAuthService.syncAppointment`) reaproveitável.
- `appointments` é **timeslot único de 1 recurso** — NÃO resolve capacidade de N
  quartos/mesas. Por isso precisamos de um modelo novo (abaixo).

## 1. O que falta de verdade: capacidade + disponibilidade

O coração do módulo é responder: *"para este recurso, neste período, há unidade
livre?"*. Hoje não há conceito de **capacidade** (ex.: 5 quartos standard, 12
mesas) nem de **período** com sobreposição.

## 2. Modelo de dados

### 2.1 Recurso reservável = `products_services` (type `reservation`) + colunas
Reaproveita o catálogo (não cria entidade paralela). Migrações idempotentes:
- `ALTER TABLE products_services ADD COLUMN capacity INTEGER DEFAULT 1`
  (unidades simultâneas: nº de quartos daquele tipo / nº de mesas / 1 p/ aluguel único).
- `ALTER TABLE products_services ADD COLUMN reservation_unit TEXT DEFAULT 'night'`
  (`night` = diária, `hour` = por hora, `slot` = por turno, `day` = por dia).
- `price` (já existe) = preço por unidade de tempo (diária/hora/turno).

### 2.2 Nova tabela `reservations`
```
id, organization_id, resource_id (→products_services.id), contact_id, ticket_id?,
start_at DATETIME, end_at DATETIME, units INTEGER DEFAULT 1, guests INTEGER?,
status TEXT DEFAULT 'pending',   -- pending | confirmed | cancelled | completed | no_show
total_amount REAL, deposit_amount REAL DEFAULT 0, payment_status TEXT DEFAULT 'pending',
order_id?, google_event_id?, notes, created_by, created_at
```
Índice: `(organization_id, resource_id, start_at, end_at, status)`.

## 3. Motor de disponibilidade (a peça central)

`ReservationService.availability(orgId, resourceId, startAt, endAt, units=1)`:
```
capacity   = products_services.capacity
ocupadas   = SUM(units) de reservations
             WHERE resource_id=? AND status IN ('pending','confirmed')
               AND start_at < :endAt AND end_at > :startAt   -- sobreposição
livres     = capacity - ocupadas
bookable   = livres >= units
```
Retorna `{ capacity, ocupadas, livres, bookable }`. (Regra de sobreposição
padrão: check-out no mesmo instante do check-in NÃO conflita.)

Helper `nights/hours(start,end)` para calcular `total_amount = price × períodos × units`.

## 4. Backend

### 4.1 `ReservationService` (`src/server/ReservationService.ts`)
- `listResources(orgId)` (type reservation, active).
- `availability(...)` (acima).
- `create(orgId, {resourceId, contactId, ticketId?, startAt, endAt, units, guests, notes, createdBy})`
  — valida disponibilidade ATÔMICA (transação) antes de inserir; calcula total e
  deposit (config do recurso/loja); status `pending`.
- `updateStatus(orgId, id, status)` — cancelar/confirmar; cancelado libera estoque
  (some da soma de ocupação) e remove evento do Calendar.
- `list(orgId, filtros)` — por período/status/recurso.
- (Opcional) `syncCalendar` reaproveitando o padrão de `syncAppointment`.

### 4.2 Rotas (`src/server/routes/reservations.ts`, módulo `reservas`)
- `GET /resources` — recursos reserváveis.
- `GET /availability?resource=&start=&end=&units=` — checagem.
- `GET /` — lista (agenda de ocupação).
- `POST /` — cria reserva (manual/owner).
- `PATCH /:id` — status/remarcar.
- `DELETE /:id` — cancela.
- Montar em `server.ts`: `protectedApi.use("/reservations", reservationsRoutes)`.

### 4.3 Pagamento de sinal
- Ao confirmar a reserva, opcional gerar cobrança via `PaymentService.chargeForOrder`
  com `amount = deposit_amount` (ou % do total). Webhook de pagamento marca
  `payment_status='paid'` e pode auto-confirmar a reserva.

## 5. IA (chat) — reservar conversando
Espelha o padrão `new_appointment`:
- Novo contexto no prompt (quando há recursos reserváveis): lista dos recursos +
  instrução para coletar **recurso, datas (check-in/out) e nº de unidades**.
- Novo campo no JSON: `reservation_request: { resource, start, end, units, guests }`.
- O orquestrador resolve o recurso, chama `availability`; se houver vaga, cria a
  reserva (e anexa o sinal via PIX); se não, responde com alternativas (datas/unid.).
- Reusa o `route_to_area`/persona já existentes sem conflito.

## 6. Loja virtual (vitrine) — reservar sozinho
- Card do recurso com **seletor de período** (intervalo de datas ou turno) + nº de
  unidades/pessoas.
- `GET /api/public/store/:slug/reservations/availability` e
  `POST /api/public/store/:slug/reservation` (cria `pending` + sinal PIX),
  reaproveitando o token de cliente (`?c=`) e o checkout atual.

## 7. UI do app
- **Catálogo:** quando `type = reservation`, exibir campos `capacity`,
  `reservation_unit` (diária/hora/turno) e preço por unidade.
- **Nova aba "Reservas"** (módulo `reservas`): lista + visão de ocupação por
  período; criar reserva manual com checagem de disponibilidade ao vivo; ações
  confirmar/cancelar; link do evento no Calendar.
- (ViewMode novo `reservas` no `useStore` + render no `App.tsx` + item na Sidebar.)

## 8. Integração com o gating da Fase 1
- Adicionar `reservas` em `OPTIONAL_MODULES` e no mapa `MODULE_BY_ROUTE`
  (`reservations → reservas`) do `ModuleService`.
- Incluir `reservas` no preset da vertical **hospitalidade** (e opcionalmente
  servicos p/ aluguéis/quadras). Adicionar rótulo no `ModulesPanel`.

## 9. Fora de escopo desta fase
- Tarifas dinâmicas/sazonais e regras de estadia mínima avançadas.
- Mapa visual de quartos/mesas (drag).
- Overbooking controlado / lista de espera.

## 10. Ordem de entrega (PRs pequenos e empilhados)
1. **MVP owner-side**: migrações + `ReservationService` (com motor de
   disponibilidade) + rotas + gating (`reservas`) + aba Reservas + campos no
   Catálogo. Testável ponta a ponta sem IA/loja.
2. **IA**: `reservation_request` no orquestrador + sinal via PIX.
3. **Loja**: widget de reserva na vitrine pública.

Cada passo fecha com `npx tsc --noEmit` + `npm run build`.
