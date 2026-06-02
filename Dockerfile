# Imagem única: builda o front (Vite) + servidor (esbuild) e roda o Node.
FROM node:22-bookworm-slim

WORKDIR /app

# Ferramentas para compilar módulos nativos (better-sqlite3, bcrypt)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Não baixar o Chromium do whatsapp-web.js (usamos a Evolution API)
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Instala dependências (inclui devDeps: vite, esbuild, tsc são necessários no build)
COPY package*.json ./
RUN npm ci --include=dev

# Copia o restante e builda (client em dist/, servidor em dist/server.cjs)
COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

# Inicia o servidor (serve o front buildado + APIs + webhooks)
CMD ["npm", "run", "start"]
