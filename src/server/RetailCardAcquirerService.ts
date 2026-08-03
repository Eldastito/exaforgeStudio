/**
 * Retail Ops — Conferência de RECEBÍVEIS DE CARTÃO (ADR-083 Fase R1).
 *
 * DUAS FONTES DE VERDADE, UM CRUZAMENTO:
 *  - `retail_pdv_card_installments` — o que a LOJA registrou (via Alterdata).
 *  - `retail_card_acquirer_installments` — o que o ADQUIRENTE (Sicredi) diz que
 *     vai depositar / depositou.
 *
 * O valor operacional está em confrontar as duas listas — se o PDV registrou
 * R$ 3.000 numa venda e o adquirente vai depositar R$ 2.800 (fora a taxa
 * esperada), esse gap costuma ser cancelamento não registrado, chargeback ou
 * erro de bandeira. Aqui a gente detecta, categoriza e mostra em cores.
 *
 * Decisões:
 *  - **RN-R1-001 — Chave de match:** (numero_transacao, parcela). O NSU (número
 *    sequencial único) é o identificador universal da transação de cartão;
 *    ambos os lados (PDV e adquirente) o carregam. Quando falta NSU no PDV
 *    (import antigo), a linha cai em `só adquirente` pra revisão manual.
 *  - **RN-R1-002 — Tolerância de valor:** diferenças <= R$ 0,05 são consideradas
 *    match (arredondamento entre sistemas). Acima disso vira `diverge`.
 *  - **RN-R1-003 — Sync HTTP � stub at� credenciais.** Sicredi n�o publica API
 *    aberta de recebíveis (o portal do dev cobre PIX/Cobrança/DDA/Extrato,
 *    não Adquirência). Enquanto a Sicredi não entrega manual + credenciais,
 *    ficamos com `importManual` (POST /card-acquirer/import) — o financeiro
 *    envia JSON do que baixou do internet banking. Quando as credenciais
 *    chegarem, `syncFromApi` implementa a chamada real; o resto da cadeia
 *    (reconcile + UI) já está pronto.
 *  - **Retrocompat** — zero mudança na aba Recebíveis existente; a
 *    conferência é um MODO novo (opt-in via toggle na UI).
 *  - **Multi-tenant** — isolamento estrito em toda query por
 *    `organization_id`.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

export type AcquirerRow = {
  filial?: string | null;
  merchantId?: string | null;
  numeroTransacao: string;
  autorizacao?: string | null;
  bandeira?: string | null;
  produto?: string | null;
  parcela?: string | null;
  parcelaNum?: number | null;
  parcelasTotal?: number | null;
  dataVenda?: string | null;
  dataVencimento: string;
  valorBruto: number;
  valorLiquido?: number | null;
  taxa?: number | null;
  status?: string | null;
  raw?: any;
};

const round2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;

export class RetailCardAcquirerService {
  /**
   * Import manual (JSON) — origem 'manual' ou 'sicredi'. Upsert por
   * (org, source, numero_transacao, parcela). Retorna contadores.
   */
  static importManual(orgId: string, source: string, rows: AcquirerRow[], actorId?: string): { inserted: number; updated: number; skipped: number } {
    const src = String(source || "manual").trim().toLowerCase();
    if (!["sicredi", "manual"].includes(src)) throw new Error("source deve ser 'sicredi' ou 'manual'");
    if (!Array.isArray(rows)) throw new Error("rows deve ser uma lista");
    const ins = db.prepare(
      `INSERT INTO retail_card_acquirer_installments
         (id, organization_id, source, filial, merchant_id, numero_transacao, autorizacao,
          bandeira, produto, parcela, parcela_num, parcelas_total,
          data_venda, data_vencimento, valor_bruto, valor_liquido, taxa, status, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, source, numero_transacao, parcela) DO UPDATE SET
         filial = COALESCE(excluded.filial, retail_card_acquirer_installments.filial),
         merchant_id = COALESCE(excluded.merchant_id, retail_card_acquirer_installments.merchant_id),
         autorizacao = COALESCE(excluded.autorizacao, retail_card_acquirer_installments.autorizacao),
         bandeira = COALESCE(excluded.bandeira, retail_card_acquirer_installments.bandeira),
         produto = COALESCE(excluded.produto, retail_card_acquirer_installments.produto),
         parcela_num = COALESCE(excluded.parcela_num, retail_card_acquirer_installments.parcela_num),
         parcelas_total = COALESCE(excluded.parcelas_total, retail_card_acquirer_installments.parcelas_total),
         data_venda = COALESCE(excluded.data_venda, retail_card_acquirer_installments.data_venda),
         data_vencimento = excluded.data_vencimento,
         valor_bruto = excluded.valor_bruto,
         valor_liquido = excluded.valor_liquido,
         taxa = excluded.taxa,
         status = COALESCE(excluded.status, retail_card_acquirer_installments.status),
         raw_json = COALESCE(excluded.raw_json, retail_card_acquirer_installments.raw_json)`
    );
    let inserted = 0, updated = 0, skipped = 0;
    const tx = db.transaction(() => {
      for (const r of rows) {
        if (!r?.numeroTransacao || !r?.dataVencimento) { skipped++; continue; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.dataVencimento))) { skipped++; continue; }
        // Se já existe, é update; senão, insert. SQLite não devolve isso direto;
        // conto pelo changes.
        const before = db.prepare(`SELECT 1 FROM retail_card_acquirer_installments WHERE organization_id = ? AND source = ? AND numero_transacao = ? AND COALESCE(parcela,'') = COALESCE(?, '')`).get(orgId, src, r.numeroTransacao, r.parcela || null);
        ins.run(
          randomUUID(), orgId, src,
          r.filial || null, r.merchantId || null, r.numeroTransacao, r.autorizacao || null,
          r.bandeira || null, r.produto || null, r.parcela || null,
          r.parcelaNum ?? null, r.parcelasTotal ?? null,
          r.dataVenda || null, r.dataVencimento,
          round2(r.valorBruto), round2(r.valorLiquido ?? 0), round2(r.taxa ?? 0),
          r.status || "previsto", r.raw ? JSON.stringify(r.raw) : null,
        );
        if (before) updated++; else inserted++;
      }
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", src, "RETAIL_CARD_ACQUIRER_IMPORTED", { source: src, inserted, updated, skipped }); } catch { /* noop */ }
    return { inserted, updated, skipped };
  }

  /**
   * Sync via HTTP com a API da Sicredi — STUB.
   * Enquanto não temos credenciais + manual do endpoint específico da
   * Adquirência, esta função é um placeholder que devolve erro claro pra UI
   * cobrar credenciais. Quando o manual chegar, implementar aqui a chamada
   * OAuth2 + endpoint de recebíveis; o resto do fluxo (reconcile + UI) já
   * consome a mesma tabela `retail_card_acquirer_installments`.
   */
  static async syncFromSicrediApi(_orgId: string, _opts: { start: string; end: string }): Promise<never> {
    throw new Error("sicredi_api_not_configured");
  }

  /**
   * Cruza PDV × Adquirente no intervalo. Categoriza cada parcela em:
   *   - match_exato: NSU bate + valor bate (≤ R$0,05)
   *   - diverge_valor: NSU bate mas valor difere
   *   - so_pdv: NSU só no PDV (sem contrapartida no adquirente)
   *   - so_adquirente: NSU só no adquirente (sem contrapartida no PDV)
   * `source` filtra o lado do adquirente (default 'sicredi').
   */
  static reconcile(orgId: string, start: string, end: string, opts?: { source?: string }): any {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error("start e end (YYYY-MM-DD) obrigatórios");
    const source = String(opts?.source || "sicredi").toLowerCase();
    const pdv = db.prepare(
      `SELECT numero, parcela, valor, liquido, vencimento, codigo_cartao, filial
         FROM retail_pdv_card_installments
        WHERE organization_id = ? AND vencimento BETWEEN ? AND ?`
    ).all(orgId, start, end) as any[];
    const acq = db.prepare(
      `SELECT numero_transacao, parcela, valor_bruto, valor_liquido, data_vencimento, bandeira, filial
         FROM retail_card_acquirer_installments
        WHERE organization_id = ? AND source = ? AND data_vencimento BETWEEN ? AND ?`
    ).all(orgId, source, start, end) as any[];
    const keyOf = (nsu: any, parcela: any) => `${String(nsu || "").trim()}|${String(parcela || "").trim()}`;
    const pdvIdx = new Map(pdv.map((r: any) => [keyOf(r.numero, r.parcela), r]));
    const acqIdx = new Map(acq.map((r: any) => [keyOf(r.numero_transacao, r.parcela), r]));

    const matched: any[] = [];
    const diverged: any[] = [];
    const onlyPdv: any[] = [];
    const onlyAcquirer: any[] = [];

    for (const [k, p] of pdvIdx) {
      const a = acqIdx.get(k);
      if (!a) { onlyPdv.push({ ...p, side: "pdv" }); continue; }
      const gap = round2(Number(p.valor || 0) - Number(a.valor_bruto || 0));
      const row = {
        numero: p.numero, parcela: p.parcela, vencimento: p.vencimento,
        pdvValor: round2(p.valor), pdvLiquido: round2(p.liquido),
        acquirerValor: round2(a.valor_bruto), acquirerLiquido: round2(a.valor_liquido),
        gap, bandeiraPdv: p.codigo_cartao, bandeiraAcq: a.bandeira, filial: p.filial || a.filial,
      };
      if (Math.abs(gap) <= 0.05) matched.push(row); else diverged.push(row);
    }
    for (const [k, a] of acqIdx) {
      if (!pdvIdx.has(k)) onlyAcquirer.push({ ...a, side: "acquirer" });
    }

    const sumBruto = (arr: any[], f: string) => round2(arr.reduce((s, r) => s + (Number(r[f]) || 0), 0));
    return {
      start, end, source,
      counts: { matched: matched.length, diverged: diverged.length, onlyPdv: onlyPdv.length, onlyAcquirer: onlyAcquirer.length },
      totals: {
        pdv: sumBruto(pdv, "valor"),
        acquirer: sumBruto(acq, "valor_bruto"),
        divergedGap: round2(diverged.reduce((s, r) => s + (r.gap || 0), 0)),
      },
      matched, diverged, onlyPdv, onlyAcquirer,
    };
  }

  static wipe(orgId: string, source: string): number {
    const info = db.prepare(`DELETE FROM retail_card_acquirer_installments WHERE organization_id = ? AND source = ?`).run(orgId, source);
    return info.changes;
  }
}
