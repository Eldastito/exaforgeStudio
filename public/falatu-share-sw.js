/**
 * ADR-154 F8.5 — receptor do Web Share Target (Android/Chrome).
 *
 * Puxado pro SW gerado pelo vite-plugin-pwa via `workbox.importScripts`
 * (mesmo molde do falatu-push-sw.js). Só age no POST que o share sheet do
 * sistema faz em /falatu-share (declarado no falatu.webmanifest): guarda o
 * conteúdo compartilhado no Cache 'falatu-share' e redireciona pro app, que
 * lê, limpa e captura (efeito ?share=1 na FalaTuView). Precisa ser aqui: o
 * share sheet entrega os ARQUIVOS num POST multipart pro escopo do SW — não
 * existe como a página recebê-los sem esse intercept.
 *
 * A decisão da ADR-082 segue intacta: nada aqui toca a API nem cacheia
 * resposta de rede — o Cache é só um estafeta entre o POST do sistema e a
 * página, apagado na leitura.
 */
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'POST') return;
  const url = new URL(event.request.url);
  if (url.pathname !== '/falatu-share') return;
  event.respondWith((async () => {
    try {
      const form = await event.request.formData();
      const cache = await caches.open('falatu-share');
      // Compartilhamento múltiplo pega só o 1º arquivo — captura é 1 mídia
      // por item (mesma regra da rota: áudio OU imagem, nunca lote).
      const file = form.get('media');
      const text = ['title', 'text', 'url']
        .map((k) => form.get(k))
        .filter((v) => typeof v === 'string' && v.trim())
        .join('\n')
        .trim();
      if (file && typeof file !== 'string' && file.size > 0) {
        await cache.put(
          '/falatu-share/payload-file',
          new Response(file, { headers: { 'Content-Type': file.type || 'application/octet-stream' } })
        );
      }
      if (text) await cache.put('/falatu-share/payload-text', new Response(text));
    } catch { /* form ilegível → abre o app mesmo assim, sem stash */ }
    return Response.redirect('/?share=1', 303);
  })());
});
