# ADR-060 — AppointmentService — agenda interna e integração com IA

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit de decisão já em código sem ADR. O `AppointmentService` nasceu para resolver um problema banal do dia-a-dia do hotel/salão/varejo: a IA no WhatsApp marcava dois clientes no mesmo horário porque não tinha estado do que **este tenant** já vendeu. Mesmo com o Google Calendar integrado, não dá para depender só dele — nem todo cliente tem conta Google, nem todo hotel quer expor a agenda inteira do calendário corporativo para a IA, e o webhook do WhatsApp precisa decidir *em tempo de resposta* se o horário oferecido pela IA está livre. Este documento fecha a lacuna.

---

## Contexto

O ZappFlow é multi-tenant (hotelaria + varejo) e cada organização tem regras de funcionamento próprias: hotel que atende 24×7, salão que abre seg-sex 9h-19h, loja de conveniência que trabalha em turnos. A agenda mora em `appointments` + `organization_settings.agenda_*` (open/close/slot/days/capacity), tudo por `organization_id` — o `AppointmentService` **nunca** aceita chamada sem `orgId`.

Por que agenda interna se já existe Google Calendar sincronizado (ADR-041)?

- O Calendar do dono do negócio pode conter compromissos pessoais que a IA não deve enxergar. A `appointments` é o espelho *filtrado* do que veio de conversa no WhatsApp/site.
- Boa parte dos clientes finais (hotel de interior, salão de bairro) não usa Google Calendar. Sincronismo é opcional; agenda interna é a fonte da verdade.
- A IA (ADR-047 — AIOrchestratorService) precisa de um bloco de contexto **estável, curto e determinístico** no prompt. Ler o Calendar em tempo de request seria caro, sujeito a rate limit e devolveria coisa que a IA não deveria ver.

O consumidor crítico é `AIOrchestratorService.ts:218`, que chama `AppointmentService.agendaText(orgId)` e injeta o resultado no system prompt antes de cada resposta ao cliente. Isso é o que impede a IA de "inventar" um horário: ela só vê a lista de LIVRES e uma regra explícita de nunca oferecer fora dela. Depois, `webhookProcessor.ts:478-493` fecha o loop: quando a IA devolve `newAppointment.scheduled_start`, o processador chama `duplicateForContact` + `isFree` **antes** de gravar, e em caso de conflito reinjeta `nextFreeSlots(3)` na conversa. É defesa em profundidade — a IA pode falhar, o servidor não deixa passar.

## Decisão

**Regras do `AppointmentService`:**

1. **Fuso fixo BR (UTC-3), sem DST.** `TZ_OFFSET_MIN = -180`, override por `APP_TZ_OFFSET_MINUTES`. Brasil aboliu horário de verão em 2019; assumimos isso e ficamos com aritmética determinística de minutos em vez de depender de tzdata do container. O rótulo humano (`label()`) usa `Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" })` — só para exibição.
2. **Schema em `organization_settings`:** `agenda_open_hour`, `agenda_close_hour`, `agenda_slot_minutes`, `agenda_days` (CSV ISO 1..7), `agenda_capacity`. Defaults: 8h-18h, 60 min, seg-sex, 1 por horário. `saveConfig` sanitiza tudo (fecha > abre, slot ≥ 5 min, dias únicos 1-7, capacidade ≥ 1) e devolve a config efetiva.
3. **Detecção de conflito por sobreposição de intervalos**, não por igualdade de timestamp. `activeOverlapping` percorre `status NOT IN ('cancelled','no_show')` e verifica `en > fromMs && st < toMs`. Se `scheduled_end` estiver nulo (legado), assume `start + slotMin`. Capacidade > 1 (hotel com N recepcionistas) é suportada via `conflictCount < capacity`.
4. **Anti-duplicidade por contato:** `duplicateForContact` impede o mesmo cliente virar dois `appointments` no mesmo slot — proteção contra retry do webhook do WhatsApp e contra a IA reconfirmar sem perceber que já marcou.
5. **`nextFreeSlots` alinhado ao grid** a partir da abertura do dia, avança dia-a-dia respeitando `days`, com guarda de ~21 dias para não rodar loop infinito se a agenda estiver totalmente cheia.
6. **`agendaText()` é o contrato com a IA.** Formato fixo em pt-BR: header com funcionamento + lista de próximos 6 livres separados por " · " + regra explícita ("só ofereça/confirme horários desta lista"). Se não há livres, muda o texto para instruir a IA a NÃO confirmar. Esse texto é lido pelo LLM — mudar a formatação é mudar o comportamento do assistente.
7. **`ms()` tolerante a formatos legados** de SQLite (`YYYY-MM-DD HH:MM:SS` sem `Z`, ISO com `Z`, ISO com offset). Uma ADR inteira poderia sair daqui, mas ficamos com heurística: se não tem sufixo de zona, trata como UTC. É o que o `datetime('now')` do SQLite produz.

## Consequências

**Positivas:**
- IA nunca oferece horário ocupado — o bloco `agendaText()` reduz alucinação a ~zero nesse eixo, e o double-check no `webhookProcessor` blinda o resto.
- Multi-tenant sem vazamento: `orgId` é obrigatório em todo método público; a query filtra por `organization_id` antes de qualquer aritmética.
- Configuração acessível via UI (`routes/appointments.ts`) sem migração — colunas ausentes caem no default silenciosamente (`try/catch` em `config()`), então a feature liga progressivamente à medida que o tenant configura.
- `ConversionVelocityService` (ADR-053) reusa `config()` + `TZ_OFFSET_MIN` para calcular horário comercial — a agenda é a fonte da verdade do "quando o negócio está aberto".

**Trade-offs aceitos:**
- **Sem múltiplos profissionais.** `capacity` é um número escalar — funciona para "quantos atendimentos simultâneos", não para "qual profissional". Salão com 3 cabeleireiros distintos que têm agendas independentes não é modelado. Aceitável no perfil de cliente atual (hotel pequeno, salão de 1-2 pessoas, loja de conveniência); vira ADR nova quando entrar rede maior.
- **Sem recorrência.** Cada `appointment` é ponto único. Consulta semanal recorrente é registrada N vezes ou fica de fora. Não vimos demanda real ainda.
- **Sem CTA de confirmação por SMS/WhatsApp.** O status vai para `confirmed` quando a IA (ou o operador humano) marca, mas não há lembrete no dia anterior nem link de "confirmar/cancelar". Para o piloto, o próprio fluxo de conversa cobre; virou item de backlog para Fase 4.
- **Fuso hard-coded em UTC-3.** Se o Brasil reintroduzir DST ou se aparecer tenant em outro país, temos que mexer. A env `APP_TZ_OFFSET_MINUTES` alivia, mas cada tenant ainda compartilha o mesmo offset do processo. Documentado em `docs/DEPLOY.md`.
- **`activeOverlapping` faz full scan de `appointments` por org.** Em tenant com 10k+ agendamentos históricos, `nextFreeSlots` fica caro. Aceitável hoje (poucos milhares por org); índice em `(organization_id, status, scheduled_start)` já resolve quando doer.

## Testes

**Cobertura direta hoje: nenhuma.** Não existe `scripts/test-appointment-service.ts`. O serviço é exercitado de forma indireta:

- `scripts/test-ai-orchestrator.ts` — chama caminho onde `agendaText()` é injetado no prompt; garante que o formato do bloco não regride ao ponto de a IA parar de respeitá-lo.
- `scripts/test-conversion-velocity.ts` (ADR-053) — usa `config()` e `TZ_OFFSET_MIN`; qualquer mudança na semântica de `agenda_open_hour`/`close_hour` explode aqui.
- `scripts/test-tenant-isolation.ts` — cobre indiretamente que query por `organization_id` não vaza entre tenants (o `AppointmentService` é um dos vetores testados).

**Lacunas honestas** que devem virar `scripts/test-appointment-service.ts` na Fase 4:
- `isFree` / `conflictCount` com capacidade > 1 e agendamentos parcialmente sobrepostos.
- `nextFreeSlots` pulando dias não-atendidos e virando para o dia seguinte quando o dia atual encheu.
- `duplicateForContact` reconhecendo o mesmo `contact_id` no mesmo slot mesmo com múltiplas execuções de `webhookProcessor` (retry do Meta).
- `agendaText()` no caso "sem horários livres" — a IA precisa ler o texto de negação, é o único fallback de segurança.
- `ms()` para os três formatos de datetime que o SQLite pode devolver.
- Round-trip de `saveConfig` — sanitizações (fechamento ≤ abertura, dias fora de 1-7, slot < 5) não vazando para o banco.

Enquanto esses testes não existirem, qualquer mudança no `AppointmentService` exige revisão manual dos 4 consumidores listados em `grep -rn AppointmentService src/server`.
