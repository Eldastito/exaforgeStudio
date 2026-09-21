/**
 * FiscalXmlStorage — guarda o XML fiscal bruto (procNFe/resNFe/evento) FORA do
 * banco e FORA do alcance público (ADR-200, Fase 3 PR 3).
 *
 * - Content-addressed por SHA-256 do conteúdo: o mesmo XML nunca é gravado duas
 *   vezes (idempotente) e a integridade é verificável (o hash é o nome).
 * - CIFRADO em repouso (EncryptionService, AES-256-GCM) — o XML tem CNPJ, itens
 *   e valores; em disco fica opaco. Sem chave válida em produção, a escrita
 *   FALHA (fail-closed), nunca cai pra texto puro.
 * - NENHUMA rota serve este diretório. A leitura é só interna (auditoria/
 *   reprocessamento), sempre isolada por organização (o path inclui o org).
 *
 * Layout: {DATA_DIR}/fiscal-xml/{orgId}/{sha256}.enc
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EncryptionService } from "./EncryptionService.js";

const dataDir = process.env.DATA_DIR || process.cwd();
const ROOT = path.join(dataDir, "fiscal-xml");

/** Só dígitos/hex/hífen — impede path traversal via org malicioso ou sha torto. */
function safeSegment(s: string): string {
  return String(s || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 128);
}

export interface StoredXml { sha256: string; ref: string; }

export class FiscalXmlStorage {
  /** SHA-256 hex do conteúdo (o endereço do arquivo). */
  static sha256(xml: string): string {
    return crypto.createHash("sha256").update(xml, "utf8").digest("hex");
  }

  /**
   * Grava o XML cifrado (idempotente por conteúdo). Retorna o hash e a
   * referência relativa ({orgId}/{sha}.enc). Vazio → null.
   */
  static putPrivate(orgId: string, xml: string | null | undefined): StoredXml | null {
    if (xml == null || xml === "") return null;
    const org = safeSegment(orgId);
    if (!org) return null;
    const sha = this.sha256(String(xml));
    const ref = `${org}/${sha}.enc`;
    const abs = path.join(ROOT, org, `${sha}.enc`);
    // Idempotente: se já existe (mesmo conteúdo = mesmo hash), não regrava.
    if (fs.existsSync(abs)) return { sha256: sha, ref };
    // EncryptionService lança (fail-closed) se a cifra falhar — o chamador
    // trata; NUNCA gravamos texto puro.
    const enc = EncryptionService.encrypt(String(xml));
    if (!enc) return null;
    fs.mkdirSync(path.join(ROOT, org), { recursive: true });
    // Escrita atômica: grava num temporário e renomeia (evita arquivo parcial
    // se o processo cair no meio).
    const tmp = `${abs}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, enc, { mode: 0o600 });
    fs.renameSync(tmp, abs);
    return { sha256: sha, ref };
  }

  /** Lê e decifra o XML pela referência. Só interno; null se ausente/ilegível. */
  static getPrivate(ref: string | null | undefined): string | null {
    if (!ref) return null;
    // A ref é "{org}/{sha}.enc" — sanitiza cada segmento contra traversal.
    const parts = String(ref).split("/");
    if (parts.length !== 2) return null;
    const org = safeSegment(parts[0]);
    const file = safeSegment(parts[1].replace(/\.enc$/, ""));
    if (!org || !file) return null;
    const abs = path.join(ROOT, org, `${file}.enc`);
    if (!fs.existsSync(abs)) return null;
    try {
      const enc = fs.readFileSync(abs, "utf8");
      return EncryptionService.decrypt(enc);
    } catch {
      return null;
    }
  }
}

export default FiscalXmlStorage;
