/**
 * Retail Ops — Boletas em tempo real (ADR-083, Fase C3).
 *
 * A loja vende com boleta MANUSCRITA de talão sequencial (ex.: Nº 005988) e
 * só lança as vendas no PDV à noite — a HORA real de cada venda se perdia.
 * O fluxo aqui devolve essa hora sem mudar a rotina do papel:
 *
 *   1. O gerente ABRE O DIA informando o nº inicial do talão.
 *   2. A cada venda, gerente/vendedor CLICA no botão — o servidor calcula o
 *      próximo nº da sequência e grava o timestamp DO SERVIDOR (a hora do
 *      clique é a hora da venda; nada de hora vinda do cliente — mesma regra
 *      do RN-150-002).
 *   3. À noite, no fechamento, o range informado (inicial/final) CONFERE com
 *      os cliques (derived.boletaClicksGap no submitDetailed), e o nº da
 *      boleta CASA com a venda do PDV (retail_pdv_sales.boleta) quando o
 *      lançamento noturno sincroniza — clique (hora real) × PDV (valor,
 *      peças, vendedor). O match é DERIVADO por query na leitura (RN-004:
 *      nunca coluna de vínculo mutável).
 *
 * Decisões:
 *  - Sequência ATÔMICA: transação com COUNT dentro da tx antes do INSERT
 *    (padrão AC-012) + unique index parcial (org, loja, dia, nº) ativo —
 *    dois cliques simultâneos nunca geram o mesmo número.
 *  - Desfazer clique = UPDATE status='cancelled' (nunca DELETE, convenção
 *    #9) e SÓ o último ativo — cancelar do meio furaria a sequência do
 *    talão. O próximo clique reusa o número liberado.
 *  - Nº inicial só pode ser corrigido enquanto não há clique ativo (os
 *    números gravados derivam dele).
 *  - Formato preservado: "017752" mantém a largura dos zeros do talão.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

const round2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;

/** "017752" → { n: 17752, width: 6 }. null quando não numérico. */
function parseNumber(s: any): { n: number; width: number } | null {
  const digits = String(s ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return { n: parseInt(digits, 10), width: digits.length };
}
function formatNumber(n: number, width: number): string {
  return String(n).padStart(width, "0");
}
/** Chave de match com o PDV: sem zeros à esquerda ("017752" ≡ "17752"). */
function matchKey(s: any): string {
  return String(s ?? "").replace(/\D/g, "").replace(/^0+/, "") || "0";
}

export class RetailBoletaService {
  static getDay(orgId: string, storeId: string, day: string): any | null {
    return (db.prepare(`SELECT * FROM retail_boleta_days WHERE organization_id = ? AND store_id = ? AND day = ?`).get(orgId, storeId, day) as any) || null;
  }

  /** Abre o dia do talão (ou corrige o nº inicial enquanto não houver clique). */
  static openDay(orgId: string, storeId: string, day: string, initialNumber: string, actorId?: string): any {
    const parsed = parseNumber(initialNumber);
    if (!parsed) throw new Error("Informe o número inicial do talão (só dígitos, ex.: 017752).");
    const existing = this.getDay(orgId, storeId, day);
    if (existing) {
      const clicks = this.activeCount(orgId, storeId, day);
      if (clicks > 0 && matchKey(existing.initial_number) !== matchKey(initialNumber)) {
        throw new Error(`Já existem ${clicks} venda(s) registrada(s) hoje — o número inicial não pode mais mudar (os números das boletas derivam dele).`);
      }
      db.prepare(`UPDATE retail_boleta_days SET initial_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(String(initialNumber).trim(), existing.id);
    } else {
      db.prepare(`INSERT INTO retail_boleta_days (id, organization_id, store_id, day, initial_number, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), orgId, storeId, day, String(initialNumber).trim(), actorId || null);
    }
    try { logAuthEvent(orgId, actorId || "system", storeId, "RETAIL_BOLETA_DAY_OPENED", { day, initialNumber }); } catch { /* noop */ }
    return this.getDay(orgId, storeId, day);
  }

  private static activeCount(orgId: string, storeId: string, day: string): number {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM retail_boleta_events WHERE organization_id = ? AND store_id = ? AND day = ? AND status = 'active'`).get(orgId, storeId, day) as any;
    return Number(r?.n || 0);
  }

  /** Próximo número da sequência (o que o botão mostra antes do clique). */
  static nextNumber(orgId: string, storeId: string, day: string): string | null {
    const d = this.getDay(orgId, storeId, day);
    if (!d) return null;
    const parsed = parseNumber(d.initial_number)!;
    return formatNumber(parsed.n + this.activeCount(orgId, storeId, day), parsed.width);
  }

  /**
   * O CLIQUE — uma venda realizada AGORA. Transação atômica (AC-012): o
   * número sai do COUNT dentro da tx; o unique parcial segura corrida.
   * O timestamp é do servidor (CURRENT_TIMESTAMP do INSERT).
   */
  static click(orgId: string, storeId: string, day: string, opts: { sellerName?: string | null; idempotencyKey?: string | null } = {}, actorId?: string): any {
    const d = this.getDay(orgId, storeId, day);
    if (!d) throw new Error("Abra o dia primeiro: informe o número inicial do talão de boletas.");
    const parsed = parseNumber(d.initial_number)!;
    const idemKey = opts.idempotencyKey ? String(opts.idempotencyKey).trim().slice(0, 100) : null;

    // BOL-002: idempotência. Se já houve um clique com esta chave (double-tap/
    // retry/resposta perdida), devolve o MESMO evento — não consome outro número.
    if (idemKey) {
      const existing = db.prepare(`SELECT * FROM retail_boleta_events WHERE organization_id = ? AND store_id = ? AND idempotency_key = ?`).get(orgId, storeId, idemKey) as any;
      if (existing) return { ...existing, deduped: true };
    }

    const id = randomUUID();
    try {
      const tx = db.transaction(() => {
        const seq = this.activeCount(orgId, storeId, day) + 1;
        const number = formatNumber(parsed.n + seq - 1, parsed.width);
        db.prepare(
          `INSERT INTO retail_boleta_events (id, organization_id, store_id, day, boleta_number, seq, seller_name, clicked_by, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, orgId, storeId, day, number, seq, opts.sellerName ? String(opts.sellerName).trim() : null, actorId || null, idemKey);
      });
      tx();
    } catch (e: any) {
      // Corrida: dois cliques simultâneos com a MESMA chave — o índice único
      // barra o segundo; devolve o vencedor (idempotente, sem número extra).
      if (idemKey && String(e?.code || "").includes("SQLITE_CONSTRAINT")) {
        const winner = db.prepare(`SELECT * FROM retail_boleta_events WHERE organization_id = ? AND store_id = ? AND idempotency_key = ?`).get(orgId, storeId, idemKey) as any;
        if (winner) return { ...winner, deduped: true };
      }
      throw e;
    }
    const ev = db.prepare(`SELECT * FROM retail_boleta_events WHERE id = ?`).get(id) as any;
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_BOLETA_CLICKED", { storeId, day, number: ev.boleta_number }); } catch { /* noop */ }
    return ev;
  }

  /** Desfaz o ÚLTIMO clique ativo (misclick). Nunca DELETE; do meio, nunca. */
  static cancelClick(orgId: string, eventId: string, actorId?: string): any {
    const ev = db.prepare(`SELECT * FROM retail_boleta_events WHERE organization_id = ? AND id = ?`).get(orgId, eventId) as any;
    if (!ev) throw new Error("Registro não encontrado.");
    if (ev.status !== "active") throw new Error("Este registro já foi cancelado.");
    const last = db.prepare(
      `SELECT id FROM retail_boleta_events WHERE organization_id = ? AND store_id = ? AND day = ? AND status = 'active' ORDER BY seq DESC LIMIT 1`
    ).get(orgId, ev.store_id, ev.day) as any;
    if (last?.id !== ev.id) throw new Error("Só o ÚLTIMO registro pode ser desfeito — cancelar um do meio furaria a sequência do talão.");
    db.prepare(`UPDATE retail_boleta_events SET status = 'cancelled', cancelled_by = ?, cancelled_at = CURRENT_TIMESTAMP WHERE id = ?`).run(actorId || null, ev.id);
    try { logAuthEvent(orgId, actorId || "system", ev.id, "RETAIL_BOLETA_CANCELLED", { storeId: ev.store_id, day: ev.day, number: ev.boleta_number }); } catch { /* noop */ }
    return db.prepare(`SELECT * FROM retail_boleta_events WHERE id = ?`).get(ev.id);
  }

  /**
   * Relatório do dia: cliques (com hora real) + match DERIVADO com o PDV por
   * (loja→filial, nº da boleta sem zeros, data) — depois do lançamento
   * noturno + sync Alterdata, cada clique ganha valor/peças/vendedor.
   */
  static dayReport(orgId: string, storeId: string, day: string): any {
    const d = this.getDay(orgId, storeId, day);
    const events = db.prepare(
      `SELECT id, boleta_number, seq, seller_name, status, clicked_at, cancelled_at FROM retail_boleta_events
        WHERE organization_id = ? AND store_id = ? AND day = ? ORDER BY seq, clicked_at`
    ).all(orgId, storeId, day) as any[];

    // Vendas do PDV do dia desta loja, indexadas pelo nº sem zeros à esquerda.
    const store = db.prepare(`SELECT code FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId) as any;
    const pdvByBoleta = new Map<string, any>();
    if (store?.code) {
      try {
        const rows = db.prepare(
          `SELECT boleta, valor, pecas, COALESCE(NULLIF(vendedor_codigo, ''), vendedor) AS matricula, rs.name AS seller_name
             FROM retail_pdv_sales s
             LEFT JOIN retail_sellers rs ON rs.organization_id = s.organization_id AND rs.matricula = COALESCE(NULLIF(s.vendedor_codigo, ''), s.vendedor)
            WHERE s.organization_id = ? AND s.filial = ? AND s.sale_date = ? AND COALESCE(s.status, 'N') <> 'C'`
        ).all(orgId, String(store.code), day) as any[];
        for (const r of rows) if (r.boleta != null) pdvByBoleta.set(matchKey(r.boleta), r);
      } catch { /* base sem PDV sync — match fica vazio */ }
    }

    const active = events.filter((e) => e.status === "active");
    const clicks = active.map((e) => {
      const pdv = pdvByBoleta.get(matchKey(e.boleta_number)) || null;
      return {
        id: e.id, number: e.boleta_number, seq: e.seq, sellerName: e.seller_name,
        clickedAt: e.clicked_at,
        pdv: pdv ? { valor: round2(pdv.valor), pecas: Number(pdv.pecas || 0), sellerName: pdv.seller_name || (pdv.matricula ? `Matrícula ${pdv.matricula}` : null) } : null,
      };
    });
    const matched = clicks.filter((c) => c.pdv);
    const byHour = new Map<string, { count: number; valor: number }>();
    for (const c of clicks) {
      // clicked_at é UTC do SQLite ("YYYY-MM-DD HH:MM:SS") — a UI converte pro
      // fuso local; aqui agrupamos pela hora UTC de forma estável.
      const h = String(c.clickedAt || "").slice(11, 13) || "??";
      const cur = byHour.get(h) || { count: 0, valor: 0 };
      cur.count += 1; cur.valor = round2(cur.valor + (c.pdv?.valor || 0));
      byHour.set(h, cur);
    }
    const lastNumber = active.length ? active[active.length - 1].boleta_number : null;
    return {
      day, storeId,
      initialNumber: d?.initial_number || null,
      nextNumber: d ? this.nextNumber(orgId, storeId, day) : null,
      lastNumber,
      count: active.length,
      cancelledCount: events.length - active.length,
      clicks,
      pdvMatch: { matched: matched.length, unmatched: active.length - matched.length, valorTotal: round2(matched.reduce((a, c) => a + (c.pdv!.valor || 0), 0)) },
      byHourUtc: Array.from(byHour.entries()).sort().map(([hour, v]) => ({ hour, ...v })),
    };
  }

  /**
   * BOL-006 — Auditoria da regra "5 produtos por boleta". Regra da loja: cada
   * boleta (talão impresso) tem no máximo 5 LINHAS, e cada linha é um produto
   * DISTINTO (código de barras). Várias unidades do MESMO código ocupam UMA
   * linha (ex.: 5 blusas G iguais = 1 linha), então a conta é por produto
   * distinto, nunca por peças. Fonte da verdade = itens lançados no PDV
   * (retail_pdv_sale_items): conta produtos distintos por boleta e sinaliza
   * quem passou de 5 — o "virtual" tem que encaixar no talão real. Sem PDV
   * sincronizado, devolve hasPdv=false (nada a conferir ainda).
   */
  static lineAudit(orgId: string, storeId: string, day: string, maxLinhas = 5): {
    hasPdv: boolean; maxLinhas: number; totalBoletas: number;
    overLimit: Array<{ boleta: string; produtos: number }>;
    boletas: Array<{ boleta: string; produtos: number; itens: number }>;
  } {
    const limit = Math.max(1, Math.trunc(Number(maxLinhas) || 5));
    const empty = { hasPdv: false, maxLinhas: limit, totalBoletas: 0, overLimit: [] as Array<{ boleta: string; produtos: number }>, boletas: [] as Array<{ boleta: string; produtos: number; itens: number }> };
    const store = db.prepare(`SELECT code FROM retail_stores WHERE organization_id = ? AND id = ?`).get(orgId, storeId) as any;
    if (!store?.code) return empty;
    let rows: any[] = [];
    try {
      rows = db.prepare(
        `SELECT boleta, COUNT(DISTINCT produto) AS produtos, COUNT(*) AS itens
           FROM retail_pdv_sale_items
          WHERE organization_id = ? AND filial = ? AND sale_date = ?
            AND boleta IS NOT NULL AND TRIM(boleta) <> ''
          GROUP BY boleta`
      ).all(orgId, String(store.code), day) as any[];
    } catch { return empty; } // base sem PDV sync — nada a auditar
    if (!rows.length) return empty;
    const boletas = rows
      .map((r) => ({ boleta: String(r.boleta), produtos: Number(r.produtos || 0), itens: Number(r.itens || 0) }))
      .sort((a, b) => a.boleta.localeCompare(b.boleta, undefined, { numeric: true }));
    const overLimit = boletas.filter((b) => b.produtos > limit).map((b) => ({ boleta: b.boleta, produtos: b.produtos }));
    return { hasPdv: true, maxLinhas: limit, totalBoletas: boletas.length, overLimit, boletas };
  }

  /**
   * BOL-005 — histórico curto (leitura): os últimos N dias com boletas da loja,
   * pra o gestor confirmar num relance que a contagem NÃO foi apagada. Derivado
   * por query (RN-004). Retorna, por dia, aberto/inicial/primeira/última/ativas/
   * canceladas.
   */
  static history(orgId: string, storeId: string, limit = 7): any[] {
    const n = Math.max(1, Math.min(31, Math.trunc(Number(limit) || 7)));
    const days = db.prepare(
      `SELECT DISTINCT day FROM retail_boleta_events WHERE organization_id = ? AND store_id = ? ORDER BY day DESC LIMIT ?`
    ).all(orgId, storeId, n) as any[];
    return days.map((row) => {
      const day = row.day;
      const d = this.getDay(orgId, storeId, day);
      const agg = db.prepare(
        `SELECT SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
                MIN(CASE WHEN status='active' THEN seq END) AS min_seq,
                MAX(CASE WHEN status='active' THEN seq END) AS max_seq
           FROM retail_boleta_events WHERE organization_id = ? AND store_id = ? AND day = ?`
      ).get(orgId, storeId, day) as any;
      const firstNum = agg?.min_seq != null ? (db.prepare(`SELECT boleta_number FROM retail_boleta_events WHERE organization_id=? AND store_id=? AND day=? AND status='active' AND seq=?`).get(orgId, storeId, day, agg.min_seq) as any)?.boleta_number : null;
      const lastNum = agg?.max_seq != null ? (db.prepare(`SELECT boleta_number FROM retail_boleta_events WHERE organization_id=? AND store_id=? AND day=? AND status='active' AND seq=?`).get(orgId, storeId, day, agg.max_seq) as any)?.boleta_number : null;
      return {
        day, initialNumber: d?.initial_number || null,
        firstNumber: firstNum || null, lastNumber: lastNum || null,
        count: Number(agg?.active || 0), cancelledCount: Number(agg?.cancelled || 0),
      };
    });
  }

  /**
   * Conferência do fechamento (chamada pelo submitDetailed): cliques do dia ×
   * range informado na folha. Gap ≠ 0 = alguém vendeu sem clicar (ou clicou
   * sem vender) — flag pro gestor, nunca bloqueio (D4).
   */
  static closingCheck(orgId: string, storeId: string, day: string, boletaInicial: any, boletaFinal: any): { clicks: number; rangeCount: number | null; gap: number | null } {
    const clicks = this.activeCount(orgId, storeId, day);
    const i = parseNumber(boletaInicial), f = parseNumber(boletaFinal);
    const rangeCount = i && f && f.n >= i.n ? f.n - i.n + 1 : null;
    return { clicks, rangeCount, gap: rangeCount != null && clicks > 0 ? rangeCount - clicks : null };
  }
}
