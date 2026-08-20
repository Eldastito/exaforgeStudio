/**
 * ProfessionalDemandService — ADR-180 F9.1: inteligência de DEMANDA da rede (read-model).
 *
 * Deriva, por-org e read-only (RN-004 — sem tabela nova, sem contador mutável), onde a rede
 * de especialistas tem DEMANDA NÃO ATENDIDA: cruza os sinais que a operação já produz —
 * waitlist (`professional_network/waitlist`, sem vaga) e recusa (`booking_declined`, o
 * profissional não pôde) — contra a demanda ATENDIDA (atendimentos federados). O resultado
 * ajuda a clínica a decidir "essa especialidade precisa de mais janelas / mais um
 * profissional", sem inventar nada: sem sinal → `insufficient_data` (§103 — só rende depois
 * de acumular uso). Isolado por org (RN-PN-2); a pressão é QUALITATIVA (não promete número
 * de negócio).
 */
import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

export type Pressure = "high" | "medium" | "low" | "insufficient_data";
export interface DemandRow { unmet: number; declined: number; met: number; pressure: Pressure; }
export interface ServiceDemand extends DemandRow { serviceId: string | null; serviceName: string | null; }
export interface ProfessionalDemand extends DemandRow { relationshipId: string; professionalName: string | null; }

function safeJson(s: any): any { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }

/** Pressão qualitativa a partir de demanda (unmet+declined) × atendida (met). */
function pressureOf(unmet: number, declined: number, met: number): Pressure {
  const demand = unmet + declined;
  if (demand === 0 && met === 0) return "insufficient_data"; // nada aconteceu ainda
  if (demand === 0) return "low";                             // tudo que veio foi atendido
  if (demand >= Math.max(met, 1)) return "high";              // demanda ≥ oferta atendida
  return "medium";
}

export class ProfessionalDemandService {
  /**
   * Demanda da rede por SERVIÇO e por PROFISSIONAL. `windowDays` (default 90) limita o
   * "atendido" e a idade dos sinais considerados. Só sinais ABERTOS contam como demanda viva.
   */
  static demand(orgId: string, opts?: { windowDays?: number }): {
    byService: ServiceDemand[];
    byProfessional: ProfessionalDemand[];
    summary: { totalUnmet: number; totalDeclined: number; totalMet: number; insufficientData: boolean };
  } {
    const windowDays = Math.min(Math.max(Number(opts?.windowDays) || 90, 1), 365);
    const sinceISO = new Date(Date.now() - windowDays * 86400000).toISOString();

    // Acumuladores por serviço e por vínculo.
    const svc = new Map<string, { unmet: number; declined: number; met: number }>();
    const prof = new Map<string, { unmet: number; declined: number; met: number }>();
    const bump = (m: Map<string, any>, k: string, field: "unmet" | "declined" | "met") => {
      const cur = m.get(k) || { unmet: 0, declined: 0, met: 0 }; cur[field] += 1; m.set(k, cur);
    };
    const svcKey = (s: string | null) => s || "__none__";

    // 1) Waitlist ABERTA (sem vaga) — demanda não atendida. serviceId + vínculo do evidence.
    const wl = db.prepare(
      `SELECT evidence_json, source_entity_id FROM business_signals
       WHERE organization_id = ? AND signal_type = 'professional_network/waitlist' AND status = 'open' AND detected_at >= ?`
    ).all(orgId, sinceISO) as any[];
    for (const r of wl) {
      const ev = safeJson(r.evidence_json);
      bump(svc, svcKey(ev.serviceId ?? null), "unmet");
      if (r.source_entity_id) bump(prof, String(r.source_entity_id), "unmet");
    }

    // 2) Recusa ABERTA — o atendimento existia mas o profissional não pôde. Junta o
    //    appointment (mesmo cancelado ele persiste) pra achar serviço + vínculo.
    const dc = db.prepare(
      `SELECT a.network_service_id AS service_id, a.network_relationship_id AS rel_id
       FROM business_signals s JOIN appointments a ON a.id = s.source_entity_id AND a.organization_id = s.organization_id
       WHERE s.organization_id = ? AND s.signal_type = 'professional_network/booking_declined' AND s.status = 'open' AND s.detected_at >= ?`
    ).all(orgId, sinceISO) as any[];
    for (const r of dc) {
      bump(svc, svcKey(r.service_id ?? null), "declined");
      if (r.rel_id) bump(prof, String(r.rel_id), "declined");
    }

    // 3) Demanda ATENDIDA — atendimentos federados vivos/atendidos na janela.
    const met = db.prepare(
      `SELECT network_service_id AS service_id, network_relationship_id AS rel_id, COUNT(*) AS n
       FROM appointments
       WHERE organization_id = ? AND network_relationship_id IS NOT NULL AND status IN ('confirmed','completed') AND scheduled_start >= ?
       GROUP BY network_service_id, network_relationship_id`
    ).all(orgId, sinceISO) as any[];
    for (const r of met) {
      const cur = svc.get(svcKey(r.service_id ?? null)) || { unmet: 0, declined: 0, met: 0 };
      cur.met += Number(r.n) || 0; svc.set(svcKey(r.service_id ?? null), cur);
      if (r.rel_id) { const p = prof.get(String(r.rel_id)) || { unmet: 0, declined: 0, met: 0 }; p.met += Number(r.n) || 0; prof.set(String(r.rel_id), p); }
    }

    // Materializa nomes + pressão, ordenado por demanda (unmet+declined) desc.
    const byService: ServiceDemand[] = [...svc.entries()].map(([k, v]) => {
      const serviceId = k === "__none__" ? null : k;
      const s = serviceId ? (db.prepare(`SELECT name FROM products_services WHERE id = ? AND organization_id = ?`).get(serviceId, orgId) as any) : null;
      return { serviceId, serviceName: s?.name ?? null, unmet: v.unmet, declined: v.declined, met: v.met, pressure: pressureOf(v.unmet, v.declined, v.met) };
    }).sort((a, b) => (b.unmet + b.declined) - (a.unmet + a.declined));

    const byProfessional: ProfessionalDemand[] = [...prof.entries()].map(([relId, v]) => {
      const rel = db.prepare(
        `SELECT r.id, p.name FROM clinic_professional_relationships r JOIN professionals p ON p.id = r.professional_id WHERE r.id = ? AND r.organization_id = ?`
      ).get(relId, orgId) as any;
      return { relationshipId: relId, professionalName: rel?.name ?? null, unmet: v.unmet, declined: v.declined, met: v.met, pressure: pressureOf(v.unmet, v.declined, v.met) };
    }).filter((r) => r.professionalName !== null).sort((a, b) => (b.unmet + b.declined) - (a.unmet + a.declined));

    const totalUnmet = byService.reduce((n, s) => n + s.unmet, 0);
    const totalDeclined = byService.reduce((n, s) => n + s.declined, 0);
    const totalMet = byService.reduce((n, s) => n + s.met, 0);
    return { byService, byProfessional, summary: { totalUnmet, totalDeclined, totalMet, insufficientData: totalUnmet + totalDeclined + totalMet === 0 } };
  }

  /**
   * F9.2 — torna a demanda PROATIVA: publica um sinal `professional_network/demand_gap` na
   * espinha (`business_signals`, convenção nº 12 — NUNCA tabela de alerta paralela) por
   * SERVIÇO com pressão ALTA (demanda ≥ atendida), e RESOLVE o sinal quando o gap fecha
   * (self-healing). Idempotente por dedupe (serviço). Advisório: nunca inventa dinheiro
   * (impact null) nem promete resultado — só aponta onde abrir janela / incluir profissional.
   * Best-effort; isolado por org.
   */
  static publishGaps(orgId: string): { published: number; resolved: number } {
    const d = this.demand(orgId);
    const highIds = new Set(d.byService.filter((s) => s.pressure === "high" && s.serviceId).map((s) => s.serviceId as string));
    let published = 0, resolved = 0;
    const dedupeFor = (serviceId: string) => `clinic:prof_demand_gap:svc:${serviceId}`;

    for (const s of d.byService) {
      if (s.pressure !== "high" || !s.serviceId) continue;
      const label = s.serviceName || "essa especialidade";
      const parts = [s.unmet ? `${s.unmet} pedido(s) sem vaga` : null, s.declined ? `${s.declined} recusa(s)` : null].filter(Boolean).join(" e ");
      try {
        BusinessSignalService.publish(orgId, {
          domain: "clinic",
          signalType: "professional_network/demand_gap",
          severity: "attention",
          basis: "fact",            // as contagens são medidas; a sugestão é advisória
          confidence: 1,
          impactAmount: null,       // não inventa dinheiro (RN-PN-4)
          sourceService: "ProfessionalDemandService",
          sourceEntityType: "service",
          sourceEntityId: s.serviceId,
          subjectType: "service",
          subjectId: s.serviceId,
          dedupeKey: dedupeFor(s.serviceId),
          evidence: {
            serviceName: s.serviceName, unmet: s.unmet, declined: s.declined, met: s.met,
            suggestion: `${parts || "Demanda acima da oferta"} em ${label} — considere abrir mais janelas ou incluir outro profissional dessa especialidade.`,
          },
        } as any);
        // Se o gap havia sido auto-resolvido e voltou, reabre (nunca reabre um dismissed
        // pelo humano — RN §65). No 1º disparo o INSERT já nasce 'open', reopen é no-op.
        try { BusinessSignalService.reopenByDedupe(orgId, dedupeFor(s.serviceId)); } catch { /* noop */ }
        published += 1;
      } catch { /* best-effort */ }
    }

    // Self-healing: gaps abertos cujo serviço não está mais ALTO → resolve.
    try {
      const open = db.prepare(
        `SELECT source_entity_id, dedupe_key FROM business_signals WHERE organization_id = ? AND signal_type = 'professional_network/demand_gap' AND status = 'open'`
      ).all(orgId) as any[];
      for (const o of open) {
        if (!o.source_entity_id || !highIds.has(String(o.source_entity_id))) {
          try { BusinessSignalService.resolveByDedupe(orgId, o.dedupe_key); resolved += 1; } catch { /* noop */ }
        }
      }
    } catch { /* noop */ }

    return { published, resolved };
  }

  /** Passe do Scheduler: publica gaps de demanda pras orgs com a rede habilitada. Best-effort. */
  static pass(): void {
    let orgs: any[] = [];
    try { orgs = db.prepare(`SELECT organization_id FROM organization_settings WHERE professional_network_enabled = 1`).all() as any[]; }
    catch { return; }
    for (const o of orgs) {
      try { this.publishGaps(o.organization_id); }
      catch (e) { console.error("[Agenda Federada] demand gap pass falhou", o.organization_id, e); }
    }
  }
}

export default ProfessionalDemandService;
