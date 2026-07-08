# DEPLOY — variáveis de ambiente para produção

Guia curto e prático do que precisa estar configurado antes de subir o ZappFlow em produção. Baseado no levantamento de maturidade (Fase 1 do plano de produção).

**Antes de mexer em produção, leia [`docs/AMBIENTES.md`](AMBIENTES.md)** — descreve o esquema de 3 ambientes (local / staging / produção) e o fluxo de mudança que evita quebrar prod.

## Regra-mãe

**Rode sempre com `NODE_ENV=production`.** Muitos defaults de segurança e performance chaveiam por esse valor (fila de webhook ligada, PDF async, checks estritos do `SecurityAuditService`).

## Obrigatórias

| Variável | O que faz | Como gerar |
|---|---|---|
| `NODE_ENV=production` | Ativa defaults de prod (fila de webhook, PDF async, security audit estrito). | Fixo. |
| `JWT_SECRET` | Assina tokens de sessão. **≥ 32 caracteres aleatórios.** | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | Criptografa segredos em repouso (tokens de canal, chaves OAuth). **Dedicada** — NÃO derivar do JWT. | `openssl rand -hex 32` |
| `GEMINI_API_KEY` **ou** `OPENAI_API_KEY` | Sem chave de IA, toda IA falha. | Painel do provedor. |

## Fortemente recomendadas

| Variável | Padrão em prod | Observação |
|---|---|---|
| `WEBHOOK_QUEUE_ENABLED` | `true` (auto em `NODE_ENV=production`) | Webhook responde 200 na hora e worker processa em background. Protege SLA da Meta/Evolution. |
| `PDF_REPORT_ASYNC_ENABLED` | `true` (auto em `NODE_ENV=production`) | PDF de relatório do gestor é enfileirado e enviado como documento separado. Sem isso, webhook pode travar 30-60s. |
| `CORS_ORIGIN` | (vazio = *) | Configure com o **domínio EXATO** da aplicação. `*` em produção falha o `SecurityAuditService`. |
| `ENABLE_RATE_LIMIT=true` | (vazio) | Rate limit em rotas públicas (webhooks, login). |

## Integrações (só se estiver usando)

| Variável | Uso |
|---|---|
| `EVOLUTION_API_KEY` | Envio via Evolution (WhatsApp/Instagram). |
| `EVOLUTION_BASE_URL` | Endpoint da instância Evolution (padrão: `https://evolutiongo.tesseractauto.com.br`). |
| `EVOLUTION_SEND_PATH` | Endpoint de envio de texto (padrão: `/send/text`). |
| `EVOLUTION_SEND_MEDIA_PATH` | Endpoint de envio de mídia (varia por fork). |
| `META_APP_SECRET` | Verificação de assinatura de webhook Meta. |
| `META_WEBHOOK_VERIFY_TOKEN` | Handshake de verificação inicial do webhook Meta. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth Google (Sheets/Calendar). |
| `GOOGLE_IMAGE_MODEL` | Modelo de geração de imagem via Gemini (padrão: `imagen-3.0-generate-002`). |

## Storage

Duas opções — **escolha uma antes de subir**:

### Opção A — S3 (recomendado para produção)

```
S3_ENABLED=true
S3_BUCKET=<seu-bucket>
S3_REGION=<região>
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

### Opção B — Disco local (aceitável para desenvolvimento e prod-single-node)

```
MEDIA_DIR=/var/lib/zappflow/media
```

⚠️ Sem S3 e sem `MEDIA_DIR` explícito, o storage vai pra `./data/media` — dá pra usar em prod mas risco de perda se o disco não for persistente.

## Filtros de segurança extras

| Variável | Uso |
|---|---|
| `STRICT_PROMPT_FILTER=true` | Filtro heurístico anti-prompt-injection em inputs LLM. |

## Auditoria automática

Depois do deploy, abra **Admin Master → Auditoria de Segurança** e rode. O `SecurityAuditService` verifica:

- Chaves de IA/JWT/ENCRYPTION presentes e fortes.
- CORS + rate limit configurados.
- Tenant leaks em tabelas críticas.
- `auth_events` sendo escritos nas últimas 24h.
- Último backup completo há ≤ 7 dias.

## Testes em CI

Cada PR pra `main` roda automaticamente `.github/workflows/ci.yml`:
- Build + typecheck (soft — permite erros pré-existentes).
- Todos os `npm run test:*` catalogados no workflow (Tier 1/2 filosóficos, isolation, RBAC, Radar, Smart Inventory, Vision, Fashion, Loja, infra + P0/P1 de segurança e commerce da Fase 4).

Testes falhando **bloqueiam merge**. Ajustes ao workflow em `.github/workflows/ci.yml`.

## Procedimentos operacionais (ADR-078)

### Rotação de `ENCRYPTION_KEY`

Quando: chave suspeita de vazamento, ciclo anual, ou mudança de operador.

Ferramenta: `scripts/rotate-encryption-key.ts` — decifra cada segredo com a chave antiga e re-cifra com a nova, um a um. Nunca sobrescreve algo que não decifra (aborta com log).

Passo a passo:
1. Provisiona a nova `ENCRYPTION_KEY` na infra (Coolify/K8s/etc.), MAS não reinicia o app.
2. Instância de manutenção com acesso ao DB e às duas chaves:
   ```
   OLD_ENCRYPTION_KEY=<antiga> ENCRYPTION_KEY=<nova> npm run rotate-encryption-key -- --dry-run
   ```
3. Se `0 pulados`, roda sem `--dry-run` para efetivar.
4. Promove a nova `ENCRYPTION_KEY` em produção (deleta a antiga da infra) e reinicia o app.
5. Opcional: mantém `OLD_ENCRYPTION_KEY` como rollback por 24-48h, depois remove.

### Migração `disk → S3`

Quando: passar a rodar mais de uma réplica, ou dar portabilidade a backups/PDF.

Ferramenta: `scripts/s3-smoke-test.ts` — HEAD/PUT/GET/DELETE contra o bucket com objeto de teste; aborta se qualquer passo falhar.

Passo a passo:
1. Cria bucket dedicado (ex.: `zappflow-prod-artifacts`) + IAM com permissão mínima (`s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:HeadBucket`).
2. Em uma instância de teste, define as envs e roda:
   ```
   S3_ENABLED=true S3_BUCKET=zappflow-prod-artifacts S3_REGION=us-east-1 \
   S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... npm run s3-smoke-test
   ```
3. Se ✅ verde → promove as envs em produção. O disco continua fonte de verdade; o S3 é espelho best-effort. Reversível a qualquer momento (`S3_ENABLED=false`).
