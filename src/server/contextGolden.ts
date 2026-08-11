import type { ContextPacket } from "./contextModel.js";

/**
 * contextGolden — PRD 3 F12 (§97/§98): utilitários de GOLDEN TEST do `ContextPacket`.
 *
 * Um golden test trava a forma+conteúdo do pacote ponta-a-ponta: org semeada
 * (determinística) → pacote esperado. O obstáculo é que o pacote carrega campos
 * VOLÁTEIS (generatedAt, o organization_id sorteado, ids uuid, timestamps de
 * evidência) que mudam a cada run. Este módulo os NORMALIZA (canonicaliza) pra o
 * pacote virar comparável — e é REUTILIZÁVEL pelo PRD 4 (§98), que consome o mesmo
 * contrato. Puro (sem DB/IA).
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ORG_RE = /org_[0-9a-f]{8}/gi;
// String que É um timestamp ISO por inteiro (observedAt/validUntil/generatedAt…).
const ISO_WHOLE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

/** Normaliza uma string: org sorteada → <org>, uuid → <uuid>, timestamp → <ts>. */
function normStr(s: string, org?: string): string {
  let out = s;
  if (org) out = out.split(org).join("<org>");
  out = out.replace(ORG_RE, "<org>").replace(UUID_RE, "<uuid>");
  if (ISO_WHOLE_RE.test(out)) return "<ts>";
  return out;
}

/**
 * Canonicaliza um `ContextPacket` — copia normalizando os campos voláteis + ordena
 * as chaves de objeto (estável a reordenação) — pra comparação golden determinística.
 * `opts.org` mapeia o organization_id específico do run pro token `<org>`.
 */
export function canonicalizeContextPacket(packet: ContextPacket, opts: { org?: string } = {}): any {
  const org = opts.org;
  const walk = (node: any): any => {
    if (typeof node === "string") return normStr(node, org);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: any = {};
      // Campos DERIVADOS voláteis (mudam a cada ms mesmo com insumos fixos): o
      // timestamp de geração e a idade em ms do frescor. Normalizados por chave.
      for (const k of Object.keys(node).sort()) {
        out[k] = k === "generatedAt" ? "<ts>" : k === "ageMs" ? "<age>" : walk(node[k]);
      }
      return out;
    }
    return node;
  };
  return walk(packet);
}

/** JSON estável (via canonicalização) — duas strings iguais ⇒ pacotes golden-iguais. */
export function goldenStringify(packet: ContextPacket, opts: { org?: string } = {}): string {
  return JSON.stringify(canonicalizeContextPacket(packet, opts));
}

/**
 * Primeiro caminho em que dois canônicos divergem (ou null se iguais) — pra o teste
 * apontar ONDE o golden quebrou, em vez de só "não bate".
 */
export function firstGoldenDiff(a: any, b: any, path = ""): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (typeof a !== typeof b) return `${path || "<root>"}: tipo ${typeof a} ≠ ${typeof b}`;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: array ≠ não-array`;
    if (a.length !== b.length) return `${path}.length: ${a.length} ≠ ${b.length}`;
    for (let i = 0; i < a.length; i++) { const d = firstGoldenDiff(a[i], b[i], `${path}[${i}]`); if (d) return d; }
    return null;
  }
  if (a && b && typeof a === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstGoldenDiff(a[k], b[k], path ? `${path}.${k}` : k); if (d) return d;
    }
    return null;
  }
  return `${path || "<root>"}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`;
}
