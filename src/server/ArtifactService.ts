/**
 * ArtifactService — PRD 1 (Fala Tu), Fase 2 (artefatos). Fonte de verdade dos
 * artefatos entregáveis do ZapFlow (relatório, export, recibo, documento).
 *
 * Guardrails (§15/§16):
 *  - arquivo no disco PRIVADO (`private_media/artifacts/{orgId}/…`), NUNCA no
 *    `/media` público; o path interno NUNCA sai — só id + URL assinada;
 *  - isolamento por `organization_id` em TODA query (convenção nº 1);
 *  - `sha256` do conteúdo + `size_bytes` gravados na criação (integridade);
 *  - entrega segura por URL assinada (`fileSigning`, escopo 'artifact') com TTL +
 *    verificação de tenant + expiração + não-purgado;
 *  - `expires_at` (TTL opcional) e `purged_at` (retenção LGPD soft).
 *
 * Nesta fatia de fundação a criação é via serviço (os geradores — ReportPdf,
 * XLSX, intake — plugam nas próximas fatias). Acesso por classificação sensível
 * a nível de usuário é refinamento seguinte; aqui vale isolamento por org + a
 * segurança da URL assinada.
 */
import db from "./db.js";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logAuthEvent } from "./auditLog.js";
import { signKey, verifyKey, DEFAULT_SIGNED_TTL_MS } from "./fileSigning.js";
import { ContextProjectionService } from "./ContextProjectionService.js";

const ARTIFACTS_DIR = path.join(process.env.DATA_DIR || process.cwd(), "private_media", "artifacts");
try { fs.mkdirSync(ARTIFACTS_DIR, { recursive: true }); } catch { /* noop */ }

const SCOPE = "artifact";
const KINDS = ["report", "export", "receipt", "document", "image", "other"];
const CLASSES = ["internal", "sensitive", "public"];
const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "text/csv": "csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/json": "json",
  "text/plain": "txt",
};

function hydrate(r: any): any {
  if (!r) return null;
  return {
    id: r.id, organizationId: r.organization_id, createdBy: r.created_by ?? null,
    kind: r.kind, title: r.title ?? null, mimeType: r.mime_type, sizeBytes: r.size_bytes,
    storageKey: r.storage_key, origin: r.origin ?? null, classification: r.classification,
    sha256: r.sha256 ?? null, correlationId: r.correlation_id ?? null,
    expiresAt: r.expires_at ?? null, createdAt: r.created_at,
  };
}

function extFor(mime: string, storageKey: string): string {
  const fromKey = storageKey.includes(".") ? storageKey.split(".").pop()! : "";
  return fromKey || MIME_EXT[mime] || "bin";
}

/** Nome de arquivo seguro pro Content-Disposition (sem aspas/barras/controles). */
function safeFilename(base: string, ext: string): string {
  const clean = String(base || "arquivo").replace(/[^a-zA-Z0-9._ -]/g, "_").trim().slice(0, 80) || "arquivo";
  return clean.toLowerCase().endsWith(`.${ext}`) ? clean : `${clean}.${ext}`;
}

export class ArtifactService {
  /** Cria um artefato: grava o binário no disco privado + registra metadados. */
  static create(orgId: string, input: {
    kind: string; title?: string | null; mimeType: string; content: Buffer | string;
    origin?: string | null; classification?: string; createdBy?: string | null;
    correlationId?: string | null; ttlMs?: number | null;
  }): any {
    const kind = KINDS.includes(input.kind) ? input.kind : "other";
    const classification = CLASSES.includes(input.classification || "") ? input.classification! : "internal";
    const mime = String(input.mimeType || "application/octet-stream");
    const buf = Buffer.isBuffer(input.content) ? input.content : Buffer.from(String(input.content), "utf-8");
    const id = randomUUID();
    const ext = MIME_EXT[mime] || "bin";
    const storageKey = `${orgId}/${id}.${ext}`;
    fs.mkdirSync(path.join(ARTIFACTS_DIR, orgId), { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS_DIR, storageKey), buf);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const expiresAt = input.ttlMs ? new Date(Date.now() + input.ttlMs).toISOString() : null;
    db.prepare(`
      INSERT INTO artifacts (id, organization_id, created_by, kind, title, mime_type, size_bytes, storage_key, origin, classification, sha256, correlation_id, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, input.createdBy || null, kind, input.title || null, mime, buf.length, storageKey, input.origin || null, classification, sha256, input.correlationId || null, expiresAt);
    logAuthEvent(orgId, input.createdBy || null, id, "ARTIFACT_CREATED", { kind, mime, size: buf.length, origin: input.origin || null, classification, correlationId: input.correlationId || null });
    return this.get(orgId, id);
  }

  /** Metadados do artefato (tenant + não-purgado). */
  static get(orgId: string, id: string): any {
    return hydrate(db.prepare(`SELECT * FROM artifacts WHERE id = ? AND organization_id = ? AND purged_at IS NULL`).get(id, orgId));
  }

  /** Lista artefatos da org (filtros opcionais). NÃO expõe storage path. */
  static list(orgId: string, opts: { createdBy?: string | null; kind?: string | null; limit?: number } = {}): any[] {
    const conds = ["organization_id = ?", "purged_at IS NULL"];
    const params: any[] = [orgId];
    if (opts.createdBy) { conds.push("created_by = ?"); params.push(opts.createdBy); }
    if (opts.kind) { conds.push("kind = ?"); params.push(opts.kind); }
    const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
    const rows = db.prepare(`SELECT * FROM artifacts WHERE ${conds.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...params, limit) as any[];
    return rows.map(hydrate).map((a) => { const { storageKey, ...pub } = a; return pub; }); // não vaza path
  }

  /** Lê o binário do artefato (tenant + não-purgado + não-expirado). */
  static read(orgId: string, id: string, now = Date.now()): { buffer: Buffer; mime: string; filename: string } | null {
    const a = this.get(orgId, id);
    if (!a) return null;
    if (a.expiresAt && new Date(a.expiresAt).getTime() < now) return null;
    const file = path.join(ARTIFACTS_DIR, a.storageKey);
    if (!fs.existsSync(file)) return null;
    const ext = extFor(a.mimeType, a.storageKey);
    return { buffer: fs.readFileSync(file), mime: a.mimeType, filename: safeFilename(a.title || a.kind, ext) };
  }

  /** URL assinada temporária (pública, sem sessão) pra baixar o artefato. */
  static signedUrl(orgId: string, id: string, ttlMs = DEFAULT_SIGNED_TTL_MS, now = Date.now()): string | null {
    const a = this.get(orgId, id);
    if (!a) return null;
    const { exp, sig } = signKey(SCOPE, `${orgId}/${id}`, ttlMs, now);
    return `/api/public/artifacts/${encodeURIComponent(orgId)}/${encodeURIComponent(id)}?exp=${exp}&sig=${sig}`;
  }

  /** Resolve uma URL assinada: verifica HMAC/expiração + entrega. null se inválido. */
  static resolveSigned(orgId: string, id: string, exp: string, sig: string, now = Date.now()): { buffer: Buffer; mime: string; filename: string } | null {
    if (!verifyKey(SCOPE, `${orgId}/${id}`, exp, sig, now)) return null;
    return this.read(orgId, id, now);
  }

  // ── RBAC por CLASSIFICAÇÃO (fecho de segurança da Fase 2) ──
  // O download público é bearer (a URL assinada JÁ é a credencial). A porta de
  // controle é a EMISSÃO/LISTAGEM: quem pode MINTAR o link ou VER o artefato.
  //   public/internal → qualquer membro da org (comportamento atual);
  //   sensitive       → só o CRIADOR ou quem tem visão ampla do negócio
  //                     (owner/gerente — reusa `hasFullBusinessVisibility`,
  //                     nenhum RBAC novo). Fail-closed: sem user → nega sensível.
  static canAccess(orgId: string, user: any, artifact: { createdBy?: string | null; classification?: string } | null): boolean {
    if (!artifact) return false;
    if (artifact.classification !== "sensitive") return true;
    const uid = user?.userId || user?.id || null;
    if (uid && artifact.createdBy && artifact.createdBy === uid) return true; // criador
    return ContextProjectionService.hasFullBusinessVisibility(orgId, user);
  }

  /** get() gated por classificação — null se o usuário não pode ver. */
  static getForUser(orgId: string, user: any, id: string): any {
    const a = this.get(orgId, id);
    return a && this.canAccess(orgId, user, a) ? a : null;
  }

  /** list() já filtrado pro que o usuário pode ver. */
  static listForUser(orgId: string, user: any, opts: { createdBy?: string | null; kind?: string | null; limit?: number } = {}): any[] {
    return this.list(orgId, opts).filter((a) => this.canAccess(orgId, user, a));
  }

  /** Minta a URL assinada só se o usuário pode acessar o artefato. */
  static signedUrlForUser(orgId: string, user: any, id: string, ttlMs = DEFAULT_SIGNED_TTL_MS, now = Date.now()): string | null {
    return this.getForUser(orgId, user, id) ? this.signedUrl(orgId, id, ttlMs, now) : null;
  }
}
