import db from "./db.js";
import { CreativeExperimentService } from "./CreativeExperimentService.js";
import { ProductOpportunityService } from "./ProductOpportunityService.js";
import { StudioBriefService } from "./StudioBriefService.js";

/**
 * GrowthAutopilotService — Growth Autopilot (PRD 11 / ADR-168 F15).
 *
 * Postura SHADOW-first: o autopilot OLHA o estado de crescimento e PROPÕE otimizações
 * (promover o campeão F9, promover um produto F11, criar conteúdo pra oportunidade F7), mas
 * NUNCA executa. Em `shadow` ele só COMPUTA o que FARIA — nada é escrito em `decision_actions`
 * e toda proposta nasce `requiresApproval:true` (a execução governada é a F16, via
 * `DecisionAction→ApprovalPolicy(Autonomy Contract)→CommandExecutor`).
 *
 * Guardrails:
 *  - RN-CG-10 — shadow-first; crescimento autônomo NUNCA vai direto pra execução. Modo é
 *    `off`|`shadow` apenas — não existe `auto` aqui.
 *  - RN-CG-08 — decidir/propor ≠ executar: `plan()` é read-only; não cria comando nem publica.
 *  - RN-CG-06 — produto sem R$ (marginBand qualitativo).
 *  - convenção nº 1 — isolamento por org; convenção nº 10 — opt-in (default `off`).
 */

export type AutopilotMode = "off" | "shadow";
const MODES = new Set<AutopilotMode>(["off", "shadow"]);

export interface GrowthProposal {
  kind: "promote_champion" | "promote_product" | "create_content";
  ref: string; label: string; rationale: string;
  requiresApproval: true;    // SEMPRE — nunca auto-executa (RN-CG-10)
  wouldExecute: false;        // SEMPRE — shadow não executa (RN-CG-08)
}

export interface GrowthPlan {
  mode: AutopilotMode; active: boolean;
  proposals: GrowthProposal[]; note: string;
}

export class GrowthAutopilotService {
  static mode(orgId: string): AutopilotMode {
    const r = db.prepare("SELECT growth_autopilot_mode AS m FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    const m = String(r?.m || "off");
    return MODES.has(m as AutopilotMode) ? (m as AutopilotMode) : "off";
  }

  /** Define a postura. Só `off`|`shadow` (RN-CG-10 — `auto` é rejeitado). */
  static setMode(orgId: string, mode: string): { mode: AutopilotMode } {
    const m = String(mode || "").trim();
    if (!MODES.has(m as AutopilotMode)) throw new Error("modo inválido — só 'off' ou 'shadow' (autopilot nunca executa direto).");
    db.prepare("UPDATE organization_settings SET growth_autopilot_mode = ? WHERE organization_id = ?").run(m, orgId);
    return { mode: m as AutopilotMode };
  }

  /**
   * O que o autopilot FARIA (read-only). SEMPRE computa as propostas; `active` reflete se a
   * postura é `shadow` (surface proativa). NADA é executado (RN-CG-08) — nem em shadow.
   */
  static plan(orgId: string): GrowthPlan {
    const mode = this.mode(orgId);
    const proposals: GrowthProposal[] = [];

    // 1. Promover o CAMPEÃO dos experimentos decididos (F9) — vencedor por resultado de negócio.
    for (const e of CreativeExperimentService.list(orgId, { status: "completed" })) {
      if ((e as any).decision === "winner" && (e as any).winner_variant_key) {
        proposals.push({ kind: "promote_champion", ref: (e as any).id, label: String((e as any).winner_variant_key),
          rationale: "Variante campeã do experimento — promover pra próxima campanha.", requiresApproval: true, wouldExecute: false });
      }
    }
    // 2. Promover PRODUTO em estoque/alta margem/vendendo pouco (F11) — sem R$ (RN-CG-06).
    for (const p of ProductOpportunityService.match(orgId, { publish: false }).opportunities) {
      proposals.push({ kind: "promote_product", ref: p.productId, label: p.name,
        rationale: `Produto de margem ${p.marginBand === "high" ? "alta" : "boa"} parado — criar conteúdo.`, requiresApproval: true, wouldExecute: false });
    }
    // 3. Criar CONTEÚDO pras oportunidades de nicho abertas (F7).
    for (const o of StudioBriefService.listOpportunities(orgId)) {
      if (!o.topic) continue;
      proposals.push({ kind: "create_content", ref: o.signalId, label: o.topic,
        rationale: `Assunto em alta${o.vertical ? ` no nicho ${o.vertical}` : ""} — vale um conteúdo.`, requiresApproval: true, wouldExecute: false });
    }

    const active = mode === "shadow";
    const note = mode === "off"
      ? "Autopilot desligado — as propostas são só uma prévia (nada é sugerido proativamente)."
      : `Autopilot em SHADOW — propõe ${proposals.length}, mas NUNCA executa: cada uma exige aprovação humana (F16).`;
    return { mode, active, proposals, note };
  }
}

export default GrowthAutopilotService;
