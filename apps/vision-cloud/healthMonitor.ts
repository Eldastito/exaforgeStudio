// Monitor de saúde de gateway — detecta heartbeat perdido e transiciona o
// gateway para 'offline', gerando o evento técnico `gateway_offline`.
//
// POR QUE ISSO RODA AQUI (dentro do vision-cloud), NÃO no Scheduler.ts do
// core: é uma responsabilidade do domínio Vision, sobre uma tabela que o
// vision-cloud é dono (vision_gateways) — colocar isso no Scheduler.ts do
// core reacoplaria os dois processos exatamente no que a ADR-001 evitou.
//
// A RECUPERAÇÃO (heartbeat volta) é tratada de forma síncrona e imediata em
// routes/gateways.ts, no momento em que o heartbeat chega — não precisa
// esperar o próximo tick deste monitor. Este monitor só cuida da detecção de
// AUSÊNCIA de heartbeat, que por natureza só pode ser percebida periodicamente.
import db from "./db.js";
import { createEventIfNotOpen } from "./events.js";

// Configuráveis por env var — tanto para operação (ajustar sensibilidade
// conforme o intervalo real de heartbeat do Edge, quando existir) quanto
// para os testes automatizados rodarem em segundos, não minutos (mesmo
// padrão já usado em scripts/supervisor.ts).
const OFFLINE_THRESHOLD_MS = Number(process.env.VISION_GATEWAY_OFFLINE_THRESHOLD_MS || 120_000);
const MONITOR_INTERVAL_MS = Number(process.env.VISION_HEALTH_MONITOR_INTERVAL_MS || 30_000);

let timer: NodeJS.Timeout | null = null;

function tick() {
  const cutoff = new Date(Date.now() - OFFLINE_THRESHOLD_MS).toISOString().replace("T", " ").slice(0, 19);

  const staleGateways = db
    .prepare(
      `SELECT id, organization_id, site_id FROM vision_gateways
       WHERE status = 'online' AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)`
    )
    .all(cutoff) as { id: string; organization_id: string; site_id: string }[];

  for (const gw of staleGateways) {
    db.prepare(`UPDATE vision_gateways SET status = 'offline', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(gw.id);
    createEventIfNotOpen({
      organizationId: gw.organization_id,
      siteId: gw.site_id,
      gatewayId: gw.id,
      eventType: "gateway_offline",
      severity: "alta",
      payload: { reason: `sem heartbeat por mais de ${OFFLINE_THRESHOLD_MS}ms` },
    });
  }
}

export function startHealthMonitor() {
  if (timer) return; // idempotente — não duplica o timer se chamado 2x
  timer = setInterval(tick, MONITOR_INTERVAL_MS);
}

export function stopHealthMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
}
