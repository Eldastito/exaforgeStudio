# DEPLOY — variáveis de ambiente para produção

Guia curto e prático do que precisa estar configurado antes de subir o ZappFlow em produção. Baseado no levantamento de maturidade (Fase 1 do plano de produção).

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
- Todos os `npm run test:*` catalogados no workflow (Tier 1/2 filosóficos, isolation, RBAC, Radar, Smart Inventory, Vision, Fashion, Loja, infra).

Testes falhando **bloqueiam merge**. Ajustes ao workflow em `.github/workflows/ci.yml`.
