# ZapFlow — Security Baseline (SEC-F0)

**Status:** baseline inicial — Regra Zero do programa de Security Hardening (auditoria antes do código).
**Escopo:** auditoria ESTÁTICA do repositório (código + arquitetura). NÃO é pentest ativo contra
produção — afirma "há risco no código" onde há evidência `arquivo:linha`, não "foi explorado".
**Data:** ver histórico git. **Método:** verificação por evidência (cada achado abaixo foi
confirmado lendo o código; `arquivo:linha` no final de cada item).

> Princípio fundante do programa: **FAIL CLOSED.** Ausência ou falha de um controle de segurança
> (criptografia, autenticação, autorização, resolução de tenant, verificação de webhook, operação
> privilegiada) **nunca** deve AMPLIAR acesso. Hoje vários mecanismos "degradam com conveniência";
> a meta é que degradem fechando.

---

## 1. Controles que JÁ existem (base positiva)

JWT assinado · bcrypt (senhas) · MFA/TOTP + backup codes · revogação em tempo real de usuário
`blocked`/`deleted` · RBAC por módulo · isolamento por `organization_id` · AES-256-GCM para segredos
(com envelope versionado `enc:v1:`) · OAuth server-side · rate limiting básico · headers de segurança
(HSTS/nosniff/X-Frame-Options) · webhooks com segredo (opt-in) · idempotência (Asaas) · auditoria ·
entitlements · JWT secret auto-gerado e persistido `0600` quando ausente · caminho de mídia PRIVADO
(HMAC + expiração) para documentos clínicos.

---

## 2. Achados verificados (todos com evidência)

Legenda de severidade: 🔴 P0 (bloqueia escala comercial) · 🟠 P1 · 🟡 P2.

| # | Sev | Achado | Evidência (`arquivo:linha`) |
| --- | --- | --- | --- |
| A1 | 🔴 P0 | ~~`EncryptionService.encrypt()` retorna **plaintext** em caso de erro~~ — **✅ CORRIGIDO (SEC-F1):** agora LANÇA `EncryptionUnavailableError` (fail-closed, SEC-01); backfill resiliente pula a linha sem abortar. `test:security-encryption` (13). | `src/server/EncryptionService.ts:60-72` |
| A2 | 🔴 P0 | Bootstrap do Master Admin **loga a senha aleatória em texto puro** (`console.warn(...\`${email} / ${password}\`)`), sem guard de produção. | `server.ts:346-365` (linha 364) |
| A3 | 🔴 P0 | Webhook do WhatsApp é aceito **sem autenticação** quando `isWebhookEnforced()` é falso (default-open: sem `WEBHOOK_SECRET` **e** sem `webhook_enforce=1` **e** sem org com clínica). Correção da auditoria: a lógica é **OR**, não AND — enforce dispara com QUALQUER uma das três. | `src/server/webhookSecurity.ts:42-54`; `server.ts:293-299` |
| A4 | 🟠 P1 | `ENCRYPTION_KEY` deriva de `JWT_SECRET` quando ausente, com fallback final `sha256("zappflow-dev-key-fallback")`; produção só emite `console.warn` (não bloqueia boot). | `src/server/EncryptionService.ts:17-27` |
| A5 | 🟠 P1 | Middleware financeiro (pré-auth, em `/api`) resolve tenant de `req.headers['x-organization-id'] \|\| 'default_org'`. Mitigado no fluxo autenticado por `requireAuth` que sobrescreve o header com o org do JWT — mas o header ainda é autoridade nesse ponto pré-auth (efeito: driblar o gate read-only ou cair em `default_org`; sem vazamento cross-tenant de dados). | `server.ts:411-431`; mitigação `src/server/middleware/auth.ts:23-24` |
| A6 | 🟠 P1 | Master Admin autorizado **só** por `req.user.email === MASTER_ADMIN_EMAIL` (claim do JWT). Não existe `platform_role` persistido nem revalidação server-side do papel master. | `src/server/middleware/auth.ts:63-68,102,119` |
| A7 | 🟠 P1 | Sem proteção de **replay** para webhook inbound do WhatsApp (nenhum `UNIQUE(provider,event_id)`/nonce/janela de timestamp). Só o webhook da Asaas tem dedup. | `server.ts:874+`, `webhookProcessor.ts` (ausência); contraste `src/server/AsaasService.ts:158` |
| A8 | 🟠 P1 | `/media` servido **público** via `express.static(MEDIA_DIR)`, sem auth/tenant (só obscuridade de UUID). Docs clínicos sensíveis JÁ estão num caminho privado separado (HMAC). | `server.ts:394-395`; privado OK `ClinicAttachmentService.ts:29`, `ClinicDocumentDeliveryService.ts:124` |
| A9 | 🟠 P1 | `saveMediaBase64(base64, ext)` grava bytes confiando na extensão/MIME do cliente — sem magic-bytes/allowlist. Cai no `/media` público. Contraste: upload clínico valida magic-bytes. | `server.ts:157-166`; contraste `ClinicAttachmentService.ts:62-84` |
| A10 | 🟠 P1 | Rate limit de login puramente **in-memory** (`new Map()`), 5 tentativas/15min por e-mail — reinício limpa; não compartilha entre instâncias; troca de e-mail/IP contorna. | `src/server/routes/auth.ts:15-18` |
| A11 | 🟠 P1 | Rate limit global in-memory (~3000 req/15min por IP), desligado por padrão fora de produção. | `server.ts:258-279` |
| A12 | 🟠 P1 | CORS manual: `Access-Control-Allow-Headers` lista `x-organization-id` e **omite `Authorization`** (o header de auth real). Origem restrita em prod (OK). | `server.ts:238-253` |
| A13 | 🟡 P2 | JWT com `expiresIn: '24h'`; re-check por request só de `global_status` blocked/deleted (e org blocked), só nas rotas com `requireOrganizationAccess`. | `src/server/routes/auth.ts:238-242`; `src/server/middleware/auth.ts:50-55` |
| A14 | 🟡 P2 | Sem `security_version`/`session_version` — tokens antigos seguem válidos após troca de senha / MFA / papel (só `blocked`/`deleted` mata a sessão). | ausente em `src/` |
| A15 | 🟡 P2 | Sem `Content-Security-Policy`, `Referrer-Policy`, `Permissions-Policy` (há HSTS/nosniff/X-Frame-Options/X-XSS legado). | `server.ts:223-232` |
| A16 | 🟡 P2 | Dockerfile roda como **root** (sem `USER`), single-stage, mantém toolchain de build (python3/make/g++) e devDependencies na imagem de runtime. | `Dockerfile` |

**Nuances corrigidas vs. auditoria original:** A3 é OR (não AND) — mais provável estar fechado do
que a auditoria supôs, mas o default-open é real. A2/A8 têm mitigações parciais (docs clínicos já são
privados). A1 afeta só a escrita (`encrypt`), não a leitura.

### 2.1 Varredura do FRONTEND (dados sensíveis no navegador)

Resultado geral: **bom**. Sem segredo hardcoded, sem exposição via `import.meta.env`/`VITE_*`, sem
sink de XSS, e o tenant **não** é confiado do cliente (nunca há `x-organization-id` no frontend;
`organizationId` vem do JWT assinado). Achados residuais (todos MED/LOW):

| # | Sev | Achado | Evidência (`arquivo:linha`) |
| --- | --- | --- | --- |
| FE1 | 🟠 MED | JWT cru + objeto de usuário completo em `localStorage` (`zappflow_token`/`zappflow_user`) — qualquer XSS exfiltra a sessão inteira. Padrão comum de SPA, mas não é httpOnly cookie. | `src/contexts/AuthContext.tsx:74-75` |
| FE2 | 🟠 MED | Gating de Master Admin / módulos é **cosmético no cliente** (`isMasterAdmin` vem de `/api/entitlements` e só esconde UI). Seguro SÓ SE todo endpoint privilegiado for enforced server-side (verificar — liga com A6). Nenhum `email === MASTER_ADMIN_EMAIL` no browser (bom). | `src/store/useStore.ts:322`; `Sidebar.tsx`, `ChannelsPanel.tsx:629` |
| FE3 | 🟠 MED | Custo/margem/lucro ABSOLUTOS renderizados na UI (valores vêm do servidor; cliente só exibe). Confirmar que as rotas de origem (`/api/catalog`, `/api/retail/*`, movimentos de estoque) são role-gated (RN-CG-06/§73) — o front não aplica check de papel. | `CatalogView.tsx:541`, `RetailOpsView.tsx:507-603`, `StockModal.tsx:126` |
| FE4 | 🟠 MED | `console.log` da mensagem WebSocket inteira (telefone = PII + corpo da mensagem) no console do navegador, em produção. | `src/App.tsx:187` (e `:172/207/231/245`) |
| FE5 | 🟡 LOW | Chave Web do Firebase commitada (`firebase-applet-config.json`) — pública por design (identificador, não segredo) e aparentemente **dead file** (sem import). Remover para evitar confusão. | `firebase-applet-config.json:5` |

Ações derivadas: FE2/FE3 são **verificações de backend** (o gate real é server-side — casa com A6 e
o RBAC das rotas de dinheiro); FE1 entra na fatia de sessão (F7); FE4 no redactor de logs (F16/SEC-38);
FE5 é limpeza (remover arquivo morto).

---

## 3. Inventário de superfícies (a completar por fatia)

Classificar cada superfície em: `internet-public` · `authenticated-tenant` · `privileged-tenant` ·
`machine-to-machine` · `master-only` · `internal-only`.

- **Rotas públicas (antes de `protectedApi`)** — inventário automatizado é a SEC-F17/F48 (route inventory).
  Conhecidas: `/media` (public static), `/api/webhooks/evolution*`, `/api/public/*`, `/api/falatu-ingest`,
  middleware financeiro em `/api` (pré-auth).
- **Segredos** — `JWT_SECRET`, `ENCRYPTION_KEY`, `WEBHOOK_SECRET`, `MASTER_ADMIN_PASSWORD`,
  `MEDIA_SIGNING_SECRET`, tokens OAuth/gateway cifrados em DB.
- **Pontos que derivam `organization_id`** — JWT (confiável), `x-organization-id` header (NÃO confiável —
  A5), webhooks (via connection record).
- **Webhooks** — Evolution/WhatsApp (A3/A7), Asaas (tem dedup), Meta.
- **Uploads/downloads** — `saveMediaBase64` (A9) → `/media` (A8); upload clínico (validado).
- **Autorização cross-tenant** — Master Admin (A6).
- **Container/entrypoint** — `Dockerfile` (A16).

---

## 4. Regras de engenharia permanentes (SEC-01..10)

**SEC-01** — segredo em plaintext **nunca** é fallback (produção falha fechado na cifra).
**SEC-02** — header de tenant (`x-organization-id`) **nunca** é autoridade; tenant vem de credencial verificada.
**SEC-03** — e-mail **não** é papel administrativo; master é atributo server-side revalidado.
**SEC-04** — produção falha fechado (boot bloqueado) quando falta segredo crítico (`JWT_SECRET`, `ENCRYPTION_KEY`).
**SEC-05** — webhook mutável em produção é autenticado (assinatura/segredo) + anti-replay.
**SEC-06** — dado tenant-private é privado por padrão (nunca `express.static` de diretório sensível).
**SEC-07** — conteúdo externo (e-mail/WhatsApp/site/documento/pesquisa) é DADO não confiável, nunca instrução.
**SEC-08** — credencial revogada (senha/MFA/papel/bloqueio) perde acesso imediatamente (`security_version`).
**SEC-09** — todo privilégio cross-tenant é explicitamente auditado.
**SEC-10** — segurança crítica vira teste de regressão (`test:security-*`).

---

## 5. Ordem de correção (fatias)

Prioridade antes de escalar vendas: **F1 cripto fail-closed → F2 chaves obrigatórias/separadas →
F3 master admin (platform_role + MFA + sem senha em log) → F4 tenant boundary → F5/F6 webhooks
(default-on + replay) → F9 mídia privada.** Depois: F7 sessão, F8 rate-limit distribuído, F10 upload,
F11 headers/CORS, F12 SSRF, F13 AI boundary, F14 container, F15 supply-chain, F16 observabilidade,
F17 tenant attack suite, F18 hardening + runbook.

## 6. Critérios de bloqueio para produção

NÃO considerar hardening concluído enquanto QUALQUER um for verdadeiro:
cripto pode persistir plaintext · senha master pode ir pro log · webhook mutável de produção sem
verificação · tenant escolhível por header arbitrário · mídia tenant-private recuperável publicamente ·
vulnerabilidade crítica de dependência não resolvida.

## 7. Gate automatizado (CI)

- `.github/workflows/security-review.yml` — roda `anthropics/claude-code-security-review` em cada PR
  (comenta findings). **Requer o secret `CLAUDE_API_KEY` no repositório** para operar; sem ele o job
  apenas não roda (não bloqueia merge). Complementa — não substitui — as suítes `test:security-*`.
- Recomendado ao fim do programa: DAST autenticado (ex.: StackHawk) + **pentest multi-tenant em
  staging** (Tenant A→B, cliente→Master, webhook→runtime, arquivo privado→público). Essa etapa não é
  substituível por revisão de código.
