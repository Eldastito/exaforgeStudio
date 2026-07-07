# ADR-052 — Connector Público (`/api/connector-in`) — contrato e segurança

**Status:** Implementado.

**Origem:** Fase 2 do plano de produção — o levantamento apontou o Connector Público como incompleto (sem teste de segurança, sem ADR do contrato). O endpoint é a **única superfície pública não-webhook** do backend: qualquer sistema externo (PMS, OTA, ERP, middleware) pode empurrar dados diretamente sem passar por JWT. Sem teste de segurança, um bug de auth ou de isolamento vira **vazamento de tenant** — o pior cenário possível de um SaaS multi-tenant.

---

## Contexto

Integrações de hotelaria e varejo raramente têm o poder de fazer OAuth ou lidar com JWT rotacionado. Mas precisam empurrar disponibilidade/preço/recursos com frequência. A escolha em ADRs anteriores foi:

- Autenticação por **TOKEN de integração** persistido em `organization_settings.integration_token_hash` (hash SHA256, nunca em plaintext).
- Token via header `x-connector-token` ou query `?token=` (fallback para webhooks bobos que não setam header).
- Endpoints públicos NÃO usam `authenticateJWT` — usam `orgByToken(req)` que resolve o `organizationId` a partir do hash do token.

## Decisão (contrato do endpoint)

**Regras invioláveis do `/api/connector-in`:**

1. **Auth strict** — sem token ou token inválido responde **401**. Nenhum caminho retorna 200 sem token válido.
2. **Prefixo obrigatório** — token deve começar com `zf_` (nossa convenção). Isso protege contra confusão com tokens de outros provedores (Bearer, GitHub, Stripe).
3. **Isolamento por request** — cada request resolve o `orgId` a partir do token e trabalha SÓ nele. Nunca aceita `organizationId` no body (evita override).
4. **Endpoints suportados hoje**:
   - `POST /api/connector-in/availability` — importa disponibilidade/preço.
   - `POST /api/connector-in/resources` — importa lista de recursos reserváveis.
5. **Fail-safe em payload inválido** — `rows` inexistente vira `[]`. Nunca retorna 5xx por payload malformado. Se o texto não for JSON, o middleware do Express devolve 400.
6. **Sem informação de tenant no erro** — 401 responde `"Token de integração inválido."` sem revelar se o token existe pra outra org, quantas tentativas, etc.

## Consequências

**Positivas:**
- **16 verificações de segurança** cobrindo auth strict + isolamento + payload defensivo + rota inexistente.
- Regressão automatizada em CI: se alguém tirar a checagem do token ou aceitar `organizationId` no body, teste vira vermelho.
- Contrato documentado facilita onboarding de novas integrações (PMS, marketplace, ERP).

**Trade-offs aceitos:**
- Token no query string aparece em logs de acesso do proxy — aceitável para tokens rotacionáveis (usuário pode `POST /api/connector/token/rotate`). Em produção, recomenda-se **sempre** header + HTTPS.
- Payload inválido retorna 200 se `rows` vira `[]` silenciosamente. Optamos por "processar zero linhas" em vez de 400 para simplificar clientes bobos que às vezes mandam batch vazio.
- Não há rate limit por IP no endpoint hoje. O rate limit vai ligar globalmente via `ENABLE_RATE_LIMIT=true` (ver `docs/DEPLOY.md`).

## Testes

`scripts/test-connector-public.ts` — **16 verificações**:
- **Auth strict** (5): sem header, header vazio, sem prefixo `zf_`, formato Bearer errado, token `zf_` inexistente → todos 401.
- **Auth ok** (2): token válido devolve 200 + `success: true`.
- **Isolamento** (3): recurso criado por token A NÃO aparece na org B.
- **Query param** (2): token via `?token=` funciona; query fake dá 401.
- **Payload defensivo** (3): body vazio, `rows: null`, string solta — nunca 5xx.
- **404 rota errada** (1).

Sobe mini-servidor Express só com o router público (isolado do resto), roda os assertions e desliga. Sem shared state entre asserts.

Registrado no CI (`.github/workflows/ci.yml`).
