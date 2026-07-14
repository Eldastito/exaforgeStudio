/**
 * Retail Ops — Conciliação de vendas (ADR-083 Fase E / ADR-084 supervisionado).
 *
 * Importa o "Fechamento de Caixa - Diário" do Alterdata (PdvUP/Moda) — a venda
 * REAL do sistema por loja/dia — grava em retail_daily_closings.system_total e
 * compara com o total INFORMADO pela loja → divergência. É a fonte externa do
 * modo supervisionado (a TOULON): o ZappFlow não é o PDV, então o system_total
 * vem do export, não dos pedidos do núcleo (ADR-084 D3). Isolado por org.
 */
import db from "./db.js";
import { RetailClosingService } from "./RetailOpsService.js";
import { logAuthEvent } from "./auditLog.js";

// "R$ 2.253,33" → 2253.33  (remove R$/espaços, ponto de milhar, vírgula decimal)
function parseMoney(s: any): number {
  if (s == null) return 0;
  const clean = String(s).replace(/r\$/i, "").replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(clean);
  return isNaN(n) ? 0 : n;
}

// "...: 13/07/2026 Até..." → "2026-07-13"
function parseDate(s: any): string | null {
  const m = String(s || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Divide uma linha CSV respeitando campos entre aspas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === "," && !inQ) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export type ReconRecord = { lojaLabel: string; lojaCode: string | null; date: string | null; systemTotal: number; grossOut: number; discount: number };

export class RetailReconciliationService {
  /** Parseia o CSV do Alterdata → registros (loja, data, venda do sistema). Dedup por (loja, dia). */
  static parseAlterdataCaixaDiario(csvText: string): ReconRecord[] {
    const lines = String(csvText || "").split(/\r?\n/).filter((l) => l.trim().length);
    const seen = new Set<string>();
    const records: ReconRecord[] = [];
    const valueAfter = (fields: string[], label: string): string | null => {
      const i = fields.findIndex((f) => f.trim() === label.trim());
      return i >= 0 && i + 1 < fields.length ? fields[i + 1] : null;
    };
    for (const line of lines) {
      const f = splitCsvLine(line);
      const lojaRaw = valueAfter(f, "Lojas :");
      if (!lojaRaw) continue; // linha sem cabeçalho de loja → ignora
      const lojaLabel = lojaRaw.trim();
      const periodo = f.find((x) => x.includes("Período das Vendas"));
      const date = parseDate(periodo);
      const systemTotal = parseMoney(valueAfter(f, "Valor Saída Líquida (=) :") ?? valueAfter(f, "Valor Total de Peças Vendidas : "));
      const key = `${lojaLabel}|${date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const codeMatch = lojaLabel.match(/^(\d+)/);
      records.push({
        lojaLabel,
        lojaCode: codeMatch ? codeMatch[1] : null,
        date,
        systemTotal,
        grossOut: parseMoney(valueAfter(f, "Valor Saída Bruta:")),
        discount: parseMoney(valueAfter(f, "Desconto (-) :")),
      });
    }
    return records;
  }

  /** Casa o registro a uma loja cadastrada (por código, número do nome ou nome). */
  private static matchStore(stores: any[], rec: ReconRecord): any | null {
    const label = rec.lojaLabel.toLowerCase();
    return stores.find((s) => {
      const code = (s.code || "").toString().trim();
      const name = (s.name || "").toString().trim().toLowerCase();
      if (code && (code === rec.lojaCode || code === rec.lojaLabel || rec.lojaLabel.includes(code))) return true;
      if (name && (name === label || label.includes(name) || name.includes(label))) return true;
      return false;
    }) || null;
  }

  /**
   * Importa o CSV e concilia: grava system_total e, se a loja já informou o
   * fechamento, calcula a divergência (informado − sistema). Tolerância default
   * R$0,01. Retorna o relatório com casadas e não-casadas.
   */
  static importCaixaDiario(orgId: string, csvText: string, opts: { toleranceBRL?: number } = {}, actorId?: string): any {
    const tol = opts.toleranceBRL != null ? Number(opts.toleranceBRL) : 0.01;
    const records = this.parseAlterdataCaixaDiario(csvText);
    const stores = db.prepare(`SELECT id, code, name FROM retail_stores WHERE organization_id = ? AND active = 1`).all(orgId) as any[];

    const results: any[] = [];
    const unmatched: string[] = [];
    let matched = 0, divergences = 0;

    for (const rec of records) {
      if (!rec.date) continue;
      const store = this.matchStore(stores, rec);
      if (!store) { unmatched.push(rec.lojaLabel); results.push({ ...rec, storeId: null, matched: false }); continue; }
      matched++;
      const closing = RetailClosingService.getOrCreate(orgId, store.id, rec.date);
      const informed = Number(closing.informed_total || 0);
      const divergence = informed > 0 ? Math.round((informed - rec.systemTotal) * 100) / 100 : null;
      const status = divergence === null ? null : (Math.abs(divergence) > tol ? "divergent" : "ok");
      if (status === "divergent") divergences++;
      db.prepare(
        `UPDATE retail_daily_closings SET system_total = ?, divergence_status = COALESCE(?, divergence_status), updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`
      ).run(rec.systemTotal, status, orgId, closing.id);
      results.push({ storeId: store.id, storeName: store.name, date: rec.date, systemTotal: rec.systemTotal, informed, divergence, status, matched: true });
    }

    try { logAuthEvent(orgId, actorId || "system", null, "RETAIL_RECONCILIATION_IMPORTED", { parsed: records.length, matched, divergences }); } catch { /* noop */ }
    return { parsed: records.length, matched, unmatchedCount: unmatched.length, unmatched, divergences, results };
  }
}
