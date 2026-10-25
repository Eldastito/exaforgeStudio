# Atualização de segurança — out/2026

Origem: pedido do dono após as falhas divulgadas em outubro/2026 (release de segurança do Node de 21/10, DoS no `multer` de 22–23/10, ondas de worms em pacotes npm). Auditoria feita em 25/10/2026 sobre o repositório real (`npm audit`, leitura do código, diff dos pacotes novos).

## 1. O que foi encontrado e corrigido

| # | Achado | Gravidade real no ZapFlow | Correção |
| - | ------ | ------------------------- | -------- |
| 1 | **Rate-limit e bloqueio de login burláveis**: o app lia `X-Forwarded-For` cru e usava o 1º valor (ou o cabeçalho inteiro como chave de balde). Esse valor é do cliente — quem ataca troca o cabeçalho a cada pedido e nunca é limitado. Afetava o limitador global da API, o de webhook, o de cadastro/login público (fashion), a rota pública do radar e a do link de consentimento, e o IP gravado na auditoria. **Achado desta auditoria, não da notícia.** | Alta (burla de proteção contra força bruta/abuso) | `src/server/clientIp.ts` — único ponto que decide o IP do cliente. Conta os proxies de confiança pela DIREITA da lista (`TRUSTED_PROXY_HOPS`, padrão 1). |
| 2 | **Node.js — release de segurança de 21/10/2026**: escrita fora do limite no decodificador Brotli (CVE-2026-111497, até execução de código via `node:zlib`), falhas de hostname em DNS/TLS, keep-alive HTTP. Corrigido em 22.23.4 / 24.22.1 / 26.12.1. Não aparece no `npm audit`. | Média: o Brotli só é alcançável se o app descomprime Brotli de origem não confiável (conferido no código instalado: o `body-parser` do Express 4 só descomprime `gzip` e `deflate`, não `br`; já o `fetch` de saída do Node decodifica `br` — o risco está em respostas de terceiros/URLs buscadas pelo servidor) | Dockerfile fixado em `node:22.23.4-bookworm-slim` (antes: tag flutuante, que com cache de camada podia reaproveitar o Node velho). `NodeRuntimeSecurityService` grita no log do boot se o Node ficar abaixo do mínimo. |
| 3 | **multer 2.2.0 → 2.5.0** — 6 avisos "high", entre eles queda do processo por requisição sem login (GHSA-q7qp-rjg7-q26m, só com `fileFilter` assíncrono — os nossos são síncronos) e vazamento de descritor de arquivo em upload abortado (afetava exatamente a 2.2.0). Há rotas de upload públicas (ex.: fashion). | Média (DoS) | Atualizado. |
| 4 | **proxy-addr 2.0.7 → 2.0.8** (marcado "critical": spoofing de IP em sub-rede IPv4-mapeada). O app não configura `trust proxy`, então o caminho vulnerável não era usado. | Baixa aqui, mas é o item que o `npm audit` chama de crítico | Atualizado (vem com o Express 4.22.3). |
| 5 | `body-parser` (DoS por bytes após corpo comprimido), `qs`, `engine.io`/Socket.IO (DoS por revisão de protocolo), `fast-uri`, `js-yaml`, `brace-expansion`, `ip-address`, `source-map-js`, `serialize-javascript`, `browserslist` | Média/baixa (DoS; vários só no build) | Atualizados dentro da faixa já declarada. |
| 6 | `@xmldom/xmldom` (15 avisos, DoS/injeção em XML) — usado na assinatura de NF-e (`nfeSignature.ts`) | Média | 0.9.12 (direto) e 0.8.15 (dentro do `xml-crypto`). |
| 7 | `sharp` (libheif/librsvg) — processa imagens enviadas por usuários | Média | 0.35.5. |
| 8 | `vite` (servidor de desenvolvimento) | Baixa (não roda em produção) | 6.4.5. Continua declarado nos dois lugares, como era. |
| 9 | **`whatsapp-web.js` removido** — nenhuma linha do código o importava (o projeto usa a Evolution API); arrastava `puppeteer`, `extract-zip`, `basic-ftp`, `proxy-agent`… (10 avisos "high" e um `postinstall` que baixa Chrome). | Baixa (código morto), mas superfície de ataque e de supply chain | Removido. Se alguém precisar dele no futuro, reinstale conscientemente. |
| 10 | **CI com ações móveis**: `anthropics/claude-code-security-review@main` (recebe a `CLAUDE_API_KEY`) e `code-review-graph@v2.3.7` (escreve em PR) apontavam para branch/tag, que mudam. | Média (supply chain) | Todas as ações fixadas por SHA de commit (verificado com `git ls-remote`). |

Resultado do `npm audit`: **33 → 6** avisos (antes: 1 crítico, 26 altos, 4 moderados, 2 baixos; depois: 0 crítico, **5 altos**, 0 moderados, 1 baixo — todos explicados em §2).

## 2. O que NÃO foi corrigido, e por quê

- **`firebase` / `@firebase/firestore` / `@grpc/grpc-js` (4 altos)**: o app só usa `firebase/app` e `firebase/auth` no navegador (`IntegrationsView.tsx`); Firestore/gRPC não são usados. A "correção" que o `npm audit` sugere é um *downgrade* para `firebase@9.14.0` — não é uma opção.
- **`zod` (1 alto)**: só entra como dependência opcional do `openai`; o código não usa os helpers de zod.
- **`esbuild` (1 baixo)**: só afeta o servidor de desenvolvimento no Windows.
- **Express 4 → 5**: é migração com quebras de comportamento e precisa de fatia própria com testes; o Express 4.22.3 já recebe as correções acima.

## 3. O que o dono precisa fazer

1. **Fazer o deploy reconstruindo a imagem** (no Coolify: *Force rebuild*/sem cache). O Dockerfile agora fixa o Node 22.23.4; confira no log do boot a linha `[SEC] Node 22.23.4 (≥ 22.23.4)…`. Se aparecer `[SEC][ATENÇÃO]`, a imagem é a antiga.
2. **Dizer quantos proxies existem na frente do app.** O padrão é 1 (Coolify/Traefik). Se houver **Cloudflare (ou outra CDN) na frente do Traefik**, defina `TRUSTED_PROXY_HOPS=2` — senão todos os clientes de uma mesma borda da CDN dividem o mesmo balde de limite. Se o app for exposto direto, sem proxy, defina `TRUSTED_PROXY_HOPS=0`. Errar para menos não abre brecha nova (continua como era antes); errar para mais pode limitar clientes legítimos.
3. Nada a rotacionar: não há indício de que algum pacote comprometido tenha entrado (ver §4). Rotacione segredos (`JWT_SECRET`, chaves de API, tokens do npm/GitHub) **somente** se aparecer algum dos pacotes citados em §4 no `package-lock.json` de qualquer máquina que rode `npm install`.

## 4. Supply chain (worms em npm)

Campanhas noticiadas em 2026 (Shai-Hulud/"ChainDrop": `keyv`, `cacheable`; `@subql/common` 5.8.3 e `tensorlake` 0.5.144 em outubro). Verificado em 25/10/2026: **nenhum desses pacotes está no `package-lock.json`** (`npm ls keyv cacheable @subql/common tensorlake` vazio; o teste `test:security-update-oct2026` repete a checagem). É um retrato do dia, não garantia futura.

Pacotes novos instalados nesta atualização: nenhum tem script de instalação; 8 das 10 versões têm atestado de procedência no npm (as exceções, `qs` e `@xmldom/xmldom`, historicamente não publicam com atestado); o diff de código das publicadas na última semana (multer, body-parser, qs, fast-uri, engine.io, proxy-addr, express) não tem padrões típicos de worm (rede, `eval`, leitura de tokens, base64). **É uma heurística, não uma prova.** `npm audit signatures` não rodou neste ambiente (o proxy bloqueou o download das chaves) — rode em uma máquina normal: `npm audit signatures`.

Higiene recomendada (não feita agora porque exige testar o build de verdade):
- Instalar com `npm ci` (nunca `npm install`) em CI/deploy — já é assim.
- Considerar `ignore-scripts=true` com `npm rebuild better-sqlite3 bcrypt sharp` explícito; precisa de um build real do Docker para validar.
- Ao atualizar uma ação do CI, atualize o SHA (e o comentário) à mão: `git ls-remote https://github.com/<dono>/<repo> refs/tags/<tag>` (use a linha `^{}` se o tag for anotado).

## 5. Como repetir

```bash
npm audit                      # hoje: 6 restantes (5 altos + 1 baixo), todos explicados em §2
npm run test:security-update-oct2026
node -e "console.log(process.version)"   # compare com a tabela em NodeRuntimeSecurityService.ts
```

## 6. Limites desta auditoria

- Não é teste de invasão: foi dependências + leitura de pontos de risco conhecidos (IP/rate-limit, uploads, XML) + CI.
- O que a notícia traz veio de pesquisa web resumida (contagens divergem entre fontes); os números de versão do Node, multer e dos pacotes foram conferidos nas páginas oficiais, no advisory do GitHub e no registro do npm.
- O Dockerfile **não foi construído aqui** (sem daemon Docker no ambiente): a tag `22.23.4-bookworm-slim` existe no Docker Hub (publicada em 21/10), mas o primeiro build real será o do seu deploy.
- Resultado dos testes: os ~155 testes que tocam upload, XML, sharp, Socket.IO, login, rotas públicas, vídeo e segurança passaram; 5 falharam em uma rodada paralela por compartilharem o `/tmp` e passaram quando rodados em série.
