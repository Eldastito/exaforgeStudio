# ADR-097 — Backup: agendamento automático, redundância da plataforma e restore

**Status:** Aprovado (aguardando implementação — item **MUITO IMPORTANTE** do backlog).

**Origem:** Item #8 do `docs/BACKLOG-CAMPO-TOULON.md`. Hoje o backup só existe no clique manual. Falta rotina programada, envio automático pro Drive do dono, cópia de redundância da plataforma e a capacidade de **restaurar** um backup de volta ao banco.

---

## Contexto

Estado atual do código:
- **`BackupService.run(orgId, jobId, type)`** — gera um snapshot JSON por organização (26 tabelas do tenant, sem `users`/`plans`), salva em disco (`/data/backups`), calcula tamanho + checksum SHA-256. **Espelha no S3** (`StorageService.mirrorToS3`) quando `S3_ENABLED=true` — best-effort, depois de já ter escrito localmente.
- **`GoogleOAuthService.driveUpload(orgId, ...)`** — envia um arquivo pro Drive do dono. O escopo `drive.file` já faz parte do OAuth Google que a TOULON usa (mesmo consentimento de Calendar/Gmail/Sheets).
- **Rotas** (`routes/integrations.ts`): `POST /backups` (gera em background), `GET /backups`, `GET /backups/:id/download`, `DELETE /backups/:id`, `POST /backups/:id/drive` (botão manual "enviar pro Drive").
- **`SecurityAudit`** alerta quando o último backup completo passou de 7 dias.
- **`Scheduler`** roda de hora em hora com 15+ passes (reativação, PIX, NPS, recompra, SLA, etc.) — **nenhum de backup**.

Lacunas:
1. Backup **só sai no clique**. Se o dono não clicar, não há backup.
2. Envio ao Drive é **manual, um a um**.
3. **Nenhum gatilho** antes de operação destrutiva.
4. **Restaurar** um backup de volta ao banco **não existe** — só geramos e baixamos.
5. O backup vive no Drive do *cliente* — se ele desconectar a conta Google ou sair, **a plataforma fica sem cópia**.

## Decisão

### 1. Backup programado diário (destino: Drive do dono)

- Novo passe no `Scheduler` (`backupPass`), com **trava diária por org** (padrão: **~3h da madrugada**, horário de menor movimento).
- **Opt-in por organização** (`organization_settings.backup_auto_enabled`), com frequência configurável (`backup_frequency`: `daily` padrão / `2x_week` / `weekly`).
- Fluxo por org: `BackupService.run` → grava em disco → **envia automaticamente pro Drive do dono** (`driveUpload`) → espelha no S3 se configurado.
- **Retenção: últimos 30** (`backup_retention`, default 30). O passe expurga os mais antigos **no disco e no Drive** (Drive via `drive.file` só enxerga os arquivos que o próprio app criou — pode listar/apagar os seus). Sem isso o Drive do dono cresceria indefinidamente.
- Notifica o dono (`NotificationService.backupReady`) em falha; sucesso é silencioso (não vira ruído diário).

### 2. Redundância da plataforma (destino: nossa infra) — independente do cliente

Ponto do Emerson, aceito como **pilar**: o backup no Drive é do *cliente* e some se ele desconectar/sair. **Nós (operador) precisamos da nossa própria cópia de redundância.**

- **Toda organização ativa** tem um backup **no mínimo semanal** armazenado na **infra da plataforma** (S3/off-site que *nós* controlamos) — **independente do opt-in** do cliente no Drive.
- Isso **não depende** da conta Google do cliente: se ele nunca ligou o backup pro Drive, ou desconectou, a redundância operacional continua.
- Implementação: o `backupPass` já gera o snapshot; a redundância é o **espelho S3 obrigatório para toda org** (não best-effort opcional) numa cadência semanal por org, com retenção própria da plataforma (independente dos 30 do cliente).
- **LGPD:** somos **operador** dos dados do lojista (ele é o controlador). Guardar cópia de redundância dos dados que já processamos é execução do contrato — legítimo. Os dados já vão cifrados/segregados por `organization_id`; a redundância herda o mesmo isolamento e o S3 deve ficar em bucket privado.
- **Dois destinos, dois donos:** Drive do dono (ele vê, controla, pode apagar) **e** redundância da plataforma (operacional, o cliente nem enxerga). Um não substitui o outro.

### 3. Restore com backup-guard

- Nova capacidade `BackupService.restore(orgId, fileName)`: lê um snapshot e **regrava as tabelas do tenant** daquela org (multi-tenant seguro — valida `organization_id`, mexe **só** nas tabelas do tenant, nunca em `users`/`plans`/dados de outras orgs).
- **Backup-guard automático:** antes de sobrescrever qualquer coisa, o restore **gera um backup de segurança** do estado atual (`type='pre-restore'`). Se o restore der errado, dá pra voltar.
- Operação sensível → exposta só ao **dono** (ou Master Admin) com **confirmação forte** (digitar o nome da org / dupla confirmação). Nunca automática.
- Registrada em log de auditoria (quem restaurou, qual arquivo, quando).

### 4. Gatilhos antes de operação destrutiva

| Situação | Capturável? | O que fazemos |
|---|---|---|
| **Queda de luz / kill abrupto** | ❌ Não (processo morre sem aviso) | Mitigação: **backup no boot** se o último for mais antigo que a janela configurada (reduz a perda ao voltar) |
| **Restart planejado / deploy** | ✅ Sim | Hook no `SIGTERM` (shutdown gracioso): backup rápido antes de sair |
| **Antes de restore** | ✅ Sim | **Backup-guard** automático (decisão 3) |

O backup no boot e no `SIGTERM` são **globais da instância** (varrem as orgs com backup ligado ou vencido), não por-request. Best-effort e com teto de tempo pra não travar boot/shutdown.

## Consequências

**Positivas:**
- Deixa de depender do clique do dono — backup vira rotina.
- Dupla proteção: cópia no Drive do cliente **e** redundância na nossa infra. Perda de dados vira evento raro e recuperável.
- Restore fecha o ciclo: backup sem restore é só metade da história.
- Backup-guard torna o restore reversível (rede de segurança pra operação perigosa).

**Trade-offs aceitos:**
- **Restore multi-tenant é delicado** — precisa garantir isolamento absoluto por `organization_id` e ordem de escrita respeitando dependências (FKs). Mitigado por: só tabelas do tenant, backup-guard, confirmação forte, teste dedicado.
- Redundância obrigatória na plataforma **exige S3 configurado** (ou outro off-site nosso). Enquanto `S3_ENABLED` estiver desligado, a redundância cai pro disco local do host — o que **não** é redundância real. Portanto: **habilitar S3 (ou equivalente) é pré-requisito operacional** deste ADR, e o SecurityAudit deve alertar se a redundância semanal não estiver saindo.
- Backup no boot/`SIGTERM` adiciona latência ao ciclo de vida da instância — limitada por teto de tempo e por só rodar quando necessário.
- Expurgo no Drive depende do escopo `drive.file` (só enxerga arquivos do próprio app) — suficiente para os backups que nós criamos, não mexe em nada mais do Drive do dono.

## Implementação (item independente, não bloqueia o Bloco A)

1. **Schema** (`organization_settings`): `backup_auto_enabled`, `backup_frequency` (`daily`/`2x_week`/`weekly`), `backup_retention` (default 30), `backup_to_drive`, `backup_auto_last_run`, `backup_platform_last_run` (trava da redundância semanal).
2. **`BackupService`**: `applyRetention(orgId)` (expurga disco+Drive além do teto), `restore(orgId, fileName)` com backup-guard, `runPlatformRedundancy(orgId)` (espelho S3 obrigatório).
3. **`Scheduler.backupPass`**: trava diária por org → gera → Drive → S3 → retenção; e trava semanal por org → redundância da plataforma. Cada org isolada em try/catch (uma falha não derruba as demais).
4. **`server.ts`**: hook `SIGTERM` (backup gracioso, com teto) + verificação no boot (backup se o último estiver vencido).
5. **Rotas**: `POST /backups/:id/restore` (dono/master, confirmação forte, auditado); manter as manuais existentes.
6. **UI** (Configurações → Integrações/Backup): toggle de backup automático + frequência + retenção; lista de backups com botão **Restaurar** (com aviso e dupla confirmação).
7. **SecurityAudit**: além do alerta de "backup do cliente > 7 dias", alertar se a **redundância da plataforma** não rodou na semana.
8. **Testes**: `test:backup-scheduler` (agenda, retenção, redundância) e `test:backup-restore` (restore isola por org, backup-guard roda antes, não vaza entre tenants).

## Aprovação

Aprovado por Emerson (jul/26): backup automático **diário de madrugada** (retenção **últimos 30**), **backup + restore com backup-guard** antes de sobrescrever, e — pilar reforçado por ele — **redundância da plataforma no mínimo semanal na nossa infra, independente do Drive do cliente** (o backup no Drive do dono não substitui a cópia operacional do operador). Item #8 do backlog marcado `[x] decidido`.
