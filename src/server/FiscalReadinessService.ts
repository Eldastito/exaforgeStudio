/**
 * FiscalReadinessService — ADR-187 F1: PRONTIDÃO fiscal (Reforma) agregada pro operador.
 *
 * Read-model que junta as facetas da ADR-181 numa resposta única — "estou pronto pra Reforma?" —
 * separando com HONESTIDADE três origens de pendência: (a) do TENANT (perfil incompleto, regime
 * não declarado → o que ele controla e conta pro `readyPct`), (b) da PLATAFORMA (alíquota do
 * período ainda não curada na base), (c) do SENADO (a alíquota cheia de 2027 — não definida até a
 * resolução de dez/2026 → NUNCA vira lacuna do tenant nem alíquota inventada). Reusa os motores
 * (FiscalProfile/TaxReference/SimplesAdvisor/FiscalIssuance); nenhuma regra/alíquota nova.
 *
 * Guardrails RN-FR: 1 (nunca inventa alíquota — herda `rateFor→null`) · 2 (nunca presume regime) ·
 * 3 (derivado/RN-004) · 4 (três origens separadas; só a do tenant conta pro score) · 5 (advisory) ·
 * 6 (isolado/determinístico/honesto) · 7 (reusa os motores ADR-181).
 */
import db from "./db.js";
import { FiscalProfileService } from "./FiscalProfileService.js";
import { TaxReferenceService } from "./TaxReferenceService.js";
import { FiscalIssuanceService } from "./FiscalIssuanceService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

const FIELD_LABEL: Record<string, string> = {
  cnpj: "CNPJ", regime: "Regime tributário", municipalityIbge: "Código IBGE do município", uf: "UF",
};

// Linha do tempo FACTUAL da Reforma (datas fixas da lei). A alíquota cheia de 2027 é `defined:false`
// + `dependsOn:'senate'` — depende da resolução do Senado (dez/2026), NUNCA estimada (RN-FR-1).
const TIMELINE = [
  { when: "2026", label: "Ano-teste: CBS 0,9% + IBS 0,1%, com destaque em documento fiscal; compensável com PIS/COFINS.", defined: true, dependsOn: null as string | null },
  { when: "2027", label: "PIS e COFINS extintos; CBS em alíquota CHEIA (percentual fixado por resolução do Senado, prevista p/ dez/2026 — ainda não definido); IS começa; IBS segue em 0,1%.", defined: false, dependsOn: "senate" },
  { when: "2029–2032", label: "ICMS e ISS caem ~10% ao ano; IBS sobe gradual para compensar.", defined: true, dependsOn: null },
  { when: "2033", label: "Sistema novo pleno; ICMS, ISS, PIS e COFINS extintos.", defined: true, dependsOn: null },
];

export interface FiscalReadiness {
  asOf: string;
  currentPhase: string;
  readyPct: number;                 // só o que o TENANT controla (RN-FR-4)
  tenantBlockers: string[];
  tenantWarnings: string[];
  dimensions: {
    identity: { complete: boolean; missing: string[]; readyPct: number };
    referenceBase: { period: string; tributes: Record<string, "covered" | "awaiting_curation"> };
    regime: { declared: boolean; regime: string | null; decisionPending: boolean };
    issuance: { state: string; informative: true };
  };
  externalPending: { platform: string[]; senate: string[] };
  timeline: { when: string; label: string; defined: boolean; dependsOn: string | null }[];
  note: string;
}

export class FiscalReadinessService {
  private static phaseFor(dateISO: string): string {
    const y = Number(dateISO.slice(0, 4));
    if (y <= 2026) return "2026 (ano-teste)";
    if (y <= 2028) return "2027–2028 (CBS cheia, IBS 0,1%)";
    if (y <= 2032) return "2029–2032 (transição ICMS/ISS)";
    return "2033+ (sistema pleno)";
  }

  static assess(orgId: string, opts: { asOf?: string } = {}): FiscalReadiness {
    const asOf = opts.asOf || new Date().toISOString().slice(0, 10);
    const period = asOf.slice(0, 7);

    // ── Dimensão TENANT: identidade fiscal (o que conta pro readyPct) ──
    const comp = FiscalProfileService.completeness(orgId);
    const profile = FiscalProfileService.get(orgId);
    const REQUIRED = ["cnpj", "regime", "municipalityIbge", "uf"];
    const identityReadyPct = Math.round(((REQUIRED.length - comp.missing.length) / REQUIRED.length) * 100);
    const tenantBlockers = comp.missing.map((m) => `Falta: ${FIELD_LABEL[m] || m}`);

    // ── Dimensão REGIME: decisão DAS × híbrido (a partir de 2027) é WARNING, não blocker ──
    const regimeDeclared = !!profile.regime;
    const decisionPending = comp.regimeIsSimples; // Simples → escolha DAS×regime regular a partir de 2027
    const tenantWarnings: string[] = [];
    if (decisionPending) tenantWarnings.push("Você é Simples: a partir de 2027 poderá escolher recolher CBS/IBS no DAS (padrão) ou no regime regular (gera/usa crédito) — decisão pendente.");

    // ── Dimensão PLATAFORMA: alíquota do período está curada? (rateFor→null = aguardando curadoria) ──
    const tributes: Record<string, "covered" | "awaiting_curation"> = {};
    const platformPending: string[] = [];
    for (const t of ["cbs", "ibs"]) {
      const covered = !!TaxReferenceService.rateFor(t, asOf);
      tributes[t] = covered ? "covered" : "awaiting_curation";
      if (!covered) platformPending.push(`Alíquota de ${t.toUpperCase()} do período ${period} ainda não curada na plataforma.`);
    }

    // ── Dimensão SENADO: a alíquota cheia de 2027 não existe até a resolução (nunca é gap do tenant) ──
    const senatePending = ["Alíquota CHEIA da CBS (2027) depende de resolução do Senado (prevista p/ dez/2026) — ainda não definida."];

    // ── Dimensão EMISSÃO: informativa (scaffold; homologação é de 3º) ──
    const issuance = FiscalIssuanceService.status(orgId);

    const readyPct = identityReadyPct; // só o tenant-controlado (RN-FR-4)
    const note = comp.complete
      ? "Sua identidade fiscal está completa — o motor CBS/IBS/IS já calcula pro seu período. O que falta pra 2027 depende do Senado (alíquota cheia) e da curadoria da plataforma, não de você."
      : `Faltam dados no seu perfil fiscal (${comp.missing.map((m) => FIELD_LABEL[m] || m).join(", ")}) — complete pra ficar pronto. A alíquota cheia de 2027 depende do Senado, não de você.`;

    return {
      asOf,
      currentPhase: this.phaseFor(asOf),
      readyPct,
      tenantBlockers,
      tenantWarnings,
      dimensions: {
        identity: { complete: comp.complete, missing: comp.missing, readyPct: identityReadyPct },
        referenceBase: { period, tributes },
        regime: { declared: regimeDeclared, regime: profile.regime, decisionPending },
        issuance: { state: issuance.state, informative: true },
      },
      externalPending: { platform: platformPending, senate: senatePending },
      timeline: TIMELINE,
      note,
    };
  }

  /**
   * ADR-187 F2 — sinal PROATIVO de prontidão. Quando o tenant tem BLOCKER (identidade fiscal
   * incompleta — o que DEPENDE DELE), publica um `business_signal` pro dono completar o perfil
   * antes da virada. Advisory: nunca bloqueia operação, nunca decide regime, nunca cria
   * `decision_action` (RN-FR-5). Hipótese (`basis:'hypothesis'`, `impactAmount:null`). Self-healing:
   * completou → `resolveByDedupe`; recorre → `reopenByDedupe` (respeita o `dismissed` humano §65).
   * Dedupe por org. Best-effort. NÃO sinaliza pendência de plataforma/Senado (não é do tenant).
   */
  static publishReadinessSignal(orgId: string): { published: boolean; resolved: boolean } {
    const dedupeKey = "fiscal_readiness:incomplete";
    let published = false, resolved = false;
    try {
      const r = this.assess(orgId);
      if (r.tenantBlockers.length > 0) {
        BusinessSignalService.publish(orgId, {
          domain: "fiscal_readiness",
          signalType: "incomplete",
          severity: "attention",
          basis: "hypothesis",
          confidence: 0.5,
          impactAmount: null,            // nunca inventa dinheiro
          sourceService: "FiscalReadinessService",
          evidence: {
            readyPct: r.readyPct, blockers: r.tenantBlockers,
            message: `Seu perfil fiscal está ${r.readyPct}% completo. Falta: ${r.tenantBlockers.join("; ")}. Complete pra ficar pronto pra Reforma Tributária — a alíquota cheia de 2027 depende do Senado, mas a sua identidade fiscal depende de você.`,
          },
          dedupeKey,
        });
        try { BusinessSignalService.reopenByDedupe(orgId, dedupeKey); } catch { /* noop */ }
        published = true;
      } else {
        try { const rr = BusinessSignalService.resolveByDedupe(orgId, dedupeKey); resolved = !!rr?.ok; } catch { /* noop */ }
      }
    } catch { /* best-effort */ }
    return { published, resolved };
  }

  /** Passe do Scheduler: só orgs FORMALIZADAS (têm CNPJ) — antes disso a Reforma não é acionável. */
  static pass(): void {
    let orgs: any[] = [];
    try { orgs = db.prepare(`SELECT organization_id FROM organization_settings WHERE comigo_cnpj IS NOT NULL AND status = 'active'`).all() as any[]; }
    catch { return; }
    for (const o of orgs) {
      try { this.publishReadinessSignal(o.organization_id); }
      catch (e) { console.error("[Fiscal] readiness pass falhou", o.organization_id, e); }
    }
  }
}

export default FiscalReadinessService;
