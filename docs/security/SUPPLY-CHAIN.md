# ZapFlow — Supply-chain (dependências) — SEC-F15

**Método:** `npm audit` (auditoria de vulnerabilidades conhecidas nas dependências) + correção
**semver-compatível** (`npm audit fix`, **sem** `--force`) — só atualiza dentro das faixas já
declaradas no `package.json`, então **nenhuma faixa de dependência direta mudou** (só o
`package-lock.json` foi fixado em versões corrigidas). Verificado com build + typecheck + testes
ANTES do merge (uma tentativa anterior com `--omit=dev` quebrou a tipagem do `vision-cloud` e foi
revertida — por isso a correção é sempre validada, nunca aplicada às cegas).

## Resultado

| | Antes | Depois |
| --- | ---: | ---: |
| **Total** | 26 | **6** |
| 🔴 Critical | 1 | **0** |
| 🟠 High | 17 | **5** |
| 🟡 Moderate | 4 | **0** |
| Low | 4 | **1** |

**56 pacotes** atualizados (todos patch/minor, mesmo major). Destaques de segurança fechados:

- **`websocket-driver` 0.7.4→0.7.5** — a ÚNICA crítica (bypass de limite de recurso via compressão).
- `ws` 8.20→8.21 (vazamento de memória não-inicializada), `socket.io-parser` 4.2.6→4.2.7 (exaustão
  de memória), `engine.io`/`engine.io-client` — pilha de tempo-real (Socket.IO).
- `react-router`/`react-router-dom` 7.15→7.18 (CSRF potencial via PUT/PATCH/DELETE).
- `multer` 2.1→2.2 (DoS via nomes de campo aninhados), `body-parser`/`qs` (parsing HTTP).
- `fast-xml-parser` 5.9→5.10 (reset de limite de expansão de entidade — usado no parser de NF-e),
  `protobufjs`, `nanoid`, `postcss`, `js-yaml`, `ip-address` (SSRF via octal), `brace-expansion`.

## Verificação (antes do merge)

- `npx tsc --noEmit` — limpo (0 erros).
- `npm run build` — OK (Vite + esbuild dos 3 entrypoints).
- Varredura de testes: 15/15 de segurança + RBAC; NF-e (`fast-xml-parser`) 21/21 + 13/13; WhatsApp
  integração 72/72; atribuição/outcome 13/13 + 23/23. CI roda a matriz completa (16 shards) como gate final.

## Restantes (6) — exigem bump MAJOR (breaking), adiado

Todas na cadeia do **`whatsapp-web.js`** (puppeteer → `@puppeteer/browsers` → `extract-zip`;
5 high + 1 low). O conserto pede `whatsapp-web.js` major (`1.34.2`), que é breaking.

**Baixa exposição no nosso runtime:** o app usa a **Evolution API** para o WhatsApp e desliga o
download do Chromium (`PUPPETEER_SKIP_DOWNLOAD=true` no Dockerfile), então o puppeteer do
`whatsapp-web.js` praticamente não é exercitado em produção. Ainda assim, o ideal é subir o major
numa fatia dedicada (testando o fluxo de WhatsApp), ou remover a dependência se ela não for mais usada.

## Como manter

- Rodar `npm audit` periodicamente; aplicar `npm audit fix` (sem `--force`) e **validar sempre**
  (`tsc` + `npm run build` + testes) antes de commitar.
- `--force` (bumps major) só numa fatia dedicada, com teste do subsistema afetado.
