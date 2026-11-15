// Mídia de um artigo de ajuda (ADR-179 F5): GIF/imagem ou vídeo curto de treinamento.
// Decide pelo final do caminho (ignora ?query/#hash), sem baixar nada.
export function isVideoUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const path = url.split(/[?#]/)[0].toLowerCase();
  return /\.(mp4|webm|m4v|mov)$/.test(path);
}
