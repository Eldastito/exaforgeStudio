/**
 * Retail Ops — Template de FOLGA por vendedor (ADR-083 Fase G2b).
 *
 * O gerente cadastra "Rafaela sempre folga segunda; Estefânio sempre terça"
 * uma vez, e o botão "Aplicar no mês" preenche a grade da escala do mês
 * inteiro sem tocar nas datas já lançadas manualmente. Também expõe o card
 * "quem folga hoje/amanhã" pra Escala e Fechamento diário.
 *
 * Decisões:
 *  - **RN-G2b-001 — Template não sobrescreve grade lançada.** `applyToMonth`
 *    só INSERE 'off' pros pares (data, seller) que ainda não têm entrada em
 *    `retail_schedule_entries`. Isso preserva ajustes manuais (troca de folga
 *    pontual, cobertura de férias) — o template é o padrão, a grade é a
 *    verdade final.
 *  - **RN-G2b-002 — Isolamento multi-tenant.** Toda query filtra `organization_id`
 *    e `store_id` (padrão da rede é por loja: cada loja tem seu quadro).
 *  - **RN-G2b-003 — day_of_week 0-6.** Domingo=0 … Sábado=6, alinhado com
 *    `Date#getUTCDay()`. As folgas semanais reais da folha do cliente
 *    tradicionalmente caem em segunda/terça — mas nada impede sábado se for
 *    o modelo da loja.
 *  - **whoIsOff** derivado por query (junta grade lançada 'off' + template
 *    dos vendedores que ainda não têm linha na grade daquele dia).
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

export type OffPattern = {
  sellerKey: string;
  sellerName?: string | null;
  daysOfWeek: number[]; // 0=dom … 6=sáb
};

const norm = (s: any) => String(s || "").trim();

export class RetailScheduleTemplateService {
  /** Lê o template atual da loja: um objeto por vendedor com seus dias de folga. */
  static list(orgId: string, storeId: string): OffPattern[] {
    const rows = db.prepare(
      `SELECT seller_key, seller_name, day_of_week FROM retail_seller_off_pattern
        WHERE organization_id = ? AND store_id = ?
        ORDER BY seller_name, seller_key, day_of_week`
    ).all(orgId, storeId) as any[];
    const map = new Map<string, OffPattern>();
    for (const r of rows) {
      const cur = map.get(r.seller_key) || { sellerKey: r.seller_key, sellerName: r.seller_name || null, daysOfWeek: [] };
      cur.daysOfWeek.push(Number(r.day_of_week));
      if (!cur.sellerName && r.seller_name) cur.sellerName = r.seller_name;
      map.set(r.seller_key, cur);
    }
    return Array.from(map.values());
  }

  /**
   * Regrava o template inteiro da loja: apaga tudo e insere o payload.
   * Vendedor sem `daysOfWeek` marcado fica fora (é o "sem folga fixa").
   */
  static save(orgId: string, storeId: string, patterns: OffPattern[], actorId?: string): OffPattern[] {
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM retail_seller_off_pattern WHERE organization_id = ? AND store_id = ?`).run(orgId, storeId);
      const ins = db.prepare(
        `INSERT INTO retail_seller_off_pattern (id, organization_id, store_id, seller_key, seller_name, day_of_week, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const p of patterns || []) {
        if (!p?.sellerKey) continue;
        for (const d of p.daysOfWeek || []) {
          const dw = Number(d);
          if (!Number.isFinite(dw) || dw < 0 || dw > 6) continue;
          ins.run(randomUUID(), orgId, storeId, norm(p.sellerKey), p.sellerName ? norm(p.sellerName) : null, dw, actorId || null);
        }
      }
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", storeId, "RETAIL_SCHEDULE_TEMPLATE_SAVED", { storeId, patterns: (patterns || []).length }); } catch { /* noop */ }
    return this.list(orgId, storeId);
  }

  /**
   * Aplica o template no intervalo. Só INSERE 'off' onde (data, seller) ainda
   * não tem linha em `retail_schedule_entries` — preserva o que foi lançado
   * manualmente (RN-G2b-001). Retorna `{ inserted, skipped }`.
   */
  static applyToRange(orgId: string, storeId: string, start: string, end: string, actorId?: string): { inserted: number; skipped: number } {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error("intervalo inválido (YYYY-MM-DD)");
    if (start > end) throw new Error("start deve ser <= end");
    const patterns = this.list(orgId, storeId);
    if (!patterns.length) return { inserted: 0, skipped: 0 };
    // Set de (data::seller_key) já ocupados na grade — inclui tanto 'work'
    // quanto 'off' já lançados: se qualquer status já existe, o template
    // não substitui (RN-G2b-001).
    const existing = new Set(
      (db.prepare(
        `SELECT work_date, seller_key FROM retail_schedule_entries
          WHERE organization_id = ? AND store_id = ? AND work_date BETWEEN ? AND ?`
      ).all(orgId, storeId, start, end) as any[]).map((r) => `${r.work_date}::${r.seller_key}`)
    );
    const ins = db.prepare(
      `INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'off', ?)`
    );
    let inserted = 0, skipped = 0;
    const tx = db.transaction(() => {
      // Itera cada dia do intervalo (limitar a 100 dias pra evitar acidentes).
      const startMs = Date.parse(start + "T00:00:00Z");
      const endMs = Date.parse(end + "T00:00:00Z");
      const days = Math.round((endMs - startMs) / 86400000) + 1;
      if (days > 100) throw new Error("intervalo muito grande (máximo 100 dias)");
      for (let i = 0; i < days; i++) {
        const dt = new Date(startMs + i * 86400000);
        const iso = dt.toISOString().slice(0, 10);
        const dow = dt.getUTCDay();
        for (const p of patterns) {
          if (!p.daysOfWeek.includes(dow)) continue;
          const key = `${iso}::${p.sellerKey}`;
          if (existing.has(key)) { skipped++; continue; }
          ins.run(randomUUID(), orgId, storeId, iso, p.sellerKey, p.sellerName || null, actorId || null);
          existing.add(key);
          inserted++;
        }
      }
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", storeId, "RETAIL_SCHEDULE_TEMPLATE_APPLIED", { storeId, start, end, inserted, skipped }); } catch { /* noop */ }
    return { inserted, skipped };
  }

  /**
   * "Quem folga em uma data" — junta o que já tá lançado na grade como 'off'
   * COM os vendedores do template que caem naquele dia da semana e ainda
   * não têm linha na grade. Devolve `[{sellerKey, sellerName, source: 'grid'|'template'}]`.
   * `storeId` opcional (sem loja = todas as lojas ativas da rede).
   */
  static whoIsOff(orgId: string, date: string, opts?: { storeId?: string | null }): any[] {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date deve ser YYYY-MM-DD");
    const dow = new Date(date + "T00:00:00Z").getUTCDay();
    const storeFilter = opts?.storeId ? " AND store_id = ?" : "";
    const args = opts?.storeId ? [orgId, opts.storeId] : [orgId];
    // 1) Linhas 'off' na grade daquele dia.
    const grid = db.prepare(
      `SELECT store_id, seller_key, seller_name FROM retail_schedule_entries
        WHERE organization_id = ? ${storeFilter} AND work_date = ? AND status = 'off'`
    ).all(...args, date) as any[];
    // 2) Template pros vendedores que folgam nesse dia da semana e AINDA NÃO
    //    têm linha na grade (senão duplicaria).
    const gridSet = new Set(grid.map((g) => `${g.store_id}::${g.seller_key}`));
    // Também consideramos vendedores que TÊM linha 'work' na grade — se o
    // gerente montou pra trabalhar naquele dia, o template não sobrepõe.
    const workLines = db.prepare(
      `SELECT store_id, seller_key FROM retail_schedule_entries
        WHERE organization_id = ? ${storeFilter} AND work_date = ?`
    ).all(...args, date) as any[];
    for (const w of workLines) gridSet.add(`${w.store_id}::${w.seller_key}`);
    const tmpl = db.prepare(
      `SELECT store_id, seller_key, seller_name FROM retail_seller_off_pattern
        WHERE organization_id = ? ${storeFilter} AND day_of_week = ?`
    ).all(...args, dow) as any[];
    const out: any[] = grid.map((r) => ({ storeId: r.store_id, sellerKey: r.seller_key, sellerName: r.seller_name, source: "grid" as const }));
    for (const t of tmpl) {
      if (gridSet.has(`${t.store_id}::${t.seller_key}`)) continue;
      out.push({ storeId: t.store_id, sellerKey: t.seller_key, sellerName: t.seller_name, source: "template" as const });
    }
    // Nomes das lojas pra rótulo
    const storeIds = Array.from(new Set(out.map((o) => o.storeId).filter(Boolean)));
    if (storeIds.length) {
      const ph = storeIds.map(() => "?").join(",");
      const rows = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND id IN (${ph})`).all(orgId, ...storeIds) as any[];
      const map = new Map(rows.map((r) => [r.id, r.name]));
      for (const o of out) o.storeName = map.get(o.storeId) || null;
    }
    return out.sort((a, b) => (a.storeName || "").localeCompare(b.storeName || "") || (a.sellerName || "").localeCompare(b.sellerName || ""));
  }

  /**
   * Escala do dia AGRUPADA POR LOJA — quem TRABALHA (verde) e quem FOLGA
   * (vermelho) em uma data. Feito pro card do Fechamento/Escala: com muitas
   * lojas, uma lista chapada de nomes fica enorme; aqui cada loja é um bloco
   * com seu nome no topo e as duas colunas.
   *
   * - **working**: linhas 'work' lançadas na grade (source 'grid') MAIS os
   *   vendedores lotados na loja que NÃO estão de folga no dia (source
   *   'roster') — "quem trabalha = todo mundo que não está de folga". Assim,
   *   numa loja onde só as FOLGAS foram lançadas, o resto da equipe já aparece
   *   trabalhando sem precisar marcar cada um.
   * - **off**: reaproveita `whoIsOff` (grade 'off' + template dos que ainda
   *   não têm linha na grade).
   *
   * Só entram lojas que têm ALGUÉM na escala do dia (trabalhando ou de folga);
   * loja sem escala montada não vira bloco vazio — a inferência preenche a
   * equipe de lojas que JÁ aparecem, nunca ressuscita loja fechada (todos de
   * folga → ninguém trabalha). Retorna ordenado por nome de loja e, dentro, por
   * nome de vendedor. `storeId` opcional (sem loja = todas as lojas ativas).
   */
  static dayRoster(orgId: string, date: string, opts?: { storeId?: string | null }): Array<{
    storeId: string;
    storeName: string | null;
    working: Array<{ sellerKey: string; sellerName: string | null; source: "grid" | "roster" }>;
    off: Array<{ sellerKey: string; sellerName: string | null; source: "grid" | "template" }>;
  }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date deve ser YYYY-MM-DD");
    const storeFilter = opts?.storeId ? " AND store_id = ?" : "";
    const args = opts?.storeId ? [orgId, opts.storeId] : [orgId];
    // Quem trabalha (explícito): linhas 'work' na grade do dia.
    const work = db.prepare(
      `SELECT store_id, seller_key, seller_name FROM retail_schedule_entries
        WHERE organization_id = ? ${storeFilter} AND work_date = ? AND status = 'work'`
    ).all(...args, date) as any[];
    // Quem folga: já resolve grade 'off' + template + nome da loja.
    const off = this.whoIsOff(orgId, date, opts);

    type WorkItem = { sellerKey: string; sellerName: string | null; source: "grid" | "roster" };
    type Bloco = {
      storeId: string;
      storeName: string | null;
      working: WorkItem[];
      off: Array<{ sellerKey: string; sellerName: string | null; source: "grid" | "template" }>;
    };
    const norm = (s: any) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
    const map = new Map<string, Bloco>();
    const bloco = (storeId: string): Bloco => {
      let b = map.get(storeId);
      if (!b) { b = { storeId, storeName: null, working: [], off: [] }; map.set(storeId, b); }
      return b;
    };
    for (const w of work) bloco(w.store_id).working.push({ sellerKey: w.seller_key, sellerName: w.seller_name || null, source: "grid" });
    for (const o of off) {
      const b = bloco(o.storeId);
      b.storeName = o.storeName || b.storeName;
      b.off.push({ sellerKey: o.sellerKey, sellerName: o.sellerName || null, source: o.source });
    }

    // INFERÊNCIA: pra cada loja que JÁ aparece, quem está lotado nela e não está
    // de folga (nem já listado como 'work') entra como trabalhando (source
    // 'roster'). Loja fechada (todos de folga) continua com working vazio.
    const storeIds = Array.from(map.keys());
    if (storeIds.length) {
      const ph = storeIds.map(() => "?").join(",");
      let roster: any[] = [];
      try {
        roster = db.prepare(
          `SELECT a.store_id, s.matricula, s.name FROM retail_seller_store_assignments a
             JOIN retail_sellers s ON s.organization_id = a.organization_id AND s.id = a.seller_id
            WHERE a.organization_id = ? AND a.active = 1 AND s.active = 1 AND a.store_id IN (${ph})`
        ).all(orgId, ...storeIds) as any[];
      } catch { roster = []; }
      for (const r of roster) {
        const b = map.get(r.store_id);
        if (!b) continue;
        const key = `mat:${r.matricula}`;
        const nName = norm(r.name);
        // Já está de folga? (por chave ou por nome) → não trabalha.
        if (b.off.some((o) => o.sellerKey === key || (nName && norm(o.sellerName) === nName))) continue;
        // Já listado como trabalhando? → não duplica.
        if (b.working.some((w) => w.sellerKey === key || (nName && norm(w.sellerName) === nName))) continue;
        b.working.push({ sellerKey: key, sellerName: r.name || null, source: "roster" });
      }
    }

    // Resolve nome das lojas que só têm gente trabalhando (não vieram do whoIsOff).
    const semNome = Array.from(map.values()).filter((b) => !b.storeName).map((b) => b.storeId);
    if (semNome.length) {
      const ph = semNome.map(() => "?").join(",");
      const rows = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND id IN (${ph})`).all(orgId, ...semNome) as any[];
      const names = new Map(rows.map((r) => [r.id, r.name]));
      for (const b of map.values()) if (!b.storeName) b.storeName = names.get(b.storeId) || null;
    }
    const byName = (a: { sellerName: string | null }, b: { sellerName: string | null }) => (a.sellerName || "").localeCompare(b.sellerName || "");
    const out = Array.from(map.values());
    for (const b of out) { b.working.sort(byName); b.off.sort(byName); }
    return out.sort((a, b) => (a.storeName || "").localeCompare(b.storeName || ""));
  }
}
