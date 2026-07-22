import db from "./db.js";
import { randomUUID } from "crypto";

/**
 * ZappFlow Comigo — Cobrança amigável e cortês do fiado (ADR-113 D3).
 *
 * "Ensinar sem humilhar" vira "cobrar sem constranger": lembretes gentis,
 * escalando o tom com carinho, NUNCA com ameaça (guarda-corpo). Frugal: o texto
 * é TEMPLATE (zero-token) — LLM só personalizaria depois, se ligado.
 *
 * Entrega via zero-integração: gera o texto + link wa.me para o dono enviar num
 * toque pelo próprio WhatsApp (funciona no dia 1, sem depender de canal Cloud).
 * Registra cada lembrete em comigo_fiado_reminders (auditável). LGPD: só se fala
 * com o próprio devedor. Lista negra NÃO para a cobrança (queremos o dinheiro de
 * volta); só não ganha fiado novo.
 */

const brl = (n: number) => `R$ ${Number(n || 0).toFixed(2).replace(".", ",")}`;
const firstName = (name?: string) => String(name || "").trim().split(/\s+/)[0] || "tudo bem";

// Régua suave — o tom escala com carinho, nunca vira ameaça (ADR-113 D3).
function template(level: number, name: string, saldo: number): string {
  const n = firstName(name);
  const s = brl(saldo);
  if (level <= 1) return `Oi ${n}! 😊 Passando só pra lembrar com carinho que ficou ${s} do fiado. Quando puder, dá um jeitinho? Qualquer coisa a gente combina 🙏`;
  if (level === 2) return `Oi ${n}, tudo bem? 🙂 Ainda consta ${s} em aberto aqui na caderneta. Se conseguir acertar essa semana eu agradeço demais! Se precisar dividir, é só me falar.`;
  return `Oi ${n}, tudo certo? Sobre os ${s} do fiado — a gente pode combinar um jeito que caiba no seu momento (parcelar, uma parte agora). Me chama que resolvemos numa boa 🤝`;
}

export class ComigoCollectionService {
  /** Próximo nível = nº de lembretes já enviados + 1 (teto 3). */
  static nextLevel(orgId: string, contactId: string): number {
    const c = (db.prepare("SELECT COUNT(*) c FROM comigo_fiado_reminders WHERE organization_id = ? AND contact_id = ?").get(orgId, contactId) as any)?.c || 0;
    return Math.min(3, Number(c) + 1);
  }

  static balanceOf(orgId: string, contactId: string): number {
    const debt = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger WHERE organization_id = ? AND contact_id = ? AND kind = 'debt'").get(orgId, contactId) as any).s;
    const paid = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger WHERE organization_id = ? AND contact_id = ? AND kind = 'payment'").get(orgId, contactId) as any).s;
    return Math.round((debt - paid) * 100) / 100;
  }

  /** Monta o lembrete (texto cortês + link wa.me), sem registrar ainda. */
  static build(orgId: string, contactId: string, level?: number): { level: number; text: string; waLink: string | null; balance: number } {
    const ct = db.prepare("SELECT name, identifier FROM contacts WHERE organization_id = ? AND id = ?").get(orgId, contactId) as any;
    const balance = this.balanceOf(orgId, contactId);
    const lvl = level && level > 0 ? Math.min(3, level) : this.nextLevel(orgId, contactId);
    const text = template(lvl, ct?.name, balance);
    const digits = String(ct?.identifier || "").replace(/\D/g, "");
    const waLink = digits ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}` : null;
    return { level: lvl, text, waLink, balance };
  }

  /** Registra o lembrete como enviado (auditável) e devolve o texto + wa.me. */
  static record(orgId: string, contactId: string, level?: number, createdBy?: string) {
    const built = this.build(orgId, contactId, level);
    db.prepare(
      `INSERT INTO comigo_fiado_reminders (id, organization_id, contact_id, level, channel, template_key, body, status, created_by) VALUES (?, ?, ?, ?, 'whatsapp', ?, ?, 'sent', ?)`
    ).run(randomUUID(), orgId, contactId, built.level, `nivel_${built.level}`, built.text, createdBy || null);
    return built;
  }
}

export default ComigoCollectionService;
