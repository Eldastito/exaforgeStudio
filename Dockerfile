# Imagem única: builda o front (Vite) + os dois servidores Node (core +
# vision-cloud, ver docs/adr/ADR-001-vision-edge-runtime.md, adendo) via
# esbuild, e roda os dois processos dentro do MESMO container.
FROM node:22-bookworm-slim

WORKDIR /app

# Ferramentas para compilar módulos nativos (better-sqlite3, bcrypt) + `tini`.
#
# `tini` é o init de facto para containers Docker — é literalmente o binário
# por trás da flag `docker run --init`. Ele roda como PID 1 real do container
# (ver ENTRYPOINT abaixo) e resolve dois problemas que Node sozinho NÃO
# resolve como PID 1: (1) reaping de processos-filho zumbis/órfãos — Node não
# faz isso; (2) repasse correto de sinais (SIGTERM do `docker stop`/redeploy
# do Coolify) para os processos filhos. Decisão completa, alternativas
# avaliadas e testes que validaram isso (inclusive teste real de reaping de
# zumbi, não só teórico): docs/adr/ADR-008-process-supervisor.md
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates tini \
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

ENV NODE_ENV=production
EXPOSE 3000

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
