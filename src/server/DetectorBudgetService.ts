/**
 * DetectorBudgetService — PRD 2 F12.2 (§84, CA17): TETO DIÁRIO de investigações
 * profundas (LLM) POR DETECTOR.
 *
 * Problema (§84): antes da F12.2 só havia teto por-org (`AiQuotaSignalService`) +
 * budget de plataforma (`ResearchBudgetService`). Nenhum limita o custo POR
 * DETECTOR — então um detector barulhento (um storm, F12.1) podia disparar
 * dezenas de investigações caras (`investigateDeep` → LLM) e drenar a verba de IA
 * da org inteira sozinho. Este service põe um teto diário por (org, detector).
 *
 * Como conta SEM tabela nova (CA1): reusa o `ai_usage_log` canônico — grava um
 * MARCADOR leve (`kind = 'radar_investigation:<detector>'`, custo 0; o custo real
 * do LLM segue registrado pelo próprio `chat()` em outra linha) a cada
 * investigação consumida, e conta os marcadores do DIA por detector. Derivado por
 * query (RN-004) — o "quanto já usei" nunca é contador mutável.
 *
 * Teto: default embutido (`DEFAULT_DAILY_CAP`), com override opcional por org
 * (`organization_settings.radar_detector_daily_budget` > 0). Isolado por org.
 * `now` injetável pra teste (janela do dia é UTC — [00:00, agora]).
 */
import db from "./db.js";
import { randomUUID } from "crypto";

const KIND_PREFIX = "radar_investigation:";
// Teto padrão: investigações profundas por detector por dia. Conservador — o
// caso comum precisa de poucas; o objetivo é conter o storm, não o uso normal.
export const DEFAULT_DAILY_CAP = 20;

export class DetectorBudgetService {
  /** Teto efetivo por detector/dia pra a org (override > 0, senão o default). */
  static capFor(orgId: string): number {
    try {
      const r = db.prepare(`SELECT radar_detector_daily_budget AS b FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
      const b = Number(r?.b) || 0;
      return b > 0 ? b : DEFAULT_DAILY_CAP;
    } catch { return DEFAULT_DAILY_CAP; }
  }

  /** Início do dia (UTC) de `now`, em ISO — a janela de contagem é [00:00, now]. */
  private static dayStartIso(now: number): string {
    const d = new Date(now);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
  }

  /** Quantas investigações o detector JÁ consumiu hoje (marcadores no usage log). */
  static usedToday(orgId: string, detector: string, now = Date.now()): number {
    try {
      const r = db.prepare(
        `SELECT COUNT(*) AS n FROM ai_usage_log WHERE organization_id = ? AND kind = ? AND created_at >= ?`
      ).get(orgId, `${KIND_PREFIX}${detector}`, this.dayStartIso(now).replace("T", " ").replace(/\.\d+Z$/, "")) as any;
      return Number(r?.n) || 0;
    } catch { return 0; }
  }

  /**
   * Estado do budget de um detector: {cap, used, remaining, allowed}. `allowed`
   * = ainda há saldo hoje. Fail-safe: em erro, ALLOW (não travar o Radar por
   * falha de contabilidade — o teto é proteção de custo, não gate de segurança).
   */
  static check(orgId: string, detector: string, now = Date.now()): { cap: number; used: number; remaining: number; allowed: boolean } {
    const cap = this.capFor(orgId);
    const used = this.usedToday(orgId, detector || "?", now);
    const remaining = Math.max(0, cap - used);
    return { cap, used, remaining, allowed: remaining > 0 };
  }

  /**
   * Registra o consumo de UMA investigação pelo detector (marcador no usage log).
   * Best-effort (convenção #7): erro aqui NUNCA propaga pro caller — no pior caso
   * a contagem fica levemente abaixo do real, o que só é generoso com o budget.
   */
  static consume(orgId: string, detector: string, meta: { model?: string | null } = {}): void {
    try {
      db.prepare(
        `INSERT INTO ai_usage_log (id, organization_id, model, kind, input_tokens, output_tokens, total_tokens, cost_usd, cost_brl)
         VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0)`
      ).run(randomUUID(), orgId, meta.model || null, `${KIND_PREFIX}${detector || "?"}`);
    } catch (e) {
      console.error("[DetectorBudgetService] consume falhou (best-effort)", e);
    }
  }

  /** Uso do dia por detector (observabilidade — alimenta a saúde do Radar F12.1). */
  static overview(orgId: string, now = Date.now()): { cap: number; detectors: Array<{ detector: string; used: number; remaining: number; allowed: boolean }> } {
    const cap = this.capFor(orgId);
    let rows: any[] = [];
    try {
      rows = db.prepare(
        `SELECT REPLACE(kind, ?, '') AS detector, COUNT(*) AS used
           FROM ai_usage_log WHERE organization_id = ? AND kind LIKE ? AND created_at >= ?
          GROUP BY kind ORDER BY used DESC`
      ).all(KIND_PREFIX, orgId, `${KIND_PREFIX}%`, this.dayStartIso(now).replace("T", " ").replace(/\.\d+Z$/, "")) as any[];
    } catch { rows = []; }
    return {
      cap,
      detectors: rows.map((r) => { const used = Number(r.used) || 0; return { detector: String(r.detector), used, remaining: Math.max(0, cap - used), allowed: used < cap }; }),
    };
  }
}

export default DetectorBudgetService;
