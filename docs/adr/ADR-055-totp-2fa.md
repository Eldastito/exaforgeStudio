# ADR-055 — TOTPService — 2FA para contas privilegiadas

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit. O SaaS é multi-tenant e uma conta owner comprometida (senha vazada, phishing, credential stuffing) equivale a **todo o tenant exposto**: dados de clientes, integrações, faturamento. O 2FA já estava no código (`src/server/TOTPService.ts` + rotas `mfa.ts` + hook no `/api/auth/login`) mas sem ADR e sem teste automatizado.

---

## Contexto

O login por e-mail + senha (bcrypt) é o único fator até então. Qualquer vazamento de senha é game over para o tenant. A escolha é o padrão de facto — **TOTP RFC 6238** — porque:

- Funciona offline com apps que o usuário já tem (Google Authenticator, Authy, 1Password, Bitwarden).
- Não depende de SMS (caro, vulnerável a SIM swap) nem de e-mail (mesmo canal comprometido).
- Não exige hardware — WebAuthn/passkeys fica como evolução futura, não bloqueia hoje.

A implementação é **feita à mão com `crypto` nativo do Node** (sem `speakeasy`, `otplib`, etc.), para não trazer dependência transitiva que precise ser auditada e atualizada.

## Decisão

**Algoritmo (fixo no `TOTPService.otpauthURL`):** `SHA1`, 6 dígitos, período de 30s — o único combo aceito universalmente pelos apps autenticadores. Fugir disso quebra scan de QR na prática.

**Segredo:**
- 20 bytes (160 bits) de `crypto.randomBytes`, codificado em base32 (charset RFC 4648 sem padding).
- **Cifrado em repouso** via `EncryptionService.encrypt(...)` antes de tocar o SQLite. As colunas `users.mfa_secret`, `users.mfa_pending_secret` e `users.mfa_backup_codes` NUNCA contêm plaintext (ver `db.ts` linhas 462–466).
- Durante o setup existe um "pending secret" separado — só vira `mfa_secret` (ativo) depois que o usuário confirma um código válido do app. Evita ficar com 2FA ligado sem o usuário ter guardado o segredo no app.

**Verificação (`TOTPService.verify`):**
- Janela de tolerância **±1 passo** (±30s) para compensar drift de relógio do celular sem virar oráculo de força bruta.
- Regex `^\d{6}$` filtra qualquer input não numérico antes do HMAC.
- Comparação em **tempo constante** (`crypto.timingSafeEqual`) — sem short-circuit por byte, sem timing side channel.

**Backup codes:**
- 8 códigos numéricos de 8 dígitos (`generateBackupCodes`), gerados no `POST /api/mfa/enable`, retornados **uma única vez** ao usuário, guardados cifrados como JSON em `users.mfa_backup_codes`.
- **Single-use**: no login, código de backup casado é removido do array e o array cifrado é regravado (`routes/auth.ts` ~L216-219). Emite evento `MFA_BACKUP_CODE_USED` no audit log.

**Pontos de enforcement (onde o 2FA REALMENTE bloqueia):**
- **`POST /api/auth/login`** — se `user.mfa_enabled = 1`, senha correta **não emite JWT sozinha**. Falta o `mfaToken` → 401 com `mfaRequired: true`. Código errado consome tentativa (mesmo `registerFailedLogin` do 1º fator) e loga `MFA_FAILED`.
- **`POST /api/mfa/disable`** — exige a **senha atual** para desligar o 2FA. Impede que uma sessão sequestrada desative silenciosamente.
- Fora isso, o 2FA é **opt-in por usuário** (não há política de "owner obrigado a ligar" ainda — decisão consciente para não travar onboarding; ver trade-off abaixo).

## Consequências

**Positivas:**
- Roubo de senha isolada **não é mais suficiente** para tomar a conta — o atacante precisa também do dispositivo com o app autenticador ou dos backup codes.
- Zero dependência nova — auditoria do algoritmo é o próprio arquivo `TOTPService.ts` (79 linhas).
- Segredos cifrados em repouso: um dump do SQLite (backup vazado, disco roubado) não expõe seeds — precisa também da `ENCRYPTION_KEY`.
- Backup codes single-use dão uma via de recuperação sem canal paralelo (SMS/e-mail).

**Trade-offs aceitos:**
- **Opt-in, não obrigatório para owners.** Um owner que nunca liga o 2FA continua vulnerável. Fase 4 deve avaliar política "owner de tenant pago é obrigado a ter 2FA em N dias".
- **Perda dos backup codes = suporte manual.** Não há fluxo self-service de recovery (o `disable` exige senha, que o usuário pode ter, mas se ele também perdeu o app precisa de intervenção). Aceitável no volume atual; virar rotina exige um fluxo de KYC.
- **Sem WebAuthn/passkeys ainda.** TOTP continua phishable (site fake pede o código de 30s). Passkeys resolvem, mas exigem UI + fallback + suporte de biometria — fica para roadmap.
- **SHA1 fixo.** RFC 6238 permite SHA256/SHA512, mas Google Authenticator ainda ignora o campo `algorithm` na URL — mudar hoje só quebra usuário.

## Testes

**Gap conhecido.** Não existe `scripts/test-totp.ts` nem `scripts/test-mfa.ts` — o `TOTPService` e as rotas `/api/mfa/*` **não têm cobertura automatizada** hoje. Foi validado manualmente contra Google Authenticator e 1Password no setup, mas o CI não regride:

- verify em código válido, código no passo -1, código no passo +1, código fora da janela (±2), código com espaços, código não numérico;
- setup → enable com código errado (deve rejeitar sem ativar);
- login com `mfa_enabled = 1` sem `mfaToken` (deve 401 com `mfaRequired`);
- login consumindo backup code (deve remover do array cifrado, um segundo uso do mesmo código deve falhar);
- `disable` sem a senha correta (deve 400, 2FA continua ativo).

**Ação Fase 4:** criar `scripts/test-totp.ts` cobrindo os pontos acima e registrar em `.github/workflows/ci.yml` — mesmo padrão do `test-connector-public.ts` (ADR-052). Enquanto isso, tratar qualquer mudança em `TOTPService.ts` ou nos ramos de MFA de `routes/auth.ts` como **change controlada** com revisão manual obrigatória.
