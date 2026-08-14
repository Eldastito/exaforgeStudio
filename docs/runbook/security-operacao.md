# Runbook — Security Hardening & Zero-Trust Boundary

Operação do programa de segurança (SEC-F0..F11). Princípio fundante: **FAIL CLOSED** — ausência
ou falha de um controle nunca AMPLIA acesso. Baseline verificado em `docs/security/SECURITY-BASELINE.md`;
modelo de ameaça em `docs/security/THREAT-MODEL.md`.

## Mapa das fatias entregues

| Fatia | Achado | Serviço / mudança | Teste |
| --- | --- | --- | --- |
| F1 | A1 🔴 | `EncryptionService.encrypt` **fail-closed** (lança `EncryptionUnavailableError`, nunca plaintext) | `test:security-encryption` |
| F2 | A4 🟠 | `SecurityConfigurationService.validateBoot` (segredos no boot; enforce sob `SECURITY_STRICT_BOOT=1`) | `test:security-config` |
| F3 | A2 🔴 + A6 🟠 | Master: sem senha em log + `users.platform_role` (`isPlatformMaster` valida no DB, não no claim) | `test:security-master` |
| F4 | A5 🟠 | `resolveTokenOrg` — tenant vem do JWT verificado, header `x-organization-id` nunca é autoridade | `test:security-tenant` |
| F5/F6 | A3 🔴 + A7 🟠 | Webhook: switch `WEBHOOK_STRICT=1` + anti-replay `claimWebhookEvent` (`webhook_inbound_events`) | `test:security-webhook` |
| F10 | A9 🟠 | `mediaValidation.validateImageBase64` — magic-bytes; rejeita não-imagem no `/media` | `test:security-media-upload` |
| F11 | A15 🟡 | `buildSecurityHeaders` — CSP (report-only default), Referrer-Policy, Permissions-Policy | `test:security-headers` |
| F18 | — | este runbook + `test:security-program-hardening` (regressão dos SEC-0x + fiação) | `test:security-program-hardening` |

## Regras de engenharia permanentes (SEC-01..10)

`SEC-01` plaintext nunca é fallback · `SEC-02` header de tenant nunca é autoridade · `SEC-03` e-mail
não é papel administrativo · `SEC-04` produção falha fechado sem segredo crítico · `SEC-05` webhook
mutável é autenticado + anti-replay · `SEC-06` dado tenant-private é privado por padrão · `SEC-07`
conteúdo externo é dado, não instrução · `SEC-08` credencial revogada perde acesso imediato ·
`SEC-09` privilégio cross-tenant é auditado · `SEC-10` segurança crítica vira teste de regressão.

## Flags e segredos (produção)

| Chave | Efeito | Quando ligar |
| --- | --- | --- |
| `ENCRYPTION_KEY` | chave dedicada de cifra (senão deriva de `JWT_SECRET`) | sempre; ver migração abaixo |
| `JWT_SECRET` | assinatura de sessão | sempre (multi-instância exige env) |
| `SECURITY_STRICT_BOOT=1` | boot **aborta** se faltar segredo crítico (SEC-04) | após a migração de chaves |
| `MASTER_ADMIN_PASSWORD` | provisiona o master (sem ela, master NÃO é criado automaticamente) | no 1º deploy |
| `WEBHOOK_SECRET` / `WEBHOOK_STRICT=1` | exige assinatura no webhook | após configurar o segredo no provider |
| `CSP_ENFORCE=1` | CSP passa de report-only a enforcing | após validar report-only sem violação |
| `CLAUDE_API_KEY` (secret do repo) | ativa o gate `security-review` por PR | quando quiser a revisão automática |

### Migração de chaves (habilitar `SECURITY_STRICT_BOOT=1` sem perder dados)

Hoje a cifra usa `sha256(ENCRYPTION_KEY || JWT_SECRET)`. Uma `ENCRYPTION_KEY` NOVA tornaria os
segredos já cifrados indecifráveis. Sequência segura: (1) `ENCRYPTION_KEY` := valor atual do
`JWT_SECRET` (preserva leitura); (2) rotacionar pra chave dedicada com `scripts/rotate-encryption-key.ts`;
(3) `GET /api/admin/security-config` retorna `ok:true`; (4) ligar `SECURITY_STRICT_BOOT=1`.

## Verificação (Admin Master)

- `GET /api/admin/security-config` — relatório REDIGIDO da config de segredos (presença/tamanho/
  códigos, nunca o valor). `issues:[]` = ok.
- `SecurityAuditService.runSecurityCheck()` (painel) — checagens de runtime (chaves, CORS,
  rate-limit, backup, tenant leak).

## Fluxo zero-trust (critério de aceite)

```
requisição não confiável → verificação de identidade (JWT) → SecurityPrincipal → fronteira de
tenant (do token, nunca do header) → permissão (RBAC) → entitlement → governança → ação → auditoria
```
Integrações: `provider externo → assinatura/token → anti-replay → resolução de tenant → validação
→ execução governada`.

## Pendências conhecidas (fora deste lote — exigem contexto de deploy/frontend)

- **A8 — mídia pública `/media`**: o *write* já é validado (F10); o *read* por UUID público exige
  mudança COORDENADA no frontend (URLs assinadas nos `<img>` do chat). Fatia própria.
- **F7 — `security_version`**: invalidar tokens antigos em troca de senha/MFA/papel (hoje só
  `blocked`/`deleted` mata a sessão via re-check por request).
- **F8 — rate-limit distribuído**: hoje in-memory (por instância). Multi-instância exige store
  compartilhado (Redis) atrás de uma abstração.
- **F14 — container**: Dockerfile roda como root, single-stage, com build tools no runtime.
  Multi-stage + `USER node` — muda a imagem de deploy.

## Troubleshooting

- **Boot abortou com falha crítica de segredo** — `SECURITY_STRICT_BOOT=1` + segredo faltando.
  Rode a migração de chaves acima; sem ela, o warning já apontou o `code`.
- **Webhook do WhatsApp parou** — se ligou `WEBHOOK_STRICT`/`WEBHOOK_SECRET` sem configurar o
  segredo no Evolution: configure nos dois lados ou desligue a flag.
- **Master perdeu acesso** — só acontece se o usuário do `MASTER_ADMIN_EMAIL` não existe no DB;
  o backfill roda no boot. Confira a linha em `users` (coluna `platform_role`).
- **UI quebrou após CSP** — só se ligou `CSP_ENFORCE=1`. Volte pra report-only e ajuste as
  diretivas em `src/server/securityHeaders.ts` conforme as violações no console.
- **Imagem do chat não aparece** — F10 rejeita conteúdo não-imagem; se for imagem legítima num
  formato fora do allowlist (png/jpeg/webp/gif), adicione o magic-byte em `mediaValidation.ts`.
