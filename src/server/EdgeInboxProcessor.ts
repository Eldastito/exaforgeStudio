/**
 * ZappFlow Continuity Layer — Processador do inbox do Edge (ADR-082, Fase 4c /
 * Edge→Cloud).
 *
 * A Fase 4a grava os comandos empurrados pelos nós Edge em `client_commands`
 * com status `received` (transporte durável e idempotente). Aqui a EXECUÇÃO
 * acontece: um dispatcher pega os `received`, roda um handler POR TIPO de
 * operação e, ao concluir, ANEXA um domain_event — fechando o loop, pois o
 * resultado volta a fluir no delta (pull) para o painel e para os outros nós.
 *
 * Handlers são registráveis (`registerHandler`), então comandos concretos
 * (ex.: SEND_MESSAGE virar uma entrega real via a fila da Fase 3) entram sem
 * tocar no dispatcher. Sem handler específico, o handler PADRÃO só emite
 * `edge.command.applied` (reconciliação observável, efeito neutro).
 *
 * Entrega: setInterval próprio (como o MessageDeliveryService) + guarda de
 * reentrância. Self-gate na flag `CONTINUITY_EDGE_SYNC_ENABLED`. Best-effort:
 * uma falha de handler nunca derruba o loop; conta tentativas e, no teto, marca
 * `failed`. Processo único — sem lease 'processing' que possa ficar preso.
 */
import db from "./db.js";
import { ContinuityService } from "./ContinuityService.js";
import { EdgeSyncService } from "./EdgeSyncService.js";

const DISPATCH_INTERVAL_MS = Number(process.env.CONTINUITY_EDGE_INBOX_INTERVAL_MS || 15_000);
const MAX_ATTEMPTS = Math.max(1, Number(process.env.CONTINUITY_EDGE_INBOX_MAX_ATTEMPTS || 6));

export type EdgeCommandContext = { orgId: string; commandId: string; deviceId: string | null; operationType: string; payload: any };
export type EdgeCommandOutcome = { resultEvent?: { aggregateType: string; aggregateId?: string | null; eventType: string; payload?: any }; result?: any };
export type EdgeCommandHandler = (ctx: EdgeCommandContext) => Promise<EdgeCommandOutcome | void>;

const handlers = new Map<string, EdgeCommandHandler>();

/** Handler PADRÃO: reconciliação observável — emite edge.command.applied. */
const defaultHandler: EdgeCommandHandler = async (ctx) => ({
  resultEvent: {
    aggregateType: "edge_command",
    aggregateId: ctx.commandId,
    eventType: "edge.command.applied",
    payload: { operationType: ctx.operationType, deviceId: ctx.deviceId },
  },
  result: { applied: true },
});

let timer: NodeJS.Timeout | null = null;
let dispatching = false;

export class EdgeInboxProcessor {
  static enabled(): boolean { return EdgeSyncService.enabled(); }

  /** Registra um handler para um operation_type (uma vez, no boot). */
  static registerHandler(operationType: string, handler: EdgeCommandHandler): void {
    handlers.set(operationType, handler);
  }

  /**
   * Processa os comandos `received`. Reentrância protegida. Retorna o resumo.
   */
  static async processDue(limit = 50): Promise<{ processed: number; failed: number; retried: number }> {
    const summary = { processed: 0, failed: 0, retried: 0 };
    if (dispatching) return summary;
    dispatching = true;
    try {
      const due = db.prepare(
        `SELECT organization_id, command_id, device_id, operation_type, result_json, attempts
           FROM client_commands WHERE status = 'received' ORDER BY created_at ASC LIMIT ?`
      ).all(limit) as any[];

      for (const c of due) {
        // `attempts` nasce em 1 no INSERT do recordCommand (Fase 4a). Aqui ele
        // conta a tentativa de PROCESSAMENTO atual: 1ª passada = tentativa 1.
        const tryNum = Number(c.attempts || 1);
        const stored = tryNum + 1; // valor persistido para a próxima passada
        const handler = handlers.get(c.operation_type) || defaultHandler;
        const ctx: EdgeCommandContext = {
          orgId: c.organization_id, commandId: c.command_id, deviceId: c.device_id,
          operationType: c.operation_type, payload: safeParse(c.result_json),
        };
        try {
          const out = (await handler(ctx)) || {};
          // Marca processado ANTES de anexar o evento (efeito do comando concluído).
          db.prepare(
            `UPDATE client_commands SET status = 'processed', attempts = ?, result_json = ?, processed_at = CURRENT_TIMESTAMP
              WHERE organization_id = ? AND command_id = ?`
          ).run(stored, JSON.stringify(out?.result ?? null), c.organization_id, c.command_id);
          if (out?.resultEvent) ContinuityService.append(c.organization_id, out.resultEvent);
          summary.processed++;
        } catch (e: any) {
          const errMsg = String(e?.message || e).slice(0, 500);
          if (tryNum >= MAX_ATTEMPTS) {
            db.prepare(`UPDATE client_commands SET status = 'failed', attempts = ?, result_json = ? WHERE organization_id = ? AND command_id = ?`)
              .run(stored, JSON.stringify({ error: errMsg }), c.organization_id, c.command_id);
            summary.failed++;
          } else {
            // Continua 'received' → retentado no próximo ciclo.
            db.prepare(`UPDATE client_commands SET attempts = ? WHERE organization_id = ? AND command_id = ?`)
              .run(stored, c.organization_id, c.command_id);
            summary.retried++;
          }
        }
      }
    } finally { dispatching = false; }
    return summary;
  }

  static start(): void {
    if (timer || !this.enabled()) return;
    timer = setInterval(() => { this.processDue().catch((e) => console.error("[EdgeInbox] tick falhou", e)); }, DISPATCH_INTERVAL_MS);
    console.log("[EdgeInbox] processador do inbox do Edge iniciado (Continuity Fase 4c).");
  }

  static stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }
}

function safeParse(s: any): any { try { return JSON.parse(s ?? "null"); } catch { return null; } }
