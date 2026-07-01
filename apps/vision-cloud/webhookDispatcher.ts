// Entrega de verdade dos webhooks enfileirados por webhooks.ts — HMAC de
// assinatura, timeout, retry com backoff exponencial e teto de tentativas
// (PRD §16.3: "assinatura", "retry", "status de entrega").
//
// Roda em timer próprio dentro do vision-cloud (mesmo padrão de
// healthMonitor.ts) — não no Scheduler.ts do core, pelo mesmo motivo: é
// responsabilidade do domínio Vision, sobre tabelas que só o vision-cloud é
// dono, e colocar isso no core reacoplaria os dois processos que o ADR-001
// deliberou manter separados.
import crypto from "crypto";
import db from "./db.js";
import { decryptSecret } from "./crypto.js";

const DISPATCH_INTERVAL_MS = Number(process.env.VISION_WEBHOOK_DISPATCH_INTERVAL_MS || 10_000);
const REQUEST_TIMEOUT_MS = Number(process.env.VISION_WEBHOOK_TIMEOUT_MS || 10_000);
const MAX_ATTEMPTS = Number(process.env.VISION_WEBHOOK_MAX_ATTEMPTS || 6);
// Backoff configurável (segundos, separado por vírgula) — só para os testes
// automatizados não esperarem horas de verdade; produção usa o default.
const BACKOFF_SECONDS = (process.env.VISION_WEBHOOK_BACKOFF_SECONDS || "30,120,600,1800,7200,21600")
  .split(",")
  .map((s) => Math.max(1, parseInt(s.trim(), 10) || 1));

let timer: NodeJS.Timeout | null = null;

type DueDelivery = {
  id: string;
  webhook_id: string;
  organization_id: string;
  event_type: string;
  payload_json: string;
  attempt_count: number;
  url: string;
  secret_enc: string;
};

async function deliverOne(d: DueDelivery): Promise<void> {
  const attempt = d.attempt_count + 1;
  let secret: string;
  try {
    secret = decryptSecret(d.secret_enc);
  } catch (e) {
    // Segredo ilegível (ex.: ENCRYPTION_KEY mudou) — não adianta tentar de
    // novo sozinho; some para o histórico e exige reprocessamento manual
    // depois que o problema de configuração for corrigido.
    finalize(d.id, attempt, "exhausted", null, "secret_decrypt_failed");
    return;
  }

  const signature = crypto.createHmac("sha256", secret).update(d.payload_json).digest("hex");
  try {
    const res = await fetch(d.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vision-Event": d.event_type,
        "X-Vision-Signature": `sha256=${signature}`,
        "X-Vision-Idempotency-Key": d.id,
      },
      body: d.payload_json,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.ok) {
      finalize(d.id, attempt, "success", res.status, null);
    } else {
      scheduleRetryOrExhaust(d.id, attempt, res.status, `http_${res.status}`);
    }
  } catch (e: any) {
    scheduleRetryOrExhaust(d.id, attempt, null, String(e?.message || e).slice(0, 500));
  }
}

function finalize(id: string, attempt: number, status: "success" | "exhausted", responseStatus: number | null, error: string | null) {
  db.prepare(
    `UPDATE vision_webhook_deliveries
     SET status = ?, attempt_count = ?, last_response_status = ?, last_error = ?,
         delivered_at = CASE WHEN ? = 'success' THEN CURRENT_TIMESTAMP ELSE delivered_at END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(status, attempt, responseStatus, error, status, id);
}

function scheduleRetryOrExhaust(id: string, attempt: number, responseStatus: number | null, error: string) {
  if (attempt >= MAX_ATTEMPTS) {
    finalize(id, attempt, "exhausted", responseStatus, error);
    return;
  }
  const delaySec = BACKOFF_SECONDS[Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)];
  db.prepare(
    `UPDATE vision_webhook_deliveries
     SET attempt_count = ?, last_response_status = ?, last_error = ?,
         next_attempt_at = datetime('now', ?), updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(attempt, responseStatus, error, `+${delaySec} seconds`, id);
}

async function tick() {
  const due = db
    .prepare(
      `SELECT d.id, d.webhook_id, d.organization_id, d.event_type, d.payload_json, d.attempt_count, w.url, w.secret_enc
       FROM vision_webhook_deliveries d
       JOIN vision_webhooks w ON w.id = d.webhook_id
       WHERE d.status = 'pending' AND w.is_active = 1 AND d.next_attempt_at <= CURRENT_TIMESTAMP
       LIMIT 50`
    )
    .all() as DueDelivery[];

  for (const d of due) {
    try { await deliverOne(d); } catch (e) { console.error("[WebhookDispatcher] Falha ao entregar", d.id, e); }
  }
}

export function startWebhookDispatcher() {
  if (timer) return; // idempotente
  timer = setInterval(() => { tick().catch((e) => console.error("[WebhookDispatcher] tick falhou:", e)); }, DISPATCH_INTERVAL_MS);
}

export function stopWebhookDispatcher() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Reprocessamento manual autorizado (PRD §16.3) — usado por routes/webhooks.ts. */
export function requeueDelivery(deliveryId: string): void {
  db.prepare(
    `UPDATE vision_webhook_deliveries
     SET status = 'pending', attempt_count = 0, next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(deliveryId);
}
