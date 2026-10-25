/**
 * RetailSellerCodeAuditService — auditoria SOMENTE LEITURA dos códigos de vendedor
 * ("Vendedores a identificar"). Responde: esse código ainda vende? Existe outro código
 * que começou quando este parou (transferência/recadastro)? O ERP traz o mesmo nome em
 * dois códigos?
 *
 * Regras:
 *  - Não grava nada e NUNCA funde/nomeia sozinho (RN-SELL-1): só aponta evidência; quem decide
 *    é o dono, pelos fluxos já existentes (confirmar nome / "são a mesma pessoa?").
 *  - "Parado" é fato (dias desde a última venda); "desligado" NÃO é afirmado — o PDV não sabe.
 *  - Par antigo→novo por tempo+loja é HIPÓTESE (`possivel`); só vira `forte` com o MESMO nome
 *    vindo do ERP (retail_erp_seller_sales.seller_name) nos dois códigos.
 *  - Volume alto por dia é sinal de caixa compartilhado, não de pessoa (limiar NÃO calibrado).
 *  - Mesma chave de código da pendência (`unidentified`): vendedor_codigo, senão vendedor.
 *  - Tudo por organization_id.
 */
import db from "./db.js";
import { SellerIdentityContext, normalizeAlias } from "./RetailSellerIdentityService.js";

export const AUDIT_INACTIVE_DAYS = 45;
const HANDOFF_BEFORE_DAYS = 14;
const HANDOFF_AFTER_DAYS = 45;
const SHARED_BOX_PER_DAY = 25; // vendas por dia com venda; NÃO calibrado
const MAX_CANDIDATES = 3;

const dayNum = (iso: string) => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000);
const isoToday = () => new Date().toISOString().slice(0, 10);
const TEST_CODE = /^(0+|1+|9+|123456|654321|987654|456789)$/;

export type CodeAuditRow = {
  matricula: string;
  identified: boolean;
  name: string | null;
  erpNames: string[];
  sales: number;
  activeDays: number;
  firstSale: string;
  lastSale: string;
  daysSinceLast: number;
  status: "ativo" | "parado";
  stores: Array<{ filial: string; storeName: string | null; sales: number; firstSale: string; lastSale: string }>;
  salesPerActiveDay: number;
  flags: { sharedBoxSuspect: boolean; testPattern: boolean };
  successors: Array<{ matricula: string; name: string | null; filial: string; gapDays: number; evidence: "forte" | "possivel"; why: string }>;
};

export class RetailSellerCodeAuditService {
  static audit(orgId: string, opts: { asOf?: string; inactiveDays?: number } = {}) {
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.asOf || "")) ? String(opts.asOf) : isoToday();
    const inactiveDays = Math.max(1, Math.min(365, Number(opts.inactiveDays) || AUDIT_INACTIVE_DAYS));
    const today = dayNum(asOf);

    const lines = db.prepare(
      `SELECT COALESCE(NULLIF(vendedor_codigo, ''), vendedor) AS m, filial, COUNT(*) AS n,
              COUNT(DISTINCT sale_date) AS days, MIN(sale_date) AS first_sale, MAX(sale_date) AS last_sale
         FROM retail_pdv_sales
        WHERE organization_id = ? AND COALESCE(NULLIF(vendedor_codigo, ''), vendedor, '') <> '' AND sale_date <= ?
        GROUP BY m, filial`
    ).all(orgId, asOf) as any[];

    const storeName = new Map<string, string>();
    for (const s of db.prepare(`SELECT code, name FROM retail_stores WHERE organization_id = ? AND code IS NOT NULL`).all(orgId) as any[]) storeName.set(String(s.code), s.name);

    const erpNames = new Map<string, Set<string>>();
    for (const r of db.prepare(`SELECT matricula, seller_name FROM retail_erp_seller_sales WHERE organization_id = ? AND seller_name IS NOT NULL AND TRIM(seller_name) <> '' AND matricula NOT LIKE 'nome:%' GROUP BY matricula, seller_name`).all(orgId) as any[]) {
      const k = String(r.matricula);
      if (!erpNames.has(k)) erpNames.set(k, new Set());
      erpNames.get(k)!.add(String(r.seller_name).trim());
    }

    const ctx = SellerIdentityContext.load(orgId);
    const byCode = new Map<string, CodeAuditRow>();
    for (const l of lines) {
      const m = String(l.m);
      let row = byCode.get(m);
      if (!row) {
        const res = ctx.resolve({ matricula: m });
        const identified = res.status === "identified" && !!res.seller?.name;
        row = {
          matricula: m, identified, name: identified ? res.seller!.name : null,
          erpNames: [...(erpNames.get(m) || [])], sales: 0, activeDays: 0,
          firstSale: l.first_sale, lastSale: l.last_sale, daysSinceLast: 0, status: "ativo",
          stores: [], salesPerActiveDay: 0, flags: { sharedBoxSuspect: false, testPattern: TEST_CODE.test(m) }, successors: [],
        };
        byCode.set(m, row);
      }
      row.sales += Number(l.n);
      row.activeDays += Number(l.days); // soma por loja: dia em 2 lojas conta 2 (aproximação conservadora p/ "por dia")
      if (l.first_sale < row.firstSale) row.firstSale = l.first_sale;
      if (l.last_sale > row.lastSale) row.lastSale = l.last_sale;
      row.stores.push({ filial: String(l.filial), storeName: storeName.get(String(l.filial)) || null, sales: Number(l.n), firstSale: l.first_sale, lastSale: l.last_sale });
    }
    const all = [...byCode.values()];
    for (const r of all) {
      r.daysSinceLast = today - dayNum(r.lastSale);
      r.status = r.daysSinceLast > inactiveDays ? "parado" : "ativo";
      r.salesPerActiveDay = r.activeDays ? Math.round((r.sales / r.activeDays) * 10) / 10 : 0;
      r.flags.sharedBoxSuspect = r.salesPerActiveDay >= SHARED_BOX_PER_DAY;
      r.stores.sort((a, b) => b.sales - a.sales);
    }

    // Pares antigo→novo: B é código NOVO (1ª venda perto/depois do fim de A) e começou na MESMA loja.
    const nameKeys = (r: CodeAuditRow) => new Set([...(r.name ? [normalizeAlias(r.name)] : []), ...r.erpNames.map(normalizeAlias)].filter(Boolean));
    for (const a of all) {
      if (a.status !== "parado") continue;
      const aEnd = dayNum(a.lastSale), aKeys = nameKeys(a);
      const found: CodeAuditRow["successors"] = [];
      for (const b of all) {
        if (b.matricula === a.matricula) continue;
        if (dayNum(b.firstSale) < aEnd - HANDOFF_BEFORE_DAYS || dayNum(b.firstSale) <= dayNum(a.firstSale)) continue; // B já existia: não é código novo
        const bKeys = nameKeys(b);
        const sameName = [...aKeys].some((k) => bKeys.has(k));
        for (const sa of a.stores) {
          const sb = b.stores.find((x) => x.filial === sa.filial);
          if (!sb) continue;
          const gap = dayNum(sb.firstSale) - dayNum(sa.lastSale);
          if (gap < -HANDOFF_BEFORE_DAYS || gap > HANDOFF_AFTER_DAYS) continue;
          found.push({
            matricula: b.matricula, name: b.name, filial: sa.filial, gapDays: gap,
            evidence: sameName ? "forte" : "possivel",
            why: sameName ? "mesmo nome nos dois códigos (ERP/cadastro) e começou na mesma loja perto do fim do outro" : "começou na mesma loja perto do fim do outro código — só tempo e loja, sem nome em comum",
          });
          break;
        }
      }
      found.sort((x, y) => (x.evidence === y.evidence ? Math.abs(x.gapDays) - Math.abs(y.gapDays) : x.evidence === "forte" ? -1 : 1));
      a.successors = found.slice(0, MAX_CANDIDATES);
    }

    // Mesmo nome em códigos diferentes (cadastro + nome do ERP).
    const byName = new Map<string, Set<string>>();
    for (const r of all) for (const k of nameKeys(r)) { if (!byName.has(k)) byName.set(k, new Set()); byName.get(k)!.add(r.matricula); }
    const sameNameGroups = [...byName.entries()].filter(([, s]) => s.size > 1).map(([name, s]) => ({ name, matriculas: [...s] }));

    const pending = all.filter((r) => !r.identified).sort((x, y) => y.sales - x.sales);
    return {
      asOf, inactiveDays, readOnly: true,
      summary: {
        pending: pending.length,
        pendingActive: pending.filter((r) => r.status === "ativo").length,
        pendingStopped: pending.filter((r) => r.status === "parado").length,
        withSuccessor: pending.filter((r) => r.successors.length > 0).length,
        sharedBoxSuspects: pending.filter((r) => r.flags.sharedBoxSuspect).length,
        testPatterns: pending.filter((r) => r.flags.testPattern).length,
        erpNamesAvailable: erpNames.size > 0,
      },
      pending,
      sameNameGroups,
      notes: [
        "Parado = sem venda no período; não prova desligamento (pode ser férias, afastamento ou código antigo).",
        "Par antigo→novo só por tempo e loja é hipótese; confirme com o RH/gerente antes de unir.",
        ...(erpNames.size === 0 ? ["O ERP ainda não trouxe nomes de vendedores: sem eles não há como marcar par 'forte' nem achar o mesmo nome em dois códigos."] : []),
        "Nada foi alterado: confirmar nome ou unir continua sendo decisão sua nos cartões existentes.",
      ],
    };
  }
}
