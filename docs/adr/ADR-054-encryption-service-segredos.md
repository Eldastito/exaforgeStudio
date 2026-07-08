# ADR-054 — EncryptionService — segredos em repouso e hash de tokens

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit de decisões já em código, sem documentação. O `EncryptionService` nasceu remendando um vazamento óbvio: tokens de OAuth do Google, segredo TOTP de MFA, token do gateway de pagamento e token de integração ficavam em **texto puro** no SQLite. Um `sqlite3` no volume do container era o suficiente para tomar posse da conta Google de qualquer tenant ou emitir cobrança em nome de uma organização. A implementação entrou, mas ficou sem ADR — este documento fecha essa lacuna.

---

## Contexto

O ZappFlow guarda no banco material que, se lido, compromete o tenant imediatamente:

- `oauth_connections.access_token` / `refresh_token` — refresh do Google não expira até revogação manual.
- `organization_settings.pay_gateway_token` e `pay_webhook_secret` — falso positivo de webhook + saque em nome da org.
- `organization_settings.integration_token` — token do Connector Público (ADR-052), usado por PMS/ERP para empurrar dados.
- `users.mfa_secret` e `mfa_backup_codes` — bypass total do segundo fator.

Para o Connector Público e o webhook de pagamento a comparação é **por valor** (o cliente manda o token e comparamos com o que temos). Não dá pra guardar só o hash — o cálculo do HMAC do webhook precisa do segredo em claro em tempo de request, e o Connector precisa recuperar o `organizationId` do banco a partir do valor recebido. Solução: guardar **cifrado** para poder decifrar quando necessário, e manter uma coluna auxiliar `*_hash` (SHA-256) para lookup indexado sem tocar na cifra.

A separação `ENCRYPTION_KEY` vs `JWT_SECRET` é intencional: rotacionar JWT invalida sessões (aceitável), rotacionar chave de criptografia inviabiliza **ler os segredos guardados** (catastrófico). Duas chaves = dois ciclos de vida.

## Decisão

**Regras invioláveis do `EncryptionService`:**

1. **AES-256-GCM** via `node:crypto` — IV de 12 bytes aleatório por operação, tag de autenticação de 16 bytes. GCM entrega confidencialidade **e** integridade; leitura com tag inválida devolve `null`, nunca a cifra crua.
2. **Formato serializado:** `enc:v1:<base64(iv || tag || ciphertext)>`. Prefixo versionado permite futuro `enc:v2:` sem quebrar leitura do legado.
3. **Chave derivada:** `sha256(ENCRYPTION_KEY || JWT_SECRET || "zappflow-dev-key-fallback")` — 32 bytes determinísticos. Em produção, se `ENCRYPTION_KEY` estiver ausente e cair no fallback do `JWT_SECRET`, loga `[SECURITY]` warning no boot.
4. **`encrypt` idempotente:** valor já com prefixo `enc:v1:` retorna como está. Permite rodar backfill N vezes sem re-cifrar.
5. **`decrypt` tolerante a legado:** valor **sem** prefixo é considerado texto migrado ainda-não-cifrado e devolvido como está. Isso é o que viabiliza deploy sem downtime — o backfill roda no boot e converte em background.
6. **`hash(plain)`** — SHA-256 hex, **não reversível**, para colunas `*_hash` de lookup (Connector Público e webhook de pagamento). Se receber valor já cifrado, decifra antes de hashear.
7. **Backfill no boot** — `backfillExistingSecrets()` chamado em `server.ts:1299`. Cifra o que ainda está em texto e preenche colunas `_hash` faltantes. Idempotente, silencioso quando não há o que fazer.

## Consequências

**Positivas:**
- Dump do SQLite não expõe mais token de OAuth, MFA, gateway ou integração.
- GCM detecta adulteração — se alguém trocar bytes no banco, `decrypt` retorna `null` em vez de devolver lixo tratado como segredo válido.
- Migração sem downtime: código antigo continua lendo texto puro; novo código lê ambos. Backfill converte de forma preguiçosa.
- Colunas `_hash` permitem lookup O(log n) por valor sem precisar decifrar linha por linha (usadas em `routes/connectorPublic.ts:18` e `PaymentService.ts:361`).

**Trade-offs aceitos:**
- **Fallback para `JWT_SECRET`** é conveniente em dev/staging mas acopla dois ciclos de rotação em produção. O warning no boot é o que temos hoje — não bloqueia. Em produção real, `ENCRYPTION_KEY` **precisa** estar definida separadamente (documentado em `docs/DEPLOY.md`).
- **`encrypt` em caso de erro devolve o plaintext** (com `console.error`) em vez de lançar. A escolha explícita foi "não perder o dado do usuário"; o custo é que uma falha de cifragem passa despercebida se ninguém ler o log. Aceitável enquanto a base de tenants for pequena; revisitar quando tivermos observabilidade de logs estruturados.
- **Sem envelope encryption** — chave única no processo, sem DEK por tenant, sem KMS. Comprometer a env compromete tudo. Suficiente para o modelo de ameaça atual (single-tenant deployment por hotel/rede); rever quando entrarmos em multi-tenant hospedado.
- **Rotação de chave não implementada** — o `v1` no prefixo é o *placeholder* para uma futura rota de re-cifra. Rotacionar hoje exige script manual (decifrar com chave antiga, cifrar com nova, atualizar todas as colunas listadas em `backfillExistingSecrets`).
- Custo de CPU do GCM é irrelevante no volume atual (< 1ms por segredo em hardware modesto), mas cada leitura de `organization_settings` agora faz decrypt — não use como cache quente.

## Testes

**Cobertura direta hoje: nenhuma.** Não existe `scripts/test-encryption-service.ts`. O que temos são testes adjacentes que exercitam o serviço de forma indireta:

- `scripts/test-jwt-secret-persist.ts` — garante que o `JWT_SECRET` (do qual a chave de encriptação deriva no fallback) sobrevive a restarts via `DATA_DIR/.jwt_secret`. Isso protege contra a pior falha silenciosa: chave mudar entre boots e tornar todos os segredos guardados ilegíveis.
- `scripts/test-connector-public.ts` (ADR-052) — exercita `EncryptionService.hash` no caminho de lookup do token de integração.

**Lacunas honestas** que devem virar `scripts/test-encryption-service.ts`:
- Round-trip `encrypt` → `decrypt` para valores unicode, vazios, `null`.
- Idempotência: `encrypt(encrypt(x)) === encrypt(x)`.
- Adulteração: mexer no ciphertext base64 e confirmar que `decrypt` devolve `null`, não string corrompida.
- Backfill idempotente: rodar duas vezes seguidas na mesma base e verificar que a segunda passada não atualiza nada.
- Compat com legado: linha sem prefixo `enc:v1:` continua legível.

Enquanto esses testes não existirem, qualquer mudança no `EncryptionService` exige revisão manual das 6 rotas consumidoras listadas em `grep -rn EncryptionService src/server`.
