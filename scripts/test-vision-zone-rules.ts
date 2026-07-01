/**
 * TESTE DO VISION CLOUD — ZONAS E REGRAS (motor determinístico de "vídeo
 * analytics", PRD §19.1)
 * ------------------------------------------------------------------
 * Sobe o processo REAL do vision-cloud e prova, com chamadas HTTP de
 * verdade e SEM nenhuma câmera/IA de verdade (os "fatos" são alimentados via
 * POST /zones/:id/observations, o mesmo formato que o futuro detector do
 * Vision Edge Gateway vai mandar), que o motor de regras:
 *   - dispara 'occupancy_count' quando a contagem de pessoas cruza o limite;
 *   - dispara 'dwell_time' quando a presença contínua ultrapassa o tempo
 *     configurado;
 *   - dispara 'after_hours_presence' quando há presença fora da janela
 *     configurada;
 *   - NÃO duplica o evento enquanto a mesma "sessão" de ocupação continua
 *     (idempotência), mas dispara de NOVO numa sessão nova (zona esvaziou e
 *     encheu de novo);
 *   - os eventos criados entram no MESMO pipeline já testado em outras
 *     suítes (webhook de saída disparado, sem precisar mudar webhooks.ts);
 *   - RBAC e isolamento multi-tenant.
 *
 * Uso:  npm run test:vision-zone-rules
 */
import os from "os";
import path from "path";
import fs from "fs";
import { spawn, ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const TSX_BIN = path.join(repoRoot, "node_modules", ".bin", "tsx");

const JWT_SECRET = "test-secret-vision-zone-rules-1234567890";
const PORT = 24000 + Math.floor(Math.random() * 2000);
const BASE_URL = `http://127.0.0.1:${PORT}`;

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}
function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function token(organizationId: string, userId: string, role: string) {
  return jwt.sign({ organizationId, userId, role }, JWT_SECRET);
}
async function call(method: string, urlPath: string, opts: { token?: string; body?: any } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE_URL}${urlPath}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  let json: any = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}
async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const res = await fetch(`${BASE_URL}/health`); if (res.ok) return true; } catch {}
    await sleep(100);
  }
  return false;
}
function countEventsOfType(events: any[], type: string): number {
  return events.filter((e: any) => e.event_type === type).length;
}

// Janela "fora do horário" garantida: escolhe uma janela de 1h que NÃO
// contém o horário atual, então after_hours_presence dispara de forma
// determinística não importa quando este teste rode.
function offHoursWindowExcludingNow(): { start: string; end: string } {
  const now = new Date();
  const startHour = (now.getHours() + 2) % 24;
  const endHour = (startHour + 1) % 24;
  const pad = (n: number) => String(n).padStart(2, "0");
  return { start: `${pad(startHour)}:00`, end: `${pad(endHour)}:00` };
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vision-zone-rules-"));

  const proc: ChildProcess = spawn(process.execPath, [TSX_BIN, path.join(repoRoot, "apps/vision-cloud/server.ts")], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: tmpDir, JWT_SECRET, VISION_CLOUD_PORT: String(PORT), NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout!.on("data", (d) => (out += d.toString()));
  proc.stderr!.on("data", (d) => (out += d.toString()));

  try {
    const up = await waitForHealth(8000);
    check("vision-cloud sobe", up);
    if (!up) throw new Error("vision-cloud não subiu: " + out);

    const orgA = "org-a-" + Date.now();
    const orgB = "org-b-" + Date.now();
    const ownerA = token(orgA, "user-a-owner", "owner");
    const ownerB = token(orgB, "user-b-owner", "owner");
    const portariaA = token(orgA, "user-a-portaria", "agent"); // sem papel Vision

    const site = await call("POST", "/sites", { token: ownerA, body: { name: "Loja com zona monitorada" } });
    const siteId = site.body?.site?.id;

    // ===== RBAC =====
    const noAuth = await call("GET", "/zones");
    check("Sem token nenhum: 401", noAuth.status === 401, `status=${noAuth.status}`);
    const asAgentCreate = await call("POST", "/zones", { token: portariaA, body: { site_id: siteId, name: "Estoque" } });
    check("RBAC: agent comum sem papel Vision não pode criar zona (403)", asAgentCreate.status === 403, `status=${asAgentCreate.status}`);

    // ===== Criação da zona =====
    const createZone = await call("POST", "/zones", { token: ownerA, body: { site_id: siteId, name: "Estoque", description: "Área de estoque, sem circulação após 20h" } });
    check("Zona criada", createZone.status === 201, `status=${createZone.status}`);
    const zoneId = createZone.body?.zone?.id;

    const zoneOtherSite = await call("POST", "/zones", { token: ownerA, body: { name: "Sem site" } });
    check("Zona sem site_id é rejeitada (400)", zoneOtherSite.status === 400, `status=${zoneOtherSite.status}`);

    // ===== Criação das 3 regras =====
    const ruleOccupancy = await call("POST", `/zones/${zoneId}/rules`, { token: ownerA, body: { rule_type: "occupancy_count", threshold_value: 3, severity: "alta" } });
    check("Regra 'occupancy_count' criada (limite 3)", ruleOccupancy.status === 201, `status=${ruleOccupancy.status}`);

    const ruleDwell = await call("POST", `/zones/${zoneId}/rules`, { token: ownerA, body: { rule_type: "dwell_time", threshold_value: 0.05, severity: "critica" } }); // 0.05 min = 3s
    check("Regra 'dwell_time' criada (limite 0.05 min = 3s)", ruleDwell.status === 201, `status=${ruleDwell.status}`);

    const offHours = offHoursWindowExcludingNow();
    const ruleAfterHours = await call("POST", `/zones/${zoneId}/rules`, { token: ownerA, body: { rule_type: "after_hours_presence", active_hours_start: offHours.start, active_hours_end: offHours.end, severity: "media" } });
    check("Regra 'after_hours_presence' criada (janela que exclui o horário atual)", ruleAfterHours.status === 201, `status=${ruleAfterHours.status}`);

    const badRule = await call("POST", `/zones/${zoneId}/rules`, { token: ownerA, body: { rule_type: "occupancy_count", threshold_value: -1 } });
    check("Regra com threshold inválido é rejeitada (400)", badRule.status === 400, `status=${badRule.status}`);
    const badRuleType = await call("POST", `/zones/${zoneId}/rules`, { token: ownerA, body: { rule_type: "algo_invalido" } });
    check("Regra com rule_type inválido é rejeitada (400)", badRuleType.status === 400, `status=${badRuleType.status}`);

    // ===== Observação 1: 1 pessoa entra -> since agora é "fora do horário" configurado, dispara after_hours_presence na hora =====
    const obs1 = await call("POST", `/zones/${zoneId}/observations`, { token: ownerA, body: { person_count: 1 } });
    check("Observação (1 pessoa) aceita", obs1.status === 200 && obs1.body?.occupancy?.current_count === 1, `status=${obs1.status}`);

    let events = (await call("GET", "/events", { token: ownerA })).body?.events || [];
    check("after_hours_presence dispara na 1ª observação (fora da janela configurada)", countEventsOfType(events, "zone_after_hours_presence") === 1, `count=${countEventsOfType(events, "zone_after_hours_presence")}`);
    check("occupancy_count NÃO dispara ainda (só 1 pessoa, limite é 3)", countEventsOfType(events, "zone_occupancy_count") === 0);
    check("dwell_time NÃO dispara ainda (sessão acabou de começar)", countEventsOfType(events, "zone_dwell_time") === 0);

    // ===== Observação 2 (mesma sessão, ainda 1 pessoa): NÃO deve duplicar after_hours_presence =====
    await call("POST", `/zones/${zoneId}/observations`, { token: ownerA, body: { person_count: 1 } });
    events = (await call("GET", "/events", { token: ownerA })).body?.events || [];
    check("Idempotência: after_hours_presence NÃO duplica na mesma sessão", countEventsOfType(events, "zone_after_hours_presence") === 1, `count=${countEventsOfType(events, "zone_after_hours_presence")}`);

    // ===== Observação 3: sobe pra 4 pessoas -> dispara occupancy_count (>= 3) =====
    await call("POST", `/zones/${zoneId}/observations`, { token: ownerA, body: { person_count: 4 } });
    events = (await call("GET", "/events", { token: ownerA })).body?.events || [];
    check("occupancy_count dispara ao cruzar o limite (4 >= 3)", countEventsOfType(events, "zone_occupancy_count") === 1, `count=${countEventsOfType(events, "zone_occupancy_count")}`);

    // ===== Espera passar de 3s (limite do dwell_time) e observa de novo, mesma sessão =====
    await sleep(3500);
    await call("POST", `/zones/${zoneId}/observations`, { token: ownerA, body: { person_count: 4 } });
    events = (await call("GET", "/events", { token: ownerA })).body?.events || [];
    check("dwell_time dispara após ultrapassar o tempo configurado", countEventsOfType(events, "zone_dwell_time") === 1, `count=${countEventsOfType(events, "zone_dwell_time")}`);
    check("occupancy_count continua sem duplicar (mesma sessão)", countEventsOfType(events, "zone_occupancy_count") === 1);

    const dwellEvent = events.find((e: any) => e.event_type === "zone_dwell_time");
    const payload = JSON.parse(dwellEvent.payload_json);
    check("Payload do evento carrega zone_id/rule_id/detail", payload.zone_id === zoneId && !!payload.rule_id && !!payload.detail);

    // ===== Zona esvazia (0 pessoas): encerra a sessão =====
    const obsEmpty = await call("POST", `/zones/${zoneId}/observations`, { token: ownerA, body: { person_count: 0 } });
    check("Observação de zona vazia encerra a sessão", obsEmpty.body?.occupancy?.session_started_at === null, `session_started_at=${obsEmpty.body?.occupancy?.session_started_at}`);

    // ===== Nova sessão (zona ocupada de novo): after_hours_presence dispara DE NOVO =====
    await call("POST", `/zones/${zoneId}/observations`, { token: ownerA, body: { person_count: 1 } });
    events = (await call("GET", "/events", { token: ownerA })).body?.events || [];
    check("Nova sessão: after_hours_presence dispara de novo (2ª vez)", countEventsOfType(events, "zone_after_hours_presence") === 2, `count=${countEventsOfType(events, "zone_after_hours_presence")}`);

    // ===== Webhook de saída também recebe esses eventos (mesmo pipeline já testado) =====
    const createWebhook = await call("POST", "/webhooks", { token: ownerA, body: { url: "https://example.com/hook-zone-rules" } });
    check("Webhook de teste criado", createWebhook.status === 201, `status=${createWebhook.status}`);
    await call("POST", `/zones/${zoneId}/observations`, { token: ownerA, body: { person_count: 0 } }); // fecha
    await call("POST", `/zones/${zoneId}/observations`, { token: ownerA, body: { person_count: 1 } }); // abre sessão nova -> dispara after_hours de novo
    const deliveries = await call("GET", `/webhooks/${createWebhook.body?.webhook?.id}/deliveries`, { token: ownerA });
    const hasZoneDelivery = (deliveries.body?.deliveries || []).some((d: any) => d.event_type === "vision.event.detected");
    check("Evento de zona também enfileira entrega de webhook (reaproveita o pipeline existente)", hasZoneDelivery, `webhookId=${createWebhook.body?.webhook?.id} deliveries=${JSON.stringify(deliveries.body)}`);

    // ===== Isolamento multi-tenant =====
    const zonesAsB = await call("GET", "/zones", { token: ownerB });
    check("Isolamento: org B não vê zonas de org A", zonesAsB.body?.zones?.length === 0, `count=${zonesAsB.body?.zones?.length}`);
    const rulesAsB = await call("GET", `/zones/${zoneId}/rules`, { token: ownerB });
    check("Isolamento: org B não acessa regras da zona de org A (404)", rulesAsB.status === 404, `status=${rulesAsB.status}`);
    const obsAsB = await call("POST", `/zones/${zoneId}/observations`, { token: ownerB, body: { person_count: 5 } });
    check("Isolamento: org B não consegue reportar observação na zona de org A (404)", obsAsB.status === 404, `status=${obsAsB.status}`);
  } finally {
    try { proc.kill("SIGTERM"); } catch {}
    await sleep(300);
    try { proc.kill("SIGKILL"); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  console.log("\n==================================================");
  console.log("  TESTE VISION CLOUD — ZONAS E REGRAS");
  console.log("==================================================\n");
  const total = results.length;
  console.log(`  Resultado: ${total - failures}/${total} verificações passaram.`);
  console.log(
    failures === 0
      ? "  🧠  MOTOR DE REGRAS OK: disparo, idempotência por sessão e integração com o pipeline existente confirmados.\n"
      : `  ⚠️  ${failures} verificação(ões) FALHARAM — investigar antes de prosseguir.\n`
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro ao rodar o teste de zonas/regras do Vision Cloud:", e);
  process.exit(1);
});
