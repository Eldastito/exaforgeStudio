# ADR-074 — Scheduler — cron interno de tarefas periódicas

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit. Assinatura vira fatura, cadência de follow-up avança um passo, campanha de reativação dispara, PIX pendente ganha lembrete progressivo, lembrete de agendamento sai 24h antes — tudo isso é **puxado pelo relógio**, não por evento do usuário. Não dá pra depender do lojista abrir a UI pra que a mensalidade de amanhã seja cobrada hoje. A implementação (`src/server/Scheduler.ts`) foi crescendo passe a passe sem ADR de referência — este documento fecha a lacuna.

---

## Contexto

O sistema tem dois motores de trabalho automático, e é importante não confundi-los:

- **`JobQueueService`** (ADR relacionado) é **reativo**: reage a eventos discretos (mensagem chegou, pedido criado) e processa fora do request. Latência-driven.
- **`Scheduler`** (este ADR) é **proativo**: acorda em intervalo fixo e pergunta ao banco "quem venceu?". Relógio-driven. A fila reage; o scheduler **decide que é hora**.

Alternativas descartadas: `node-cron`/`agenda`/`bull-scheduler` — carregam dependência, formato próprio de cron string, e no nosso desenho single-node não pagam pelo peso. O `setInterval` nativo faz o mesmo com 3 linhas.

O cluster continua sendo **single-node** (SQLite local, sem Redis). Isso é o que torna o scheduler viável sem lock distribuído: só existe um processo, então só existe um tick. Se um dia houver réplica, este ADR precisa ser revisto (ver "Consequências").

## Decisão

**Dois timers no processo, orquestrados por `Scheduler.start(io)` chamado no boot do `server.ts`:**

1. **Tick lento** — padrão **1h** (`SCHEDULER_INTERVAL_MS`). Cobre tudo que tolera janela horária: reativação semanal, lembrete de agendamento (janela de 24h), assinaturas, expiração de pedidos, cadências de follow-up, retenção LGPD/avatares, carrinho abandonado, NPS, memória do cliente, recompra, sync Google Sheets, radar de oportunidades, snapshot RIC, trial ending.
2. **Tick rápido** — padrão **5min** (`SCHEDULER_FAST_INTERVAL_MS`). Cobre o que é sensível a minuto: `pixReminderPass` (lembrete progressivo de PIX), `InstagramService.publishScheduledPass` (post agendado às 14:30 tem que sair 14:30, não 15h), `JobQueueService.sweepStale` (rede de segurança da fila), `ticketSlaPass` (SLA de 30min não pode ser vigiado hora em hora).

**Boot warm-up:** o tick lento roda a primeira vez em `30s` e o rápido em `45s` — variáveis pra evitar concorrer com a inicialização de rotas/DB e pra que os testes automatizados (`scripts/test-vision-maestro-bridge.ts`) não esperem os 45s reais.

**Anti-duplicação por identificador**, três padrões repetidos ao longo do arquivo:
- **Trava de janela** por coluna `*_last_run` em `organization_settings` (`auto_reactivation_last_run`, `repurchase_reminder_last_run`, `opportunity_radar_last_run`): pass só dispara se `Date.now() - last >= 7 dias`.
- **Trava de estado** por coluna no próprio registro alvo (`appointments.reminder_status='sent'`, `tickets.abandoned_nudged_at IS NOT NULL`, `contacts.repurchase_reminded_at >= last_purchase_at`, `payment_charges.reminder_count < max`).
- **Trava de dia** por memo em processo (`ricSnapshotPass` usa `_lastRicSnap = YYYY-MM-DD`) — mais barato que ida ao banco quando o único requisito é "1x por dia por processo".

**TZ São Paulo** (`process.env.TZ_DISPLAY || 'America/Sao_Paulo'`) é usada nos **cutoffs de exibição** ao cliente (`toLocaleString` no lembrete de agendamento). Os cutoffs de janela contra o banco usam `datetime('now', ...)` do SQLite — UTC. Consciente: um agendamento das 09:00 SP no dia seguinte é comparado corretamente em UTC; só a **string** que vai pro WhatsApp é traduzida pra hora local.

**Isolamento por org**: cada pass itera `organization_settings` filtrando por flag opt-in (`auto_reactivation_enabled`, `pix_reminder_enabled`, `nps_enabled`, ...), e envolve cada org em `try/catch` — uma org com Google desconectado não derruba o tick pras outras. Cada `await` do tick também é `.catch(console.error)`, então um pass quebrado nunca aborta o tick.

## Consequências

**Positivas:**
- Zero dependência externa. Um `setInterval`, um `AbortController` implícito (o processo morre, o timer some).
- Modelo mental simples: "de hora em hora, o que venceu?" — o SQL de cada pass é auditável e testável isoladamente.
- Opt-in por org via flag em `organization_settings` — tenant novo entra desligado; ativar não requer deploy.
- Boot warm-up de 30s/45s dá tempo do DB estar quente e do WebSocket conectado antes do primeiro passe emitir eventos.

**Trade-offs aceitos:**
- **Não sobrevive restart no meio de um pass.** Se `subscriptionPass` cair após gerar a fatura mas antes de marcar `charge_ref`, o próximo tick reenvia a cobrança. A trava está no *efeito* (`charge_ref IS NULL`), não em transação distribuída. Duplo envio é possível em janelas de crash — aceitável no volume atual, dolorido se virar rotina.
- **Sem overlap protection entre ticks.** Se um `tick()` demorar mais de 1h (raro, mas `googleSheetsSyncPass` com muitas orgs pode), o próximo `setInterval` dispara em paralelo. As travas de banco impedem duplicação de *efeito*, mas dois `memoryPass` concorrentes vão gastar dobrado em IA. Solução futura: flag em memória `this._running` no início do `tick()`.
- **Se o processo dorme, perde ticks.** Container hibernado (PaaS free-tier), laptop fechado em dev, host suspenso — o tick não "recupera" o que perdeu. Aceitável porque nenhum pass depende de estado incremental por tick: todos consultam "quem venceu até *agora*?" e processam. Só cliente que perde é `ricSnapshotPass` num dia que o processo não subiu — snapshot daquele dia não existe.
- **Single-node hardcoded.** Se um dia houver réplica, dois processos rodarão os mesmos passes ao mesmo tempo. As travas de banco protegem contra o efeito, mas o ideal seria eleição de líder (Postgres advisory lock, ou coluna `scheduler_leader_id` no `organization_settings` global). Não implementado; sinalizado aqui pra quando importar.
- **Tudo no mesmo tick, sequencial.** O `tick()` faz 20+ `await`s em série. Cadeia lenta = fila longa. Em compensação, ordem é determinística e não há race entre passes que tocam a mesma tabela (ex.: `orderExpiryPass` cancela pedido → `subscriptionPass` não tenta cobrar).

## Testes

**Cobertura direta hoje: baixa.** Não há `scripts/test-scheduler.ts` que rode o `tick()` completo. O que existe:

- `scripts/test-vision-maestro-bridge.ts` — usa `SCHEDULER_FAST_INITIAL_DELAY_MS` pra reduzir a espera do primeiro passe rápido; valida indiretamente que o `fastPass` executa `MaestroService.reactToVisionEvents`.
- Testes por serviço consumidor (`test-subscription.ts`, `test-cadence.ts`, `test-campaign.ts`, `test-pix-reminders.ts`) exercitam a **lógica de cada pass** chamando o método diretamente, sem o timer. Isso cobre o "SQL certo, mensagem certa", mas não cobre "o tick chamou o método na ordem certa".

**Lacunas honestas:**
- Sobreposição de ticks — não há teste que force `tick()` a demorar > `INTERVAL` e verifique o comportamento sob concorrência.
- TZ boundary — cutoff de dia às 23:59 SP no `ricSnapshotPass` não é testado (poderia rodar duas vezes na virada UTC).
- Anti-duplicação sob crash — matar o processo no meio de `subscriptionPass` e conferir se o próximo tick não cobra duas vezes é hoje verificação manual.
- Boot warm-up — não há teste que valide que `start()` é idempotente (`if (this.timer) return`); mudar essa guarda passaria silencioso.

Enquanto isso, qualquer mudança no `Scheduler.ts` exige revisão manual dos 20+ passes e das flags `*_enabled` correspondentes em `organization_settings`.
