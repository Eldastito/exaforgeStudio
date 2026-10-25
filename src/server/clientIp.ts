/**
 * clientIp — IP do cliente para rate-limit, bloqueio de login e auditoria (hardening de segurança, out/2026).
 *
 * POR QUE existe: o app lia `X-Forwarded-For` CRU e usava o 1º valor (ou o cabeçalho inteiro como chave). Esse cabeçalho é
 * escrito pelo cliente: quem ataca manda `X-Forwarded-For: <qualquer coisa>` e ganha um balde novo de rate-limit a cada
 * requisição — o limitador global, o de cadastro/login público (fashion) e os da rota pública (radar/consentimento) deixavam
 * de limitar. O 1º valor da lista é justamente o que o cliente controla; o que vale é o que o NOSSO proxy acrescentou.
 *
 * REGRA: `TRUSTED_PROXY_HOPS` = quantos proxies de confiança existem na frente do app (padrão 1 — Coolify/Traefik, um proxy).
 * Cada proxy acrescenta o IP de quem falou com ele ao FIM da lista; então o cliente real é o `hops`-ésimo valor contado da
 * DIREITA. Valores à esquerda são não confiáveis e são ignorados.
 *  - 0 → app exposto direto (sem proxy): ignora o cabeçalho e usa só o endereço da conexão.
 *  - lista com menos itens que `hops` (cabeçalho ausente/curto: healthcheck interno, requisição que não passou pelo proxy)
 *    → usa o endereço da conexão (nunca confia no que veio de fora).
 *  - valor que não é IP válido → endereço da conexão.
 * Com Cloudflare NA FRENTE do proxy, configure TRUSTED_PROXY_HOPS=2 (senão todos os clientes de uma borda da CDN dividem o
 * mesmo balde). Sem a variável, o comportamento seguro é o de 1 proxy.
 */
import net from "node:net";

const MAX_HOPS = 5;

export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.TRUSTED_PROXY_HOPS ?? "").trim();
  if (raw === "") return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return 1;
  return Math.min(n, MAX_HOPS);
}

/** Tira o prefixo IPv4-mapeado (::ffff:1.2.3.4) pra mesma pessoa não virar dois baldes. */
export function normalizeIp(ip: string): string {
  const s = String(ip || "").trim();
  return s.toLowerCase().startsWith("::ffff:") && net.isIPv4(s.slice(7)) ? s.slice(7) : s;
}

export function clientIp(req: any, hops: number = trustedProxyHops()): string {
  const socketIp = normalizeIp(req?.socket?.remoteAddress || req?.connection?.remoteAddress || "") || "unknown";
  if (hops <= 0) return socketIp;
  const header = req?.headers?.["x-forwarded-for"];
  const raw = Array.isArray(header) ? header.join(",") : String(header ?? "");
  if (!raw || raw.length > 2048) return socketIp;
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < hops) return socketIp;
  const candidate = normalizeIp(parts[parts.length - hops]);
  return net.isIP(candidate) ? candidate : socketIp;
}
