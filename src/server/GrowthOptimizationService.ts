/**
 * GrowthOptimizationService — Governed optimization (PRD 11 / ADR-168 F16).
 *
 * É a PONTE entre o Growth Autopilot em SHADOW (F15, que só PROPÕE) e a execução
 * GOVERNADA. Quando o dono ACEITA uma proposta do autopilot (promover o campeão F9 /
 * promover um produto F11 / criar conteúdo pra oportunidade F7), ela deixa de ser uma
 * prévia read-only e vira um COMANDO governado que atravessa
 * `DecisionAction → ApprovalPolicy (Autonomy Contract) → CommandExecutor` (D4).
 *
 * Reúso puro (§37 — sem 2º Decision/Approval/Confirmation Engine e sem runtime paralelo):
 * só compõe os engines canônicos e registra UM command_type novo no MESMO registry do
 * executor (espelha `SocialPublishCommandHandler` da F11 — um handler não é um motor).
 *
 * Guardrails:
 *  - RN-CG-08 — decidir/propor ≠ executar. `propose` NASCE `awaiting_approval` (política
 *    default 'single' exige aprovação humana); NADA roda até o choke-point governado
 *    aprovar. `execute` só corre sobre ação APROVADA (o executor barra o resto).
 *  - RN-CG-10 — crescimento nunca vai direto pra execução: mesmo aceitando a proposta, o
 *    efeito ainda passa por aprovação. Semear `agent_policy` NÃO amplia autonomia — só
 *    deixa o executor PERMITIR o efeito que a governança já aprovou (mesma lógica da F11).
 *  - RN-CG-09 — grounded: só governa uma proposta que o autopilot AINDA propõe (re-deriva
 *    o plano F15); proposta obsoleta é recusada, nunca inventada.
 *  - convenção nº 1 — isolamento por org (`orgId` 1º arg).
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { DecisionActionService } from "./DecisionActionService.js";
import { CommandExecutorService } from "./CommandExecutorService.js";
import { GrowthAutopilotService, type GrowthProposal } from "./GrowthAutopilotService.js";
// Importa o handler pelo efeito colateral de REGISTRO no executor (F16).
import "./GrowthOptimizationCommandHandler.js";

const OPEN_STATES = ["awaiting_approval", "approved"];

export interface GovernableProposal extends GrowthProposal {
  governed: boolean;          // já existe uma ação governada aberta pra (kind, ref)?
  actionId: string | null;    // a ação, quando governed
  actionStatus: string | null;
}

export class GrowthOptimizationService {
  /** Índice das ações governadas ABERTAS de otimização, por `${kind}:${ref}`. */
  private static openIndex(orgId: string): Map<string, any> {
    const rows = db.prepare(
      `SELECT id, status, command_payload_json FROM decision_actions
       WHERE organization_id = ? AND domain = 'social' AND action_type = 'growth_optimization'
         AND status IN (${OPEN_STATES.map(() => "?").join(",")})`
    ).all(orgId, ...OPEN_STATES) as any[];
    const idx = new Map<string, any>();
    for (const r of rows) {
      let p: any = {}; try { p = r.command_payload_json ? JSON.parse(r.command_payload_json) : {}; } catch { /* ignora payload corrompido */ }
      if (p?.kind && p?.ref) idx.set(`${p.kind}:${p.ref}`, r);
    }
    return idx;
  }

  /**
   * As propostas do autopilot (F15) ANOTADAS com o estado de governança — pra a UI saber o
   * que já virou ação (e não propor 2×). Read-only.
   */
  static list(orgId: string): { proposals: GovernableProposal[] } {
    const idx = this.openIndex(orgId);
    const proposals = GrowthAutopilotService.plan(orgId).proposals.map((p): GovernableProposal => {
      const open = idx.get(`${p.kind}:${p.ref}`);
      return { ...p, governed: !!open, actionId: open?.id ?? null, actionStatus: open?.status ?? null };
    });
    return { proposals };
  }

  /**
   * Aceita uma proposta do autopilot e a PROPÕE como comando governado. Grounded (RN-CG-09):
   * a proposta precisa estar VIVA no plano atual. Idempotente por (kind, ref): se já há uma
   * ação aberta, devolve-a em vez de duplicar. NASCE `awaiting_approval` (RN-CG-08/10).
   */
  static propose(orgId: string, sel: { kind: string; ref: string }, createdBy?: string): any {
    const kind = String(sel?.kind || "").trim();
    const ref = String(sel?.ref || "").trim();
    if (!kind || !ref) throw new Error("kind e ref são obrigatórios.");

    // Grounding: só governa o que o autopilot AINDA propõe (RN-CG-09).
    const live = GrowthAutopilotService.plan(orgId).proposals.find((p) => p.kind === kind && p.ref === ref);
    if (!live) throw new Error("Proposta não está mais ativa — o autopilot não a sugere no momento.");

    // Idempotência por (kind, ref): não duplica a ação governada.
    const existing = this.openIndex(orgId).get(`${kind}:${ref}`);
    if (existing) return DecisionActionService.get(orgId, existing.id);

    // Semeia a política de execução (não amplia autonomia — o executor só PERMITE o efeito
    // que a aprovação já liberou). Idempotente. Mesmo padrão da F11 (GovernedPublishService).
    const pol = db.prepare(`SELECT id FROM agent_policies WHERE organization_id = ? AND domain = 'social' AND action_type = 'growth_optimization'`).get(orgId) as any;
    if (!pol) {
      db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'social', 'growth_optimization', 'execute', 'approved_execution', 1)`)
        .run(randomUUID(), orgId);
    }

    // create_content carrega o signalId da oportunidade → herda o fio (correlation_id).
    const signalId = kind === "create_content" ? ref : null;
    return DecisionActionService.propose(orgId, {
      signalId,
      domain: "social",
      actionType: "growth_optimization",
      title: this.titleFor(live),
      basis: "hypothesis",     // otimização é hipótese até a confirmação (PUBLISHED ≠ RESULTADO)
      commandType: "growth_optimization",
      commandPayload: { kind, ref, label: live.label, rationale: live.rationale },
      createdBy: createdBy || "growth_autopilot",
    });
  }

  /** Executa o efeito de uma otimização APROVADA (pelo choke-point governado). */
  static execute(orgId: string, actionId: string): Promise<any> {
    return CommandExecutorService.execute(orgId, actionId);
  }

  private static titleFor(p: GrowthProposal): string {
    if (p.kind === "promote_champion") return `Promover variante campeã ${p.label}`;
    if (p.kind === "promote_product") return `Promover produto ${p.label}`;
    return `Criar conteúdo sobre ${p.label}`;
  }
}

export default GrowthOptimizationService;
