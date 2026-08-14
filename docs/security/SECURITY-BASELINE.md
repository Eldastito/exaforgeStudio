# ZapFlow — Security Baseline (SEC-F0)

**Status:** baseline inicial — Regra Zero do programa de Security Hardening (auditoria antes do código).
**Escopo:** auditoria ESTÁTICA do repositório (código + arquitetura). NÃO é pentest ativo contra
produção — afirma "há risco no código" onde há evidência `arquivo:linha`, não "foi explorado".
**Data:** ver histórico git. **Método:** verificação por evidência (cada achado abaixo foi
confirmado lendo o código; `arquivo:linha` no final de cada item).

> **Progresso (SEC-F0..F18):** fechados A1,A2,A3 (P0), A4,A5,A6,A7,A9 (P1), A12,A14,A15 (P2) +
> A13,A14,A15 (P2) + FE2,FE3,FE4. Regressão em `test:security-*` (consolidada em
> `test:security-program-hardening`); runbook em `docs/runbook/security-operacao.md`. Pendentes (exigem
> contexto de deploy/frontend/infra, fora do que dá pra fechar de forma aditiva/reversível sem decisão
> do operador): A8 (mídia pública — read, precisa de URL assinada no frontend), A11/F8 (rate-limit
> GLOBAL + store **compartilhado/Redis** p/ resistir a restart e multi-instância — A10 já ganhou o
> limitador testável + defesa por-IP opt-in + encaixe p/ Redis), A16/F14 (container non-root, muda a
> imagem de deploy — sem daemon Docker aqui, não dá pra validar a imagem antes do merge), FE1 (JWT em
> localStorage → httpOnly cookie, redesenho de sessão no frontend).
>
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
| A2 | 🔴 P0 | ~~Bootstrap do Master Admin **loga a senha aleatória em texto puro**~~ — **✅ CORRIGIDO (SEC-F3):** a senha NUNCA entra no log; sem `MASTER_ADMIN_PASSWORD` a conta NÃO é criada automaticamente (avisa pra definir a env). | `server.ts` (`ensureMasterAdmin`) |
| A3 | 🔴 P0 | Webhook do WhatsApp aceito sem autenticação quando `isWebhookEnforced()` é falso — **✅ MITIGADO (SEC-F5):** novo switch opt-in `WEBHOOK_STRICT=1` liga a exigência de segredo sem depender de org clínica; o operador liga após configurar o segredo nos dois lados (mesmo padrão fail-closed opt-in do F2, sem rejeitar webhooks vivos). `test:security-webhook` (12). | `src/server/webhookSecurity.ts` (`isWebhookEnforced`) |
| A4 | 🟠 P1 | ~~`ENCRYPTION_KEY` deriva de `JWT_SECRET`; fallback final hardcoded; prod só avisa~~ — **✅ MITIGADO (SEC-F2):** `SecurityConfigurationService.validateBoot()` valida os segredos no boot (chave presente/distinta/não-fallback/não-placeholder), AVISA + marca `degraded` em produção, e ABORTA o boot sob `SECURITY_STRICT_BOOT=1` (fail-closed opt-in). Rota master `GET /api/admin/security-config`; o pior caso (chave hardcoded) virou `critical` também no painel `SecurityAuditService`. `test:security-config` (14). Falta só ligar o strict após a migração (abaixo). | `src/server/SecurityConfigurationService.ts` |
| A5 | 🟠 P1 | ~~Middleware financeiro (pré-auth) resolve tenant do header `x-organization-id`~~ — **✅ CORRIGIDO (SEC-F4):** `resolveTokenOrg()` deriva o tenant SÓ do JWT verificado; o middleware financeiro pula o bloqueio sem token válido (nunca decide por header spoofável); header divergente do token vira evento `TENANT_HEADER_MISMATCH`. `test:security-tenant` (7). | `src/server/middleware/auth.ts` (`resolveTokenOrg`); `server.ts` |
| A6 | 🟠 P1 | ~~Master Admin autorizado só por `req.user.email` (claim do JWT)~~ — **✅ CORRIGIDO (SEC-F3):** coluna `users.platform_role`; `isPlatformMaster()` revalida o papel na LINHA do DB por `userId` (o e-mail REAL do DB é a autoridade, não o claim); os 3 gates master passam por ela; login carrega `platform_role`; backfill no boot. `test:security-master` (10). | `src/server/middleware/auth.ts` (`isPlatformMaster`) |
| A7 | 🟠 P1 | ~~Sem proteção de **replay** pro webhook inbound do WhatsApp~~ — **✅ CORRIGIDO (SEC-F6):** tabela `webhook_inbound_events` com `UNIQUE(provider,event_id)` + `claimWebhookEvent()` no handler Evolution — a MESMA mensagem reenviada executa 1× (1ª entrega processa; replay → `200 duplicate_ignored`). Aditivo/best-effort (sem event_id → não bloqueia; erro de storage → processa). `test:security-webhook` (12). | `src/server/webhookSecurity.ts` (`claimWebhookEvent`); `server.ts` |
| A8 | 🟠 P1 | ~~`/media` servido **público** via `express.static`~~ — **✅ MITIGADO (SEC-F21):** a MÍDIA DE CONVERSA (foto que o cliente manda, `saveMediaBase64`) passou pro subdir `/media/private/` com **URL assinada** (HMAC+TTL, reusa `fileSigning`); produto/estúdio seguem públicos (vitrine e publicação social IG/FB **intactas** — elas dependem de `/media` público). Fail-closed OPT-IN: `/media/private/` só EXIGE assinatura com `MEDIA_PRIVATE_CHAT=1` (off por padrão → 0-regressão até validar que o chat renderiza; depois ligar). Assinado no histórico (`routes/messages.ts`) e no push ao vivo (`webhookProcessor.ts`). `mediaSigning.ts` + `test:security-media-signing` (14). Docs clínicos já eram privados. | `src/server/mediaSigning.ts`; `server.ts` |
| A9 | 🟠 P1 | ~~`saveMediaBase64` grava bytes confiando na extensão/MIME do cliente~~ — **✅ CORRIGIDO (SEC-F10):** `mediaValidation.validateImageBase64` valida o CONTEÚDO por magic bytes, deriva a extensão do tipo REAL e REJEITA não-imagem (script/HTML/PDF/lixo não aterrissam no `/media`). `test:security-media-upload` (12). | `src/server/mediaValidation.ts`; `server.ts` |
| A10 | 🟠 P1 | ~~Rate limit de login solto/in-memory, sem teste, contornável por rotação de e-mail~~ — **✅ PARCIAL (A10):** limitador extraído/testável (`LoginRateLimiter` sobre `RateLimitStore` plugável — **encaixe pronto p/ Redis**); por-e-mail 5/15min inalterado (0-regressão); **defesa por-IP OPT-IN** (`LOGIN_RATELIMIT_BY_IP=1`, 20/15min) fecha a rotação de e-mail; **✅ store DISTRIBUÍDO (SEC-F22):** com `REDIS_URL`, o bloqueio é **compartilhado entre instâncias e sobrevive a restart** (`DistributedLoginLimiter`+`ioredis`); Redis fora/ausente → cai pra memória (login nunca trava — fail-safe). `test:security-login-ratelimit` (12) + `test:security-login-ratelimit-redis` (9). | `src/server/loginRateLimitRedis.ts`; `src/server/routes/auth.ts` |
| A11 | 🟠 P1 | Rate limit global in-memory (~3000 req/15min por IP), desligado por padrão fora de produção. | `server.ts:258-279` |
| A12 | 🟠 P1 | ~~CORS manual: `Access-Control-Allow-Headers` lista `x-organization-id` e **omite `Authorization`**~~ — **✅ CORRIGIDO (SEC-F12):** `buildCorsHeaders()` central agora INCLUI `Authorization`; política de origem inalterada (prod → origem explícita, dev → `*`, sem reflexão de Host). `test:security-cors` (12). | `src/server/corsConfig.ts`; `server.ts` |
| A13 | 🟡 P2 | ~~JWT com `expiresIn: '24h'` fixo~~ — **✅ MITIGADO (A13):** TTL da sessão agora configurável via env `JWT_TTL` (`SESSION_JWT_TTL`), default `24h` (0-regressão); o operador pode ENCURTAR a janela de um token vazado (ex.: `8h`, `30m`, `3600`s). Parsing seguro (só-dígitos → segundos como NUMBER; unidade → string; inválido → default+aviso, nunca quebra `jwt.sign`). Complementa o `security_version` (A14/SEC-F7) que já revoga na hora em troca de senha/MFA/bloqueio. `test:security-session-ttl` (9). | `src/server/config/secret.ts`; `src/server/routes/auth.ts` |
| A14 | 🟡 P2 | ~~Sem `security_version` — tokens antigos seguem válidos após troca de senha/MFA~~ — **✅ CORRIGIDO (SEC-F7):** coluna `users.security_version`; JWT carrega `sv`; `requireOrganizationAccess` compara e barra 401 quando diverge; `bumpSecurityVersion()` no reset de senha / desativar MFA / bloqueio. Token legado sem `sv` não é barrado (sem lockout). `test:security-session` (6). | `src/server/middleware/auth.ts`; `routes/auth.ts`, `routes/mfa.ts`, `routes/users.ts` |
| A15 | 🟡 P2 | ~~Sem CSP/Referrer-Policy/Permissions-Policy~~ — **✅ CORRIGIDO (SEC-F11):** `buildSecurityHeaders()` central adiciona `Referrer-Policy`, `Permissions-Policy` (camera/mic `self`; nega geolocation/payment/…) e CSP em **report-only** por padrão (enforcing sob `CSP_ENFORCE=1`, sem quebrar o SPA); HSTS/nosniff/X-Frame-Options mantidos (X-XSS legado removido). `test:security-headers` (10). | `src/server/securityHeaders.ts`; `server.ts` |
| A16 | 🟡 P2 | ~~Dockerfile roda como **root**~~ — **✅ NÃO-ROOT (SEC-F23):** a EXECUÇÃO cai pro usuário `node` (uid 1000) — build segue como root (precisa do toolchain), só o runtime é sem privilégio. **Validar no deploy:** volume de DATA_DIR precisa ser gravável pelo uid 1000. **✅ MULTI-STAGE (SEC-F26):** o build (toolchain + devDeps) roda no estágio `builder` e é DESCARTADO; a imagem final não tem mais `python3/make/g++` (só compilava os nativos) nem as devDeps (podadas com `npm prune --omit=dev`). Pré-condição validada: os bundles usam esbuild `--packages=external`, então NENHUM devDep é `require()`d em runtime (varredura dos 3 `.cjs` = zero) — o único que era (`vite`, top-level `import`, virava `require("vite")` no boot mesmo em prod) foi convertido em `import()` DINÂMICO dentro do ramo dev-only, então em produção nunca carrega. Nativos (better-sqlite3/bcrypt) compilam no `builder` (mesma base → mesmo glibc/arch) e viajam prontos. **Validar no deploy:** exige um `docker build` real (não há daemon no CI/sessão); reversível por `git revert` (volta ao single-stage). | `Dockerfile`, `server.ts` |

**Nuances corrigidas vs. auditoria original:** A3 é OR (não AND) — mais provável estar fechado do
que a auditoria supôs, mas o default-open é real. A2/A8 têm mitigações parciais (docs clínicos já são
privados). A1 afeta só a escrita (`encrypt`), não a leitura.

### 2.0.1 Auditoria de INJEÇÃO (código digitado em formulários) — SEC-F16

Pergunta do dono: "um usuário mal-intencionado consegue escrever código nos campos e executar?".
Varredura completa (XSS cliente/servidor, SQL, comando, path traversal, prompt-injection):

| Classe | Resultado |
| --- | --- |
| **XSS armazenado (SSR JSON-LD)** | 🔴 **1 CONFIRMADO → ✅ CORRIGIDO (SEC-F16):** `server.ts` embutia `JSON.stringify(jsonLd)` (nome/descrição do produto, digitados no form do lojista) num `<script type="application/ld+json">`. `JSON.stringify` não escapa `<`/`>`/`&` — um produto `</script><script>…</script>` executava JS na loja pública. `jsonForScript` (`src/server/htmlSafe.ts`) escapa como `\uXXXX` (JSON segue válido). `test:security-xss-jsonld` (10). |
| XSS cliente (React) | ✅ SEGURO — zero `dangerouslySetInnerHTML`/`innerHTML`/`eval`/`new Function`; React escapa texto por padrão. |
| SQL injection | ✅ SEGURO — `better-sqlite3` com `?` em tudo; fragmentos `${where}` são cláusulas fixas, valores sempre via bind; colunas de `ORDER BY`/`SET` são literais/whitelist; `LIMIT` sempre `Number()`-coagido. Nenhuma query monta SQL com dado do request. |
| Comando/código | ✅ SEGURO — sem `eval`/`new Function`/`vm`/`child_process` alcançável por rota HTTP (só em `scripts/` de teste, com args fixos). |
| Path traversal | ✅ SEGURO — nomes de arquivo são UUID do servidor ou chaves do DB por-org; onde há URL do usuário, `path.basename()` protege. |
| Prompt-injection (IA) | ✅ **ENDURECIDO (SEC-F17):** o chat principal (`AIOrchestratorService`) e o legado (`geminiRAG`) agora ROTEIAM o conteúdo externo pelo `ContextGuardService` — trechos de RAG e a mensagem do cliente vão CERCADOS no envelope `<untrusted_external_data>` (sentinela desarmado, chars de controle removidos), e o system prompt declara que ali é DADO, nunca instrução. Continua com a whitelist de ações server-side (`sanitizeActions`) por trás. `test:security-ai-fence` (11). |
| Validação de entrada | Manual por rota (destructuring de campos nomeados, coerção, whitelist de enum, cap de tamanho) — sem lib de schema (zod). É o que mantém o SQL seguro; recomendação futura: camada central de validação. |

### 2.0.2 Auditoria de PAGAMENTOS / dados bancários (a maior preocupação) — SEC-F19

Perguntas: (1) dá pra DESVIAR o pagamento pra outra conta? (2) dado de cliente/banco vaza pro
frontend? (3) a confirmação de pagamento é autêntica? Modelo: cada loja recebe DIRETO na PRÓPRIA
chave PIX / conta de gateway (sem split de plataforma) — "desviar" = adulterar a config de
recebimento da própria loja, ou forjar um "pago".

| # | Achado | Sev / Status |
| --- | --- | --- |
| **P1** | **Desvio de pagamento por funcionário** — `PUT /api/payments/settings` (grava `pay_pix_key`/`pay_gateway_token`) e `POST /webhook-secret` NÃO tinham trava de dono; `pagamentos` não está em `FINANCE_MODULES` e o parque legado (sem perfil RBAC) passava sem gate → um `agent` trocava a chave PIX/token pela conta dele e desviava os recebimentos. Só MESMA org (não cross-tenant). | 🔴 **CORRIGIDO (SEC-F19):** `requireRole("owner","admin")` no PUT e no rotate; GET redige a chave PIX pra não-dono. `test:security-payment-payout` (13). |
| P2 | Webhook genérico marcava pago com `paid` default `true` (sem status) e SEM conferir valor; sem replay/dedup no path de pagamento. | 🟠 **CORRIGIDO (SEC-F20):** exige status pago EXPLÍCITO (ausência ≠ pago), CONFERE o valor do payload contra o total do pedido (rejeita divergência), e `claimWebhookEvent('payment')` bloqueia reenvio duplicado. `paymentWebhookGuard.ts` (puro/testável) + `test:security-payment-webhook` (19). **✅ Stone endurecido (SEC-F27):** `syncStonePayment` não confia mais no `status` do CORPO — pega o id do evento, RE-CONSULTA a API do Pagar.me (`GET /orders|/charges`) e confirma só pelo objeto AUTORITATIVO (status 'paid' + `code`/metadata + valor conferido contra a cobrança guardada), igual a MP/Asaas. FAIL CLOSED (API fora/status≠paid/valor divergente → não confirma). `stonePaymentGuard.ts` (puro) + `test:security-stone-webhook` (18). |
| — | Segredos do gateway CIFRADOS em repouso (AES-256-GCM real, fail-closed); NENHUM endpoint devolve segredo em claro (só `hasGatewayToken`); campo de token no front é write-only. | ✅ SEGURO |
| — | Valor/destino da cobrança vêm SEMPRE do servidor (pedido/reserva), nunca do corpo do request — não dá pra redirecionar o pagamento no checkout. | ✅ SEGURO |
| — | Isolamento multi-tenant: org sempre do JWT; nenhuma query de dinheiro/PII confia em id do corpo sem escopo de org. Cross-tenant NÃO é possível. | ✅ SEGURO |
| — | Cartão (PCI): nenhum PAN/CVV é gravado/logado — 100% delegado ao gateway (PIX MP + link Stone). Mercado Pago, Asaas E Stone (SEC-F27) RE-CONSULTAM a API antes de marcar pago (autêntico). | ✅ SEGURO |

### 2.1 Varredura do FRONTEND (dados sensíveis no navegador)

Resultado geral: **bom**. Sem segredo hardcoded, sem exposição via `import.meta.env`/`VITE_*`, sem
sink de XSS, e o tenant **não** é confiado do cliente (nunca há `x-organization-id` no frontend;
`organizationId` vem do JWT assinado). Achados residuais (todos MED/LOW):

| # | Sev | Achado | Evidência (`arquivo:linha`) |
| --- | --- | --- | --- |
| FE1 | 🟠 MED | ~~JWT cru + objeto de usuário completo em `localStorage` (`zappflow_token`/`zappflow_user`) — qualquer XSS exfiltra a sessão inteira.~~ — **✅ FASE 1 (SEC-F24, backend):** o login agora EMITE a mesma sessão num cookie **httpOnly** (`zf_session`, `SameSite=Strict`, `Secure` em prod) e o backend ACEITA o token do cookie além do header `Authorization` (header tem precedência → **0-regressão**, ninguém deslogado). Autenticação por cookie ganha defesa **CSRF por mesma-origem** (`Origin`/`Referer`) em métodos que mudam estado; `POST /logout` limpa o cookie; socket handshake também lê o cookie. **✅ FASE 2 (frontend, atrás de flag de build `VITE_COOKIE_SESSION`, default OFF):** com a flag LIGADA o SPA **não guarda mais o token no `localStorage`** (só o perfil não-secreto), confia no cookie httpOnly, reidrata a sessão no refresh via `/api/auth/me` (cookie), faz `POST /api/auth/logout` no sair e o socket reconecta pelo cookie; `/api/auth/me` passou a aceptar o cookie. **Ligar SÓ após validar no navegador** (login/refresh/logout/socket) — flag de build, reversível por rebuild. Migração sem logout: usuários com token no localStorage continuam no header mode até o próximo login em cookie mode. | `src/server/sessionCookie.ts`; `src/server/middleware/auth.ts`; `src/server/routes/auth.ts`; `server.ts`; `src/lib/sessionMode.ts`; `src/contexts/AuthContext.tsx`; `src/lib/api.ts` |
| FE2 | 🟠 MED | Gating de Master Admin / módulos é **cosmético no cliente** (`isMasterAdmin` só esconde UI). **✅ Backend endurecido (SEC-F3):** o gate server-side `requireMasterAdmin`/`isPlatformMaster` agora exige `platform_role='master_admin'` na LINHA do DB — esconder o botão deixou de ser a única defesa. | `src/store/useStore.ts:322` (UI); backend `middleware/auth.ts` |
| FE3 | 🟠 MED | ~~Custo/margem/lucro ABSOLUTOS renderizados na UI sem o front aplicar papel — confirmar que as rotas de origem são role-gated server-side~~ — **✅ CORRIGIDO (SEC-F13):** a verificação de backend achou GETs financeiros SEM gate (o gate do cliente não é segurança). Fechados server-side: relatórios puros → `requireRole("owner","admin")` (`products.ts` `/sales-analytics[/csv]`; `retailops.ts` `/stores/:id/costs`, `/stores/:id/variable-costs`, `/stores/:id/result`, `/stores-result`, `/pricing/products`); o catálogo (`GET /api/products`) segue aberto ao vendedor mas com `avg_cost`/`suggested_price` REDIGIDOS pra não-owner/admin (`canSeeProductCost`). `test:security-money-routes` (32). Borderline pendente (R$ de valor/impacto, não custo/margem): `retailops` `/impact*` e `/dashboard/*`. **✅ VARREDURA FINAL (SEC-F25):** uma sweep de dados-no-frontend achou 5 GETs financeiros que o SEC-F13 não cobriu, todos fechados na MESMA convenção: relatórios puros → `requireRole("owner","admin")` (`dre.ts` `/api/dre`; `analytics.ts` `/api/analytics/profit`; `loss.ts` `/api/loss`; `comigo.ts` `/summary`); rota MISTA (operacional + dinheiro) → redige só o valor de dinheiro (`comigo.ts` `/overview` redige `fiadoReceivable` via `redactMoney`, mantendo contadores operacionais pro staff). Helper puro `moneyVisibility.ts` (`canSeeOrgMoney`/`redactMoney`, FAIL CLOSED). `test:security-money-gating` (12). A sweep confirmou LIMPO: bank/PIX/segredos de gateway (redigidos/cifrados), PII cross-cliente em endpoints públicos, hashes/tokens de auth em respostas, segredos no bundle do cliente, e PII em `console.log` de produção. | `src/server/routes/{dre,analytics,loss,comigo}.ts`, `src/server/moneyVisibility.ts` |
| FE4 | 🟠 MED | ~~`console.log` da mensagem WebSocket inteira (telefone = PII + corpo da mensagem) no console do navegador, em produção~~ — **✅ CORRIGIDO (SEC-F12):** `devLog` (só emite em DEV; no-op em produção) substitui os `console.log` que carregavam dados de contato/mensagem — nada sensível aterrissa mais no console do cliente em produção. | `src/lib/log.ts`; `src/App.tsx` |
| FE5 | 🟡 LOW | Chave Web do Firebase commitada (`firebase-applet-config.json`) — pública por design (identificador, **não** segredo). **Correção da auditoria:** NÃO é dead file — é importada por `IntegrationsView.tsx:4`; removê-la quebraria o build. Sem ação (é identificador público, não credencial). | `firebase-applet-config.json:5`; `src/features/IntegrationsView.tsx:4` |

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

## 6.1 Migração de chaves (habilitar o boot fail-closed — SEC-F2)

Hoje a cifra usa `sha256(ENCRYPTION_KEY || JWT_SECRET)`. Definir uma `ENCRYPTION_KEY` NOVA e
aleatória tornaria **indecifráveis** os segredos já cifrados (tokens OAuth/gateway/MFA → `null`).
Sequência SEGURA para chegar ao `SECURITY_STRICT_BOOT=1` sem perder dados:

1. **Preservar a leitura** — defina `ENCRYPTION_KEY` = o valor ATUAL do `JWT_SECRET` (o mesmo
   material que a cifra já usa). Nada muda na decifragem; agora a chave é explícita e desacoplada.
2. **Rotacionar para chave dedicada** — gere `openssl rand -hex 32` e rode
   `scripts/rotate-encryption-key.ts` (recifra a base da chave antiga para a nova). Agora
   `ENCRYPTION_KEY` ≠ `JWT_SECRET`.
3. **Confirmar** — `GET /api/admin/security-config` deve retornar `issues: []` (`ok: true`).
4. **Ligar o fail-closed** — defina `SECURITY_STRICT_BOOT=1`. A partir daí, boot com segredo
   crítico faltando **aborta** (SEC-04), em vez de degradar silenciosamente.

Enquanto o strict não é ligado, o boot só AVISA (não brica o deploy atual).

## 7. Gate automatizado (CI)

- `.github/workflows/security-review.yml` — roda `anthropics/claude-code-security-review` em cada PR
  (comenta findings). **Requer o secret `CLAUDE_API_KEY` no repositório** para operar; sem ele o job
  apenas não roda (não bloqueia merge). Complementa — não substitui — as suítes `test:security-*`.
- **Supply-chain (SEC-F15):** `npm audit fix` (semver-compatível, validado) reduziu 26→6 vulns
  (crítica 1→0). Restam 6 na cadeia `whatsapp-web.js`/puppeteer (major/breaking, baixa exposição —
  usamos Evolution API + `PUPPETEER_SKIP_DOWNLOAD`). Detalhe em `docs/security/SUPPLY-CHAIN.md`.
- Recomendado ao fim do programa: DAST autenticado (ex.: StackHawk) + **pentest multi-tenant em
  staging** (Tenant A→B, cliente→Master, webhook→runtime, arquivo privado→público). Essa etapa não é
  substituível por revisão de código.
