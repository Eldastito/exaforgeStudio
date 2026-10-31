/**
 * RetailSellerLinkageAuditService — diagnóstico SOMENTE LEITURA das LIGAÇÕES de cada código de vendedor.
 * Responde duas perguntas do dono:
 *  1) Os códigos sem nome estão ligados às mesmas coisas que os códigos COM nome (vendas do PDV, vendas do ERP,
 *     lançamento manual/ranking, cadastro, vínculo de loja, meta, base de comissão)? O que falta em cada um?
 *  2) Há vendedor CADASTRADO cuja matrícula nunca vendeu no PDV/ERP (matrícula "fantasma" — inventada pelo ZapFlow ou
 *     digitada à mão), mas que tem venda manual? Se sim, qual código sem nome provavelmente é dele?
 *
 * Regras:
 *  - Não grava nada e NUNCA vincula/funde/nomeia (RN-SELL-1): só mostra evidência; quem decide é o dono.
 *  - "Falta" é relativo ao que a MAIORIA (>= 50%) dos códigos com nome e com venda recente tem — não uma lista fixa.
 *  - Código fantasma é FATO (nunca vendeu no PDV/ERP), mas "é dele" é HIPÓTESE (reaproveita o `likelyPerson` da auditoria).
 *  - "Base de comissão" = o código aparece em `salesBySellerStore` no mês de referência ou no anterior (mesma função que paga).
 *  - Tudo por organization_id.
 */
import db from "./db.js";
import { SellerIdentityContext, normalizeAlias } from "./RetailSellerIdentityService.js";
import { RetailSellerCodeAuditService } from "./RetailSellerCodeAuditService.js";
import { RetailCommissionService } from "./RetailCommissionService.js";

const RECENT_DAYS = 90;
const MAJORITY = 0.5;
const MAX_LISTED = 80;

const isoToday = () => new Date().toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) + n * 86400000).toISOString().slice(0, 10);
const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;
const prevMonthStart = (iso: string) => { const y = +iso.slice(0, 4), m = +iso.slice(5, 7); return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`; };
const lastDayOf = (start: string) => { const y = +start.slice(0, 4), m = +start.slice(5, 7); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const PLACEHOLDER = /^LV-/i;

export const LINK_KEYS = ["cadastro", "pdv", "erp", "manual", "loja", "meta", "comissao"] as const;
export type LinkKey = typeof LINK_KEYS[number];
export const LINK_LABEL: Record<LinkKey, string> = {
  cadastro: "tem nome no cadastro", pdv: "vendas no PDV", erp: "vendas vindas do ERP", manual: "lançamento manual (ranking)",
  loja: "vínculo com loja", meta: "meta semanal", comissao: "entra na base de comissão",
};

export type LinkageRow = {
  matricula: string;
  named: boolean;
  name: string | null;
  recent: boolean; // vendeu no PDV nos últimos 90 dias
  pdvSales: number;
  lastPdvSale: string | null;
  links: Record<LinkKey, boolean>;
  counts: { erpRows: number; manualRows: number; stores: number; quotas: number };
  lacks: LinkKey[]; // o que a maioria dos códigos com nome tem e este não
};

export class RetailSellerLinkageAuditService {
  static report(orgId: string, opts: { asOf?: string } = {}) {
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.asOf || "")) ? String(opts.asOf) : isoToday();
    const recentFrom = addDays(asOf, -RECENT_DAYS);

    // ── fontes (uma consulta agregada por tabela; nenhuma por código) ──
    const pdv = new Map<string, { n: number; last: string }>();
    for (const r of db.prepare(
      `SELECT COALESCE(NULLIF(vendedor_codigo, ''), vendedor) AS m, COUNT(*) AS n, MAX(sale_date) AS last
         FROM retail_pdv_sales WHERE organization_id = ? AND COALESCE(NULLIF(vendedor_codigo, ''), vendedor, '') <> '' AND sale_date <= ? GROUP BY m`
    ).all(orgId, asOf) as any[]) pdv.set(String(r.m), { n: Number(r.n), last: String(r.last) });

    const erp = new Map<string, number>();
    for (const r of db.prepare(
      `SELECT matricula AS m, COUNT(*) AS n FROM retail_erp_seller_sales WHERE organization_id = ? AND matricula IS NOT NULL AND matricula <> '' AND matricula NOT LIKE 'nome:%' GROUP BY matricula`
    ).all(orgId) as any[]) erp.set(String(r.m), Number(r.n));

    const manual = new Map<string, number>();
    for (const r of db.prepare(
      `SELECT matricula AS m, COUNT(*) AS n FROM retail_seller_sales WHERE organization_id = ? AND matricula IS NOT NULL AND matricula <> '' GROUP BY matricula`
    ).all(orgId) as any[]) manual.set(String(r.m), Number(r.n));

    const quotas = new Map<string, number>();
    for (const r of db.prepare(
      `SELECT seller_key AS k, COUNT(*) AS n FROM retail_seller_quotas WHERE organization_id = ? AND seller_key LIKE 'mat:%' GROUP BY seller_key`
    ).all(orgId) as any[]) quotas.set(String(r.k).slice(4), Number(r.n));

    const sellers = db.prepare(
      `SELECT id, matricula, name, active, merged_into_seller_id FROM retail_sellers WHERE organization_id = ?`
    ).all(orgId) as any[];
    const sellerByMat = new Map<string, any>(sellers.map((s) => [String(s.matricula), s]));

    const storeCount = new Map<string, number>();
    for (const r of db.prepare(
      `SELECT seller_id, COUNT(*) AS n FROM retail_seller_store_assignments WHERE organization_id = ? AND active = 1 GROUP BY seller_id`
    ).all(orgId) as any[]) storeCount.set(String(r.seller_id), Number(r.n));

    // alias de matrícula → pessoa (um código ligado a outra pessoa por apelido herda os vínculos dela)
    const aliasSeller = new Map<string, string>();
    for (const r of db.prepare(`SELECT alias, alias_norm, seller_id FROM retail_seller_aliases WHERE organization_id = ? AND kind = 'matricula'`).all(orgId) as any[]) {
      aliasSeller.set(String(r.alias), String(r.seller_id)); aliasSeller.set(String(r.alias_norm), String(r.seller_id));
    }

    // base de comissão: mesma função que paga (mês de referência + anterior)
    const commissionCodes = new Set<string>();
    for (const start of [monthStart(asOf), prevMonthStart(asOf)]) {
      try {
        for (const r of RetailCommissionService.salesBySellerStore(orgId, start, start === monthStart(asOf) ? asOf : lastDayOf(start))) {
          if (r.matricula) commissionCodes.add(String(r.matricula));
          for (const k of r.aliasKeys || []) if (String(k).startsWith("mat:")) commissionCodes.add(String(k).slice(4));
        }
      } catch { /* leitura best-effort: sem a base de comissão, a coluna fica falsa e o relatório diz isso nas notas */ }
    }

    // ── um registro por código visto em QUALQUER fonte ──
    const ctx = SellerIdentityContext.load(orgId);
    const codes = new Set<string>([...pdv.keys(), ...erp.keys(), ...manual.keys(), ...quotas.keys(), ...sellerByMat.keys()]);
    const rows: LinkageRow[] = [];
    for (const m of codes) {
      const res = ctx.resolve({ matricula: m });
      const named = res.status === "identified" && !!res.seller?.name;
      const reg = sellerByMat.get(m);
      const sellerId = (named && res.seller?.id) || reg?.id || aliasSeller.get(m) || aliasSeller.get(normalizeAlias(m)) || null;
      const p = pdv.get(m);
      const stores = sellerId ? storeCount.get(String(sellerId)) || 0 : 0;
      rows.push({
        matricula: m, named, name: named ? res.seller!.name : null,
        recent: !!p && p.last >= recentFrom, pdvSales: p?.n || 0, lastPdvSale: p?.last || null,
        links: {
          cadastro: named, pdv: !!p, erp: erp.has(m), manual: manual.has(m), loja: stores > 0, meta: quotas.has(m), comissao: commissionCodes.has(m),
        },
        counts: { erpRows: erp.get(m) || 0, manualRows: manual.get(m) || 0, stores, quotas: quotas.get(m) || 0 },
        lacks: [],
      });
    }

    // ── comparação: com nome × sem nome, entre os que venderam no PDV recentemente ──
    const active = rows.filter((r) => r.recent);
    const namedActive = active.filter((r) => r.named);
    const unnamedActive = active.filter((r) => !r.named);
    const pct = (group: LinkageRow[], k: LinkKey) => (group.length ? Math.round((group.filter((r) => r.links[k]).length / group.length) * 1000) / 10 : null);
    const groupStats = (group: LinkageRow[]) => ({ codes: group.length, withLink: Object.fromEntries(LINK_KEYS.map((k) => [k, group.filter((r) => r.links[k]).length])) as Record<LinkKey, number>, pct: Object.fromEntries(LINK_KEYS.map((k) => [k, pct(group, k)])) as Record<LinkKey, number | null> });
    const baseline = LINK_KEYS.filter((k) => k !== "cadastro" && namedActive.length > 0 && (pct(namedActive, k) as number) >= MAJORITY * 100);
    for (const r of rows) if (!r.named) r.lacks = baseline.filter((k) => !r.links[k]);

    // ── fantasmas: cadastrado, ativo, nunca vendeu no PDV/ERP ──
    const pending = RetailSellerCodeAuditService.audit(orgId, { asOf }).pending;
    const personToCodes = new Map<string, Array<{ matricula: string; matchDays: number; pdvDays: number }>>();
    for (const row of pending) {
      const lp = row.likelyPerson; if (!lp) continue;
      const key = lp.sellerId || normalizeAlias(lp.name);
      if (!personToCodes.has(key)) personToCodes.set(key, []);
      personToCodes.get(key)!.push({ matricula: row.matricula, matchDays: lp.matchDays, pdvDays: lp.pdvDays });
    }
    const manualByPerson = db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(valor), 0) AS v, MAX(sale_date) AS last FROM retail_seller_sales
        WHERE organization_id = ? AND (matricula = ? OR LOWER(TRIM(seller_name)) = ?)`
    );
    const ghosts: Array<{ sellerId: string; name: string; matricula: string; placeholder: boolean; manualRows: number; manualTotal: number; lastManual: string | null; probableCodes: Array<{ matricula: string; matchDays: number; pdvDays: number }> }> = [];
    for (const s of sellers) {
      if (!s.active || s.merged_into_seller_id || !s.name || !String(s.name).trim()) continue;
      const m = String(s.matricula);
      if (pdv.has(m) || erp.has(m)) continue;
      // algum apelido de matrícula dessa pessoa já vendeu? então não é fantasma (ela tem código real ligado)
      const aliasCodes = [...aliasSeller.entries()].filter(([, id]) => id === s.id).map(([a]) => a);
      if (aliasCodes.some((a) => pdv.has(a) || erp.has(a))) continue;
      const man = manualByPerson.get(orgId, m, String(s.name).trim().toLowerCase()) as any;
      ghosts.push({
        sellerId: String(s.id), name: String(s.name), matricula: m, placeholder: PLACEHOLDER.test(m),
        manualRows: Number(man?.n) || 0, manualTotal: Math.round((Number(man?.v) || 0) * 100) / 100, lastManual: man?.last || null,
        probableCodes: personToCodes.get(String(s.id)) || personToCodes.get(normalizeAlias(String(s.name))) || [],
      });
    }
    ghosts.sort((a, b) => b.manualTotal - a.manualTotal);

    const unnamedCodes = rows.filter((r) => !r.named && r.pdvSales > 0).sort((a, b) => b.pdvSales - a.pdvSales);
    const incomplete = unnamedCodes.filter((r) => r.lacks.length > 0);
    return {
      asOf, recentDays: RECENT_DAYS, readOnly: true,
      summary: {
        namedActive: namedActive.length, unnamedActive: unnamedActive.length, unnamedTotal: unnamedCodes.length,
        unnamedMissingLinks: incomplete.length, ghosts: ghosts.length, ghostsWithManual: ghosts.filter((g) => g.manualRows > 0).length,
        ghostsWithProbableCode: ghosts.filter((g) => g.probableCodes.length > 0).length, placeholders: ghosts.filter((g) => g.placeholder).length,
        commissionBaseAvailable: commissionCodes.size > 0,
      },
      baseline: baseline.map((k) => ({ key: k, label: LINK_LABEL[k], namedPct: pct(namedActive, k) })),
      groups: { named: groupStats(namedActive), unnamed: groupStats(unnamedActive) },
      unnamed: unnamedCodes.slice(0, MAX_LISTED),
      ghosts: ghosts.slice(0, MAX_LISTED),
      notes: [
        "Só leitura: nada foi vinculado, fundido ou nomeado. Quem decide é o dono, nos cartões existentes.",
        "\"Falta\" = algo que a maioria dos códigos com nome e com venda recente tem. Código sem nome não ter cadastro/loja/meta é esperado — o ponto é se as VENDAS dele chegam ao ranking e à comissão.",
        "Matrícula fantasma = pessoa cadastrada cuja matrícula nunca vendeu no PDV/ERP. \"Código provável\" é hipótese (valor manual do dia ≈ valor do PDV); confirme com o gerente.",
        ...(commissionCodes.size === 0 ? ["Não foi possível ler a base de comissão do período (ou não há vendas nele): a coluna \"entra na base de comissão\" não é conclusiva."] : []),
      ],
    };
  }
}
