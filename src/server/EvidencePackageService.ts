import db from "./db.js";
import { randomUUID } from "crypto";
import { BusinessSnapshotV2Service } from "./BusinessSnapshotV2Service.js";

/**
 * EvidencePackageService — Evidence Package v1 (INTERNO). Decision Intelligence
 * DI-1, aditivo sobre o Business Snapshot V2 (ADR-135). Ver
 * docs/decision-intelligence/PLANO-E-FATIAS.md.
 *
 * PROBLEMA (PRD §11/§12): hoje cada consumidor de raciocínio (Diretor IA,
 * Maestro, e amanhã as estratégias Pre-Mortem/Red Team/Advocate) reconstrói o
 * panorama do negócio do zero. Este service embrulha o snapshot num PACOTE
 * REUTILIZÁVEL — uma consulta, vários consumidores — cacheado por (org, subject)
 * com TTL, carregando `generatedAt`/`expiresAt`/`freshness`/`confidence`/
 * `sources`.
 *
 * NÃO DUPLICA agregação: reusa `BusinessSnapshotV2Service.build` (não recalcula
 * nenhum domínio). Evidência EXTERNA e HISTÓRICA são SLOTS VAZIOS nesta v1:
 * `externalEvidence` entra na DI-4 (e depende da decisão de cache cross-tenant —
 * ADR-079 D4); `historicalEvidence` fica adiada.
 *
 * CACHE opt-in por org (convenção nº 10): `organization_settings
 * .evidence_layer_enabled`. Off (default): `build()` computa fresco e NÃO
 * persiste — comportamento idêntico ao de hoje. On: persiste em
 * `evidence_packages` e reusa enquanto fresco. É cache DERIVADO (pode ser
 * sobrescrito; nunca guarda nada que não esteja nas fontes — sem tocar em
 * retenção). Isolado por `organization_id` (convenção nº 1).
 */

export interface EvidencePackage {
  id: string;
  organizationId: string;
  subject: string;
  vertical: string | null;
  period: { month: string };
  generatedAt: string;
  expiresAt: string;
  freshness: "fresh" | "stale";
  confidence: number | null;
  dataQuality: any;
  internalEvidence: any;
  topPriorities: any[];
  externalEvidence: any[];   // DI-4 (adiado)
  historicalEvidence: any[]; // adiado
  sources: string[];
  cacheHit?: boolean;
}

const DEFAULT_TTL_MIN = 720; // 12h — janela L2 "Organization Intelligence" (PRD §25)

export class EvidencePackageService {
  /** Cache do Evidence Layer está ligado para a org? (opt-in, convenção nº 10) */
  static isEnabled(orgId: string): boolean {
    const row = db.prepare("SELECT evidence_layer_enabled FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    return !!(row && row.evidence_layer_enabled);
  }

  /**
   * Monta (ou reusa do cache) o Evidence Package do `subject`. Default:
   * `business_snapshot:<AAAA-MM>`. `force` ignora o cache; `ttlMinutes` sobrepõe
   * o TTL padrão. Sempre retorna um pacote — o cache só muda a origem.
   */
  static build(orgId: string, opts: { subject?: string; period?: string; ttlMinutes?: number; force?: boolean } = {}): EvidencePackage {
    const period = opts.period || new Date().toISOString().slice(0, 7);
    const subject = opts.subject || `business_snapshot:${period}`;
    const enabled = this.isEnabled(orgId);

    if (enabled && !opts.force) {
      const cached = this.get(orgId, subject);
      if (cached && cached.freshness === "fresh") { this.recordCacheEvent(orgId, subject, 1); return { ...cached, cacheHit: true }; }
    }

    const pkg = this.compose(orgId, subject, period, opts.ttlMinutes ?? DEFAULT_TTL_MIN);
    if (enabled) { this.persist(orgId, pkg); this.recordCacheEvent(orgId, subject, 0); }
    return { ...pkg, cacheHit: false };
  }

  /** Log append-only de hit/miss (DI-3) — insumo do cache_hit_rate. Best-effort. */
  private static recordCacheEvent(orgId: string, subject: string, hit: 0 | 1): void {
    try { db.prepare("INSERT INTO evidence_cache_events (id, organization_id, subject, hit) VALUES (?, ?, ?, ?)").run(randomUUID(), orgId, subject, hit); } catch { /* nunca derruba o build */ }
  }

  /** Lê o pacote persistido (ou null). Recalcula `freshness` contra o relógio. */
  static get(orgId: string, subject: string): EvidencePackage | null {
    const row = db.prepare("SELECT * FROM evidence_packages WHERE organization_id = ? AND subject = ?").get(orgId, subject) as any;
    if (!row) return null;
    let pkg: EvidencePackage;
    try { pkg = JSON.parse(row.package_json); } catch { return null; }
    const fresh = new Date(row.expires_at).getTime() > Date.now();
    return { ...pkg, freshness: fresh ? "fresh" : "stale", cacheHit: true };
  }

  private static compose(orgId: string, subject: string, period: string, ttlMin: number): EvidencePackage {
    const snap: any = BusinessSnapshotV2Service.build(orgId, period);
    const vertical = (db.prepare("SELECT vertical FROM organization_settings WHERE organization_id = ?").get(orgId) as any)?.vertical || null;
    const dq = snap?.dataQuality || null;
    const confidence = dq && dq.pct != null ? Math.round((Number(dq.pct) / 100) * 100) / 100 : null;
    const now = new Date();
    const expires = new Date(now.getTime() + Math.max(0, ttlMin) * 60000);
    return {
      id: randomUUID(),
      organizationId: orgId,
      subject,
      vertical,
      period: { month: period },
      generatedAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      freshness: "fresh",
      confidence,
      dataQuality: dq,
      internalEvidence: snap?.domains || {},
      topPriorities: snap?.topPriorities || [],
      externalEvidence: collectExternalEvidence(orgId),
      historicalEvidence: [],
      sources: collectSources(snap?.domains),
    };
  }

  private static persist(orgId: string, pkg: EvidencePackage): void {
    db.prepare(`
      INSERT INTO evidence_packages (id, organization_id, subject, vertical, package_json, confidence, generated_at, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(organization_id, subject) DO UPDATE SET
        id = excluded.id,
        vertical = excluded.vertical,
        package_json = excluded.package_json,
        confidence = excluded.confidence,
        generated_at = excluded.generated_at,
        expires_at = excluded.expires_at,
        updated_at = CURRENT_TIMESTAMP
    `).run(pkg.id, orgId, pkg.subject, pkg.vertical, JSON.stringify(pkg), pkg.confidence, pkg.generatedAt, pkg.expiresAt);
  }
}

/**
 * Evidência EXTERNA do slot `externalEvidence[]` (DI-4.3): as contextualizações
 * de vertical FRESCAS que a org já tem (read-only, sem disparar pesquisa). Vazio
 * se a org não optou / não tem inteligência de nicho curada. Nunca traz dado de
 * outra org (isolado por organization_id).
 */
function collectExternalEvidence(orgId: string): any[] {
  try {
    const rows = db.prepare(`
      SELECT c.fingerprint, c.vertical, c.topic, c.context_json, v.confidence AS vi_confidence, v.valid_until AS vi_valid_until
      FROM organization_contextualization c
      JOIN vertical_intelligence v ON v.id = c.vertical_intelligence_id
      WHERE c.organization_id = ? AND v.valid_until > CURRENT_TIMESTAMP
      ORDER BY v.valid_until DESC LIMIT 50
    `).all(orgId) as any[];
    return rows.map((r) => {
      let ctx: any = {}; try { ctx = JSON.parse(r.context_json); } catch { /* */ }
      return { source: "vertical_intelligence", vertical: r.vertical, topic: r.topic, fingerprint: r.fingerprint, summary: ctx?.summary ?? null, confidence: r.vi_confidence, validUntil: r.vi_valid_until };
    });
  } catch { return []; }
}

/** Coleta os `source` (nível 0 e 1) dos domínios do snapshot, únicos e ordenados. */
function collectSources(domains: any): string[] {
  const out = new Set<string>();
  if (domains && typeof domains === "object") {
    for (const d of Object.values<any>(domains)) {
      if (!d || typeof d !== "object") continue;
      if (typeof d.source === "string") out.add(d.source);
      for (const v of Object.values<any>(d)) {
        if (v && typeof v === "object" && typeof v.source === "string") out.add(v.source);
      }
    }
  }
  return Array.from(out).sort();
}

export default EvidencePackageService;
