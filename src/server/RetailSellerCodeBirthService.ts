/**
 * Códigos de vendedor SEM NOME — escolher o código REAL no cadastro e avisar quando um código
 * novo começa a vender (P1 + P2 de docs/retail/ANALISE-CODIGOS-VENDEDOR-SEM-NOME.md).
 *
 * Por que existe: a Alterdata manda só o CÓDIGO do vendedor em cada venda, nunca o nome. O
 * ZapFlow sugeria no cadastro a "próxima matrícula" (maior código da loja + 1) — um PALPITE no
 * espaço de códigos da Alterdata. A pessoa ficava cadastrada num código que nunca vendia, o
 * código real vendia "sem nome", e o lançamento manual por nome somava em dobro (caso BANGU:
 * cadastro 10830002/03/04, PDV vendendo 10830001/05/06).
 *
 * Regras:
 *  - NUNCA inventa código: o cadastro escolhe entre os códigos que DE FATO venderam naquela loja
 *    (`candidatesForStore`); digitar à mão continua possível, mas a tela avisa quando o código
 *    nunca apareceu no caixa da loja.
 *  - NUNCA nomeia nem liga sozinho: "parece ser X" é a hipótese da auditoria (lançamento manual
 *    diário batendo com o PDV — RetailSellerCodeAuditService); quem decide é uma pessoa.
 *  - Código NOVO = 1ª venda NAQUELA loja nos últimos `NEW_CODE_DAYS` dias e ainda sem nome. Vira
 *    aviso da loja (`retail_seller_code_new` em business_signals, publicado pelo
 *    RetailOpsSignalPublisher) e some sozinho quando o código ganha nome.
 *  - Mesma chave de código da pendência (`vendedor_codigo`, senão `vendedor`). Tudo por org.
 */
import db from "./db.js";
import { RetailSellerCodeAuditService } from "./RetailSellerCodeAuditService.js";
import { normalizeAlias } from "./RetailSellerIdentityService.js";

export const NEW_CODE_DAYS = 30;

const dayNum = (iso: string) => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000);
const isoToday = () => new Date().toISOString().slice(0, 10);

export type CodeCandidate = {
  matricula: string; sales: number; firstSale: string; lastSale: string; daysSinceLast: number;
  status: "ativo" | "parado"; likelyPerson: { name: string; sellerId: string | null; why: string } | null;
  sharedBoxSuspect: boolean; testPattern: boolean;
};

export class RetailSellerCodeBirthService {
  /** P1 — códigos SEM NOME que venderam no caixa desta loja: o cadastro escolhe o código real daqui. */
  static candidatesForStore(orgId: string, storeId: string, opts: { asOf?: string } = {}): any {
    const store = db.prepare(`SELECT id, name, code FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId) as any;
    if (!store) throw new Error("Loja não encontrada.");
    const filial = String(store.code || "").trim();
    if (!filial) return { storeId: store.id, storeName: store.name, filial: null, candidates: [], note: "A loja não tem código de filial: não dá para saber quais códigos venderam nela." };
    const audit = RetailSellerCodeAuditService.audit(orgId, { asOf: opts.asOf });
    const today = dayNum(audit.asOf);
    const candidates: CodeCandidate[] = [];
    for (const r of audit.pending) {
      const st = r.stores.find((s) => s.filial === filial);
      if (!st) continue;
      const daysSinceLast = today - dayNum(st.lastSale);
      candidates.push({
        matricula: r.matricula, sales: st.sales, firstSale: st.firstSale, lastSale: st.lastSale, daysSinceLast,
        status: daysSinceLast > audit.inactiveDays ? "parado" : "ativo",
        likelyPerson: r.likelyPerson ? { name: r.likelyPerson.name, sellerId: r.likelyPerson.sellerId, why: r.likelyPerson.why } : null,
        sharedBoxSuspect: r.flags.sharedBoxSuspect, testPattern: r.flags.testPattern,
      });
    }
    // Vendendo agora primeiro; dentro de cada grupo, a venda mais recente primeiro.
    candidates.sort((a, b) => (a.status === b.status ? b.lastSale.localeCompare(a.lastSale) : a.status === "ativo" ? -1 : 1));
    return { storeId: store.id, storeName: store.name, filial, asOf: audit.asOf, inactiveDays: audit.inactiveDays, candidates };
  }

  /** O código já apareceu vendendo no caixa desta loja? (aviso do cadastro quando a matrícula é digitada à mão) */
  static seenInStore(orgId: string, storeId: string, matricula: string): boolean {
    const store = db.prepare(`SELECT code FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId) as any;
    const filial = String(store?.code || "").trim();
    const m = String(matricula || "").trim();
    if (!filial || !m) return false;
    return !!db.prepare(
      `SELECT 1 FROM retail_pdv_sales WHERE organization_id = ? AND filial = ? AND COALESCE(NULLIF(vendedor_codigo, ''), vendedor) = ? LIMIT 1`
    ).get(orgId, filial, m);
  }

  /**
   * P2 — códigos NOVOS sem nome, por loja: 1ª venda naquela loja há no máximo `NEW_CODE_DAYS` dias.
   * Loja sem cadastro ativo para a filial fica de fora (é assunto da auditoria de filial, não deste aviso).
   */
  static newCodes(orgId: string, asOf?: string): Array<{
    storeId: string; storeName: string; filial: string; matricula: string; firstSale: string; lastSale: string; sales: number;
    likelyPerson: { name: string; sellerId: string | null; why: string } | null; sharedBoxSuspect: boolean; testPattern: boolean;
  }> {
    const ref = /^\d{4}-\d{2}-\d{2}$/.test(String(asOf || "")) ? String(asOf) : isoToday();
    const stores = new Map<string, { id: string; name: string }>();
    for (const s of db.prepare(`SELECT id, name, code FROM retail_stores WHERE organization_id = ? AND active = 1 AND code IS NOT NULL AND TRIM(code) <> ''`).all(orgId) as any[]) stores.set(String(s.code).trim(), { id: s.id, name: s.name });
    if (!stores.size) return [];
    const audit = RetailSellerCodeAuditService.audit(orgId, { asOf: ref });
    const today = dayNum(audit.asOf);
    const out: ReturnType<typeof RetailSellerCodeBirthService.newCodes> = [];
    for (const r of audit.pending) {
      for (const st of r.stores) {
        const store = stores.get(st.filial);
        if (!store) continue;
        if (today - dayNum(st.firstSale) > NEW_CODE_DAYS) continue;
        out.push({
          storeId: store.id, storeName: store.name, filial: st.filial, matricula: r.matricula,
          firstSale: st.firstSale, lastSale: st.lastSale, sales: st.sales,
          likelyPerson: r.likelyPerson ? { name: r.likelyPerson.name, sellerId: r.likelyPerson.sellerId, why: r.likelyPerson.why } : null,
          sharedBoxSuspect: r.flags.sharedBoxSuspect, testPattern: r.flags.testPattern,
        });
      }
    }
    return out.sort((a, b) => a.storeName.localeCompare(b.storeName) || b.firstSale.localeCompare(a.firstSale));
  }

  /**
   * Guarda do "dar nome": já existe pessoa ATIVA com esse nome sob OUTRA matrícula? Criar outra
   * linha duplicaria a pessoa (a venda do código e a do lançamento manual somariam separadas).
   */
  static sameNameSeller(orgId: string, name: string, exceptMatricula: string): { id: string; name: string; matricula: string } | null {
    const k = normalizeAlias(name);
    if (!k) return null;
    const rows = db.prepare(
      `SELECT id, name, matricula FROM retail_sellers
        WHERE organization_id = ? AND active = 1 AND merged_into_seller_id IS NULL AND name IS NOT NULL AND TRIM(name) <> '' AND matricula <> ?`
    ).all(orgId, String(exceptMatricula || "")) as any[];
    const hit = rows.find((r) => normalizeAlias(r.name) === k);
    return hit ? { id: hit.id, name: hit.name, matricula: String(hit.matricula) } : null;
  }
}

export default RetailSellerCodeBirthService;
