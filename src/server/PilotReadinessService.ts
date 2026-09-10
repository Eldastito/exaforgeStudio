/**
 * PilotReadinessService — PRD WhatsApp Unificado F7.3 (RF §21 §531 / §602 / Gate G7).
 *
 * "Reconciliar migração/filas; AMPLIAR SOMENTE COM GATES CUMPRIDOS." Este é o
 * read model que responde, ao FIM da janela de observação do piloto, se os gates
 * objetivos de reconciliação estão cumpridos — a ferramenta que o operador roda
 * antes de decidir ampliar (número autorizado → empresa piloto → ampliação).
 *
 * COMPÕE, read-only, as superfícies que já existem (§184 — sem motor/loop/tabela
 * de reconciliação paralelos):
 *   - migração: `FalaTuBridgeReconService.report`/`records` (elos quebrados +
 *     divergência de estado = "migração não reconciliada", §602);
 *   - filas: `WhatsAppHealthService.metrics` (fila presa + `unknown` acumulado =
 *     entrega possivelmente duplicada a reconciliar, §14/§602);
 *   - canais: `ChannelStateService.list` (webhook `rejected` = recebimento não
 *     confiável; nunca "ready").
 *
 * O veredito é ADVISÓRIO (como o risco do DI): a decisão de ampliar é do humano;
 * o serviço só diz se os gates OBJETIVOS estão cumpridos e, se não, POR QUÊ. NÃO
 * corrige regressão nem migra nada — corrigir é ação governada, e as regressões
 * REAIS só aparecem após a observação do ciclo real (dependente do dono).
 *
 * Limiares são configuráveis (não inventa SLA §600): os defaults são
 * conservadores e derivados da baseline que o operador registrou.
 *
 * NÃO altera nada (read-only, RN-004), isolado por org, token-safe (as fontes já
 * o são). Não lê segredo.
 */
import { FalaTuBridgeReconService } from "./FalaTuBridgeReconService.js";
import { WhatsAppHealthService } from "./WhatsAppHealthService.js";
import { ChannelStateService } from "./ChannelStateService.js";

export interface PilotReadinessOptions {
  /** Idade máxima tolerada de item preso na fila (s). Default 3600 (1h). */
  maxQueueAgeSec?: number;
  /** Máximo de envios `unknown` (possível duplicação) não reconciliados. Default 0. */
  maxUnknown?: number;
}

export interface ReadinessDimension {
  ready: boolean;
  blockers: string[];
  warnings: string[];
  detail: Record<string, unknown>;
}

export interface PilotReadinessReport {
  generatedAt: string;
  /** Veredito ADVISÓRIO: os gates objetivos de reconciliação estão cumpridos? */
  ready: boolean;
  /** Motivos que impedem ampliar (vazio quando ready). */
  blockers: string[];
  /** Pontos de atenção que NÃO bloqueiam por si (operador avalia). */
  warnings: string[];
  migration: ReadinessDimension;
  queue: ReadinessDimension;
  channels: ReadinessDimension;
  thresholds: { maxQueueAgeSec: number; maxUnknown: number };
  note: string;
}

export class PilotReadinessService {
  static assess(orgId: string, opts: PilotReadinessOptions = {}): PilotReadinessReport {
    const maxQueueAgeSec = opts.maxQueueAgeSec ?? 3600;
    const maxUnknown = opts.maxUnknown ?? 0;

    // ── MIGRAÇÃO: elos quebrados + divergência de estado = não reconciliada (§602). ──
    const report = FalaTuBridgeReconService.report(orgId);
    const counts = FalaTuBridgeReconService.records(orgId, { limit: 0 }).counts;
    const brokenLinks =
      report.bridges.tasks.brokenLinks + report.bridges.events.brokenLinks + report.bridges.lists.brokenLinks;
    const divergent = counts.linked_state_divergent || 0;
    const migBlockers: string[] = [];
    if (brokenLinks > 0) migBlockers.push(`${brokenLinks} vínculo(s) quebrado(s) (canônico ausente) — reconciliar antes de ampliar (§15.1/§602)`);
    if (divergent > 0) migBlockers.push(`${divergent} registro(s) com estado divergente silo×canônico — convergir antes de ampliar (§602)`);
    const migWarnings: string[] = [];
    const unbridgedMigratable = counts.unlinked_migratable || 0;
    if (unbridgedMigratable > 0) migWarnings.push(`${unbridgedMigratable} registro(s) migrável(is) ainda sem espelho (rodar backfill quando decidir migrar)`);
    const migration: ReadinessDimension = {
      ready: migBlockers.length === 0,
      blockers: migBlockers,
      warnings: migWarnings,
      detail: { brokenLinks, divergent, unbridgedMigratable, counts, overallReady: report.overallReady },
    };

    // ── FILAS: fila presa + `unknown` acumulado (possível duplicação, §14/§602). ──
    const m = WhatsAppHealthService.metrics(orgId);
    const qBlockers: string[] = [];
    if (m.queueAgeMaxSec !== null && m.queueAgeMaxSec > maxQueueAgeSec)
      qBlockers.push(`fila presa: item mais antigo há ${m.queueAgeMaxSec}s (limite ${maxQueueAgeSec}s) — drenar/investigar antes de ampliar`);
    if (m.failuresByClass.unknown > maxUnknown)
      qBlockers.push(`${m.failuresByClass.unknown} envio(s) indeterminado(s) (unknown) não reconciliado(s) — possível duplicação (§14), reconciliar antes de ampliar`);
    const qWarnings: string[] = [];
    if (m.failuresByClass.permanent > 0) qWarnings.push(`${m.failuresByClass.permanent} falha(s) permanente(s) (número inválido/opt-out/finalidade desligada) — esperadas, revisar se em excesso`);
    if (m.failuresByClass.transient > 0) qWarnings.push(`${m.failuresByClass.transient} falha(s) transitória(s) (retentadas) — acompanhar se persistir`);
    const queue: ReadinessDimension = {
      ready: qBlockers.length === 0,
      blockers: qBlockers,
      warnings: qWarnings,
      detail: { queued: m.queued, sent: m.sent, delivered: m.delivered, queueAgeMaxSec: m.queueAgeMaxSec, failuresByClass: m.failuresByClass },
    };

    // ── CANAIS: webhook `rejected` = recebimento não confiável (nunca "ready"). ──
    const states = ChannelStateService.list(orgId);
    const rejected = states.filter((s) => s.webhook === "rejected");
    const notOperational = states.filter((s) => s.operation !== "ready" && s.administration !== "paused");
    const chBlockers: string[] = [];
    if (rejected.length > 0)
      chBlockers.push(`${rejected.length} canal(is) com webhook REJEITADO (segredo/URL) — corrigir a URL na Evolution antes de ampliar (A10)`);
    const chWarnings: string[] = [];
    for (const s of notOperational)
      chWarnings.push(`canal ${s.channelId}: operação '${s.operation}' (sessão ${s.session}, webhook ${s.webhook}) — verificar se deveria estar ativo`);
    const channels: ReadinessDimension = {
      ready: chBlockers.length === 0,
      blockers: chBlockers,
      warnings: chWarnings,
      detail: { total: states.length, rejected: rejected.length, notOperational: notOperational.length, webhookEnforced: ChannelStateService.webhookEnforced() },
    };

    const blockers = [...migration.blockers, ...queue.blockers, ...channels.blockers];
    const warnings = [...migration.warnings, ...queue.warnings, ...channels.warnings];
    return {
      generatedAt: new Date().toISOString(),
      ready: blockers.length === 0,
      blockers,
      warnings,
      migration,
      queue,
      channels,
      thresholds: { maxQueueAgeSec, maxUnknown },
      note: "Veredito ADVISÓRIO dos gates OBJETIVOS de reconciliação (§531/§602). A decisão de ampliar é do operador; corrigir regressões e reconciliar são ações à parte. Regressões do ciclo REAL só aparecem após a observação do piloto (dependente do dono).",
    };
  }
}

export default PilotReadinessService;
