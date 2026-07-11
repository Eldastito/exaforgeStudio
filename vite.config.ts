import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      // ZappFlow Continuity Layer — PWA real (ADR-082, Fase 1c / D7).
      //
      // O service worker cacheia SÓ o app shell (HTML/JS/CSS estáticos do build)
      // para o painel abrir instantaneamente e sobreviver a uma queda de rede.
      // Ele NUNCA cacheia a API: não há `runtimeCaching` para `/api`, então toda
      // chamada autenticada sempre vai à rede (dado sensível/por-tenant nunca
      // encosta no cache do navegador). O outbox (Fase 1b) é quem garante a
      // resiliência de escrita offline; o SW cuida apenas do carregamento da casca.
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: 'auto',
        // Mantemos o manifest oficial já versionado em public/site.webmanifest
        // (branding ZappFlow). O plugin não gera outro nem o injeta.
        manifest: false,
        workbox: {
          // Casca do app: entrega o index.html cacheado para navegações do painel
          // (funciona offline / em rede instável).
          navigateFallback: '/index.html',
          // ...exceto onde NÃO queremos servir a casca cacheada:
          navigateFallbackDenylist: [
            /^\/api\//,                  // API autenticada — sempre rede
            /^\/loja\//,                 // vitrine pública (SPA própria)
            /^\/lp(\/|$)/,               // landing comercial pública
            /^\/radar-ia(\/|$)/,         // Radar de Execução IA (público)
            /^\/clinic\/professional\//, // portal do profissional (token público)
          ],
          // Não deixamos o Workbox inventar cache de runtime para a API.
          runtimeCaching: [],
          // Limpa precaches de versões antigas do SW ao atualizar.
          cleanupOutdatedCaches: true,
          globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,woff,woff2}'],
          // O bundle do painel é uma casca grande (~2,2 MB). Elevamos o teto de
          // precache para 4 MiB para que o app shell inteiro fique disponível
          // offline (o padrão de 2 MiB deixaria o chunk principal de fora).
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        },
        // Em dev não registramos o SW (evita interferir no HMR do AI Studio).
        devOptions: { enabled: false },
      }),
    ],
    // Nenhuma chave de IA é exposta ao cliente. As chamadas de IA passam pelo
    // backend (/api/ai/*, /api/webhooks/*), que lê OPENAI_API_KEY do ambiente.
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
