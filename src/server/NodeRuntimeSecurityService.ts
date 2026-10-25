/**
 * NodeRuntimeSecurityService — avisa (no boot e no smoke) quando o Node em execução é anterior ao release de segurança.
 *
 * POR QUE: as falhas do runtime Node NÃO aparecem em `npm audit` (não são pacote). O release de 21/10/2026 corrigiu, entre
 * outras, uma escrita fora do limite no decodificador Brotli (CVE-2026-111497, alcançável por `node:zlib` com dado
 * controlado por terceiro; pode ir de queda a execução de código), falhas de verificação de hostname em DNS/TLS e a reutilização de
 * conexão keep-alive. Versões corrigidas: 22.23.4 · 24.22.1 · 26.12.1 (fonte: nodejs.org/en/blog/vulnerability/
 * october-2026-security-releases). Não é bloqueio — só ruído alto no log, pra um deploy com imagem antiga/cacheada não passar
 * despercebido. Linhas fora da tabela (18/20/EOL) não têm correção publicada → `unsupported`.
 */
export interface NodeRuntimeStatus {
  version: string;
  major: number | null;
  minimum: string | null;
  status: "patched" | "outdated" | "unsupported" | "unknown";
  message: string;
}

// Mínimo corrigido por linha. Atualizar junto do Dockerfile (ARG NODE_IMAGE) a cada novo release de segurança.
export const NODE_MIN_PATCHED: Record<number, string> = { 22: "22.23.4", 24: "24.22.1", 26: "26.12.1" };

function parse(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function lt(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
  return false;
}

export class NodeRuntimeSecurityService {
  static check(version: string = process.versions.node): NodeRuntimeStatus {
    const cur = parse(version);
    if (!cur) return { version: String(version), major: null, minimum: null, status: "unknown", message: `Não consegui ler a versão do Node ("${version}").` };
    const min = NODE_MIN_PATCHED[cur[0]];
    if (!min) {
      return { version, major: cur[0], minimum: null, status: "unsupported", message: `Node ${version}: linha ${cur[0]}.x sem correção do release de segurança de out/2026 — use 22.x, 24.x ou 26.x atualizado.` };
    }
    if (lt(cur, parse(min)!)) {
      return { version, major: cur[0], minimum: min, status: "outdated", message: `Node ${version} está ABAIXO de ${min} (release de segurança de 21/10/2026: Brotli/DNS/TLS). Reconstrua a imagem sem cache (docker build --pull --no-cache) ou suba o ARG NODE_IMAGE do Dockerfile.` };
    }
    return { version, major: cur[0], minimum: min, status: "patched", message: `Node ${version} (≥ ${min}) — inclui o release de segurança de out/2026.` };
  }

  /** Log do boot: silencioso quando está ok; alto (console.error) quando não está. Nunca lança nem derruba o app. */
  static logAtBoot(): NodeRuntimeStatus {
    const s = this.check();
    try {
      if (s.status === "patched") console.log(`[SEC] ${s.message}`);
      else console.error(`[SEC][ATENÇÃO] ${s.message}`);
    } catch { /* log nunca derruba o boot */ }
    return s;
  }
}

export default NodeRuntimeSecurityService;
