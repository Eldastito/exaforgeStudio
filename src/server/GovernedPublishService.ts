/**
 * GovernedPublishService (PRD 10 / ADR-167 F11 — Governed Publishing) — a PORTA de
 * publicação social. NÃO publica direto: PROPÕE um comando governado
 * (`social_publish`) que atravessa `DecisionAction → ApprovalPolicy (Autonomy Contract)
 * → CommandExecutor → ConfirmationEngine` (D4). Reúso puro (§42 — sem runtime/policy/
 * confirmation paralelo): só compõe os engines canônicos.
 *
 * Por padrão a publicação EXIGE aprovação humana (`social_publish` → policy 'single'); o
 * Autonomy Contract do dono pode liberar (auto) ou bloquear (deny) por banda de valor.
 * Semear a `agent_policy` (execute/approved_execution) NÃO amplia autonomia — só deixa o
 * executor PERMITIR o efeito que a governança já aprovou (mesma lógica do
 * `dispatchGoverned`). Carrega o fio (correlationId/signalId/variantKey) da oportunidade
 * → variante (F7/F9) pra atribuição na F12. Isolamento (convenção #1): `orgId` 1º arg.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { DecisionActionService } from "./DecisionActionService.js";
import { CommandExecutorService } from "./CommandExecutorService.js";
// Importa o handler pelo efeito colateral de REGISTRO no executor (F11).
import "./SocialPublishCommandHandler.js";

export interface GovernedPublishInput {
  channel: string;
  caption?: string | null;
  mediaRef?: string | null;
  kind?: string;
  variantKey?: string | null;
  signalId?: string | null;
  correlationId?: string | null;
  title?: string;
  createdBy?: string;
}

export class GovernedPublishService {
  /**
   * Propõe a publicação como comando governado. Retorna a ação (status reflete a
   * governança: `awaiting_approval` = espera humano; `approved` = Autonomy Contract
   * liberou). NÃO executa o efeito aqui — quem roda é `execute()` sobre a ação APROVADA.
   */
  static propose(orgId: string, input: GovernedPublishInput): any {
    if (!input?.channel) throw new Error("channel é obrigatório.");
    // Semeia a política de execução (não amplia autonomia — o executor só PERMITE
    // o efeito que a aprovação já liberou). Idempotente.
    const pol = db.prepare(`SELECT id FROM agent_policies WHERE organization_id = ? AND domain = 'social' AND action_type = 'social_publish'`).get(orgId) as any;
    if (!pol) {
      db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'social', 'social_publish', 'execute', 'approved_execution', 1)`)
        .run(randomUUID(), orgId);
    }
    return DecisionActionService.propose(orgId, {
      signalId: input.signalId ?? null,
      domain: "social",
      actionType: "social_publish",
      title: input.title || `Publicar em ${input.channel}`,
      commandType: "social_publish",
      commandPayload: { channel: input.channel, caption: input.caption ?? null, mediaRef: input.mediaRef ?? null, kind: input.kind || "image", variantKey: input.variantKey ?? null },
      correlationId: input.correlationId ?? null,
      createdBy: input.createdBy || "studio",
    });
  }

  /** Executa o efeito de uma ação de publicação APROVADA (pelo choke-point governado). */
  static execute(orgId: string, actionId: string): Promise<any> {
    return CommandExecutorService.execute(orgId, actionId);
  }
}

export default GovernedPublishService;
