import { randomBytes, createHash, randomUUID } from "node:crypto";
import db from "./db.js";
import { PdvConsentService, PDV_CONSENT_SCOPE } from "./PdvConsentService.js";
import { onlyDigits } from "./phoneMatch.js";
import { logAuthEvent } from "./auditLog.js";

/**
 * PdvConsentLinkService — ADR-204 D4c: o PRÓPRIO cliente do PDV decide, numa página pública, se autoriza receber mensagens.
 *
 * O operador gera um link PESSOAL e TEMPORÁRIO para um cliente; o cliente abre, lê, e toca "Autorizo" OU "Não autorizo" (dois botões iguais, nada
 * pré-marcado). A decisão cai no MESMO livro append-only (`PdvConsentService.record`, origem `link`) — não há 2º registro de consentimento.
 *
 * Regras (RN-D4c):
 *  - Token de 32 bytes aleatórios devolvido UMA vez; no banco só o HASH (SHA-256). Resolve sempre por hash. Um link ativo por cliente (gerar outro revoga o anterior).
 *  - Link vale até expirar (padrão 14 dias) ou ser revogado e pode ser REABERTO pra mudar de ideia (revogar tem que ser fácil — LGPD); cada decisão é uma linha nova do livro.
 *  - A página mostra o MÍNIMO: nome da empresa, 1º nome do cliente e final do celular — nunca CPF, e-mail, endereço, histórico ou celular completo.
 *  - O ZapFlow NUNCA envia este link: mandar mensagem a quem ainda não autorizou é justamente o que o consentimento evita. O operador entrega pessoalmente (QR na tela) ou por conta própria.
 *  - Decisão sem celular cadastrado, link expirado/revogado/desconhecido → recusa sem gravar nada. Isolado por organização.
 */
export const CONSENT_LINK_TTL_DAYS = 14;
const hashToken = (raw: string) => createHash("sha256").update(String(raw)).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();

export type LinkLookup = { ok: true; link: any } | { ok: false; reason: "invalid" | "expired" };

export class PdvConsentLinkService {
  /** Gera (e invalida o anterior) o link do cliente. Devolve o token CRU uma única vez. */
  static create(orgId: string, code: string, actorId: string | null | undefined, opts: { ttlDays?: number; now?: number } = {}): { token: string; path: string; expiresAt: string } {
    const c = db.prepare("SELECT codigo_n, celular, inativo FROM retail_pdv_customers WHERE organization_id = ? AND codigo_n = ?").get(orgId, String(code)) as any;
    if (!c) throw new Error("Cliente não encontrado na base do PDV desta empresa.");
    if (c.inativo) throw new Error("Cliente inativo — não gero link.");
    if (!onlyDigits(c.celular)) throw new Error("O cliente não tem celular cadastrado — não há por onde falar com ele.");
    const now = opts.now ?? Date.now();
    const ttl = Math.min(60, Math.max(1, Math.floor(Number(opts.ttlDays) || CONSENT_LINK_TTL_DAYS)));
    const raw = randomBytes(32).toString("hex");
    const expiresAt = iso(now + ttl * 86400000);
    const tx = db.transaction(() => {
      db.prepare("UPDATE retail_pdv_consent_links SET revoked_at = ? WHERE organization_id = ? AND customer_code = ? AND revoked_at IS NULL").run(iso(now), orgId, String(code));
      db.prepare("INSERT INTO retail_pdv_consent_links (id, organization_id, customer_code, token_hash, expires_at, created_by) VALUES (?,?,?,?,?,?)").run(randomUUID(), orgId, String(code), hashToken(raw), expiresAt, actorId || null);
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", null, "PDV_CONSENT_LINK_CREATED", { customer: String(code), ttlDays: ttl }); } catch { /* best-effort */ }
    return { token: raw, path: `/consentimento/${raw}`, expiresAt };
  }

  /** Revoga o link ativo do cliente (o token deixa de abrir). */
  static revoke(orgId: string, code: string, actorId?: string | null, now = Date.now()): { revoked: number } {
    const r = db.prepare("UPDATE retail_pdv_consent_links SET revoked_at = ? WHERE organization_id = ? AND customer_code = ? AND revoked_at IS NULL").run(iso(now), orgId, String(code));
    if (r.changes) { try { logAuthEvent(orgId, actorId || "system", null, "PDV_CONSENT_LINK_REVOKED", { customer: String(code) }); } catch { /* best-effort */ } }
    return { revoked: Number(r.changes) || 0 };
  }

  /** Há link ativo (não vencido, não revogado) para o cliente? Só pro operador — nunca devolve o token. */
  static activeFor(orgId: string, code: string, now = Date.now()): { active: boolean; expiresAt: string | null } {
    const r = db.prepare("SELECT expires_at FROM retail_pdv_consent_links WHERE organization_id = ? AND customer_code = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1").get(orgId, String(code), iso(now)) as any;
    return { active: !!r, expiresAt: r?.expires_at || null };
  }

  static resolve(token: string, now = Date.now()): LinkLookup {
    const raw = String(token || "");
    if (!/^[0-9a-f]{64}$/.test(raw)) return { ok: false, reason: "invalid" };
    const l = db.prepare("SELECT * FROM retail_pdv_consent_links WHERE token_hash = ?").get(hashToken(raw)) as any;
    if (!l || l.revoked_at) return { ok: false, reason: "invalid" };
    if (Date.parse(l.expires_at) <= now) return { ok: false, reason: "expired" };
    return { ok: true, link: l };
  }

  /** O que a página pública pode mostrar: o MÍNIMO. */
  static view(token: string, now = Date.now()): { ok: true; businessName: string; firstName: string | null; phoneTail: string | null; state: "granted" | "revoked" | "unknown"; expiresAt: string } | { ok: false; reason: "invalid" | "expired" } {
    const r = this.resolve(token, now);
    if (r.ok === false) return { ok: false, reason: r.reason };
    const { organization_id: orgId, customer_code: code } = r.link;
    const c = db.prepare("SELECT nome, celular, inativo FROM retail_pdv_customers WHERE organization_id = ? AND codigo_n = ?").get(orgId, code) as any;
    if (!c || c.inativo) return { ok: false, reason: "invalid" };
    const biz = (db.prepare("SELECT business_name FROM organization_settings WHERE organization_id = ?").get(orgId) as any)?.business_name;
    const digits = onlyDigits(c.celular);
    const first = String(c.nome || "").trim().split(/\s+/)[0] || null;
    return { ok: true, businessName: String(biz || "a loja"), firstName: first, phoneTail: digits.length >= 4 ? digits.slice(-4) : null, state: PdvConsentService.status(orgId, code).state, expiresAt: r.link.expires_at };
  }

  /** A decisão do cliente. Grava no livro (origem `link`); recusa sem gravar se o link não vale. */
  static decide(token: string, granted: unknown, now = Date.now()): { ok: true; state: "granted" | "revoked" } | { ok: false; reason: "invalid" | "expired" | "bad_request" | "no_phone" } {
    if (typeof granted !== "boolean") return { ok: false, reason: "bad_request" };
    const r = this.resolve(token, now);
    if (r.ok === false) return { ok: false, reason: r.reason };
    const { id, organization_id: orgId, customer_code: code } = r.link;
    try {
      const out = PdvConsentService.record(orgId, code, { granted, source: "link", evidence: `link:${id}` }, "customer:link");
      db.prepare("UPDATE retail_pdv_consent_links SET last_decision_at = ? WHERE id = ?").run(iso(now), id);
      return { ok: true, state: out.state === "granted" ? "granted" : "revoked" };
    } catch (e: any) {
      return { ok: false, reason: /celular/i.test(String(e?.message)) ? "no_phone" : "invalid" };
    }
  }
}

export { PDV_CONSENT_SCOPE };
export default PdvConsentLinkService;
