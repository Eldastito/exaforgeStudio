/**
 * GrowthOptimizationCommandHandler (PRD 11 / ADR-168 F16 — Governed optimization) — o handler
 * de comando que APLICA uma otimização de crescimento aceita do autopilot (F15) PELO
 * choke-point governado. A otimização deixa de ser uma prévia read-only e vira um COMANDO
 * que passa por `DecisionAction → ApprovalPolicy (Autonomy Contract) → CommandExecutor` (D4).
 * Registrado no MESMO registry do executor (§37 — sem runtime paralelo), espelhando
 * `SocialPublishCommandHandler`.
 *
 * O efeito é uma DIRETIVA DE CONTEÚDO determinística (promover campeão / promover produto /
 * criar conteúdo) — auditável e reversível, sem efeito externo. A publicação real continua
 * sendo o comando governado `social_publish` (F11) que o dono roda do Estúdio: F16 governa a
 * DECISÃO de otimizar, não republica sozinho (RN-CG-08). Não arma confirmação (não há efeito
 * externo a confirmar); não inventa dinheiro (RN-CG-03 — a diretiva não promete receita).
 */
import { CommandExecutorService, type CommandHandler } from "./CommandExecutorService.js";

function payloadOf(action: any): any { try { return action.command_payload_json ? JSON.parse(action.command_payload_json) : {}; } catch { return {}; } }

function directiveFor(p: any): string {
  const label = String(p.label || "").trim();
  if (p.kind === "promote_champion") return `Promover a variante campeã "${label}" na próxima campanha.`;
  if (p.kind === "promote_product") return `Criar conteúdo destacando o produto "${label}" (estoque parado, boa margem).`;
  return `Criar conteúdo sobre "${label}" enquanto o assunto está em alta.`;
}

export const GrowthOptimizationCommandHandler: CommandHandler = {
  key: "GrowthOptimizationCommandHandler",
  commandTypes: ["growth_optimization"],

  prepare(_orgId, action) {
    const p = payloadOf(action);
    return {
      summary: `Otimização preparada: ${directiveFor(p)}`,
      artifact: { kind: "growth_directive_draft", optimization: p.kind || null, ref: p.ref ?? null, label: p.label ?? null, directive: directiveFor(p) },
    };
  },

  execute(_orgId, action) {
    const p = payloadOf(action);
    // Efeito HONESTO: emite a diretiva de conteúdo. Sem efeito externo → sem confirmação.
    return {
      summary: directiveFor(p),
      artifact: { kind: "growth_directive", optimization: p.kind || null, ref: p.ref ?? null, label: p.label ?? null, directive: directiveFor(p) },
      effect: "growth_optimization_applied",
      externalRef: null,
    };
  },
};

// Registra no MESMO registry do executor (mesmo padrão de SocialPublishCommandHandler).
CommandExecutorService.registerHandler(GrowthOptimizationCommandHandler);

export default GrowthOptimizationCommandHandler;
