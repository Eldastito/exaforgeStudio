/**
 * IdentityResolutionService (ADR-162 / PRD 5 §12, F3) — resolve QUAL cliente está por
 * trás de uma reclamação, com matching DETERMINÍSTICO multi-chave. Regra dura RN-CRR-5:
 * NUNCA associa ao cliente errado pra "fechar o fluxo" — em caso de conflito/ambiguidade,
 * devolve os candidatos e encaminha (o humano decide). Nome NÃO é chave (fraco demais).
 *
 * Estratégia por UNIÃO (segura): coleta candidatos de todas as chaves fornecidas
 * (contactId direto > pedido > telefone > email); se a união apontar pra UM único
 * contato → resolvido; se apontar pra vários → AMBÍGUO (encaminha); nenhum → não achado.
 * Chaves em conflito (telefone e email de contatos diferentes) = ambíguo por construção.
 *
 * Reúso: `phoneMatches` (ADR-051) tolera DDI/9º dígito. Lookups por email/pedido não
 * existiam no fluxo de atendimento (só match exato por canal no webhook) — criados aqui.
 * `protocol` é aceito no contrato mas hoje NÃO resolve (não há coluna de protocolo em
 * ticket/order/contact) — degradação explícita, nunca um match falso.
 */
import db from "./db.js";
import { phoneMatches, onlyDigits } from "./phoneMatch.js";

export interface IdentityHints {
  contactId?: string | null;
  phone?: string | null;
  email?: string | null;
  /** Id INTERNO do pedido (orders.id). Ref humana externa não tem coluna — gap conhecido. */
  orderRef?: string | null;
  /** Aceito por contrato; hoje não resolve (sem coluna de protocolo) — não inventa match. */
  protocol?: string | null;
}

export interface IdentityCandidate { contactId: string; name: string | null; matchedBy: string; }

export interface IdentityResolution {
  status: "resolved" | "ambiguous" | "not_found";
  contactId: string | null;
  matchedBy: string[];            // chaves que concordaram (quando resolvido)
  candidates: IdentityCandidate[]; // preenchido quando ambíguo (pra encaminhar)
  unsupported: string[];          // chaves fornecidas que não têm como resolver hoje
  reason?: string;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const ORDER_RE = /pedido\s*#?\s*([A-Za-z0-9-]{3,})/i;

export class IdentityResolutionService {
  /** Resolve o contato a partir das pistas. Determinístico, isolado por org. */
  static resolve(orgId: string, hints: IdentityHints): IdentityResolution {
    const candidates: IdentityCandidate[] = [];
    const unsupported: string[] = [];

    // 1) contactId direto (mais forte).
    if (hints.contactId) {
      const c = db.prepare(`SELECT id, name FROM contacts WHERE organization_id = ? AND id = ?`).get(orgId, hints.contactId) as any;
      if (c) candidates.push({ contactId: c.id, name: c.name || null, matchedBy: "contactId" });
    }

    // 2) pedido (orders.id INTERNO) → contact_id.
    if (hints.orderRef) {
      const o = db.prepare(`SELECT contact_id FROM orders WHERE organization_id = ? AND id = ?`).get(orgId, hints.orderRef) as any;
      if (o?.contact_id) {
        const c = db.prepare(`SELECT id, name FROM contacts WHERE organization_id = ? AND id = ?`).get(orgId, o.contact_id) as any;
        if (c) candidates.push({ contactId: c.id, name: c.name || null, matchedBy: "orderRef" });
      }
    }

    // 3) telefone (phoneMatches tolera DDI/9º dígito). Pré-filtra por últimos 8 dígitos.
    if (hints.phone) {
      const digits = onlyDigits(String(hints.phone));
      const tail = digits.slice(-8);
      if (tail) {
        const rows = db.prepare(`SELECT id, name, identifier FROM contacts WHERE organization_id = ? AND identifier LIKE ?`).all(orgId, `%${tail}`) as any[];
        for (const r of rows) if (phoneMatches(r.identifier, hints.phone)) candidates.push({ contactId: r.id, name: r.name || null, matchedBy: "phone" });
      }
    }

    // 4) email (case-insensitive; lookup criado aqui — não existia no fluxo).
    if (hints.email) {
      const rows = db.prepare(`SELECT id, name FROM contacts WHERE organization_id = ? AND LOWER(email) = LOWER(?)`).all(orgId, String(hints.email).trim()) as any[];
      for (const r of rows) candidates.push({ contactId: r.id, name: r.name || null, matchedBy: "email" });
    }

    // protocol: aceito, mas sem como resolver hoje — registra como não suportado.
    if (hints.protocol) unsupported.push("protocol");

    // União → decisão. Distintos por contactId.
    const distinct = new Map<string, IdentityCandidate>();
    const matchedByFor = new Map<string, Set<string>>();
    for (const c of candidates) {
      if (!distinct.has(c.contactId)) distinct.set(c.contactId, c);
      if (!matchedByFor.has(c.contactId)) matchedByFor.set(c.contactId, new Set());
      matchedByFor.get(c.contactId)!.add(c.matchedBy);
    }

    if (distinct.size === 0) {
      return { status: "not_found", contactId: null, matchedBy: [], candidates: [], unsupported, reason: unsupported.length ? "sem chave resolvível" : "nenhum match" };
    }
    if (distinct.size === 1) {
      const only = [...distinct.values()][0];
      return { status: "resolved", contactId: only.contactId, matchedBy: [...(matchedByFor.get(only.contactId) || [])].sort(), candidates: [], unsupported, reason: "match único" };
    }
    // >1 contato distinto → AMBÍGUO. Nunca escolhe sozinho (RN-CRR-5): encaminha.
    const list = [...distinct.values()].map((c) => ({ ...c, matchedBy: [...(matchedByFor.get(c.contactId) || [])].sort().join("+") }));
    return { status: "ambiguous", contactId: null, matchedBy: [], candidates: list, unsupported, reason: "chaves apontam pra contatos diferentes — encaminhar" };
  }

  /**
   * Extrai pistas do TEXTO da reclamação (determinístico, regex). Conteúdo é dado NÃO
   * confiável — só EXTRAI candidatos pra tentar casar; nunca confia no que o texto
   * "afirma". Email e "pedido #x"; telefone só quando há sequência longa de dígitos.
   */
  static extractHints(text: string | null | undefined): IdentityHints {
    const s = String(text || "");
    const email = (s.match(EMAIL_RE) || [])[0] || null;
    const orderRef = (s.match(ORDER_RE) || [])[1] || null;
    // telefone: 10–13 dígitos contíguos (ignora números curtos como valores/qtd).
    const phoneMatch = s.replace(/[^\d]/g, " ").match(/\b\d{10,13}\b/);
    const phone = phoneMatch ? phoneMatch[0] : null;
    return { email, orderRef, phone };
  }
}

export default IdentityResolutionService;
