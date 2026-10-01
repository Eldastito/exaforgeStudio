/**
 * RetailSellerIdentityService — identidade ÚNICA de vendedor (PRD Fase 1, F1.1).
 *
 * Problema: nome digitado, matrícula, CAI_USUARIO do ERP e loja criavam várias linhas da
 * mesma pessoa (Lohan Grande Rio / LOHAN; Eduardo Lázaro / EDUARDO) — e o contrário (duas
 * pessoas fundidas por nome parecido) seria pior (Vinícius Romão ≠ Vinícius Nascimento).
 *
 * `retail_sellers` continua sendo a identidade canônica (RN-SELL-2). Aqui entra:
 *  - ALIASES: nome/matrícula/CAI_USUARIO que apontam pra UMA identidade. Um alias pertence a
 *    um único vendedor por org; se já é de outro → conflito explícito (nunca "rouba" em silêncio).
 *  - RESOLUÇÃO: só casa por igualdade normalizada (sem acento/caixa) com matrícula, nome
 *    oficial ou alias CONFIRMADO. NUNCA por parecido/primeiro nome: sem correspondência exata é
 *    "não identificado" (RN-SELL-1 — nunca inventa correspondência). Dois candidatos → ambíguo.
 *  - FUSÃO governada e REVERSÍVEL: a identidade fundida é desativada (nunca DELETE — retenção),
 *    seus nomes/matrícula viram aliases da canônica, as lotações são movidas. `unmerge` desfaz.
 *  - ALOCAÇÃO com tipo e período (principal · temporária · cobertura de férias · transferência
 *    definitiva): quem a pessoa É ≠ onde ela trabalhou naquele período. Vender em outra loja
 *    NÃO cria outro vendedor; o resultado é lido por pessoa + loja + período (`storeOn`).
 *
 * F1.1a: modelo, resolução, fusão e alocação. F1.1b: as AGREGAÇÕES de venda/comissão/corrida/ranking
 * passam pela identidade canônica via `SellerIdentityContext.canonicalize` (só quando a linha foi tocada
 * por fusão/alias; org sem aliases/fusões recebe exatamente as chaves de antes). Nada é reescrito no
 * histórico — a unificação é feita na LEITURA (reversível com `unmerge`).
 * Tudo isolado por organization_id (convenção nº 1).
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

export type AliasKind = "name" | "matricula" | "cai_usuario";
export type AssignmentType = "principal" | "temporaria" | "cobertura_ferias" | "transferencia_definitiva";
const ALIAS_KINDS: AliasKind[] = ["name", "matricula", "cai_usuario"];
const TEMP_TYPES: AssignmentType[] = ["temporaria", "cobertura_ferias"];
const MAX_MERGE_DEPTH = 5;

export type IdentityResolution = {
  status: "identified" | "ambiguous" | "unidentified";
  seller: { id: string; name: string | null; matricula: string } | null;
  via: "matricula" | "alias" | "name" | null;
  candidates: Array<{ id: string; name: string | null; matricula: string }>;
};

/** Sem acento, minúscula, espaços colapsados. Só igualdade — não é fuzzy. */
export function normalizeAlias(v: unknown): string {
  return String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}
const isoDay = (v: unknown): string | null => {
  const s = String(v ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const today = () => new Date().toISOString().slice(0, 10);

/** Chave de casamento das agregações de vendas/corrida (mesma convenção `norm` do RetailCommissionRaceService). */
const aggNorm = (v: unknown) => String(v ?? "").trim().toLowerCase();

export type CanonicalRef = {
  sellerId: string;
  matricula: string;
  name: string;                 // nome da identidade canônica (ou "Matrícula X" se sem nome)
  userId: string | null;
  /** Chaves `user:`/`mat:`/`nom:` de TODAS as identidades ligadas (canônica + fundidas + aliases): cotas/escala cadastradas com a chave antiga continuam casando. */
  aliasKeys: string[];
};

/**
 * Identidade em MEMÓRIA (uma leitura por agregação): as tabelas de vendedor/alias são pequenas,
 * então uma agregação carrega tudo UMA vez e resolve milhares de linhas sem tocar o banco.
 * `empty` = a org não usa aliases nem fusões → `canonicalize` devolve sempre null (0-regressão
 * POR CONSTRUÇÃO: quem não configurou identidade recebe exatamente as chaves de antes).
 */
export class SellerIdentityContext {
  readonly empty: boolean;
  private byId = new Map<string, any>();
  private byMat = new Map<string, any>();
  private aliases: Array<{ seller_id: string; alias: string; alias_norm: string; kind: string }>;
  private officials: any[];

  private constructor(sellers: any[], aliases: any[]) {
    for (const r of sellers) { this.byId.set(r.id, r); this.byMat.set(String(r.matricula), r); }
    this.aliases = aliases;
    this.officials = sellers.filter((r) => r.active === 1 && !r.merged_into_seller_id && r.name);
    this.empty = aliases.length === 0 && !sellers.some((r) => r.merged_into_seller_id);
  }

  static load(orgId: string): SellerIdentityContext {
    const sellers = db.prepare(`SELECT id, matricula, name, user_id, active, merged_into_seller_id FROM retail_sellers WHERE organization_id = ?`).all(orgId) as any[];
    const aliases = db.prepare(`SELECT seller_id, alias, alias_norm, kind FROM retail_seller_aliases WHERE organization_id = ?`).all(orgId) as any[];
    return new SellerIdentityContext(sellers, aliases);
  }

  canonicalSeller(id: string): any | null {
    let cur = this.byId.get(id) || null;
    for (let i = 0; cur && cur.merged_into_seller_id && i < MAX_MERGE_DEPTH; i++) {
      const next = this.byId.get(cur.merged_into_seller_id);
      if (!next) break;
      cur = next;
    }
    return cur;
  }

  /** Mesma regra do `RetailSellerIdentityService.resolve` — igualdade normalizada, sem fuzzy. `hit` = a linha casada ANTES de seguir a fusão. */
  resolve(ref: { matricula?: string | null; name?: string | null }): IdentityResolution & { hit: any | null } {
    const none = { status: "unidentified" as const, seller: null, via: null, candidates: [] as IdentityResolution["candidates"], hit: null };
    const shape = (x: any) => ({ id: x.id, name: x.name || null, matricula: x.matricula });
    const found = (hit: any, via: IdentityResolution["via"]) => {
      const c = this.canonicalSeller(hit.id) || hit;
      return { status: "identified" as const, seller: shape(c), via, candidates: [] as IdentityResolution["candidates"], hit };
    };
    const mat = String(ref.matricula ?? "").trim();
    if (mat) {
      const byMat = this.byMat.get(mat);
      if (byMat) return found(byMat, "matricula");
      const ids = [...new Set(this.aliases.filter((a) => (a.kind === "matricula" || a.kind === "cai_usuario") && a.alias_norm === normalizeAlias(mat)).map((a) => a.seller_id))];
      if (ids.length === 1) { const x = this.byId.get(ids[0]); if (x) return found(x, "alias"); }
      if (ids.length > 1) return { ...none, status: "ambiguous" as any, candidates: ids.map((i) => this.byId.get(i)).filter(Boolean).map(shape) };
    }
    const nm = normalizeAlias(ref.name);
    if (nm.length >= 2) {
      const officials = this.officials.filter((r) => normalizeAlias(r.name) === nm);
      const al = this.aliases.filter((a) => a.kind === "name" && a.alias_norm === nm);
      const map = new Map<string, any>();
      for (const o of officials) { const c = this.canonicalSeller(o.id) || o; map.set(c.id, c); }
      for (const a of al) { const c = this.canonicalSeller(a.seller_id); if (c) map.set(c.id, c); }
      const list = [...map.values()];
      if (list.length === 1) return { ...found(list[0], al.length && !officials.length ? "alias" : "name"), hit: officials[0] || list[0] };
      if (list.length > 1) return { ...none, status: "ambiguous" as any, candidates: list.map(shape) };
    }
    return none;
  }

  /**
   * Só devolve algo quando a identidade DA LINHA foi tocada por fusão ou alias confirmado;
   * vendedor comum (sem fusão/alias) → null e a agregação segue com as chaves originais.
   */
  canonicalize(ref: { matricula?: string | null; name?: string | null }): CanonicalRef | null {
    if (this.empty) return null;
    const r = this.resolve(ref);
    if (r.status !== "identified" || !r.seller) return null;
    const touched = r.via === "alias" || (r.hit && r.hit.merged_into_seller_id);
    if (!touched) return null;
    const c = this.byId.get(r.seller.id);
    if (!c) return null;
    const keys = new Set<string>();
    const addSeller = (x: any) => {
      if (x.user_id) keys.add(`user:${x.user_id}`);
      if (x.matricula) keys.add(`mat:${x.matricula}`);
      if (x.name) keys.add(`nom:${aggNorm(x.name)}`);
    };
    const ids = new Set<string>([c.id]);
    for (const x of this.byId.values()) if ((this.canonicalSeller(x.id) || x).id === c.id) ids.add(x.id);
    for (const id of ids) { const x = this.byId.get(id); if (x) addSeller(x); }
    for (const a of this.aliases) {
      if (!ids.has(a.seller_id)) continue;
      if (a.kind === "name") keys.add(`nom:${aggNorm(a.alias)}`);
      else keys.add(`mat:${String(a.alias).trim()}`);
    }
    return { sellerId: c.id, matricula: String(c.matricula), name: c.name || unidentifiedLabel(c.matricula), userId: c.user_id || null, aliasKeys: [...keys] };
  }
}

/** Vigência de uma lotação numa data (YYYY-MM-DD). Temporária/cobertura: janela inclusiva; legado: sem limite inferior; transferência: fim exclusivo. */
function assignmentApplies(r: any, d: string): boolean {
  const from = String(r.effective_from || "").slice(0, 10) || "0000-00-00";
  const to = r.effective_to ? String(r.effective_to).slice(0, 10) : null;
  const type = (r.assignment_type || "principal") as AssignmentType;
  if (type === "temporaria" || type === "cobertura_ferias") return from <= d && to !== null && d <= to;
  if (r.assignment_type === null) return r.active ? true : (to !== null && d < to);
  return from <= d && (r.active ? (to === null || d <= to) : (to !== null && d < to));
}

/** Rótulo único de matrícula sem pessoa confirmada (PRD Fase 1 §3): nunca "Matrícula X" solto, nunca nome chutado. */
export const unidentifiedLabel = (matricula: unknown): string => `Vendedor não identificado — matrícula ${String(matricula ?? "").trim() || "?"}`;

export class RetailSellerIdentityService {
  // ── leitura básica ────────────────────────────────────────────────────────
  private static seller(orgId: string, id: string): any | null {
    return (db.prepare(`SELECT * FROM retail_sellers WHERE organization_id = ? AND id = ?`).get(orgId, id) as any) || null;
  }

  /** Segue `merged_into_seller_id` até a identidade canônica (proteção contra ciclo). */
  static canonicalSeller(orgId: string, sellerId: string): any | null {
    let cur = this.seller(orgId, sellerId);
    for (let i = 0; cur && cur.merged_into_seller_id && i < MAX_MERGE_DEPTH; i++) {
      const next = this.seller(orgId, cur.merged_into_seller_id);
      if (!next) break;
      cur = next;
    }
    return cur;
  }

  // ── aliases ───────────────────────────────────────────────────────────────
  static listAliases(orgId: string, sellerId: string): any[] {
    return db.prepare(
      `SELECT id, alias, kind, source, confirmed_by, created_at FROM retail_seller_aliases
        WHERE organization_id = ? AND seller_id = ? ORDER BY kind, alias`
    ).all(orgId, sellerId) as any[];
  }

  /** Gesto HUMANO: confirma que `alias` é este vendedor. Conflito com outro vendedor → erro. */
  static addAlias(orgId: string, sellerId: string, input: { alias: string; kind?: AliasKind }, actorId?: string | null): any {
    const target = this.seller(orgId, sellerId);
    if (!target) throw new Error("Vendedor não encontrado.");
    if (target.merged_into_seller_id) throw new Error("seller_merged: use a identidade canônica.");
    const kind = (input.kind || "name") as AliasKind;
    if (!ALIAS_KINDS.includes(kind)) throw new Error(`kind inválido (${ALIAS_KINDS.join("|")}).`);
    const alias = String(input.alias ?? "").trim();
    const norm = normalizeAlias(alias);
    if (norm.length < 2) throw new Error("Alias muito curto.");
    const existing = db.prepare(`SELECT id, seller_id FROM retail_seller_aliases WHERE organization_id = ? AND kind = ? AND alias_norm = ?`).get(orgId, kind, norm) as any;
    if (existing) {
      if (existing.seller_id === sellerId) return { id: existing.id, alias, kind, deduped: true };
      throw new Error("alias_conflict: este alias já pertence a outro vendedor.");
    }
    // Um nome/matrícula que JÁ é a identidade oficial de OUTRO vendedor também é conflito.
    const owner = this.ownerOfPrimaryKey(orgId, kind, norm);
    if (owner && owner !== sellerId) throw new Error("alias_conflict: este valor é a identidade oficial de outro vendedor (funda-os em vez de aliasar).");
    const id = randomUUID();
    db.prepare(
      `INSERT INTO retail_seller_aliases (id, organization_id, seller_id, alias, alias_norm, kind, source, confirmed_by) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)`
    ).run(id, orgId, sellerId, alias, norm, kind, actorId || null);
    try { logAuthEvent(orgId, actorId || "system", sellerId, "RETAIL_SELLER_ALIAS_ADDED", { alias, kind }); } catch { /* noop */ }
    return { id, alias, kind, deduped: false };
  }

  static removeAlias(orgId: string, aliasId: string, actorId?: string | null): boolean {
    const row = db.prepare(`SELECT seller_id, alias, kind FROM retail_seller_aliases WHERE organization_id = ? AND id = ?`).get(orgId, aliasId) as any;
    if (!row) return false;
    db.prepare(`DELETE FROM retail_seller_aliases WHERE organization_id = ? AND id = ?`).run(orgId, aliasId);
    try { logAuthEvent(orgId, actorId || "system", row.seller_id, "RETAIL_SELLER_ALIAS_REMOVED", { alias: row.alias, kind: row.kind }); } catch { /* noop */ }
    return true;
  }

  /** Dono da identidade OFICIAL (matrícula ou nome de um `retail_sellers` ativo e não fundido). */
  private static ownerOfPrimaryKey(orgId: string, kind: AliasKind, norm: string): string | null {
    const rows = db.prepare(`SELECT id, matricula, name FROM retail_sellers WHERE organization_id = ? AND active = 1 AND merged_into_seller_id IS NULL`).all(orgId) as any[];
    const hit = rows.filter((r) => (kind === "name" ? normalizeAlias(r.name) === norm : normalizeAlias(r.matricula) === norm));
    return hit.length === 1 ? hit[0].id : null;
  }

  // ── resolução ─────────────────────────────────────────────────────────────
  /**
   * Quem é esse vendedor? Ordem: matrícula/CAI → alias de matrícula → nome oficial → alias de nome.
   * Só igualdade normalizada. Sem correspondência exata → `unidentified` (nunca inventa).
   */
  static resolve(orgId: string, ref: { matricula?: string | null; name?: string | null }): IdentityResolution {
    const { hit: _hit, ...r } = SellerIdentityContext.load(orgId).resolve(ref);
    return r;
  }

  /** Contexto em memória p/ agregações (uma leitura, N linhas). */
  static context(orgId: string): SellerIdentityContext { return SellerIdentityContext.load(orgId); }

  /** Matrícula da identidade CANÔNICA (a que a agregação deve usar — F1.1b). Sem mapeamento → a própria. */
  static canonicalMatricula(orgId: string, matricula: string | null | undefined): string | null {
    const m = String(matricula ?? "").trim();
    if (!m) return null;
    const r = this.resolve(orgId, { matricula: m });
    return r.status === "identified" && r.seller ? r.seller.matricula : m;
  }

  /** Nome pra exibir. Matrícula sem pessoa confirmada NUNCA vira nome inventado. */
  static displayName(orgId: string, matricula: string | null | undefined): string {
    const m = String(matricula ?? "").trim();
    const r = m ? this.resolve(orgId, { matricula: m }) : null;
    if (r?.status === "identified" && r.seller?.name) return r.seller.name;
    return unidentifiedLabel(m);
  }

  /** Matrículas vistas nas vendas sem pessoa nomeada/confirmada (pendência acionável, nunca chute). */
  static unidentified(orgId: string): Array<{ matricula: string; sales: number; lastSale: string | null; displayName: string }> {
    const rows = db.prepare(
      `SELECT COALESCE(NULLIF(vendedor_codigo, ''), vendedor) AS m, COUNT(*) AS n, MAX(sale_date) AS last_sale
         FROM retail_pdv_sales WHERE organization_id = ? AND COALESCE(NULLIF(vendedor_codigo, ''), vendedor, '') <> ''
        GROUP BY m ORDER BY n DESC`
    ).all(orgId) as any[];
    const out: Array<{ matricula: string; sales: number; lastSale: string | null; displayName: string }> = [];
    const ctx = SellerIdentityContext.load(orgId);
    for (const r of rows) {
      const res = ctx.resolve({ matricula: String(r.m) });
      if (res.status === "identified" && res.seller?.name) continue;
      out.push({ matricula: String(r.m), sales: Number(r.n), lastSale: r.last_sale || null, displayName: unidentifiedLabel(r.m) });
    }
    return out;
  }

  // ── fusão governada ───────────────────────────────────────────────────────
  /**
   * Funde `fromId` em `intoId`. NÃO apaga nada: `from` é desativada e marcada `merged_into`;
   * matrícula/nome/aliases de `from` viram aliases de `into`; lotações são movidas (sem duplicar
   * a loja). Falha se algum alias colidir com um TERCEIRO vendedor (não decide sozinha).
   */
  static mergeSellers(orgId: string, fromId: string, intoId: string, actorId?: string | null): any {
    if (fromId === intoId) throw new Error("Não dá pra fundir um vendedor nele mesmo.");
    const from = this.seller(orgId, fromId), into = this.seller(orgId, intoId);
    if (!from || !into) throw new Error("Vendedor não encontrado.");
    if (from.merged_into_seller_id) throw new Error("O vendedor de origem já foi fundido.");
    if (into.merged_into_seller_id) throw new Error("O destino já foi fundido em outro — use a identidade canônica.");
    if (from.user_id && into.user_id && from.user_id !== into.user_id) throw new Error("user_conflict: cada identidade tem um usuário diferente.");

    const norm = (k: AliasKind, v: unknown) => ({ kind: k, alias: String(v ?? "").trim(), norm: normalizeAlias(v) });
    const wanted = [norm("matricula", from.matricula), ...(from.name ? [norm("name", from.name)] : [])].filter((a) => a.norm.length >= 2);
    const moved = db.prepare(`SELECT id, alias, alias_norm, kind FROM retail_seller_aliases WHERE organization_id = ? AND seller_id = ?`).all(orgId, fromId) as any[];
    // Colisão com TERCEIRO → recusa antes de qualquer escrita.
    for (const a of wanted) {
      const ex = db.prepare(`SELECT seller_id FROM retail_seller_aliases WHERE organization_id = ? AND kind = ? AND alias_norm = ?`).get(orgId, a.kind, a.norm) as any;
      if (ex && ex.seller_id !== fromId && ex.seller_id !== intoId) throw new Error(`alias_conflict: "${a.alias}" pertence a outro vendedor.`);
    }

    const tx = db.transaction(() => {
      db.prepare(`UPDATE retail_sellers SET merged_into_seller_id = ?, merged_at = CURRENT_TIMESTAMP, active = 0, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(intoId, orgId, fromId);
      if (from.user_id && !into.user_id) db.prepare(`UPDATE retail_sellers SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(from.user_id, orgId, intoId);
      // aliases já existentes de `from` passam a `into` (marcados p/ desfazer)
      for (const a of moved) {
        const dup = db.prepare(`SELECT 1 FROM retail_seller_aliases WHERE organization_id = ? AND seller_id = ? AND kind = ? AND alias_norm = ?`).get(orgId, intoId, a.kind, a.alias_norm);
        if (dup) db.prepare(`DELETE FROM retail_seller_aliases WHERE id = ?`).run(a.id);
        else db.prepare(`UPDATE retail_seller_aliases SET seller_id = ?, via_merge_of = ? WHERE id = ?`).run(intoId, fromId, a.id);
      }
      // matrícula e nome oficiais de `from` viram aliases de `into`
      for (const a of wanted) {
        if (a.kind === "matricula" && a.norm === normalizeAlias(into.matricula)) continue;
        if (a.kind === "name" && a.norm === normalizeAlias(into.name)) continue;
        db.prepare(
          `INSERT OR IGNORE INTO retail_seller_aliases (id, organization_id, seller_id, alias, alias_norm, kind, source, via_merge_of, confirmed_by) VALUES (?, ?, ?, ?, ?, ?, 'merge', ?, ?)`
        ).run(randomUUID(), orgId, intoId, a.alias, a.norm, a.kind, fromId, actorId || null);
      }
      // lotações: move as de `from` pra `into` sem duplicar a loja
      const acts = db.prepare(`SELECT id, store_id, is_primary FROM retail_seller_store_assignments WHERE organization_id = ? AND seller_id = ? AND active = 1`).all(orgId, fromId) as any[];
      const intoHasPrimary = !!db.prepare(`SELECT 1 FROM retail_seller_store_assignments WHERE organization_id = ? AND seller_id = ? AND active = 1 AND is_primary = 1`).get(orgId, intoId);
      let primaryTaken = intoHasPrimary;
      for (const a of acts) {
        const has = db.prepare(`SELECT 1 FROM retail_seller_store_assignments WHERE organization_id = ? AND seller_id = ? AND store_id = ? AND active = 1`).get(orgId, intoId, a.store_id);
        if (has) db.prepare(`UPDATE retail_seller_store_assignments SET active = 0, effective_to = CURRENT_TIMESTAMP WHERE id = ?`).run(a.id);
        else {
          const keepPrimary = a.is_primary && !primaryTaken ? 1 : 0;
          if (keepPrimary) primaryTaken = true;
          db.prepare(`UPDATE retail_seller_store_assignments SET seller_id = ?, is_primary = ? WHERE id = ?`).run(intoId, keepPrimary, a.id);
        }
      }
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", intoId, "RETAIL_SELLER_MERGED", { fromId, fromMatricula: from.matricula, fromName: from.name, intoId }); } catch { /* noop */ }
    return { merged: true, intoId, fromId, aliases: this.listAliases(orgId, intoId) };
  }

  /** Desfaz a fusão: reativa `from` e remove os aliases que a fusão criou. As lotações movidas ficam onde estão (seguro). */
  static unmerge(orgId: string, fromId: string, actorId?: string | null): any {
    const from = this.seller(orgId, fromId);
    if (!from || !from.merged_into_seller_id) throw new Error("Este vendedor não está fundido.");
    const intoId = from.merged_into_seller_id;
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM retail_seller_aliases WHERE organization_id = ? AND via_merge_of = ? AND source = 'merge'`).run(orgId, fromId);
      // aliases que `from` tinha antes da fusão voltam pra ele
      db.prepare(`UPDATE retail_seller_aliases SET seller_id = ?, via_merge_of = NULL WHERE organization_id = ? AND via_merge_of = ?`).run(fromId, orgId, fromId);
      db.prepare(`UPDATE retail_sellers SET merged_into_seller_id = NULL, merged_at = NULL, active = 1, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(orgId, fromId);
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", fromId, "RETAIL_SELLER_UNMERGED", { intoId }); } catch { /* noop */ }
    return { unmerged: true, fromId, intoId };
  }

  // ── alocação por tipo e período ───────────────────────────────────────────
  /**
   * Registra onde a pessoa trabalha em um período. A identidade NÃO muda.
   *  - temporaria / cobertura_ferias: exigem startDate e endDate; nascem `active=0` (não
   *    entram no roster legado) e valem só na janela — lidas por `assignmentsOn`/`storeOn`.
   *  - transferencia_definitiva: encerra as lotações ativas e cria a nova principal (aplica
   *    a partir de hoje; data futura é recusada — registre na data).
   */
  static addAssignment(orgId: string, input: { sellerId: string; storeId: string; type: AssignmentType; startDate: string; endDate?: string | null }, actorId?: string | null): any {
    const seller = this.seller(orgId, input.sellerId);
    if (!seller) throw new Error("Vendedor não encontrado.");
    if (seller.merged_into_seller_id) throw new Error("seller_merged: use a identidade canônica.");
    if (!db.prepare(`SELECT 1 FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, input.storeId)) throw new Error("Loja não encontrada.");
    const type = input.type;
    const start = isoDay(input.startDate);
    if (!start) throw new Error("startDate inválida (YYYY-MM-DD).");

    if (type === "transferencia_definitiva") {
      if (start > today()) throw new Error("Transferência definitiva aplica hoje: registre na data da mudança.");
      const id = randomUUID();
      db.transaction(() => {
        db.prepare(`UPDATE retail_seller_store_assignments SET active = 0, effective_to = ? WHERE organization_id = ? AND seller_id = ? AND active = 1 AND assignment_type IS NOT 'temporaria' AND assignment_type IS NOT 'cobertura_ferias'`).run(start, orgId, input.sellerId);
        db.prepare(
          `INSERT INTO retail_seller_store_assignments (id, organization_id, seller_id, store_id, is_primary, active, effective_from, source, confirmed_by, confirmed_at, assignment_type)
           VALUES (?, ?, ?, ?, 1, 1, ?, 'manual', ?, CURRENT_TIMESTAMP, 'transferencia_definitiva')`
        ).run(id, orgId, input.sellerId, input.storeId, start, actorId || null);
      })();
      try { logAuthEvent(orgId, actorId || "system", input.sellerId, "RETAIL_SELLER_ASSIGNMENT_ADDED", { type, storeId: input.storeId, startDate: start }); } catch { /* noop */ }
      return { id, type, storeId: input.storeId, startDate: start, endDate: null };
    }
    if (!TEMP_TYPES.includes(type)) throw new Error(`type inválido (${[...TEMP_TYPES, "transferencia_definitiva"].join("|")}).`);
    const end = isoDay(input.endDate);
    if (!end) throw new Error("endDate é obrigatória para alocação temporária.");
    if (end < start) throw new Error("endDate anterior a startDate.");
    const id = randomUUID();
    db.prepare(
      `INSERT INTO retail_seller_store_assignments (id, organization_id, seller_id, store_id, is_primary, active, effective_from, effective_to, source, confirmed_by, confirmed_at, assignment_type)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?, 'manual', ?, CURRENT_TIMESTAMP, ?)`
    ).run(id, orgId, input.sellerId, input.storeId, start, end, actorId || null, type);
    try { logAuthEvent(orgId, actorId || "system", input.sellerId, "RETAIL_SELLER_ASSIGNMENT_ADDED", { type, storeId: input.storeId, startDate: start, endDate: end }); } catch { /* noop */ }
    return { id, type, storeId: input.storeId, startDate: start, endDate: end };
  }

  /** Lojas em que a pessoa atua numa data (principal + períodos temporários vigentes). */
  static assignmentsOn(orgId: string, sellerId: string, date: string): Array<{ storeId: string; storeName: string | null; type: AssignmentType }> {
    const d = isoDay(date) || today();
    const c = this.canonicalSeller(orgId, sellerId);
    if (!c) return [];
    const rows = db.prepare(
      `SELECT a.store_id, s.name AS store_name, a.assignment_type, a.is_primary, a.active, a.effective_from, a.effective_to
         FROM retail_seller_store_assignments a LEFT JOIN retail_stores s ON s.organization_id = a.organization_id AND s.id = a.store_id
        WHERE a.organization_id = ? AND a.seller_id = ?`
    ).all(orgId, c.id) as any[];
    const out: Array<{ storeId: string; storeName: string | null; type: AssignmentType }> = [];
    for (const r of rows) {
      if (assignmentApplies(r, d)) out.push({ storeId: r.store_id, storeName: r.store_name || null, type: (r.assignment_type || "principal") as AssignmentType });
    }
    return out;
  }

  /**
   * Quem está NA loja numa data (equipe do dia): lotação vigente + cobertura/temporária vigente. Quem está
   * cobrindo OUTRA loja no dia não conta na loja de origem (a pessoa não está lá). Só vendedores ativos e
   * canônicos (fundido nunca aparece). Mesmo critério de `assignmentsOn` — uma única definição de vigência.
   */
  static rosterOn(orgId: string, storeId: string, date?: string): Array<{ id: string; matricula: string; name: string | null; photoUrl: string | null }> {
    const d = isoDay(date) || today();
    const rows = db.prepare(
      `SELECT a.seller_id, a.store_id, a.assignment_type, a.is_primary, a.active, a.effective_from, a.effective_to,
              s.matricula, s.name, s.photo_url
         FROM retail_seller_store_assignments a
         JOIN retail_sellers s ON s.organization_id = a.organization_id AND s.id = a.seller_id
        WHERE a.organization_id = ? AND s.active = 1 AND s.merged_into_seller_id IS NULL
          AND a.seller_id IN (SELECT seller_id FROM retail_seller_store_assignments WHERE organization_id = ? AND store_id = ?)`
    ).all(orgId, orgId, storeId) as any[];
    const bySeller = new Map<string, any[]>();
    for (const r of rows) { if (!bySeller.has(r.seller_id)) bySeller.set(r.seller_id, []); bySeller.get(r.seller_id)!.push(r); }
    const out: Array<{ id: string; matricula: string; name: string | null; photoUrl: string | null }> = [];
    for (const [sid, list] of bySeller) {
      const live = list.filter((r) => assignmentApplies(r, d));
      const here = live.some((r) => r.store_id === storeId);
      if (!here) continue;
      const coveringElsewhere = live.some((r) => r.store_id !== storeId && (r.assignment_type === "temporaria" || r.assignment_type === "cobertura_ferias"));
      const coveringHere = live.some((r) => r.store_id === storeId && (r.assignment_type === "temporaria" || r.assignment_type === "cobertura_ferias"));
      if (coveringElsewhere && !coveringHere) continue;
      const x = list[0];
      out.push({ id: sid, matricula: String(x.matricula), name: x.name || null, photoUrl: x.photo_url || null });
    }
    return out.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  }

  /**
   * Em qual loja atribuir o resultado da pessoa nesta data? Período temporário vigente vence a
   * principal (a pessoa está cobrindo); sem nada → null (não inventa loja).
   */
  static storeOn(orgId: string, sellerId: string, date: string): { storeId: string; storeName: string | null; type: AssignmentType } | null {
    const list = this.assignmentsOn(orgId, sellerId, date);
    return list.find((a) => a.type === "temporaria" || a.type === "cobertura_ferias") || list[0] || null;
  }
}

export default RetailSellerIdentityService;
