/**
 * Retail Floor — Resumo diário da loja por WhatsApp (ADR-150, Fatia 10).
 *
 * A materialização da mensagem-exemplo do PRD ("Hoje a Loja 1005 realizou 84
 * atendimentos. A conversão confirmada foi de 31%, contra 36% na média...").
 * Tudo FATO CALCULADO do próprio módulo (RN-150-006): o texto relata números
 * e aponta onde agir — não inventa causa nem promete transferência (isso é do
 * Comprador IA/ADR-137, que consome os mesmos sinais).
 *
 * Operação (convenção #7 — best-effort, nunca throw pro caller):
 *  - Opt-in por org: settings.daily_digest_enabled (default 0) + digest_hour
 *    (default 20, HORA DO BRASIL = UTC-3 fixo, sem DST desde 2019).
 *  - 1 resumo por (org, loja, dia) — dedupe pelo unique de
 *    retail_floor_digest_log; o passe horário pode rodar N vezes.
 *  - Só loja com TURNO no dia (sem operação, sem spam).
 *  - Destinatários: retail_store_responsibles ativos da loja (ADR-108);
 *    fallback: whatsapp_identifier da própria loja. Sem destino → não envia
 *    nem marca o log (quando cadastrarem, o próximo passe envia).
 *  - `send` é injetado (Scheduler passa o canal real; teste passa um stub).
 *
 * RN-150-001: orgId 1º arg; tudo filtra organization_id.
 */
import db from "./db.js";
import { randomUUID } from "crypto";
import { RetailFloorSettingsService } from "./RetailFloorService.js";
import { RetailFloorAnalyticsService } from "./RetailFloorAnalyticsService.js";

const BRT_OFFSET_HOURS = -3;
const brtHour = (now: Date) => ((now.getUTCHours() + BRT_OFFSET_HOURS) + 24) % 24;
const dayISO = (base: string, offset: number) => {
  const d = new Date(`${base}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const brDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const brl = (n: number) => `R$ ${Number(n || 0).toFixed(2).replace(".", ",")}`;

const LOSS_LABEL: Record<string, string> = {
  price: "preço/condição", size_fit: "tamanho/modelagem", service_time: "atendimento/tempo", other: "outro motivo",
  "product:no_assortment": "peça fora do mix", "product:no_local_stock": "sem estoque local",
  "product:no_network_stock": "sem estoque na rede", "product:missing_size": "falta de tamanho",
  "product:missing_color": "falta de cor", "product:missing_category": "falta de categoria",
};

export class RetailFloorDigestService {
  /**
   * Monta o texto do resumo do dia de UMA loja — determinístico, só fatos.
   * Linhas sem dado não aparecem. Retorna null quando o dia não teve
   * atendimento (nada a resumir).
   */
  static buildMessage(orgId: string, storeId: string, date: string): string | null {
    const day = RetailFloorAnalyticsService.store(orgId, storeId, date, date);
    if (!day.totals.attendances) return null;
    const hist = RetailFloorAnalyticsService.store(orgId, storeId, dayISO(date, -28), dayISO(date, -1));

    const t = day.totals;
    const lines: string[] = [];
    lines.push(`*${day.storeName} — Atendimento de Loja, resumo de ${brDate(date)}*`);

    let conv = `• ${t.attendances} atendimentos (${t.decided} com desfecho)`;
    if (t.conversionConfirmedPct != null) {
      conv += `; conversão confirmada ${t.conversionConfirmedPct}%`;
      if (hist.totals.conversionConfirmedPct != null) conv += ` (média 28d: ${hist.totals.conversionConfirmedPct}%)`;
      if (t.conversionDeclaredPct != null) conv += `; declarada ${t.conversionDeclaredPct}%`;
    }
    lines.push(conv + ".");

    if (t.avgServiceMinutes != null) {
      let l = `• Tempo médio de atendimento: ${t.avgServiceMinutes}min`;
      if (t.confirmedValue > 0) l += `; ${brl(t.confirmedValue)} confirmados no PDV`;
      lines.push(l + ".");
    }

    const losses = day.lossPareto as any[];
    if (losses.length) {
      const totalLoss = losses.reduce((acc, l) => acc + l.count, 0);
      const top = losses[0];
      lines.push(`• Principal perda: ${LOSS_LABEL[top.reason] || top.reason} (${Math.round((top.count / totalLoss) * 100)}% de ${totalLoss} perdas).`);
    }
    if (day.topUnmet.length) {
      const u = day.topUnmet[0];
      lines.push(`• Peça mais pedida sem atender: ${u.item} (${LOSS_LABEL[`product:${u.reason}`] || u.reason}, ${u.count}x).`);
    }

    const byHour = day.byHour as any[];
    if (byHour.length) {
      const peak = byHour.reduce((a, b) => (b.count > a.count ? b : a));
      let l = `• Pico às ${peak.hour}h (${peak.count} atendimentos)`;
      const qd = db.prepare(`SELECT evidence_json FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`)
        .get(orgId, `retail_floor.queue_delay|${storeId}|${date}`) as any;
      if (qd) {
        try { l += `; equipe 100% ocupada por ${JSON.parse(qd.evidence_json).allBusyMinutes}min no dia`; } catch { /* evidência malformada não derruba o resumo */ }
      }
      lines.push(l + ".");
    }

    if (t.unmatchedCount > 0) lines.push(`• ${t.unmatchedCount} conversão(ões) declarada(s) sem venda no PDV — conferir lançamento/vendedor no caixa.`);
    if (t.pendingCount > 0) lines.push(`• ${t.pendingCount} aguardando o lançamento do PDV pra confirmar.`);

    lines.push(day.inCalibration
      ? "_Números do módulo em calibração — não valem pra cobrança._"
      : "_Detalhes no ZappFlow: Atendimento de Loja › Indicadores._");
    return lines.join("\n");
  }

  /**
   * Passe de envio da org (chamado pelo Scheduler por hora, best-effort).
   * `now`/`send` injetados. Retorna quantos resumos enviou.
   */
  static async runDigestPass(orgId: string, opts: { now: Date; send: (target: string, message: string) => Promise<any> }): Promise<number> {
    const settings = RetailFloorSettingsService.get(orgId);
    if (!settings.dailyDigestEnabled) return 0;
    if (brtHour(opts.now) < settings.digestHour) return 0;
    const date = opts.now.toISOString().slice(0, 10);

    const stores = db.prepare(
      `SELECT DISTINCT s.id, s.name, s.whatsapp_identifier FROM retail_floor_shifts sh
         JOIN retail_stores s ON s.organization_id = sh.organization_id AND s.id = sh.store_id AND s.active = 1
        WHERE sh.organization_id = ? AND date(sh.opened_at) = ?`
    ).all(orgId, date) as any[];

    let sent = 0;
    for (const store of stores) {
      try {
        const already = db.prepare(`SELECT id FROM retail_floor_digest_log WHERE organization_id = ? AND store_id = ? AND digest_date = ?`).get(orgId, store.id, date);
        if (already) continue;
        const message = this.buildMessage(orgId, store.id, date);
        if (!message) continue;
        const responsibles = db.prepare(
          `SELECT whatsapp_identifier FROM retail_store_responsibles WHERE organization_id = ? AND store_id = ? AND active = 1`
        ).all(orgId, store.id) as any[];
        const targets = [...new Set(responsibles.map((r) => String(r.whatsapp_identifier)).concat(store.whatsapp_identifier ? [String(store.whatsapp_identifier)] : []).filter(Boolean))];
        if (!targets.length) continue; // sem destino: não marca o log — o próximo passe tenta de novo

        try {
          db.prepare(`INSERT INTO retail_floor_digest_log (id, organization_id, store_id, digest_date, sent_to) VALUES (?, ?, ?, ?, ?)`)
            .run(randomUUID(), orgId, store.id, date, targets.join(","));
        } catch { continue; } // corrida entre processos: outro passe já pegou

        for (const target of targets) {
          try { await opts.send(target, message); } catch (e) { console.error("[RetailFloor] envio de resumo falhou", store.id, target, e); }
        }
        sent++;
      } catch (e) { console.error("[RetailFloor] resumo da loja falhou", store.id, e); }
    }
    return sent;
  }
}

export default RetailFloorDigestService;
