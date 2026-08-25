import db from "./db.js";
import { MissionService } from "./MissionService.js";
import { MissionReversePlanner, ReversePlanOpts } from "./MissionReversePlanner.js";

/**
 * MissionReadinessService — ADR-189 F4 (Mission OS): PRONTIDÃO + RISCO da missão.
 *
 * COMPÕE (D4/§16 — SEM motor novo) sinais que a org LEGITIMAMENTE possui num score de
 * prontidão, e surfaça os riscos antecedentes (Pre-Mortem light §18) a partir dos
 * `business_signals` de severidade risk/critical já publicados pelos detectores existentes
 * (Radar etc.). NÃO expõe infra de plataforma (CPU/fila/headroom) — isso é Admin Master e
 * NUNCA vaza pro tenant (RN-PRC/ADR-164); a prontidão de infra é da plataforma, não da missão.
 *
 * Dimensões (só as APLICÁVEIS contam pro score; missão qualitativa não é penalizada por não
 * ter cadeia de receita):
 *   contract — o contrato tem o mínimo pra agir? (título + alvo/prazo)
 *   plan     — o planejamento reverso fecha? (aplicável + sem estágio unknown)
 *   data     — há dado pra planejar? (ticket médio + base conhecidos)
 *   channel  — há canal conectado pra alcançar o cliente?
 *   risk     — há riscos antecedentes abertos? (sinais risk/critical)
 *
 * DETERMINÍSTICO/read-only, isolado por org. Reusa MissionReversePlanner (F3) + business_signals.
 */

export interface ReadinessDimension { key: string; label: string; ready: boolean | null; detail: string }
export interface MissionRisk { id: string; severity: string; domain: string; summary: string }

export interface MissionReadiness {
  missionId: string;
  readyPct: number;                 // só dimensões aplicáveis
  humanState: string;
  dimensions: ReadinessDimension[];
  blockers: string[];               // dimensões aplicáveis NÃO prontas
  risks: MissionRisk[];             // riscos antecedentes (Pre-Mortem light)
  note: string;
}

export class MissionReadinessService {
  private static connectedChannels(orgId: string): number {
    try { return Number((db.prepare(`SELECT COUNT(*) n FROM channels WHERE organization_id = ? AND status != 'disconnected'`).get(orgId) as any).n); }
    catch { return 0; }
  }
  private static openRisks(orgId: string): MissionRisk[] {
    try {
      const rows = db.prepare(`
        SELECT id, severity, domain, signal_type FROM business_signals
        WHERE organization_id = ? AND status = 'open' AND severity IN ('risk','critical')
        ORDER BY (severity='critical') DESC, detected_at DESC LIMIT 10
      `).all(orgId) as any[];
      return rows.map((r) => ({ id: r.id, severity: r.severity, domain: r.domain, summary: `${r.domain}/${r.signal_type}` }));
    } catch { return []; }
  }

  static assess(orgId: string, missionId: string, opts: ReversePlanOpts = {}): MissionReadiness {
    const mission = MissionService.get(orgId, missionId);
    if (!mission) throw new Error("Missão não encontrada.");

    const plan = MissionReversePlanner.plan(orgId, missionId, opts);
    const dims: ReadinessDimension[] = [];

    // contract — mínimo pra agir.
    const contractReady = !!mission.title && (!!mission.targetValue || !!mission.deadline || !!mission.targetMetric);
    dims.push({ key: "contract", label: "Contrato da missão", ready: contractReady, detail: contractReady ? "Objetivo e critério definidos." : "Falta alvo ou prazo." });

    // plan — só aplicável a missões com cadeia (receita). Qualitativa → n/a (não penaliza).
    if (plan.applicable) {
      const hasUnknown = plan.chain.some((s) => s.basis === "unknown");
      dims.push({ key: "plan", label: "Plano reverso", ready: !hasUnknown, detail: hasUnknown ? `Faltam premissas (${plan.criticalStage || "—"}).` : "Cadeia completa até a base." });
      // Dado-base é POR MÉTRICA (F29): receita usa ticket médio; agenda usa comparecimento — não
      // exigir ticket de uma clínica (era revenue-cêntrico e dava falso "falta ticket" na agenda).
      const isAgenda = mission.targetMetric === "appointments";
      const baseOk = plan.base.available != null;
      const drift = isAgenda ? plan.assumptions.showRate != null : plan.assumptions.avgTicket != null;
      const dataReady = drift && baseOk;
      const detail = dataReady
        ? (isAgenda ? "Comparecimento e base conhecidos." : "Ticket médio e base conhecidos.")
        : !baseOk ? "Falta base de contatos."
        : isAgenda ? "Falta histórico de atendimentos (comparecimento)."
        : "Falta ticket médio (sem vendas registradas).";
      dims.push({ key: "data", label: "Dados pra planejar", ready: dataReady, detail });
    } else {
      dims.push({ key: "plan", label: "Plano reverso", ready: null, detail: "Missão acompanhada por marcos (sem cadeia de receita)." });
      dims.push({ key: "data", label: "Dados pra planejar", ready: null, detail: "Não aplicável a esta missão." });
    }

    // channel — canal conectado pra alcançar o cliente.
    const channels = this.connectedChannels(orgId);
    dims.push({ key: "channel", label: "Canal de alcance", ready: channels > 0, detail: channels > 0 ? `${channels} canal(is) conectado(s).` : "Nenhum canal conectado (WhatsApp/etc.)." });

    // risk — riscos antecedentes abertos (Pre-Mortem light §18).
    const risks = this.openRisks(orgId);
    dims.push({ key: "risk", label: "Riscos antecedentes", ready: risks.length === 0, detail: risks.length === 0 ? "Nenhum risco aberto relevante." : `${risks.length} risco(s) aberto(s) a considerar.` });

    const applicable = dims.filter((d) => d.ready !== null);
    const readyCount = applicable.filter((d) => d.ready === true).length;
    const readyPct = applicable.length ? Math.round((readyCount / applicable.length) * 100) : 0;
    const blockers = applicable.filter((d) => d.ready === false).map((d) => `${d.label}: ${d.detail}`);

    const humanState = readyPct >= 100 ? "Pronta pra começar" : readyPct >= 60 ? "Quase pronta" : "Precisa de preparo";
    const note = blockers.length
      ? `Antes de começar, resolva: ${blockers.map((b) => b.split(":")[0]).join(", ")}.${risks.length ? ` Encontrei ${risks.length} risco(s) pra considerar.` : ""}`
      : risks.length
        ? `Tudo pronto, mas encontrei ${risks.length} risco(s) antecedente(s) pra você olhar antes.`
        : "Tudo pronto pra começar.";

    return { missionId, readyPct, humanState, dimensions: dims, blockers, risks, note };
  }
}

export default MissionReadinessService;
