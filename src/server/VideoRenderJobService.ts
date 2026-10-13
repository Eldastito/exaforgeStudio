/**
 * VideoRenderJobService — edição de vídeo em SEGUNDO PLANO (ADR-207 F13b.8). Sem fila nova: a execução é do `JobQueueService`
 * que já existe (handler `video_render`); aqui fica só a visão de PRODUTO do trabalho (`video_render_jobs`): status do cliente
 * (queued · processing · completed · failed · cancelled), resultado, mensagem de erro de cliente e cancelamento.
 *
 * Regras: o render é o MESMO `VideoPostProductionService.render` (nada duplicado; o endpoint síncrono segue existindo).
 *  - Sem progresso inventado: só status + tempos. Percentual falso não.
 *  - Limite de jobs ativos por empresa (anti-enxurrada) e duplo-clique devolve o job que já existe.
 *  - Cancelar: na fila → cancelado na hora; rodando → mata o ffmpeg (AbortSignal) e descarta a saída; nunca cria a criação.
 *    Depois de concluído é tarde demais (a criação já existe) — o cancelamento diz isso.
 *  - Concorrência: uma trava em memória (mesmo teto do FfmpegService) faz os jobs excedentes ESPERAREM a vez, em ordem — não é fila nova.
 *  - Ffmpeg ocupado por OUTRO uso (`busy`, ex.: render síncrono) NÃO falha: volta pra fila e o JobQueue reprocessa com backoff. Outros erros viram `failed` com a
 *    mensagem de cliente, SEM nova tentativa (repetir um corte inválido só gasta CPU) e sem poluir o dead-letter da operação.
 *  - Reinício do servidor no meio: o `sweepStale` do JobQueue reroda o job (render não gravou nada antes do fim); se já estava
 *    `completed`/`cancelled` o handler só sai.
 *  - Isolamento: toda leitura/cancelamento filtra `organization_id`.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { JobQueueService, JobQueueError } from "./JobQueueService.js";
import { VideoPostProductionService } from "./VideoPostProductionService.js";
import { ChannelAdaptationService } from "./ChannelAdaptationService.js";
import { FfmpegService } from "./FfmpegService.js";

export type VideoJobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";
const ACTIVE: VideoJobStatus[] = ["queued", "processing"];
const controllers = new Map<string, AbortController>();   // jobs rodando NESTE processo

export function maxActivePerOrg(): number { return Math.max(1, Number(process.env.VIDEO_JOBS_MAX_ACTIVE) || 3); }
const BUSY_MAX_ATTEMPTS = 6;

// Trava de concorrência (NÃO é fila nova — a fila é o JobQueue): no máximo `maxConcurrentJobs` renders ao mesmo tempo, o mesmo teto do
// FfmpegService. Cada render usa 1 processo ffmpeg por vez, então os nossos jobs nunca esbarram em `busy` entre si; os excedentes
// esperam a vez em memória (status segue "queued"), em ordem, em vez de falhar e voltar só no passe de 5 min do sweep.
let running = 0;
const waiters: (() => void)[] = [];
const gateLimit = () => Math.max(1, FfmpegService.limits.maxConcurrentJobs);
function acquire(): Promise<void> {
  if (running < gateLimit()) { running++; return Promise.resolve(); }
  return new Promise<void>((res) => waiters.push(res));          // a vaga é repassada por release(), sem decrementar
}
function release(): void { const next = waiters.shift(); if (next) next(); else running = Math.max(0, running - 1); }
// sweepStale não duplica quem espera a vez ou roda: a 2ª chamada AGUARDA a 1ª (o background_jobs só vira "completed" quando de fato terminou)
const inflight = new Map<string, Promise<void>>();

function view(r: any) {
  if (!r) return null;
  return {
    id: r.id, creationId: r.creation_id, channel: r.channel, status: r.status as VideoJobStatus,
    result: r.result_json ? JSON.parse(r.result_json) : null, error: r.error_message || null,
    createdAt: r.created_at, startedAt: r.started_at || null, finishedAt: r.finished_at || null,
  };
}

export class VideoRenderJobService {
  /** Valida o pedido (rápido, igual ao render) e enfileira. Pedido idêntico já ativo devolve o mesmo job. */
  static enqueue(orgId: string, userId: string | null, input: { creationId: string; channel: string; topic: string; objectiveId?: string | null; subtitles?: boolean; removePauses?: boolean; title?: boolean | string; cta?: boolean | string }) {
    const creationId = String(input?.creationId || "");
    const row = db.prepare("SELECT id, kind, status FROM studio_creations WHERE id = ? AND organization_id = ?").get(creationId, orgId) as any;
    if (!row || row.kind !== "video") throw new Error("Vídeo do Estúdio não encontrado.");
    if (row.status && row.status !== "done") throw new Error("Esse vídeo ainda não está pronto.");
    const channel = String(input?.channel || "");
    if (!ChannelAdaptationService.isKnownChannel(channel)) throw new Error("Canal não suportado para edição.");
    if (!String(input?.topic || "").trim()) throw new Error("Informe o tópico do vídeo.");

    const params = {
      creationId, channel, topic: String(input.topic).trim(), objectiveId: input.objectiveId ?? null,
      subtitles: input.subtitles === true, removePauses: input.removePauses === true,
      title: typeof input.title === "string" ? input.title : input.title === true, cta: typeof input.cta === "string" ? input.cta : input.cta === true,
    };
    const paramsJson = JSON.stringify(params);
    const active = db.prepare(`SELECT * FROM video_render_jobs WHERE organization_id = ? AND status IN ('queued','processing')`).all(orgId) as any[];
    const dup = active.find((a) => a.params_json === paramsJson);
    if (dup) return { ...view(dup)!, deduplicated: true };
    if (active.length >= maxActivePerOrg()) throw new Error(`Você já tem ${active.length} edições em andamento. Espere uma terminar ou cancele uma.`);

    const id = randomUUID();
    db.prepare("INSERT INTO video_render_jobs (id, organization_id, creation_id, channel, params_json, status, requested_by) VALUES (?, ?, ?, ?, ?, 'queued', ?)").run(id, orgId, creationId, channel, paramsJson, userId);
    JobQueueService.enqueue("video_render", { videoJobId: id }, { organizationId: orgId, maxAttempts: BUSY_MAX_ATTEMPTS });
    return { ...view(this.row(orgId, id))!, deduplicated: false };
  }

  private static row(orgId: string, id: string): any {
    return db.prepare("SELECT * FROM video_render_jobs WHERE id = ? AND organization_id = ?").get(String(id || ""), orgId);
  }
  static get(orgId: string, id: string) { return view(this.row(orgId, id)); }
  static list(orgId: string, limit = 20) {
    return (db.prepare("SELECT * FROM video_render_jobs WHERE organization_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(orgId, Math.min(100, Math.max(1, limit))) as any[]).map(view);
  }

  /** Cancela. Na fila: na hora. Rodando: mata o ffmpeg. Já terminado: não dá (a criação existe / o erro já aconteceu). */
  static cancel(orgId: string, id: string): { ok: boolean; status: VideoJobStatus | null; message: string } {
    const r = this.row(orgId, id);
    if (!r) return { ok: false, status: null, message: "Edição não encontrada." };
    const res = db.prepare("UPDATE video_render_jobs SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP, error_message = NULL WHERE id = ? AND organization_id = ? AND status IN ('queued','processing')").run(r.id, orgId);
    if (!res.changes) return { ok: false, status: r.status, message: r.status === "completed" ? "Essa edição já terminou — o vídeo está pronto." : r.status === "cancelled" ? "Essa edição já estava cancelada." : "Essa edição já terminou com erro." };
    controllers.get(r.id)?.abort();
    return { ok: true, status: "cancelled", message: "Edição cancelada." };
  }

  /** Corpo do handler do JobQueue. */
  static async run(videoJobId: string, job?: any): Promise<void> {
    const r = db.prepare("SELECT * FROM video_render_jobs WHERE id = ?").get(String(videoJobId || "")) as any;
    if (!r || !ACTIVE.includes(r.status)) return;            // cancelado/concluído/removido: nada a fazer
    const existing = inflight.get(r.id);
    if (existing) return existing;
    const p = (async () => {
      await acquire();
      try { await this.execute(r, job); } finally { release(); }
    })();
    inflight.set(r.id, p);
    try { await p; } finally { inflight.delete(r.id); }
  }

  private static async execute(r: any, job?: any): Promise<void> {
    const orgId = r.organization_id as string;
    const started = db.prepare("UPDATE video_render_jobs SET status = 'processing', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ? AND status IN ('queued','processing')").run(r.id);
    if (!started.changes) return;
    const ac = new AbortController(); controllers.set(r.id, ac);
    try {
      const params = JSON.parse(r.params_json || "{}");
      const result = await VideoPostProductionService.render(orgId, params, { signal: ac.signal });
      // só conclui se NÃO foi cancelado no meio (a criação só existe se o render passou da checagem de cancelamento)
      db.prepare("UPDATE video_render_jobs SET status = 'completed', result_json = ?, error_message = NULL, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'processing'").run(JSON.stringify(result), r.id);
    } catch (e: any) {
      const code = e?.code as string | undefined;
      if (code === "cancelled" || ac.signal.aborted) return;   // o cancel() já gravou o estado
      if (code === "busy") {
        // `job.attempts` ainda é o valor ANTES desta tentativa. Na última, desiste com mensagem de cliente (nunca fica "na fila" pra sempre).
        const attemptNo = (job?.attempts || 0) + 1;
        if (attemptNo >= (job?.max_attempts || BUSY_MAX_ATTEMPTS)) {
          db.prepare("UPDATE video_render_jobs SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'processing'").run("O servidor está ocupado com outras edições. Tente de novo em alguns minutos.", r.id);
          return;
        }
        db.prepare("UPDATE video_render_jobs SET status = 'queued' WHERE id = ? AND status = 'processing'").run(r.id);
        throw new JobQueueError("ffmpeg ocupado", "retryable");   // JobQueue reprocessa com backoff
      }
      db.prepare("UPDATE video_render_jobs SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'processing'").run(String(e?.message || "Não consegui editar esse vídeo.").slice(0, 300), r.id);
    } finally {
      controllers.delete(r.id);
    }
  }
}

JobQueueService.registerHandler("video_render", async (p: any, job: any) => { await VideoRenderJobService.run(p?.videoJobId, job); return { ok: true }; });

export default VideoRenderJobService;
