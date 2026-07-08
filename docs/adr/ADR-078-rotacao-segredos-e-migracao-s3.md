# ADR-078 — Rotação de segredos e migração de storage disk→S3

**Status:** Implementado (ferramentas + procedimento). Migração operacional pendente de janela.

**Origem:** Fase 6 do plano de produção — fechar dois débitos técnicos que travam produção "de verdade":

1. **Rotação de `ENCRYPTION_KEY`** — sem um procedimento seguro, comprometer a chave = perder OS SEGREDOS DE TODOS OS TENANTS. Precisamos de "trocar a fechadura sem perder a chave" comprovado.
2. **Migração de storage `disk → S3`** — SQLite + `BACKUPS_DIR` local funcionam para single-node, mas presos ao volume do container. Deploy em outro host ou réplica precisa de storage remoto para backup e PDF de relatório.

Este ADR fecha a Fase 6 com **ferramentas + documento operacional**. A execução real (rotacionar o segredo em produção, subir bucket S3) depende de janela de manutenção do dono.

---

## Contexto

**Rotação de `ENCRYPTION_KEY`:** o `EncryptionService` (ADR-054) cifra tokens do Google/OAuth, `pay_gateway_token`, `pay_webhook_secret`, `integration_token`, segredo TOTP, memory_facts do CRM. A chave é derivada de `ENCRYPTION_KEY` (com fallback para `JWT_SECRET`). Se a chave for comprometida (vaza no log, no repo, na infra) — a mitigação é **re-cifrar tudo com uma chave nova**, sem invalidar sessão de usuário nem quebrar credenciais salvas.

**Migração `disk → S3`:** o `StorageService` (ADR-075) já expõe `mirrorToS3` que grava um espelho best-effort de arquivo local no S3. Backup (ADR-057) e PDF de relatório usam. Faltava (a) um procedimento operacional passo-a-passo, (b) validação prévia da configuração antes de ligar `S3_ENABLED=true` em produção.

## Decisão

**Duas ferramentas + procedimento operacional documentado. Zero mudança de código de produção.**

### Rotação de `ENCRYPTION_KEY`

`scripts/rotate-encryption-key.ts` — decifra cada segredo com `OLD_ENCRYPTION_KEY` e re-cifra com `ENCRYPTION_KEY` (nova), atualizando linha por linha. Regras invioláveis:

- **Nunca perde dado**: um segredo que não decifra com a chave antiga é PULADO com log, não é sobrescrito.
- **Dry-run obrigatório**: `--dry-run` reporta o que iria mudar sem escrever no banco.
- **Idempotente**: rodar novamente com as mesmas chaves não altera nada (segredos já cifrados com a nova chave não são reencontrados como "candidatos").
- **Legado texto puro preservado**: valores sem prefixo `enc:v1:` são detectados e pulados — quem já não estava cifrado não vira nada.
- **Escopo definido em código**: espelha o `backfillExistingSecrets` do `EncryptionService`. Se surgir nova coluna cifrada, atualizar as duas listas.

Procedimento (janela recomendada: baixa carga, 15 min):

1. Provisiona a nova `ENCRYPTION_KEY` na infra (Coolify/K8s/…) MAS não reinicia o app ainda.
2. Roda uma instância de manutenção com acesso ao DB:
   ```
   OLD_ENCRYPTION_KEY=<antiga> ENCRYPTION_KEY=<nova> npm run rotate-encryption-key -- --dry-run
   ```
3. Se `0 pulados`, roda sem `--dry-run` para efetivar.
4. Promove a nova `ENCRYPTION_KEY` em produção (deleta a antiga da infra).
5. Reinicia o app; ele passa a decifrar tudo com a nova.
6. **OPCIONAL**: mantém `OLD_ENCRYPTION_KEY` como rollback por 24-48h; depois remove.

Se qualquer segredo aparecer como "pulado", o procedimento aborta com `exit 2` e o operador investiga (chave errada, corrupção, dado adulterado) **antes** de promover.

### Migração `disk → S3`

`scripts/s3-smoke-test.ts` — antes de ligar `S3_ENABLED=true` em produção, roda HEAD/PUT/GET/DELETE contra o bucket com um objeto de teste. Se falhar, aborta com instrução de investigar. Compatível com AWS/R2/B2/MinIO.

Procedimento:

1. Cria bucket dedicado (ex.: `zappflow-prod-artifacts`), lifecycle policy opcional (30-90 dias).
2. Cria IAM user/role com permissão mínima ao bucket (`s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:HeadBucket`).
3. Define envs em uma instância de teste:
   ```
   S3_ENABLED=true S3_BUCKET=zappflow-prod-artifacts S3_REGION=us-east-1 \
   S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... npm run s3-smoke-test
   ```
4. Se ✅ verde: promove as envs em produção. O `StorageService.mirrorToS3` já é usado por backup e PDF automaticamente quando `isEnabled()` vira true.
5. Para provedores S3-compatíveis (R2/B2/MinIO): também setar `S3_ENDPOINT` + `S3_FORCE_PATH_STYLE=true`. Para servir URL pública: `S3_PUBLIC_URL_BASE=https://cdn.zappflow.com`.

**Nada muda para o usuário:** disco continua sendo a fonte de verdade. S3 é **redundância best-effort**. Se o upload falhar, o arquivo local segue existindo, o cliente segue baixando normal. Migração é aditiva, reversível a qualquer momento (`S3_ENABLED=false`).

## Consequências

**Positivas:**

- **Rotação de chave sem downtime** e sem perda de dado: a ferramenta é dry-run-first, para em qualquer falha, deixa rastro em log.
- **Migração de storage sem risco**: smoke test detecta problema de config antes de deploy, mirror mantém disco como fallback natural.
- **Procedimento documentado**: qualquer operador (não só o autor) segue os passos e chega ao mesmo lugar.
- **Compat multi-provedor** (AWS/R2/B2/MinIO) já validada no código — nada de vendor lock-in imposto.

**Trade-offs aceitos:**

- **Rotação exige janela de manutenção** com acesso ao DB (não é online no sentido "sem parar nada nunca"). Aceitável: rotação de chave é rara (idealmente 1x/ano ou em incidente).
- **Rotação lista as colunas em código** — surge nova coluna cifrada e alguém esquece de atualizar ambos os pontos, essa coluna fica com a chave antiga silenciosamente. Mitigação: comentário no `EncryptionService.backfillExistingSecrets` e no script apontando um para o outro.
- **S3 mirror é one-way** hoje — se alguém apagar o arquivo local antes do upload, o S3 fica sem cópia. Aceitável enquanto backup e PDF são gerados sob demanda; se um dia começarmos a limpar disco automaticamente, revisitar para trocar mirror por upload primário.
- **Sem detecção de drift entre disco e S3** — se alguém deletar do S3 fora do app, ninguém sabe. Aceitável enquanto S3 é redundância, não fonte de verdade.

## Testes

- **Rotação**: sem teste automatizado próprio — o script depende de duas chaves reais. Cobertura indireta via `test-encryption-service` (54 checks de round-trip + IV único + adulteração) garante que a criptografia funciona; o script reusa exatamente o mesmo esquema (AES-256-GCM, prefixo `enc:v1:`, 12-byte IV, 16-byte tag).
- **S3 smoke test**: o próprio script é o teste — HEAD/PUT/GET/DELETE contra bucket real. Não roda em CI (precisa credencial), mas está documentado como pré-flight obrigatório antes de subir `S3_ENABLED=true`.

## Fecha Fase 6 e o plano de produção

Este ADR marca o **fechamento do plano de 6 fases**. Total entregue nas fases 1-6:

- **Fase 1**: CI + env flags + SecurityAudit real (PR #321).
- **Fase 2**: Coordenador + Connector Público + AIOrchestrator + ADRs 051-053 (PRs #322/#323).
- **Fase 3**: 23 ADRs retrofit (054-076) em 3 waves (PRs #324/#325/#326).
- **Fase 4**: 262 checks P0/P1 em 7 módulos críticos (PRs #327/#328/#329/#330).
- **Fase 5**: Prospect gated como experimental + ADR-077 (PR #331).
- **Fase 6**: Rotação + smoke test + ADR-078 (este PR).

O sistema está em **estado de produção com procedimentos operacionais documentados**. Restam apenas ações do dono (rotacionar chave real, subir S3 real, aprovar deploy).
