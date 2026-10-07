import { randomUUID } from "crypto";
import db from "./db.js";
import { phoneMatches, onlyDigits } from "./phoneMatch.js";
import { logAuthEvent } from "./auditLog.js";

/**
 * PdvConsentService — ADR-204 D4 (consentimento na base de clientes do PDV).
 *
 * O PDV (`retail_pdv_customers`, vindo do ERP) NÃO tem consentimento, e o gate LGPD do sink de mensagens (`OutboundConsentGuardService`) só enxerga
 * `contacts` — um cliente do PDV era tratado como "contato desconhecido = mensagem de sistema" e passava SEM prova. Decisão do dono (D4): o cliente
 * precisa aprovar. Este serviço é o REGISTRO dessa aprovação (escopo `comunicacoes`, o mesmo do gate), NÃO a campanha.
 *
 * Regras (RN-D4):
 *  - SEM PROVA = SEM CONSENTIMENTO: nunca inferido (nem de "comprou", nem do ERP, nem de ter celular). `unknown` ≠ `granted`.
 *  - Livro APPEND-ONLY (nunca UPDATE/DELETE — retenção/auditoria): a ÚLTIMA linha vale; revogar é gravar `granted=0` e SEMPRE vence a anterior.
 *  - Cada registro carrega ORIGEM (balcão/whatsapp/formulário/telefone) + quem registrou + evidência curta (sem dado sensível); auditado.
 *  - Isolado por organização; só cliente que EXISTE no PDV da org (não inventa).
 *  - Este serviço só LÊ/REGISTRA: não envia nada. A campanha preditiva futura DEVE perguntar `assertContactable` antes de qualquer envio.
 */
export const PDV_CONSENT_SCOPE = "comunicacoes" as const;
// `link` = o PRÓPRIO cliente decidiu pela página pública (PdvConsentLinkService) — a origem mais forte; as outras são o operador registrando o que o cliente disse.
export const PDV_CONSENT_SOURCES = ["balcao", "whatsapp", "formulario", "telefone", "link"] as const;
export type PdvConsentState = "granted" | "revoked" | "unknown";

const clip = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);

export class PdvConsentService {
  private static customer(orgId: string, code: string): any | null {
    return db.prepare("SELECT codigo_n, nome, celular, filial, inativo FROM retail_pdv_customers WHERE organization_id = ? AND codigo_n = ?").get(orgId, String(code)) as any || null;
  }

  /** Estado atual: a última linha do livro vale; sem linha = `unknown` (nunca "granted"). */
  static status(orgId: string, code: string): { state: PdvConsentState; since: string | null; source: string | null } {
    const r = db.prepare("SELECT granted, source, recorded_at FROM retail_pdv_consents WHERE organization_id = ? AND customer_code = ? AND scope = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1").get(orgId, String(code), PDV_CONSENT_SCOPE) as any;
    if (!r) return { state: "unknown", since: null, source: null };
    return { state: r.granted ? "granted" : "revoked", since: r.recorded_at, source: r.source };
  }

  /** Estado de VÁRIOS clientes de uma vez (1 query) — pra listas. Quem não tem linha fica `unknown`. */
  static statusMany(orgId: string, codes: string[]): Map<string, { state: PdvConsentState; since: string | null; source: string | null }> {
    const out = new Map<string, { state: PdvConsentState; since: string | null; source: string | null }>();
    const uniq = [...new Set(codes.map(String))];
    for (const c of uniq) out.set(c, { state: "unknown", since: null, source: null });
    if (!uniq.length) return out;
    for (let i = 0; i < uniq.length; i += 400) {
      const chunk = uniq.slice(i, i + 400);
      const rows = db.prepare(`SELECT customer_code, granted, source, recorded_at FROM retail_pdv_consents k
        WHERE k.organization_id = ? AND k.scope = ? AND k.customer_code IN (${chunk.map(() => "?").join(",")})
          AND k.rowid = (SELECT k2.rowid FROM retail_pdv_consents k2 WHERE k2.organization_id = k.organization_id AND k2.customer_code = k.customer_code AND k2.scope = k.scope ORDER BY k2.recorded_at DESC, k2.rowid DESC LIMIT 1)`).all(orgId, PDV_CONSENT_SCOPE, ...chunk) as any[];
      for (const r of rows) out.set(r.customer_code, { state: r.granted ? "granted" : "revoked", since: r.recorded_at, source: r.source });
    }
    return out;
  }

  static history(orgId: string, code: string): any[] {
    return db.prepare("SELECT id, granted, source, evidence, actor_id, recorded_at FROM retail_pdv_consents WHERE organization_id = ? AND customer_code = ? AND scope = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 50").all(orgId, String(code), PDV_CONSENT_SCOPE) as any[];
  }

  /** Registra (append-only) a decisão do cliente. Lança em dado inválido; não envia nada. */
  static record(orgId: string, code: string, input: { granted: unknown; source?: unknown; evidence?: unknown }, actorId?: string | null): { ok: true; id: string; state: PdvConsentState } {
    if (typeof input?.granted !== "boolean") throw new Error("Informe se o cliente autorizou (true) ou recusou/revogou (false).");
    const c = this.customer(orgId, code);
    if (!c) throw new Error("Cliente não encontrado na base do PDV desta empresa.");
    const source = String(input.source || "");
    if (!(PDV_CONSENT_SOURCES as readonly string[]).includes(source)) throw new Error(`Origem do consentimento inválida. Use: ${PDV_CONSENT_SOURCES.join(", ")}.`);
    if (input.granted && !onlyDigits(c.celular)) throw new Error("O cliente não tem celular cadastrado no PDV — não há por onde falar com ele.");
    const id = randomUUID();
    db.prepare("INSERT INTO retail_pdv_consents (id, organization_id, customer_code, scope, granted, source, evidence, actor_id) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, orgId, String(code), PDV_CONSENT_SCOPE, input.granted ? 1 : 0, source, clip(input.evidence, 300) || null, actorId || null);
    try { logAuthEvent(orgId, actorId || "system", null, input.granted ? "PDV_CONSENT_GRANTED" : "PDV_CONSENT_REVOKED", { customer: String(code), source }); } catch { /* best-effort */ }
    return { ok: true, id, state: input.granted ? "granted" : "revoked" };
  }

  /** Pode receber mensagem? Só `granted` + celular. Qualquer outra coisa recusa com o motivo. */
  static assertContactable(orgId: string, code: string): { allowed: boolean; reason: "ok" | "customer_not_found" | "inactive" | "no_phone" | "consent_unknown" | "consent_revoked" } {
    const c = this.customer(orgId, code);
    if (!c) return { allowed: false, reason: "customer_not_found" };
    if (c.inativo) return { allowed: false, reason: "inactive" };
    if (!onlyDigits(c.celular)) return { allowed: false, reason: "no_phone" };
    const s = this.status(orgId, code).state;
    if (s === "revoked") return { allowed: false, reason: "consent_revoked" };
    if (s === "unknown") return { allowed: false, reason: "consent_unknown" };
    return { allowed: true, reason: "ok" };
  }

  /** Cobertura da base (só contagens, sem PII): quantos podem ser contatados × quantos faltam pedir. total=0 → percentuais null (não inventa 0%). */
  static summary(orgId: string): { total: number; withPhone: number; granted: number; revoked: number; unknown: number; contactable: number; contactablePctOfWithPhone: number | null } {
    const rows = db.prepare(`
      SELECT c.codigo_n code, c.celular cel,
        (SELECT granted FROM retail_pdv_consents k WHERE k.organization_id = c.organization_id AND k.customer_code = c.codigo_n AND k.scope = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1) g
      FROM retail_pdv_customers c WHERE c.organization_id = ? AND COALESCE(c.inativo, 0) = 0`).all(PDV_CONSENT_SCOPE, orgId) as any[];
    const withPhone = rows.filter((r) => onlyDigits(r.cel)).length;
    const granted = rows.filter((r) => r.g === 1).length, revoked = rows.filter((r) => r.g === 0).length;
    const contactable = rows.filter((r) => r.g === 1 && onlyDigits(r.cel)).length;
    return { total: rows.length, withPhone, granted, revoked, unknown: rows.length - granted - revoked, contactable, contactablePctOfWithPhone: withPhone > 0 ? Math.round((contactable / withPhone) * 100) : null };
  }

  /** Lista de quem PODE ser contatado (granted + celular + ativo). Escopo de loja aplicado por quem chama (`restrictCodes`). */
  static contactable(orgId: string, opts: { limit?: number; restrictCodes?: string[] } = {}): Array<{ code: string; nome: string | null; celular: string; filial: string | null }> {
    const limit = Math.min(500, Math.max(1, Math.floor(Number(opts.limit) || 100)));
    const where = ["c.organization_id = ?", "COALESCE(c.inativo,0) = 0", "c.celular IS NOT NULL", "TRIM(c.celular) <> ''"]; const args: any[] = [orgId];
    if (opts.restrictCodes) { if (!opts.restrictCodes.length) return []; where.push(`c.filial IN (${opts.restrictCodes.map(() => "?").join(",")})`); args.push(...opts.restrictCodes); }
    const rows = db.prepare(`SELECT c.codigo_n code, c.nome, c.celular, c.filial,
      (SELECT granted FROM retail_pdv_consents k WHERE k.organization_id = c.organization_id AND k.customer_code = c.codigo_n AND k.scope = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1) g
      FROM retail_pdv_customers c WHERE ${where.join(" AND ")} ORDER BY c.nome`).all(PDV_CONSENT_SCOPE, ...args) as any[];
    return rows.filter((r) => r.g === 1 && onlyDigits(r.celular)).slice(0, limit).map((r) => ({ code: r.code, nome: r.nome, celular: r.celular, filial: r.filial }));
  }

  /**
   * Usado pelo SINK de mensagens: o destinatário é um cliente do PDV? Casa pelo celular (tolerante a DDI/9º dígito, `phoneMatches`).
   * Devolve null se não casa com ninguém ativo. Pré-filtra por SQL nos 8 últimos dígitos (a base do ERP guarda o celular formatado).
   */
  static findByPhone(orgId: string, identifier: string): { code: string; nome: string | null } | null {
    const d = onlyDigits(identifier);
    if (d.length < 8) return null;
    const tail = d.slice(-8);
    const stripped = "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(c.celular,'(',''),')',''),'-',''),' ',''),'+','')";
    const rows = db.prepare(`SELECT c.codigo_n code, c.nome, c.celular FROM retail_pdv_customers c WHERE c.organization_id = ? AND COALESCE(c.inativo,0) = 0 AND c.celular IS NOT NULL AND ${stripped} LIKE ?`).all(orgId, `%${tail}%`) as any[];
    const hit = rows.find((r) => phoneMatches(r.celular, identifier));
    return hit ? { code: hit.code, nome: hit.nome } : null;
  }
}

export default PdvConsentService;
