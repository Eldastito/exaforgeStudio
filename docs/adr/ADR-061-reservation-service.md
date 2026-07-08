# ADR-061 — ReservationService — reservas por período (hospedagem, mesa, espaço)

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit. Pousada, hotel pequeno, restaurante com mesa reservada e espaço para eventos precisam bloquear um recurso por um intervalo de tempo, com sinal, respeitando capacidade. O código já estava rodando em `src/server/ReservationService.ts` sem ADR próprio — este documento fecha a lacuna e registra as regras que a IA (ADR-053) precisa respeitar quando sugere reservas.

---

## Contexto

O modelo de dados do ZappFlow trata "reserva" como um caso especial de `products_services` — o recurso reservável (`type = 'reservation'`) carrega `capacity` (quantas unidades simultâneas existem) e `reservation_unit` (`night` / `day` / `hour` / `slot`). Isso permite que um mesmo tenant venda produtos normais e recursos por período pelo mesmo catálogo, sem exigir o módulo Catálogo habilitado.

Três problemas específicos tinham que ser resolvidos:

1. **Corrida de overbooking.** Dois clientes pedindo o mesmo período do mesmo recurso ao mesmo tempo (via storefront público, IA no WhatsApp, ou digitação do dono) não podem passar pelos dois checks e gravar as duas reservas.
2. **Integração com PMS/OTA externo** (Booking, Airbnb, etc). O tenant pode ter um conector que empurra disponibilidade e preço por data — quando esse override existe, ele é o **teto**, não a fonte de verdade absoluta (a capacidade interna ainda vale como piso, se for menor).
3. **IA colhe, backend valida.** A IA no WhatsApp entende que o cliente quer reservar (`reservation_request` no JSON estruturado, ADR-053) e devolve `{ resource, start, end, units, guests, adults, children, pets, special_requests, budget }`. Ela **nunca** decide se há vaga — quem decide é a query de sobreposição neste serviço, dentro de uma transação SQLite.

## Decisão

**Regras invioláveis do `ReservationService`:**

1. **Sobreposição estrita, check-out abre vaga.** A query de conflito é `start_at < ? AND end_at > ?` — reservas que fazem check-out **no mesmo instante** do check-in seguinte não conflitam. Cabe ao produto exigir folga (limpeza etc.) via horários e não no motor.
2. **Só `pending` e `confirmed` ocupam.** `cancelled`, `completed` e `no_show` liberam a vaga. É a razão de `updateStatus` só aceitar essa lista fechada de estados.
3. **Cálculo em transação (`db.transaction`).** `getResource` → `availability` → `INSERT` roda tudo como uma unidade lógica. Não impede corrida em cluster distribuído, mas o deploy é single-process SQLite (uma escrita serializa a próxima) — suficiente hoje.
4. **Override do conector é teto, não fonte única.** `availability()` lê `resource_availability` para os dias do período; se houver `available_units`, a capacidade efetiva vira o **menor** valor entre a capacidade interna e o override — nunca aumenta o que a organização configurou.
5. **`ratedTotal` respeita preço por data.** Para `night`/`day` o total é `soma_por_dia(price_override || base) × units`. Para `hour`/`slot` é `base × períodos × units`. Isso permite alta temporada / feriado sem depender do gateway.
6. **Sinal:** `depositAmount` explícito vence. Se não vier, aplica `organization_settings.reservation_deposit_percent`. Pagamento é reconciliado pelo `PaymentService` (ADR-053 do webhook) via `markPaid()`, que move `status` para `confirmed` e `payment_status` para `paid`.
7. **`daysInRange` ancora ao meio-dia UTC.** Iterar por dia direto em `Date` quebra em datas com horário de verão — a âncora ao meio-dia UTC é o que garante que a iteração acerta o dia local (`America/Sao_Paulo`) mesmo em fronteira de fuso.
8. **`matchResource` normaliza acento e casing.** É o que a IA usa: ela devolve o nome do recurso ("Chalé Beira-Mar") e o serviço casa contra `products_services` de forma tolerante — exact match primeiro, depois `includes` bidirecional.
9. **Importação idempotente por nome.** `importResources` casa por `lower(name)`, cria o que falta, atualiza preço/capacidade/unidade do que existe. Roda quantas vezes quiser a mesma planilha.

O acoplamento com a IA está isolado em `AIOrchestratorService.sanitizeReservation` (`src/server/AIOrchestratorService.ts:791`): a IA devolve JSON solto, o `sanitize` transforma em `{ resource, start, end, units, ... }` tipado e clampeado, e só então o webhookProcessor chama `matchResource` + `availability` + `create`. O serviço aqui não confia em nada que a IA disse — recalcula tudo.

## Consequências

**Positivas:**
- Overbooking dentro de um único processo é impossível pelo caminho normal (transação + query de sobreposição).
- Adicionar tipo novo de recurso (bike, sala de reunião, quadra) é só cadastrar `products_services` com `type='reservation'` e uma `reservation_unit` válida — nenhum código novo.
- Storefront público, IA no WhatsApp, digitação manual e webhook do conector usam **o mesmo** `create()` — não há caminho paralelo que escape do check.
- Override de PMS/OTA integra sem virar fonte única — se o conector cair, a capacidade interna continua funcionando.

**Trade-offs aceitos:**
- **Sem política de cancelamento.** `updateStatus(id, 'cancelled')` libera a vaga na hora e não calcula multa nem reembolso proporcional de sinal. Se o dono quiser reter, faz manual no PIX. Aceitável na base atual (hospedagem informal, restaurante); vira ADR próprio quando aparecer hotel de rede.
- **Sem overbooking controlado.** Alguns hotéis vendem 105% da capacidade contando no-show. Aqui `bookable = livres >= units` é estrito. Reabrir isso exige coluna `overbooking_percent` no recurso e ainda não temos demanda.
- **Sinal via PIX manual.** `depositAmount` é gravado, mas a cobrança do sinal em si depende do PIX estático da organização (ADR do PaymentService). Não geramos QR dinâmico por reserva — o dono manda a chave e reconcilia pelo webhook de comprovante.
- **Corrida em cluster.** A transação é local ao processo SQLite. Se um dia rodarmos réplicas com WAL compartilhado, o `INSERT` ainda serializa, mas o `availability` no meio pode ler antes de outro processo escrever. Aceitável enquanto o deploy for single-container por tenant.
- **`matchResource` é heurístico.** "Chalé 1" e "Chalé 12" batem via `includes` e a IA pode fechar no errado. Em produção real, o serviço devolve o primeiro match ambíguo e o dono corrige na aba Reservas — não bloqueamos. Custo baixo, revisitar se aparecer confusão de verdade.
- **Sem calendário de manutenção.** Bloquear um chalé para reforma exige criar uma "reserva" com `status='confirmed'` no nome do dono. Feio, mas funciona.

## Testes

**Cobertura direta hoje: nenhuma.** Não existe `scripts/test-reservation-service.ts`. O motor está exercitado indiretamente por:

- `scripts/test-connector-public.ts` — passa por `importResources` e `setAvailability` no caminho de webhook autenticado (ADR-052).
- Testes do storefront público e do orquestrador de IA tocam `create` e `availability`, mas nenhum força os casos de borda.

**Lacunas honestas** que devem virar `scripts/test-reservation-service.ts`:

- Sobreposição borderline: check-out às 11:00 e check-in às 11:00 no mesmo recurso não pode conflitar.
- Overbooking sob concorrência: duas transações simultâneas pedindo a última vaga — só uma deve passar.
- `daysInRange` cruzando o horário de verão (que o Brasil hoje não tem, mas o código foi escrito para sobreviver ao retorno).
- Override do conector: `available_units = 0` no meio do período trava a reserva mesmo com capacidade interna sobrando.
- `ratedTotal` com `price_override` em alguns dias e base nos outros — soma tem que ser exata (arredondamento em duas casas).
- `matchResource` com acento, caixa alta, e substring ambígua.
- `markPaid` idempotente (webhook do gateway repete).

Enquanto esses testes não existirem, qualquer mudança na query de sobreposição ou em `daysInRange` exige revisão manual dos 6 consumidores listados em `grep -rn ReservationService src/server`.
