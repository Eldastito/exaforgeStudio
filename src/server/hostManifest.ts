/**
 * ADR-154 F8.5 — qual manifest de PWA servir pra cada host.
 *
 * O mesmo build atende o painel ZappFlow e o FalaTu standalone (subdomínio
 * `falatu.*`, ver src/main.tsx F7.1). O `share_target` do Web Share só faz
 * sentido onde a captura mora — instalar o painel da clínica NÃO deve criar
 * um alvo "compartilhar com ZappFlow" que cai no FalaTu. Por isso o manifest
 * é trocado por host no server (o <link> do index.html continua único), e o
 * `site.webmanifest` do painel fica exatamente como era.
 *
 * Função pura separada do server.ts pra ser testável sem subir o Express.
 */
const FALATU = "falatu.webmanifest";
const PANEL = "site.webmanifest";

export function manifestFileForHost(host: unknown): typeof FALATU | typeof PANEL {
  if (typeof host !== "string") return PANEL;
  // Host header pode vir com porta (falatu.exemplo.com:443) — só o hostname importa.
  const hostname = host.trim().toLowerCase().split(":")[0];
  return hostname.startsWith("falatu.") ? FALATU : PANEL;
}
