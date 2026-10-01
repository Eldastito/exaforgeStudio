/**
 * RetailSellerDuplicateService — "esses dois são a mesma pessoa?" (PRD Fase 1, F1.1c).
 *
 * Não é tela de gestão: é uma PERGUNTA de um toque que aparece dentro da Retail Ops só quando o sistema
 * enxerga possível duplicidade e some quando resolvida. Regras duras:
 *  - NUNCA funde sozinho (RN-SELL-1): só sugere; quem decide é o dono (owner/admin) com um toque;
 *  - sugestão por NOME, em dois graus: `likely` (todas as palavras do nome mais curto estão no mais longo —
 *    "Eduardo" ⊂ "Eduardo Lázaro") e `check` (mesmo primeiro nome mas sobrenomes diferentes — "Vinícius Romão"
 *    × "Vinícius Nascimento": provavelmente PESSOAS DIFERENTES, pergunta assim mesmo porque é o erro mais caro);
 *  - "pessoas diferentes" é memorizado (`retail_seller_distinct_pairs`) e nunca mais pergunta;
 *  - "mesma pessoa" = fusão governada/reversível do `RetailSellerIdentityService` (unmerge desfaz); opcionalmente
 *    "cobrindo férias em outra loja": a lotação da duplicata NÃO vira permanente — vira cobertura com datas.
 * Tudo isolado por organization_id. Sem LLM.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { normalizeAlias, RetailSellerIdentityService } from "./RetailSellerIdentityService.js";

const MAX_SUGGESTIONS = 10;
const isoDay = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "")) ? String(v) : null);

type Row = { id: string; matricula: string; name: string; toks: string[]; stores: Array<{ id: string; name: string }> };

export type DuplicateSuggestion = {
  kind: "likely" | "check";
  a: { id: string; name: string; matricula: string; stores: string[] };
  b: { id: string; name: string; matricula: string; stores: string[] };
  suggestedIntoId: string;                 // a identidade "mais completa" (nome mais longo) é a canônica sugerida
  question: string;
};

const pairKey = (x: string, y: string) => (x < y ? [x, y] : [y, x]) as [string, string];

export class RetailSellerDuplicateService {
  private static load(orgId: string): Row[] {
    const sellers = db.prepare(`SELECT id, matricula, name FROM retail_sellers WHERE organization_id = ? AND active = 1 AND merged_into_seller_id IS NULL AND COALESCE(name, '') <> ''`).all(orgId) as any[];
    const acts = db.prepare(
      `SELECT a.seller_id, st.id AS store_id, st.name AS store_name FROM retail_seller_store_assignments a
         JOIN retail_stores st ON st.organization_id = a.organization_id AND st.id = a.store_id
        WHERE a.organization_id = ? AND a.active = 1`,
    ).all(orgId) as any[];
    const byS = new Map<string, Array<{ id: string; name: string }>>();
    for (const x of acts) { if (!byS.has(x.seller_id)) byS.set(x.seller_id, []); byS.get(x.seller_id)!.push({ id: x.store_id, name: x.store_name }); }
    return sellers.map((s) => ({ id: s.id, matricula: String(s.matricula || ""), name: String(s.name), toks: normalizeAlias(s.name).split(" ").filter((t) => t.length >= 2), stores: byS.get(s.id) || [] }));
  }

  static suggestions(orgId: string): DuplicateSuggestion[] {
    const rows = this.load(orgId);
    const within = (a: Row, b: Row) => a.toks.every((t) => b.toks.includes(t));            // todas as palavras de a estão em b
    // Quem o nome curto também poderia ser: nomes MAIS LONGOS que o contêm.
    const supers = (r: Row) => rows.filter((z) => z.id !== r.id && z.toks.length > r.toks.length && within(r, z));
    // "Vinicius" cabe em "Vinicius Romão", "Vinicius Nascimento" e "MARCUS VINICIUS": são pessoas diferentes entre si,
    // então confirmar "mesma pessoa" com qualquer uma seria chute.
    const ambiguous = (r: Row) => { const c = supers(r); return c.some((a, i) => c.slice(i + 1).some((b) => !within(a, b) && !within(b, a))); };
    const distinct = new Set((db.prepare(`SELECT seller_a_id, seller_b_id FROM retail_seller_distinct_pairs WHERE organization_id = ?`).all(orgId) as any[]).map((r) => `${r.seller_a_id}|${r.seller_b_id}`));
    const out: DuplicateSuggestion[] = [];
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const x = rows[i], y = rows[j];
      if (!x.toks.length || !y.toks.length) continue;
      const [ka, kb] = pairKey(x.id, y.id);
      if (distinct.has(`${ka}|${kb}`)) continue;
      const [short, long] = x.toks.length <= y.toks.length ? [x, y] : [y, x];
      const subset = short.toks.every((t) => long.toks.includes(t));
      const sameFirst = x.toks[0] === y.toks[0] && x.toks[0].length >= 3;
      if (!subset && !sameFirst) continue;
      // "Vinícius Romão" × "Vinícius Nascimento": nome completo dos dois, sobrenomes diferentes e nenhum contém o outro →
      // são pessoas DIFERENTES por construção (PRD Fase 1 §3). Nunca sugere fusão nem pergunta de novo.
      if (!subset && x.toks.length >= 2 && y.toks.length >= 2) continue;
      // Par redundante: existe um nome mais completo que contém os dois ("EDUARDO" × "Eduardo" quando há "Eduardo Lázaro").
      // A resposta vem pelo nome completo — perguntar os três pares seria o mesmo assunto 3 vezes.
      if (subset && rows.some((z) => z.id !== x.id && z.id !== y.id && z.toks.length > Math.max(x.toks.length, y.toks.length) && within(x, z) && within(y, z))) continue;
      const ambiguousShort = subset && short.toks.length < long.toks.length && ambiguous(short);
      const kind: "likely" | "check" = subset && !ambiguousShort ? "likely" : "check";
      // canônica sugerida: nome mais longo; empate → a de menor id (estável)
      const into = x.toks.length === y.toks.length ? (x.id < y.id ? x : y) : long;
      const view = (r: Row) => ({ id: r.id, name: r.name, matricula: r.matricula, stores: r.stores.map((s) => s.name) });
      out.push({
        kind, a: view(x), b: view(y), suggestedIntoId: into.id,
        question: kind === "likely" ? `"${x.name}" e "${y.name}" são a mesma pessoa?`
          : ambiguousShort ? `"${short.name}" pode ser mais de uma pessoa — "${x.name}" e "${y.name}" são pessoas diferentes?`
          : `"${x.name}" e "${y.name}" são pessoas diferentes? (mesmo primeiro nome)`,
      });
    }
    out.sort((p, q) => (p.kind === q.kind ? 0 : p.kind === "likely" ? -1 : 1));
    return out.slice(0, MAX_SUGGESTIONS);
  }

  /** "Pessoas diferentes": memoriza o par e nunca mais pergunta. Idempotente. */
  static markDistinct(orgId: string, aId: string, bId: string, actorId?: string | null): { ok: true } {
    if (aId === bId) throw new Error("Escolha dois vendedores diferentes.");
    const s = db.prepare(`SELECT id FROM retail_sellers WHERE organization_id = ? AND id IN (?, ?)`).all(orgId, aId, bId) as any[];
    if (s.length !== 2) throw new Error("Vendedor não encontrado.");
    const [a, b] = pairKey(aId, bId);
    db.prepare(`INSERT OR IGNORE INTO retail_seller_distinct_pairs (id, organization_id, seller_a_id, seller_b_id, decided_by) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), orgId, a, b, actorId || null);
    return { ok: true };
  }

  /**
   * "Mesma pessoa": funde (reversível). `coverage` = está cobrindo férias na loja da duplicata: a lotação da
   * duplicata vira COBERTURA com datas (não principal permanente). Valida tudo ANTES de escrever.
   */
  static confirmSame(orgId: string, aId: string, bId: string, opts: { intoId?: string; coverage?: { startDate: string; endDate: string } } = {}, actorId?: string | null): any {
    if (aId === bId) throw new Error("Escolha dois vendedores diferentes.");
    const rows = this.load(orgId).filter((r) => r.id === aId || r.id === bId);
    if (rows.length !== 2) throw new Error("Vendedor não encontrado (ou já fundido).");
    const intoId = opts.intoId && (opts.intoId === aId || opts.intoId === bId) ? opts.intoId : (this.suggestions(orgId).find((s) => [s.a.id, s.b.id].includes(aId) && [s.a.id, s.b.id].includes(bId))?.suggestedIntoId || aId);
    const fromId = intoId === aId ? bId : aId;
    const from = rows.find((r) => r.id === fromId)!, into = rows.find((r) => r.id === intoId)!;

    let coverageStore: { id: string; name: string } | null = null;
    let start: string | null = null, end: string | null = null;
    if (opts.coverage) {
      start = isoDay(opts.coverage.startDate); end = isoDay(opts.coverage.endDate);
      if (!start || !end) throw new Error("Informe o período da cobertura (início e fim).");
      if (end < start) throw new Error("O fim da cobertura é anterior ao início.");
      coverageStore = from.stores[0] || null;
      if (!coverageStore) throw new Error("A duplicata não tem loja — não há onde registrar a cobertura.");
      if (into.stores.some((s) => s.id === coverageStore!.id)) throw new Error("A pessoa já é da loja " + coverageStore.name + " — não é cobertura.");
    }

    if (coverageStore) {
      // a lotação da duplicata não pode virar principal permanente da canônica ao fundir
      db.prepare(`UPDATE retail_seller_store_assignments SET active = 0, effective_to = CURRENT_TIMESTAMP WHERE organization_id = ? AND seller_id = ? AND active = 1`).run(orgId, fromId);
    }
    const merged = RetailSellerIdentityService.mergeSellers(orgId, fromId, intoId, actorId);
    let coverage: any = null;
    if (coverageStore && start && end) coverage = RetailSellerIdentityService.addAssignment(orgId, { sellerId: intoId, storeId: coverageStore.id, type: "cobertura_ferias", startDate: start, endDate: end }, actorId);
    return { merged: true, intoId, fromId, intoName: into.name, coverage, aliases: merged.aliases };
  }
}

export default RetailSellerDuplicateService;
