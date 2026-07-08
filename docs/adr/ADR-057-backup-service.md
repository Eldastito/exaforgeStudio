# ADR-057 — BackupService — cópia do SQLite e rotação

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit. SQLite single-file (ADR-002) é o ponto único de falha mais óbvio do stack; um backup que funciona é a diferença entre "perdi um dia" e "perdi o SaaS". A implementação existia sem ADR — este documento formaliza o que está no código e admite o que ainda é gap.

---

## Contexto

A arquitetura enxuta escolhida em ADR-002 (SQLite via `better-sqlite3`, arquivo único em `/data/zeroforge.db`) trocou complexidade operacional por risco concentrado: se o arquivo for corrompido ou o volume Coolify for perdido, cai tudo. A resposta implementada NÃO é uma cópia binária do `.db` — é um **snapshot lógico em JSON por organização**, gerado sob demanda pela rota `POST /api/integrations/backups` (ver `src/server/routes/integrations.ts`). O arquivo vai para `BACKUPS_DIR` (default `/data/backups`, sobrescrevível por env), com mirror opcional para S3 e envio manual para o Google Drive do dono.

Não há cron interno disparando o backup — hoje o gatilho é humano (botão na UI de Integrações) ou externo (Scheduler batendo na rota). O `SecurityAuditService` monitora `backup_jobs.completed_at`: se o último backup passar de 7 dias, sobe finding `ops-backup-stale`. Isso é alerta, não automação.

## Decisão

**Regras do `BackupService` (`src/server/BackupService.ts`):**

1. **Formato: JSON lógico por org, não `VACUUM INTO`.** `run(orgId, jobId, type)` itera por `TENANT_TABLES` (28 tabelas com `organization_id`) e serializa `SELECT * WHERE organization_id = ?`. Vantagem: multi-tenant isolado, portável entre versões de schema. Custo: perde índices, precisa restore lógico caso a caso.
2. **Exclusões deliberadas** — `plans` (global) e `users` (para não vazar `password_hash` num arquivo baixável). Consequência: um restore não recria contas de usuário.
3. **Destino primário: disco local** — `fs.writeFileSync` em `BACKUPS_DIR` (volume persistente do Coolify). Nome `${safeOrgSanitizada}-${jobId}.json`.
4. **Mirror off-site opcional: S3** — se `StorageService.isS3Enabled()`, a rota chama `mirrorToS3(fullPath, "backups/${fileName}")` em fire-and-forget. Falha do S3 nunca bloqueia nem invalida o backup local (o disco é fonte de verdade).
5. **Anti path-traversal/IDOR** — `resolveFile` rejeita `..`, `/`, `\` e exige prefixo `${safeOrg}-` no filename. Impossível uma org baixar backup de outra mesmo forjando `fileName`.
6. **Trigger: manual, via rota autenticada** — `setImmediate` executa fora do ciclo de request; `backup_jobs` guarda `pending → completed/failed` para a UI polar. Sem cron dentro do processo Node.
7. **Retenção: manual.** `deleteFile(orgId, fileName)` é idempotente e chamado por `DELETE /backups/:id`. Não há rotação automática — arquivos ficam até serem apagados pela UI.
8. **Integridade: SHA-256 disponível, não aplicada.** `checksum(fullPath)` existe mas não é chamado por nenhum caller hoje.

## Consequências

**Positivas:**
- RPO controlável pelo operador (rodar quantas vezes quiser); cada backup é auto-contido e legível fora do sistema.
- Isolamento multi-tenant garantido no formato — impossível vazar dado de outra org num arquivo mesmo se a autorização da rota falhar, porque a query já filtra por `organization_id`.
- Off-site via S3 sem acoplar o fluxo principal — o mirror é best-effort e silencioso.
- `SecurityAuditService` transforma "esqueci de backupear" em um finding visível no painel de segurança.

**Trade-offs aceitos:**
- **Restore nunca foi exercitado em produção.** Não existe rotina automatizada de restore no repo — o JSON é lido manualmente. Marcado para Fase 4.
- **Sem verificação de integridade automática.** `checksum` é utilitário órfão; nada compara hash antes/depois do mirror S3.
- **Sem rotação/retenção automática.** Storage cresce linearmente com o número de backups por org até alguém apagar na UI.
- **Sem cron interno.** Depende de gatilho externo (Scheduler ou humano). Se o Scheduler cair, o único aviso é o finding `ops-backup-stale` 7+ dias depois.
- **Não é backup do arquivo SQLite.** WAL, índices, tabelas globais (`plans`, `users`) ficam de fora — restore parcial por design.

## Testes

**Gap conhecido: zero.** Não há `scripts/test-backup*.ts` nem cobertura unitária de `BackupService`. Auditoria manual confirmou path-traversal e prefixo de org no `resolveFile`, mas sem regressão automatizada — se alguém remover a checagem, nada quebra em CI.

Pendente para Fase 4:
- Teste de smoke que roda `run` numa org, valida contagem por tabela, confere prefixo do filename e tenta baixar como outra org (esperado 404).
- Teste de restore end-to-end: subir DB vazio, aplicar snapshot, contar linhas por tabela.
- Verificação de checksum pós-mirror S3.
