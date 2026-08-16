# Multi-stage (SEC-F26 / follow-up A16): a imagem de RUNTIME não carrega mais o
# toolchain de compilação (python3/make/g++) nem as devDependencies (vite/esbuild/
# tsc/@types) — só o que o app precisa pra RODAR. O build (que precisa do toolchain
# e das devDeps) acontece no estágio `builder` e é DESCARTADO; o estágio final copia
# apenas o /app já buildado e com `node_modules` de produção.
#
# Por que isso importa e é seguro:
#  - Os bundles são feitos com esbuild `--packages=external` (ver package.json): NENHUM
#    pacote é embutido no .cjs — em runtime, os .cjs fazem `require()` de tudo a partir
#    de `node_modules`. Logo a imagem final PRECISA do `node_modules` de PRODUÇÃO, com
#    os módulos NATIVOS (better-sqlite3, bcrypt) já compilados. Compilamos no `builder`
#    (mesma imagem base → mesmo glibc/arch, os .node são compatíveis) e copiamos prontos.
#  - Copiamos o /app INTEIRO do builder (após `npm prune`), não uma seleção de arquivos:
#    como o servidor é bundlado mas lê assets em runtime (templates/fontes de PDF, etc.),
#    um copy seletivo arriscaria faltar um arquivo. Copiar tudo (menos o toolchain apt e
#    as devDeps já podadas) é o corte seguro. Otimização futura (encolher mais a imagem
#    tirando o código-fonte) exige validar os caminhos de asset num build real.

# ── Estágio 1: builder (tem toolchain + devDeps; é descartado) ──────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Ferramentas p/ compilar módulos nativos (better-sqlite3, bcrypt). Só no builder.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Não baixar o Chromium do whatsapp-web.js (usamos a Evolution API)
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Instala dependências (inclui devDeps: vite, esbuild, tsc são necessários no build)
COPY package*.json ./
RUN npm ci --include=dev

# Copia o restante e builda: client em dist/, e os TRÊS entrypoints Node
# (core, vision-cloud, supervisor) via esbuild — ver scripts em package.json.
COPY . .
RUN npm run build && npm run build:vision-cloud && npm run build:supervisor

# Remove as devDependencies do node_modules — o runtime só precisa das `dependencies`
# (com os nativos já compilados acima). NÃO recompila nada; só poda.
RUN npm prune --omit=dev

# ── Estágio 2: runtime (sem toolchain, sem devDeps) ─────────────────────────
FROM node:22-bookworm-slim
WORKDIR /app

# `tini` é o init de facto para containers Docker — é literalmente o binário
# por trás da flag `docker run --init`. Ele roda como PID 1 real do container
# (ver ENTRYPOINT abaixo) e resolve dois problemas que Node sozinho NÃO
# resolve como PID 1: (1) reaping de processos-filho zumbis/órfãos — Node não
# faz isso; (2) repasse correto de sinais (SIGTERM do `docker stop`/redeploy
# do Coolify) para os processos filhos. Decisão completa, alternativas
# avaliadas e testes que validaram isso (inclusive teste real de reaping de
# zumbi, não só teórico): docs/adr/ADR-008-process-supervisor.md
#
# `ca-certificates` fica no runtime (chamadas HTTPS de saída em produção); o
# toolchain de build (python3/make/g++) NÃO — ele só existia pra compilar os
# nativos, o que já aconteceu no estágio `builder`.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
EXPOSE 3000

# Copia o app já buildado + node_modules de produção (nativos compilados) do builder
# JÁ com owner=node:node no momento da cópia (--chown). Antes disso rodávamos
# `RUN chown -R node:node /app` num passo separado, que caminhava por centenas de
# milhares de arquivos do node_modules chamando chown() em cada um — no ambiente
# do Coolify isso estourava a memória do container de build e o daemon matava o
# passo com exit code 255 (OOM-kill silencioso, sem stderr). Fazer o chown no
# próprio COPY é ~10x mais barato: o BuildKit aplica o owner à medida que copia,
# em vez de re-iterar toda a árvore depois. SEC-F23 preservado: o app segue rodando
# como usuário `node` (uid/gid 1000).
COPY --chown=node:node --from=builder /app /app

# SEC-F23 (achado A16): roda como usuário SEM privilégio (não-root) — reduz o impacto
# de uma eventual exploração (um processo comprometido não é root do container). A imagem
# base `node:*` já traz o usuário `node` (uid/gid 1000); todo o /app já pertence a ele
# pelo `--chown` acima.
#
# IMPORTANTE (validar no deploy): o app escreve em DATA_DIR (SQLite, mídia, .jwt_secret).
# Sem DATA_DIR definido, o default é /app (que fica gravável pelo `node`). SE você MONTA um
# volume e aponta DATA_DIR pra ele, esse volume precisa ser GRAVÁVEL pelo uid 1000 — senão
# o app não sobe (permissão negada ao escrever o banco). No Coolify/host, garanta a
# permissão do volume (ex.: chown 1000:1000 no diretório do volume) OU deixe DATA_DIR no
# default. Reversível: se algo travar, basta trocar o `--chown` no COPY acima por
# uma cópia simples + reintroduzir `RUN chown -R node:node /app` e remover o USER.
USER node

# `tini` como PID 1 real do container (ENTRYPOINT, não CMD — isso importa:
# ENTRYPOINT não é sobrescrito por overrides de comando, garantindo que o
# init nunca seja acidentalmente pulado). Filho único do tini é o supervisor
# Node, que sobe `core` (dist/server.cjs, o CRM/atendimento/Kanban/RIC) e
# `vision-cloud` (dist/vision-cloud.cjs, ver apps/vision-cloud/server.ts) como
# processos independentes — uma falha isolada no vision-cloud nunca derruba
# o core. Ver scripts/supervisor.ts para o comportamento completo e
# troubleshooting, e docs/adr/ADR-008-process-supervisor.md para a decisão.
#
# CMD chama `node` diretamente (não `npm run start:supervisor`): `npm` é mais
# uma camada de processo no meio, e camadas assim nem sempre repassam sinal/
# exit-code de forma confiável para quem as invocou — inclusive descobrimos
# esse exato problema com `npx` no próprio teste automatizado deste
# mecanismo (ver `scripts/test-supervisor.ts` e a nota no ADR-008). Evitar a
# mesma armadilha aqui, no ponto de entrada real do container, é deliberado.
# Para rodar manualmente (debug local/`docker exec`), use
# `npm run start:supervisor` — o script continua existindo para isso.
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/supervisor.cjs"]
