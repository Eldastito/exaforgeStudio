import db from "./db.js";

/**
 * CollectionCopy — fonte única da copy de cobrança (ADR-155 F2.1).
 *
 * Centraliza os 3 estágios da cadência (ADR-152 F4b/F4b.3) em 2 variantes A/B:
 *   - `control`    — a copy ATUAL, byte-idêntica (default de toda org ⇒ zero
 *                    mudança em prod; mantém o test:cobranca-cadencia verde).
 *   - `calibrated` — copy afinada pela rubrica `docs/grimoire/copy/compose/
 *                    dunning-cadence.md` (padrão 4 grimoire): CTA único, tom
 *                    escalando sem culpar, valor+vencimento sempre, e o aviso
 *                    final mantendo o informativo CDC ("proteção ao crédito").
 *
 * A escolha da variante é por-org (`organization_settings.collection_copy_
 * variant`, default 'control') — a atribuição/rollout do A/B é F2.3. A
 * calibração de soft vs hard decline (PIX recuperável × boleto vencido) é F2.2.
 *
 * NÃO muda canal nem regra de WhatsApp (guardrail F2): só o texto. Copy nova
 * passa pela governança ADR-130.
 */

export type CollectionVariant = "control" | "calibrated";

const brDate = (d?: string | null): string => String(d || "").split("-").reverse().join("/");
const brMoney = (a: number): string => Number(a).toFixed(2).replace(".", ",");

export class CollectionCopy {
  /** Variante de copy da org (A/B). Qualquer valor != 'calibrated' cai em 'control'. */
  static variantFor(orgId: string): CollectionVariant {
    const row = db
      .prepare(`SELECT collection_copy_variant AS v FROM organization_settings WHERE organization_id = ?`)
      .get(orgId) as { v?: string } | undefined;
    return row?.v === "calibrated" ? "calibrated" : "control";
  }

  /** T1 / D0 — lembrete inicial (enviado pelo playbook `receivable_collection_v1`). */
  static reminder(variant: CollectionVariant, p: { amount: number; dueDate?: string; description?: string }): string {
    const valor = brMoney(p.amount);
    const dueBR = brDate(p.dueDate);
    const item = p.description ? `\nReferente a: ${p.description}` : "";
    if (variant === "calibrated") {
      return `Oi! 👋 Passando pra lembrar do valor de R$ ${valor} ${dueBR ? `com vencimento em ${dueBR}` : "em aberto"}.${item}\n\nJá tô te mandando o PIX pra deixar rápido — é só pagar pelo link/QR que chega em seguida. 🙂\n\nSe já pagou ou quiser combinar outra forma, é só responder por aqui.`;
    }
    return `Olá! 👋\n\nLembrando do valor de R$ ${valor} ${dueBR ? `com vencimento em ${dueBR}` : "em aberto"}.${item}\n\nPra facilitar, gerei o PIX pra você — o link/QR chega em seguida.\n\nQualquer coisa é só responder por aqui. 🙏`;
  }

  /** T2 / D+N2 — 2ª tentativa, mais firme (sem culpar). template_key='firm'. */
  static firm(variant: CollectionVariant, p: { amount: number; dueDate: string }): string {
    const valor = brMoney(p.amount);
    const dueBR = brDate(p.dueDate);
    if (variant === "calibrated") {
      return `Oi! 🙋 Sobre a cobrança de R$ ${valor} que venceu em ${dueBR}: ainda consta em aberto por aqui.\n\nPra resolver rapidinho, é só pagar pelo PIX que te enviei. Se precisar parcelar, mudar a data ou tiver rolado algum problema, me conta que a gente ajeita junto. 🙏`;
    }
    return `Olá! 🙋\n\nSobre a cobrança de R$ ${valor} que venceu em ${dueBR}: notei que ainda não foi paga.\n\nSe puder acertar via o PIX que enviei antes, resolve rapidinho. Se preferir combinar de outro jeito (parcelar, mudar a data, ou algum problema), é só responder aqui — a gente vê o que dá. 🙏`;
  }

  /** T3 / D+N3 — aviso informativo de proteção ao crédito (CDC). template_key='default_notice'. */
  static notice(variant: CollectionVariant, p: { amount: number; dueDate: string }): string {
    const valor = brMoney(p.amount);
    const dueBR = brDate(p.dueDate);
    if (variant === "calibrated") {
      return `Oi 🙋 Precisamos resolver a cobrança de R$ ${valor}, vencida em ${dueBR}. Se não conseguirmos acertar nos próximos dias, vamos precisar informar os órgãos de proteção ao crédito.\n\nAinda dá tempo de evitar isso — responda aqui e a gente encontra uma saída juntos. 🙏`;
    }
    return `Olá 🙋\n\nPrecisamos combinar sobre a cobrança de R$ ${valor} vencida em ${dueBR}. Se não conseguirmos resolver nos próximos dias, vamos precisar informar as agências de proteção ao crédito.\n\nAinda dá tempo — responda aqui e a gente encontra um jeito juntos. 🙏`;
  }
}

export default CollectionCopy;
