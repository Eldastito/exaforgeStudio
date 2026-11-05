/**
 * P3 — ligação SEGURA de quem foi cadastrado SEM o código do caixa (docs/retail/ANALISE-CODIGOS-VENDEDOR-SEM-NOME.md).
 *
 * "Sem código" = pessoa ativa cujo(s) código(s) NUNCA aparece(m) em venda do PDV/ERP:
 *  - placeholder `LV-xxxxxx` criado pelo Atendimento de Loja quando o lojista não sabia a matrícula; ou
 *  - matrícula "fantasma" (palpite do antigo "próxima matrícula", ex.: 10830002 na BANGU) que nunca vendeu.
 * Quando um código SEM NOME passa a vender numa loja dessa pessoa e as vendas diárias dele batem com o que
 * se sabe da pessoa — o lançamento manual do gerente (por nome/matrícula) e/ou a venda DECLARADA no
 * Atendimento de Loja — o ZapFlow PROPÕE: "o código X parece ser de Fulano". Só uma pessoa confirma; a
 * confirmação liga o código como APELIDO de matrícula (RetailSellerIdentityService.linkMatricula —
 * reversível, não cria vendedor, não troca a matrícula principal).
 *
 * Regras (mesmas tolerâncias da auditoria `RetailSellerCodeAuditService.fillLikelyPerson`, para as duas
 * sugestões não se contradizerem):
 *  - dia "bate" = valor do PDV do código e o valor da pessoa no dia diferem até ±10% (mín. R$ 5);
 *  - propõe só com ≥ 5 dias batendo E ≥ 60% dos dias em que o código vendeu;
 *  - empate (2º colocado ≥ 70% do 1º), por código OU por pessoa → não propõe ninguém;
 *  - exige LOJA em comum (o código vendeu numa loja onde a pessoa está lotada, atendeu ou foi lançada);
 *  - janela de 180 dias; só código ATIVO (vendeu nos últimos 45 dias).
 *  - SOMENTE LEITURA: nada é gravado aqui. Tudo por organization_id.
 */
import db from "./db.js";
import { RetailSellerCodeAuditService } from "./RetailSellerCodeAuditService.js";
import { normalizeAlias } from "./RetailSellerIdentityService.js";

export const PLACEHOLDER_CODE = /^LV-/i;
const LOOKBACK_DAYS = 180;
const MIN_MATCH_DAYS = 5;
const MIN_MATCH_SHARE = 0.6;
const TIE_RATIO = 0.7;

const dayNum = (iso: string) => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000);
const isoOf = (n: number) => new Date(n * 86400000).toISOString().slice(0, 10);
const isoToday = () => new Date().toISOString().slice(0, 10);
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(5, 0.1 * Math.max(a, b));

export type CodelessPerson = {
  sellerId: string; name: string; matricula: string; placeholder: boolean; codes: string[];
  storeIds: string[]; storeNames: string[];
};
export type CodeProposal = {
  sellerId: string; name: string; matricula: string; placeholder: boolean;
  code: string; storeIds: string[]; storeNames: string[];
  matchDays: number; pdvDays: number; sources: Array<"manual" | "atendimento">; why: string;
};

export class RetailSellerCodeProposalService {
  /** Pessoas ativas e nomeadas cujos códigos nunca venderam no PDV/ERP (inclui o placeholder LV- do Atendimento de Loja). */
  static codelessPeople(orgId: string): CodelessPerson[] {
    const sellers = db.prepare(
      `SELECT id, name, matricula FROM retail_sellers
        WHERE organization_id = ? AND active = 1 AND merged_into_seller_id IS NULL AND name IS NOT NULL AND TRIM(name) <> ''`
    ).all(orgId) as any[];
    if (!sellers.length) return [];
    const aliasRows = db.prepare(`SELECT seller_id, alias, kind FROM retail_seller_aliases WHERE organization_id = ?`).all(orgId) as any[];
    const codesOf = new Map<string, string[]>();
    for (const a of aliasRows) {
      if (a.kind !== "matricula" && a.kind !== "cai_usuario") continue;
      if (!codesOf.has(a.seller_id)) codesOf.set(a.seller_id, []);
      codesOf.get(a.seller_id)!.push(String(a.alias).trim());
    }
    const sold = new Set<string>();
    for (const r of db.prepare(`SELECT DISTINCT COALESCE(NULLIF(vendedor_codigo, ''), vendedor) AS m FROM retail_pdv_sales WHERE organization_id = ? AND COALESCE(NULLIF(vendedor_codigo, ''), vendedor, '') <> ''`).all(orgId) as any[]) sold.add(String(r.m));
    for (const r of db.prepare(`SELECT DISTINCT matricula AS m FROM retail_erp_seller_sales WHERE organization_id = ? AND matricula IS NOT NULL AND matricula <> ''`).all(orgId) as any[]) sold.add(String(r.m));

    const storeName = new Map<string, string>();
    for (const s of db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ?`).all(orgId) as any[]) storeName.set(s.id, s.name);
    const assigned = db.prepare(`SELECT DISTINCT store_id FROM retail_seller_store_assignments WHERE organization_id = ? AND seller_id = ? AND active = 1`);
    const attended = db.prepare(`SELECT DISTINCT store_id FROM retail_floor_attendances WHERE organization_id = ? AND seller_id = ?`);

    const out: CodelessPerson[] = [];
    for (const s of sellers) {
      const codes = [String(s.matricula), ...(codesOf.get(s.id) || [])].filter(Boolean);
      if (codes.some((c) => !PLACEHOLDER_CODE.test(c) && sold.has(c))) continue; // já tem código que vende
      const stores = new Set<string>();
      for (const r of assigned.all(orgId, s.id) as any[]) stores.add(r.store_id);
      for (const r of attended.all(orgId, s.id) as any[]) stores.add(r.store_id);
      out.push({
        sellerId: s.id, name: s.name, matricula: String(s.matricula), placeholder: PLACEHOLDER_CODE.test(String(s.matricula)), codes,
        storeIds: [...stores], storeNames: [...stores].map((id) => storeName.get(id) || id),
      });
    }
    return out;
  }

  /** Propostas código→pessoa para quem está sem código. Somente leitura. */
  static proposals(orgId: string, opts: { asOf?: string } = {}): CodeProposal[] {
    return this.report(orgId, opts).people.flatMap((p) => (p.proposal ? [p.proposal] : []));
  }

  /** Pessoas sem código + a proposta de cada uma (ou null). Alimenta o cartão da rede e o Atendimento de Loja. */
  static report(orgId: string, opts: { asOf?: string } = {}): { asOf: string; people: Array<CodelessPerson & { proposal: CodeProposal | null }> } {
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.asOf || "")) ? String(opts.asOf) : isoToday();
    const people = this.codelessPeople(orgId);
    if (!people.length) return { asOf, people: [] };
    const since = isoOf(dayNum(asOf) - LOOKBACK_DAYS);

    // Códigos SEM NOME que vendem agora (auditoria) e as lojas (filiais) de cada um.
    const audit = RetailSellerCodeAuditService.audit(orgId, { asOf });
    const storeByCode = new Map<string, { id: string; name: string }>();
    for (const s of db.prepare(`SELECT id, name, code FROM retail_stores WHERE organization_id = ? AND code IS NOT NULL AND TRIM(code) <> ''`).all(orgId) as any[]) storeByCode.set(String(s.code).trim(), { id: s.id, name: s.name });
    const codes = audit.pending.filter((r) => r.status === "ativo").map((r) => ({
      code: r.matricula,
      stores: r.stores.map((st) => storeByCode.get(st.filial)).filter(Boolean) as Array<{ id: string; name: string }>,
    })).filter((c) => c.stores.length > 0);
    if (!codes.length) return { asOf, people: people.map((p) => ({ ...p, proposal: null })) };

    const pdvStmt = db.prepare(
      `SELECT sale_date AS d, SUM(valor) AS v FROM retail_pdv_sales
        WHERE organization_id = ? AND COALESCE(NULLIF(vendedor_codigo, ''), vendedor) = ? AND COALESCE(status, 'N') <> 'C'
          AND sale_date BETWEEN ? AND ? GROUP BY sale_date`
    );
    const pdvByCode = new Map<string, Map<string, number>>();
    for (const c of codes) {
      const m = new Map<string, number>();
      for (const r of pdvStmt.all(orgId, c.code, since, asOf) as any[]) if (Number(r.v) > 0) m.set(String(r.d), Number(r.v));
      pdvByCode.set(c.code, m);
    }

    // O que se sabe de cada pessoa por dia: lançamento manual (nome/matrícula) e venda declarada no Atendimento.
    const nameAliases = new Map<string, string[]>();
    for (const a of db.prepare(`SELECT seller_id, alias_norm FROM retail_seller_aliases WHERE organization_id = ? AND kind = 'name'`).all(orgId) as any[]) {
      if (!nameAliases.has(a.seller_id)) nameAliases.set(a.seller_id, []);
      nameAliases.get(a.seller_id)!.push(String(a.alias_norm));
    }
    const manualRows = db.prepare(
      `SELECT store_id, seller_name, matricula, sale_date AS d, SUM(valor) AS v FROM retail_seller_sales
        WHERE organization_id = ? AND sale_date BETWEEN ? AND ? GROUP BY store_id, LOWER(TRIM(seller_name)), matricula, sale_date`
    ).all(orgId, since, asOf) as any[];
    const floorStmt = db.prepare(
      `SELECT store_id, date(started_at) AS d, SUM(COALESCE(declared_value, 0)) AS v FROM retail_floor_attendances
        WHERE organization_id = ? AND seller_id = ? AND outcome = 'converted' AND date(started_at) BETWEEN ? AND ?
        GROUP BY store_id, date(started_at)`
    );

    type Score = { person: CodelessPerson; code: string; codeStores: Array<{ id: string; name: string }>; match: number; pdvDays: number; sources: Set<"manual" | "atendimento"> };
    const scores: Score[] = [];
    for (const p of people) {
      const names = new Set([normalizeAlias(p.name), ...(nameAliases.get(p.sellerId) || [])].filter(Boolean));
      const codeSet = new Set(p.codes);
      const manual = new Map<string, number>();
      const stores = new Set(p.storeIds);
      for (const r of manualRows) {
        const mine = (r.matricula && codeSet.has(String(r.matricula))) || names.has(normalizeAlias(r.seller_name));
        if (!mine) continue;
        manual.set(String(r.d), (manual.get(String(r.d)) || 0) + (Number(r.v) || 0));
        if (r.store_id) stores.add(r.store_id);
      }
      const floor = new Map<string, number>();
      for (const r of floorStmt.all(orgId, p.sellerId, since, asOf) as any[]) {
        floor.set(String(r.d), (floor.get(String(r.d)) || 0) + (Number(r.v) || 0));
        if (r.store_id) stores.add(r.store_id);
      }
      if (!manual.size && !floor.size) continue;
      for (const c of codes) {
        const codeStores = c.stores.filter((s) => stores.has(s.id));
        if (!codeStores.length) continue; // sem loja em comum: não propõe
        const pdv = pdvByCode.get(c.code)!;
        if (pdv.size < MIN_MATCH_DAYS) continue;
        let match = 0;
        const sources = new Set<"manual" | "atendimento">();
        for (const [d, v] of pdv) {
          const m = manual.get(d), f = floor.get(d);
          const byManual = m != null && m > 0 && close(v, m);
          const byFloor = f != null && f > 0 && close(v, f);
          if (byManual || byFloor) { match++; if (byManual) sources.add("manual"); if (byFloor) sources.add("atendimento"); }
        }
        if (match >= MIN_MATCH_DAYS && match / pdv.size >= MIN_MATCH_SHARE) scores.push({ person: p, code: c.code, codeStores, match, pdvDays: pdv.size, sources });
      }
    }

    // Sem empate: por código (duas pessoas parecidas) e por pessoa (dois códigos parecidos).
    const unique = (list: Score[]) => { const s = [...list].sort((a, b) => b.match - a.match); return s[0] && !(s[1] && s[1].match >= TIE_RATIO * s[0].match) ? s[0] : null; };
    const byCode = new Map<string, Score[]>(), byPerson = new Map<string, Score[]>();
    for (const s of scores) {
      if (!byCode.has(s.code)) byCode.set(s.code, []); byCode.get(s.code)!.push(s);
      if (!byPerson.has(s.person.sellerId)) byPerson.set(s.person.sellerId, []); byPerson.get(s.person.sellerId)!.push(s);
    }
    const chosen = new Map<string, CodeProposal>();
    for (const [sellerId, list] of byPerson) {
      const best = unique(list);
      if (!best || unique(byCode.get(best.code)!) !== best) continue;
      const src = [...best.sources];
      const label = src.length === 2 ? "o lançamento manual e a venda declarada no Atendimento de Loja" : src[0] === "manual" ? "o lançamento manual" : "a venda declarada no Atendimento de Loja";
      chosen.set(sellerId, {
        sellerId, name: best.person.name, matricula: best.person.matricula, placeholder: best.person.placeholder,
        code: best.code, storeIds: best.codeStores.map((s) => s.id), storeNames: best.codeStores.map((s) => s.name),
        matchDays: best.match, pdvDays: best.pdvDays, sources: src,
        why: `Em ${best.match} de ${best.pdvDays} dias em que o código ${best.code} vendeu, ${label} de ${best.person.name} tem valor parecido (±10%).`,
      });
    }
    return { asOf, people: people.map((p) => ({ ...p, proposal: chosen.get(p.sellerId) || null })) };
  }
}

export default RetailSellerCodeProposalService;
