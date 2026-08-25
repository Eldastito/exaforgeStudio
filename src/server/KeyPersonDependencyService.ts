import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

/**
 * Key-Person Dependency (ADR-190 §38 / D9 — deferida da camada CEO, agora entregue).
 *
 * Detecta RISCO DE CONCENTRAÇÃO (single-point-of-failure): quando UMA pessoa carrega
 * boa parte da operação — receita concentrada num vendedor, atendimentos num
 * profissional. É um "desvio" ESTRUTURAL que o North Star (§4) quer expor e que
 * nenhum detector existente calcula.
 *
 * NATUREZA: serviço FINO, READ-ONLY, derivado por query (RN-004). NÃO é motor: o
 * alerta vai pra ESPINHA (`business_signals`, convenção nº 12) — nunca uma tabela
 * de alerta paralela — de onde flui SOZINHO pro snapshot executivo (F4) e pra
 * restrição (F5). Zero tabela nova.
 *
 * HONESTIDADE (RN-CEO-11): sem dado / operação de 1 pessoa / volume insuficiente →
 * `insufficient_data` (NUNCA inventa risco; um negócio de 1 dono não é "dependência"
 * a sinalizar — é a natureza dele). A concentração medida é FATO; a leitura de que
 * "isso é um risco" é HIPÓTESE (o sinal nasce advisory/estimate, nunca fato de perda).
 *
 * DINHEIRO role-gated (§73): o share é um % (não é dinheiro) e sempre aparece; os
 * valores em R$ por pessoa só saem com `includeMoney`.
 *
 * Janela de 90 dias: concentração é métrica ESTRUTURAL — a janela mensal seria
 * ruído de amostra. Documentado, não mágico.
 */

const WINDOW_DAYS = 90;
const MIN_PARTICIPANTS = 2;   // 1 pessoa não é "dependência" a sinalizar.
const MIN_VOLUME = 5;         // abaixo disso a concentração é ruído de amostra.
const HIGH = 60, MEDIUM = 45; // limiares de share % do topo.

export type ConcentrationRisk = "high" | "medium" | "low" | "insufficient_data";

export interface DimensionConcentration {
  dimension: "revenue" | "appointments";
  label: string;
  available: boolean;
  risk: ConcentrationRisk;
  topShare: number | null;     // % do total que o topo carrega
  topActorId: string | null;
  participants: number;
  totalVolume: number;         // nº de eventos (fact) — pedidos pagos / atendimentos
  basis: string;               // "fact" (a concentração é medida, não estimada)
  topActorAmount?: number | null; // R$ do topo (só com includeMoney; receita)
  totalAmount?: number | null;    // R$ total (só com includeMoney; receita)
}

export interface KeyPersonAssessment {
  generatedAt: string;
  windowDays: number;
  dimensions: DimensionConcentration[];
  hasRisk: boolean; // algum dimension high
}

function riskFor(topShare: number, participants: number, volume: number): ConcentrationRisk {
  if (participants < MIN_PARTICIPANTS || volume < MIN_VOLUME) return "insufficient_data";
  if (topShare >= HIGH) return "high";
  if (topShare >= MEDIUM) return "medium";
  return "low";
}

export class KeyPersonDependencyService {
  /** Concentração por dimensão (receita/atendimentos). Read-only, nunca inventa risco. */
  static assess(orgId: string, opts: { includeMoney?: boolean } = {}): KeyPersonAssessment {
    const includeMoney = opts.includeMoney !== false;
    const dimensions = [this.revenueConcentration(orgId, includeMoney), this.appointmentsConcentration(orgId)];
    return {
      generatedAt: new Date().toISOString(),
      windowDays: WINDOW_DAYS,
      dimensions,
      hasRisk: dimensions.some((d) => d.risk === "high"),
    };
  }

  /** Concentração de RECEITA por vendedor (pedidos pagos na janela). */
  private static revenueConcentration(orgId: string, includeMoney: boolean): DimensionConcentration {
    const rows = db.prepare(
      `SELECT seller_user_id AS actor, COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS v
         FROM orders
        WHERE organization_id = ? AND seller_user_id IS NOT NULL AND TRIM(seller_user_id) <> ''
          AND status IN ('pago','em_preparo','entregue','concluido')
          AND datetime(created_at) >= datetime('now', ?)
        GROUP BY seller_user_id`
    ).all(orgId, `-${WINDOW_DAYS} day`) as any[];
    const total = rows.reduce((s, r) => s + Number(r.v || 0), 0);
    const volume = rows.reduce((s, r) => s + Number(r.n || 0), 0);
    const participants = rows.length;
    const base: DimensionConcentration = {
      dimension: "revenue", label: "Concentração de receita (vendedor)", available: participants > 0,
      risk: "insufficient_data", topShare: null, topActorId: null, participants, totalVolume: volume, basis: "fact",
    };
    if (!participants || total <= 0) return base;
    const top = rows.reduce((a, b) => (Number(b.v) > Number(a.v) ? b : a));
    const topShare = Math.round((Number(top.v) / total) * 1000) / 10;
    base.topShare = topShare;
    base.topActorId = String(top.actor);
    base.risk = riskFor(topShare, participants, volume);
    if (includeMoney) { base.topActorAmount = Math.round(Number(top.v) * 100) / 100; base.totalAmount = Math.round(total * 100) / 100; }
    return base;
  }

  /** Concentração de ATENDIMENTOS por responsável (concluídos na janela). Sem dinheiro. */
  private static appointmentsConcentration(orgId: string): DimensionConcentration {
    const rows = db.prepare(
      `SELECT assigned_to AS actor, COUNT(*) AS n
         FROM appointments
        WHERE organization_id = ? AND assigned_to IS NOT NULL AND TRIM(assigned_to) <> ''
          AND status = 'completed'
          AND datetime(COALESCE(scheduled_start, created_at)) >= datetime('now', ?)
        GROUP BY assigned_to`
    ).all(orgId, `-${WINDOW_DAYS} day`) as any[];
    const volume = rows.reduce((s, r) => s + Number(r.n || 0), 0);
    const participants = rows.length;
    const base: DimensionConcentration = {
      dimension: "appointments", label: "Concentração de atendimentos (responsável)", available: participants > 0,
      risk: "insufficient_data", topShare: null, topActorId: null, participants, totalVolume: volume, basis: "fact",
    };
    if (!participants || volume <= 0) return base;
    const top = rows.reduce((a, b) => (Number(b.n) > Number(a.n) ? b : a));
    const topShare = Math.round((Number(top.n) / volume) * 1000) / 10;
    base.topShare = topShare;
    base.topActorId = String(top.actor);
    base.risk = riskFor(topShare, participants, volume);
    return base;
  }

  /** Publica/self-heal o sinal `key_person_risk` na espinha (convenção nº 12). Dimensão HIGH
   *  → sinal advisory (HIPÓTESE, impacto null — nunca inventa dinheiro); abaixo → resolve. */
  static detect(orgId: string): { published: number; resolved: number } {
    const a = this.assess(orgId, { includeMoney: false });
    let published = 0, resolved = 0;
    for (const d of a.dimensions) {
      const dedupeKey = `key_person:${d.dimension}`;
      if (d.risk === "high" && d.topShare != null) {
        BusinessSignalService.publish(orgId, {
          domain: "operations", signalType: "key_person_risk", severity: "risk", basis: "estimate", confidence: 0.7,
          impactAmount: null, impactUnit: null, sourceService: "KeyPersonDependencyService",
          evidence: { dimension: d.dimension, topShare: d.topShare, participants: d.participants, totalVolume: d.totalVolume, topActorId: d.topActorId },
          dedupeKey,
        });
        published += 1;
      } else if (d.available && d.risk !== "insufficient_data") {
        // Concentração aliviou (ou nunca foi alta) → resolve o sinal auto (self-healing).
        try { const r = BusinessSignalService.resolveByDedupe(orgId, dedupeKey); if (r?.ok) resolved += 1; } catch { /* noop */ }
      }
    }
    return { published, resolved };
  }

  /** Scheduler pass: só orgs com fonte de concentração (vendedor no pedido OU responsável no atendimento). */
  static pass(): void {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(
        `SELECT organization_id FROM orders WHERE seller_user_id IS NOT NULL AND TRIM(seller_user_id) <> ''
         UNION SELECT organization_id FROM appointments WHERE assigned_to IS NOT NULL AND TRIM(assigned_to) <> '' AND status = 'completed'`
      ).all() as any[];
    } catch { return; }
    for (const o of orgs) {
      try { this.detect(o.organization_id); } catch (e) { console.error("[KeyPerson] detect falhou", o.organization_id, e); }
    }
  }
}

export default KeyPersonDependencyService;
