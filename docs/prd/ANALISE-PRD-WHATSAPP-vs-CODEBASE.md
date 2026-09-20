# ANÁLISE — PRD "Conexão WhatsApp Autônoma e Resiliente" × Codebase (F0)

**Baseline auditado**: `afcb70f0` (HEAD em 20/09/2026 — o PRD analisou `48e315dd`, 3 merges atrás; nada de WhatsApp mudou entre eles).
**Provedor**: Evolution GO, linhagem 0.7.2 (fonte clonada e auditada em `evolution-foundation/evolution-go`, commit `9337afc` "sync: 0.7.2").
**Veredito da F0**: o PRD é factualmente correto nas 4 falhas centrais, mas **subestima o que o HEAD já tem** (resolvedor canônico com gate de regressão, estado em 4 dimensões como read-model, provisionamento idempotente por nome) e **desconhece dois fatos de produção** que mudam prioridade e desenho (incidente Postgres + rate-limit da Meta). A execução segue o plano de fatias da seção 7 — não as 9 fases do PRD.

---

## 1. O que a produção REALMENTE mostrou (16–19/09/2026)

O PRD aposta no passkey como "hipótese principal" do QR que não vem. O incidente real, diagnosticado e resolvido nesta operação, foi outro:

1. **Postgres do provedor esgotado** (`pq: sorry, too many clients already`) → GetQr falhava no `StartInstance` → "QR não obtido" pra sempre. Causa-raiz **no evolution-go**: cada `StartInstance` cria um `sqlstore.New` (pool novo) que nunca é fechado (`pkg/whatsmeow/service/whatsmeow.go:322-334` — a mensagem "Failed to create container" dos logs de produção nasce na linha 337). Mitigado com `max_connections=300` + restart; **o vazamento continua no provedor**.
2. Corrigido o Postgres, **o QR voltou a ser gerado normalmente** — nenhum `passkeyStage` foi observado no ambiente TOULON.
3. O bloqueio seguinte foi **rate-limit da Meta** no pareamento ("não é possível conectar novos dispositivos") após ciclos repetidos de parear/desparear — resolve com tempo, não com código.

**Consequências de desenho**:
- O gate de envio e o estado fresco protegem a operação HOJE; o passkey protege um cenário ainda não observado aqui (mas real — ver §2).
- Qualquer reconciliador periódico precisa ser **leak-aware**: o GetQr (e qualquer caminho que inicie sessão) consome conexões de Postgres do provedor. Reconciliar = ler estado (`/instance/all`), nunca re-disparar sessão; jitter + backoff + teto por cluster.
- O runbook de conexão deve incluir o sintoma `too many clients` (visível no diagnóstico do #1691, "Logs da instância no provedor") e o remédio (max_connections/restart).

## 2. Evidência de FONTE do evolution-go (o probe da F0)

Clonado `evolution-foundation/evolution-go` @ 0.7.2 e auditado — isso **promove o passkey de hipótese a fato de contrato**:

- `GetQr`, com cerimônia de passkey ativa, **não devolve QR** e devolve (`pkg/instance/service/instance_service.go:99-101, 457-463`):
  - `passkeyStage` — estágios: `challenge` → `awaiting_confirmation` → `confirmation` (código disponível, usuário confere) → `confirmed` → `error` (`pkg/passkey/ceremony/store.go:21-25`);
  - `passkeyCode` — o código de confirmação;
  - `passkeyOpenUrl` — URL da cerimônia (`GET /passkey-ceremony/{token}`), construída de **`PASSKEY_PUBLIC_URL`**; sem a env, o provedor devolve o literal `<SET_PASSKEY_PUBLIC_URL>` (`instance_service.go:502-505`) — sinal de má-configuração detectável.
- TTL da cerimônia: **~5 minutos** (`store.go:29`).
- Não existe bypass headless: a confirmação WebAuthn roda em `web.whatsapp.com` com o autenticador do dono (release notes 0.7.2).

**O que o ZapFlow faz hoje** (`src/server/EvolutionService.ts:449, 488, 552-553`): captura só `passkeyStage`, **descarta** `passkeyCode`/`passkeyOpenUrl` e devolve `ok:false` mandando o operador pro Manager. Exatamente a falha crítica nº 1 do PRD — confirmada.

**Checklist de ambiente (operador, sem código)**:
- [ ] Confirmar a versão implantada no VPS (imagem `evoapicloud/evolution-go` — conferir se a build carrega a cerimônia 0.7.2; `GET /server/ok`/manager mostra a versão).
- [ ] Definir `PASSKEY_PUBLIC_URL` no compose apontando pra URL pública HTTPS do evolution-go (hoje **não está** no compose — o openUrl viria como `<SET_PASSKEY_PUBLIC_URL>`).

## 3. Matriz PRD × HEAD (existe / incompleto / ausente)

| # | Requisito do PRD | Estado no HEAD | Evidência |
|---|---|---|---|
| P0-1 | Passkey completo (openUrl+code+TTL na UI) | **AUSENTE** | `EvolutionService.ts:552` converte em erro; campos descartados |
| P0-2 | Estado real com `observedAt`/freshness | **INCOMPLETO** | `ChannelStateService` já deriva 4 dimensões como read-model (session/webhook/administration/operation) — mas sem `observed_at`, e a tela lê o banco sem prova de frescor |
| P0-3 | Disconnect bloqueia envio imediatamente | **AUSENTE** | `MessageProviderService.ts:40,230` só barra `status='disabled'`; canal `disconnected` ainda envia |
| P0-4 | Operações por `channelId` | **AUSENTE** | `POST /whatsapp/disconnect` desconecta TODOS os canais evolution da org (`routes/channels.ts:97-101`); reset análogo |
| P1-1 | Webhook (credencial+saúde) por canal | **AUSENTE** | `webhookSecurity.ts:23` — `webhook_secret` global; `ChannelStateService.webhookState()` sem parâmetro de canal |
| P1-2 | Dedupe de eventos de webhook | **PARCIAL** | `test:meta-webhook-dedup` cobre Cloud; lado Evolution a verificar na fatia F6 |
| P1-3 | Bindings em todos os seletores | **EXISTE EM GRANDE PARTE** | `ChannelBindingService.resolve`/`selectOutboundChannel`/`assertOutboundAllowed` + gate de regressão (`test:channel-select-resolver`: "o SQL legado não existe mais fora do helper" — cobre os produtores A5). Sobram seletores diretos fora do gate: ver §5 |
| P1-4 | Idempotência + lock no provisionamento | **PARCIAL** | Nome determinístico por (org, identifier) reusa canal/instância (`ChannelProvisioningService.ts:141-158`); **sem lock nem UNIQUE** → duplo clique/2 abas ainda podem correr |
| P1-5 | Reconciliação periódica | **PARCIAL** | `sync` manual existe (`test:channel-sync-provider` 14 checks); sem passe periódico — e o passe DEVE ser leak-aware (§1) |
| P1-6 | Operação persistida / retomada pós-reload | **AUSENTE** | Nenhuma tabela de operações; QR/desafio vive só na resposta |
| P2 | Meta Cloud + Embedded Signup | **FUNDAÇÃO PARCIAL, PARKED** | provider `whatsapp_cloud` no envio + webhook dedup; Embedded Signup exige verificação de negócio na Meta e aprovação de app — **pendência de terceiro** (padrão Sicredi/ASAAS), sem fatia agora |
| — | Não reativar rotas legadas `/api/evolution/*` | **OK** | removidas no #1687 |
| — | QR ausente nunca reseta automaticamente | **OK** | auto-heal destrutivo removido (F1.3, comentário em `EvolutionService.ts:508-516`) |
| — | Diagnóstico com logs do provedor | **OK** | #1691 (`getInstanceLogs` + providerLogs no diagnose) |

## 4. Baseline de testes (antes de qualquer mudança)

16 suítes WhatsApp/canal do HEAD, todas verdes em 20/09/2026:
`evolution-credential` 6 · `evolution-connect-subscribe` 9 · `evolution-channel-status` 10 · `evolution-reset` 14 · `channel-provision` 15 · `channel-sync-provider` 14 · `channel-binding` 21 · `channel-binding-gate` 11 · `channel-binding-migration` 18 · `channel-select-resolver` 23 · `channel-state-machine` 14 · `whatsapp-disconnect` 10 · `whatsapp-reset-diagnose` 24 · `whatsapp-health-ca10` 14 · `meta-webhook-dedup` 10 · `channel-health` 8 — **221 checks**. Falha nova em qualquer uma = regressão desta iniciativa.

## 5. Inventário dos seletores diretos (classificado)

Re-busca no HEAD (`FROM channels` em serviços de negócio). Classificação:

**Migrar pro resolvedor canônico (WhatsApp de saída, fatia F7):**
- `ProspectExecutionService.ts:64,177` — `LIMIT 1` evolution-first e `LIMIT 1` cru.
- `SchoolImportService.ts:75` — `ORDER BY (status != 'disabled') DESC LIMIT 1`.
- `SubscriptionService.ts:230` — `status='connected' LIMIT 1`.
- `ClinicReminderService.ts:121`, `ClinicVacancyService.ts:214` e demais Clinic*Delivery/Notice — têm lógica própria de fallback (preservam `contactChannelId`, o que é correto), mas o fallback final é seletor direto; trocar SÓ o fallback por `selectOutboundChannel`.

**NÃO migrar (seletor legítimo de outro domínio):**
- `TaskAudioService.ts:103` — `kind='internal'` (canal interno do Fala Tu, não é escolha de canal de saída).
- Consultas por `id` exato (`WHERE id = ? AND organization_id = ?`) — lookup, não seleção.
- `FacebookService`/`InstagramService` — providers próprios, fora do escopo WhatsApp.

## 6. Podas sobre o PRD (decisões de arquitetura da execução)

1. **Sem `channel_connections`**: a identidade remota já vive em `channels` (identifier determinístico). Tabela paralela criaria a segunda fonte de verdade que o próprio PRD condena. Colunas aditivas em `channels` (`observed_at`, `session_state` observado, `admin_state` se necessário) resolvem.
2. **Estado de 4 dimensões continua READ-MODEL** (RN-004) — o `ChannelStateService` já é assim; a fatia acrescenta frescor (`observed_at`) e a dimensão webhook por canal, não colunas de status armazenadas.
3. **1 tabela nova estrutural**: `channel_connection_operations` (idempotency key + estado + TTL do desafio QR/passkey embutido) — resolve duplo clique, retomada pós-reload e a persistência do desafio sem tabela dedicada com criptografia própria.
4. **Constraint única de identidade remota**: só se a query de diagnóstico (abaixo) provar duplicados em produção — unique em tabela viva exige rebuild (padrão F0c-1/ADR-199), caro demais sem evidência.
   ```sql
   -- rodar em produção antes da F4:
   SELECT organization_id, identifier, COUNT(*) n FROM channels
    WHERE provider IN ('evolution','whatsapp_cloud') AND identifier IS NOT NULL
    GROUP BY organization_id, identifier HAVING n > 1;
   ```
5. **Migration framework do PRD (dry-run/rollback scripts)**: não existe no repo; a convenção é CREATE-then-ALTER aditivo em `db.ts`. Mantida a convenção.
6. **Meta Cloud**: parked como pendência de terceiro. Nenhuma fatia.

## 7. Plano de fatias (1 fatia = 1 PR, ordem aprovada pelo dono)

| Fatia | Entrega | Estado |
|---|---|---|
| **F0** | Esta análise + probe de fonte + baseline verde | **FECHADA** (#1708) |
| **F1** | Gate canônico de envio: elegibilidade (admin/status + evidência) aplicada no `MessageProviderService` e jobs; disconnect bloqueia local imediatamente | **FECHADA** (#1709 — `test:whatsapp-send-gate` 17) |
| **F2** | `channelId` obrigatório em disconnect/reset/sync/diagnose (compat: org com 1 canal segue sem id) | **FECHADA** (#1710 — `test:whatsapp-channel-scope` 15) |
| **F3** | `observed_at` + sync reconcilia com o provedor; passe periódico **leak-aware** no Scheduler (só `/instance/all`+`/webhook/set`, intervalo mínimo 5min, jitter, teto por tick) | **FECHADA** (#1711 — `test:whatsapp-observed-at` 16) |
| **F4** | `channel_connection_operations` + idempotency key + lock AC-012 (duplo clique/2 abas) | **FECHADA** (#1712 — `test:whatsapp-operation-lock` 13) |
| **F5** | Passkey completo: backend normaliza `passkeyStage/Code/OpenUrl` como `awaiting_passkey` (sucesso pendente, nunca erro) + UI etapa no `ChannelsPanel` (abrir link, copiar código, TTL ~5 min, refresh) + detecção do `<SET_PASSKEY_PUBLIC_URL>` como erro de configuração | **FECHADA** (#1713 — `test:whatsapp-passkey` 13) |
| **F6** | Credencial opaca `whc_` + saúde + validação de webhook POR CANAL (`ChannelWebhookCredentialService`, rotação com janela 48h, `webhookStateFor` por canal) | **FECHADA** (#1714 — `test:whatsapp-webhook-channel` 20) |
| **F7.1** | Migração dos produtores do §5 (Prospect envio+âncora, School âncora, Subscription) pro resolvedor canônico + gate ampliado | **FECHADA** (#1715 — `test:channel-producer-binding` 10; gate 31) |
| **F7.2** | Fallback das 7 Clinic* centralizado em `ChannelBindingService.selectContactChannel` (contact-first preservado; binding `clinica` decide; fallback exclui desconectado) | **FECHADA** (#1716 — `test:clinic-channel-fallback` 17; gate 38) |
| — | Meta Cloud | parked (terceiro — verificação de negócio na Meta) |

**PRD executável COMPLETO em 20/09/2026** (9 PRs #1708–#1716). Pendências de OPERAÇÃO (lado do dono, no VPS): confirmar `evolution-go` ≥ 0.7.2 e definir `PASSKEY_PUBLIC_URL` no docker-compose (necessárias pro fluxo passkey da F5).

**Guardrails herdados do PRD (valem em todas as fatias)**: QR/passkey ausente nunca dispara reset · reset é explícito+confirmado+auditado · organizationId sempre da sessão, nunca do corpo · canal de outro tenant responde 404 · segredo/QR/código nunca em log ou resposta além do necessário · toda fatia com teste tmpDir + regressão da bateria do §4.
