import db from "./db.js";
import { MissionService, Mission } from "./MissionService.js";

/**
 * MissionProactiveService — ADR-189 F11 (Mission OS): MISSÕES PROATIVAS (§34).
 *
 * O Radar/detectores já publicam `business_signals` (oportunidade/risco). Esta camada os traduz em
 * PROPOSTAS de missão — sem executar NADA. Postura SHADOW-first (§35): `off` (default) → nada;
 * `shadow` → CALCULA o que faria, não grava; `suggest` → grava rascunhos `system_generated` (que
 * aparecem no "Hoje" F7 e seguem o mesmo ciclo governado). NUNCA `auto`/autopilot — missão proativa
 * é sempre proposta; a execução segue exigindo o caminho governado (F5). Mapeamento sinal→missão é
 * DETERMINÍSTICO (domínio/tipo → forma de missão); domínio não mapeado → ignora (não força/inventa).
 *
 * Reusa business_signals (não cria fila paralela) + MissionService (contrato único). Dedup por
 * `signal:<id>` no baseline_state (aditivo, sem coluna nova). Isolado por org; idempotente.
 */

export type ProactiveMode = "off" | "shadow" | "suggest";

interface MissionShape { intentId: string; title: string; targetMetric: string | null; targetUnit: "BRL" | "count" | null; desiredState: string }

/** Mapa DETERMINÍSTICO sinal→missão. Só domínios/tipos conhecidos viram proposta (nunca força). */
function shapeForSignal(domain: string, signalType: string, impact: number | null): MissionShape | null {
  const d = String(domain || "").toLowerCase(), t = String(signalType || "").toLowerCase();
  const money = impact && impact > 0 ? ` (~R$ ${Number(impact).toLocaleString("pt-BR")})` : "";
  if (/recovery|churn|reten|inativ/.test(d) || /inactive|dormant|churn|inativ/.test(t))
    return { intentId: "recover_customer", title: `Recuperar clientes inativos${money}`, targetMetric: null, targetUnit: "count", desiredState: "recuperar clientes inativos" };
  if (/collection|cobran|receiv|inadimpl/.test(d) || /overdue|inadimpl|atras/.test(t))
    return { intentId: "collect_receivable", title: `Recuperar valores em atraso${money}`, targetMetric: null, targetUnit: "BRL", desiredState: "recuperar valores em atraso" };
  if (/vacancy|agenda|schedul/.test(d) || /vacancy|ocios|vago/.test(t))
    return { intentId: "fill_schedule", title: "Preencher a agenda", targetMetric: "appointments", targetUnit: "count", desiredState: "preencher a agenda" };
  if (/result_projection|cash|revenue/.test(d) || /below_breakeven|rupture|queda/.test(t))
    return { intentId: "grow_revenue", title: "Recuperar o ritmo de faturamento", targetMetric: "revenue", targetUnit: "BRL", desiredState: "aumentar a receita" };
  return null;
}

export interface ProactiveProposal { signalId: string; domain: string; shape: MissionShape; alreadyExists: boolean }
export interface ProactiveResult { mode: ProactiveMode; proposals: ProactiveProposal[]; created: Mission[]; note: string }

export class MissionProactiveService {
  static mode(orgId: string): ProactiveMode {
    try {
      const r = db.prepare(`SELECT mission_proactive_mode m FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
      const m = String(r?.m || "off");
      return (["off", "shadow", "suggest"] as string[]).includes(m) ? (m as ProactiveMode) : "off";
    } catch { return "off"; }
  }

  static setMode(orgId: string, mode: string, _actor?: string): { mode: ProactiveMode } {
    const m = String(mode || "").toLowerCase();
    if (!(["off", "shadow", "suggest"] as string[]).includes(m)) throw new Error("Modo inválido (off|shadow|suggest). 'auto' não é permitido — missão proativa nunca executa sozinha.");
    db.prepare(`UPDATE organization_settings SET mission_proactive_mode = ? WHERE organization_id = ?`).run(m, orgId);
    return { mode: m as ProactiveMode };
  }

  /** Deriva as propostas dos sinais abertos (read-only). Não grava. */
  static scan(orgId: string): ProactiveProposal[] {
    let rows: any[] = [];
    try {
      rows = db.prepare(`
        SELECT id, domain, signal_type, impact_amount FROM business_signals
        WHERE organization_id = ? AND status = 'open' AND severity IN ('attention','risk') AND domain != 'mission'
        ORDER BY detected_at DESC LIMIT 20
      `).all(orgId) as any[];
    } catch { return []; }
    const out: ProactiveProposal[] = [];
    for (const r of rows) {
      const shape = shapeForSignal(r.domain, r.signal_type, r.impact_amount != null ? Number(r.impact_amount) : null);
      if (!shape) continue;
      const exists = !!db.prepare(`SELECT 1 FROM missions WHERE organization_id = ? AND source = 'system_generated' AND baseline_state = ?`).get(orgId, `signal:${r.id}`);
      out.push({ signalId: r.id, domain: r.domain, shape, alreadyExists: exists });
    }
    return out;
  }

  /**
   * Materializa conforme a postura. `off` → nada; `shadow` → só calcula; `suggest` → grava rascunhos
   * `system_generated` (nasce draft/off — nunca executa; dedup por signal). Idempotente.
   */
  static run(orgId: string, opts: { mode?: ProactiveMode; actor?: string } = {}): ProactiveResult {
    const mode = opts.mode || this.mode(orgId);
    const proposals = this.scan(orgId);
    const created: Mission[] = [];
    if (mode === "suggest") {
      for (const p of proposals) {
        if (p.alreadyExists) continue;
        const m = MissionService.create(orgId, {
          title: p.shape.title, desiredState: p.shape.desiredState,
          targetMetric: p.shape.targetMetric, targetUnit: p.shape.targetUnit,
          baselineState: `signal:${p.signalId}`,   // marcador de dedup (sem coluna nova)
          source: "system_generated",
        }, opts.actor);
        created.push(m);
      }
    }
    const note = mode === "off" ? "Missões proativas desligadas."
      : mode === "shadow" ? `Em shadow: ${proposals.length} missão(ões) seriam propostas (nada gravado).`
      : `${created.length} missão(ões) proposta(s) a partir de sinais.`;
    return { mode, proposals, created, note };
  }

  /** Passe do Scheduler: só orgs com o Mission Layer ligado + postura shadow/suggest. Best-effort. */
  static pass(): void {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`
        SELECT organization_id FROM organization_settings
        WHERE COALESCE(mission_layer_enabled,0) = 1 AND COALESCE(mission_proactive_mode,'off') != 'off'
      `).all() as any[];
    } catch { return; }
    for (const o of orgs) {
      try { this.run(o.organization_id); }
      catch (e) { console.error("[Mission] proactive pass falhou", o.organization_id, e); }
    }
  }
}

export default MissionProactiveService;
