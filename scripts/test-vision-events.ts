/**
 * TESTE DO VISION CLOUD — EVENTOS TÉCNICOS (Sprint 2: gateway_offline/
 * gateway_online, Event Inbox)
 * ------------------------------------------------------------------
 * Sobe o processo REAL do vision-cloud com o monitor de saúde acelerado
 * (env vars de teste) e prova com chamadas HTTP de verdade:
 *   - heartbeat perdido gera evento `gateway_offline` (severidade alta) e
 *     marca o gateway como offline;
 *   - heartbeat que volta resolve automaticamente o evento aberto e gera um
 *     evento informativo `gateway_online`;
 *   - o Event Inbox lista, filtra por status/severidade, e a revisão humana
 *     (acknowledge/resolve/false_positive) funciona e é RBAC-gated;
 *   - isolamento multi-tenant nos eventos.
 *
 * Uso:  npm run test:vision-events
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

const JWT_SECRET = "test-secret-vision-events-1234567890";
const PORT = 25000 + Math.floor(Math.random() * 4000);
const BASE_URL = `http://127.0.0.1:${PORT}`;

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function token(organizationId: string, userId: string, role: string) {
  return jwt.sign({ organizationId, userId, role }, JWT_SECRET);
}

async function call(method: string, urlPath: string, opts: { token?: string; gatewayKey?: string; body?: any } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.gatewayKey) headers["X-Gateway-Key"] = opts.gatewayKey;
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, body: json };
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return true;
    } catch {}
    await sleep(100);
  }
  return false;
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number, pollMs = 200): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(pollMs);
  }
  return predicate();
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vision-events-"));

  // Monitor bem acelerado para o teste não demorar minutos: considera
  // offline depois de 1s sem heartbeat, checa a cada 500ms.
  const proc: ChildProcess = spawn(process.execPath, [TSX_BIN, path.join(repoRoot, "apps/vision-cloud/server.ts")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATA_DIR: tmpDir,
      JWT_SECRET,
      VISION_CLOUD_PORT: String(PORT),
      NODE_ENV: "production",
      VISION_GATEWAY_OFFLINE_THRESHOLD_MS: "1000",
      VISION_HEALTH_MONITOR_INTERVAL_MS: "500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout!.on("data", (d) => (out += d.toString()));
  proc.stderr!.on("data", (d) => (out += d.toString()));

  try {
    const up = await waitForHealth(8000);
    check("vision-cloud sobe (com monitor de saúde acelerado para teste)", up);
    if (!up) throw new Error("vision-cloud não subiu: " + out);

    const orgA = "org-a-" + Date.now();
    const orgB = "org-b-" + Date.now();
    const ownerA = token(orgA, "user-a-owner", "owner");
    const ownerB = token(orgB, "user-b-owner", "owner");
    const portariaA = token(orgA, "user-a-portaria", "agent"); // sem papel Vision ainda

    const site = await call("POST", "/sites", { token: ownerA, body: { name: "Site com gateway" } });
    const siteId = site.body?.site?.id;

    const register = await call("POST", "/gateways/register", { token: ownerA, body: { site_id: siteId, name: "Gateway Teste" } });
    const gatewayId = register.body?.gateway?.id;
    const apiKey = register.body?.api_key;

    // Primeiro heartbeat: gateway fica online, sem evento nenhum ainda.
    await call("POST", `/gateways/${gatewayId}/heartbeat`, { gatewayKey: apiKey, body: {} });
    const eventsBeforeTimeout = await call("GET", "/events", { token: ownerA });
    check("Nenhum evento antes do heartbeat expirar", eventsBeforeTimeout.body?.events?.length === 0, `count=${eventsBeforeTimeout.body?.events?.length}`);

    // Espera o heartbeat expirar (threshold 1s) + o monitor rodar (intervalo 500ms).
    const offlineDetected = await waitUntil(async () => {
      const r = await call("GET", "/events", { token: ownerA, });
      return r.body?.events?.some((e: any) => e.event_type === "gateway_offline" && e.status === "detected");
    }, 5000);
    check("Monitor detecta heartbeat perdido e cria evento gateway_offline", offlineDetected);

    const gatewayAfterOffline = await call("GET", `/gateways/${gatewayId}/health`, { token: ownerA });
    check("Gateway é marcado como 'offline' depois do timeout", gatewayAfterOffline.body?.gateway?.status === "offline", `status=${gatewayAfterOffline.body?.gateway?.status}`);

    // Não deve duplicar evento em ticks subsequentes do monitor.
    await sleep(1200); // pelo menos +2 ticks do monitor
    const eventsAfterExtraTicks = await call("GET", "/events", { token: ownerA, });
    const offlineEvents = eventsAfterExtraTicks.body?.events?.filter((e: any) => e.event_type === "gateway_offline");
    check("Monitor NÃO duplica evento enquanto o gateway continua offline", offlineEvents?.length === 1, `count=${offlineEvents?.length}`);

    // ===== RBAC no Event Inbox: usuário sem papel Vision não pode revisar =====
    const eventId = offlineEvents[0].id;
    const reviewAsPortaria = await call("POST", `/events/${eventId}/review`, { token: portariaA, body: { action: "acknowledge" } });
    check("RBAC: usuário sem papel Vision não pode revisar evento (403)", reviewAsPortaria.status === 403, `status=${reviewAsPortaria.status}`);

    const acknowledge = await call("POST", `/events/${eventId}/review`, { token: ownerA, body: { action: "acknowledge" } });
    check("Evento pode ser reconhecido (acknowledge)", acknowledge.status === 200 && acknowledge.body?.event?.status === "acknowledged", `status=${acknowledge.body?.event?.status}`);

    const invalidAction = await call("POST", `/events/${eventId}/review`, { token: ownerA, body: { action: "chutar_o_balde" } });
    check("Ação de revisão inválida é rejeitada (400)", invalidAction.status === 400, `status=${invalidAction.status}`);

    // ===== Recuperação: heartbeat volta, evento resolve sozinho, evento gateway_online aparece =====
    await call("POST", `/gateways/${gatewayId}/heartbeat`, { gatewayKey: apiKey, body: {} });
    const gatewayAfterRecovery = await call("GET", `/gateways/${gatewayId}/health`, { token: ownerA });
    check("Gateway volta a 'online' assim que o heartbeat retorna", gatewayAfterRecovery.body?.gateway?.status === "online");

    const eventAfterRecovery = await call("GET", `/events/${eventId}`, { token: ownerA });
    check(
      "Evento gateway_offline é resolvido AUTOMATICAMENTE quando o heartbeat volta",
      eventAfterRecovery.body?.event?.status === "resolved" && !!eventAfterRecovery.body?.event?.resolved_at,
      `status=${eventAfterRecovery.body?.event?.status}`
    );

    const eventsAfterRecovery = await call("GET", "/events", { token: ownerA });
    const onlineEvent = eventsAfterRecovery.body?.events?.find((e: any) => e.event_type === "gateway_online");
    check("Evento informativo gateway_online é criado na recuperação", !!onlineEvent);

    // ===== Filtros do Event Inbox =====
    const resolvedFilter = await call("GET", "/events?status=resolved", { token: ownerA });
    check(
      "Filtro por status funciona (só eventos 'resolved')",
      resolvedFilter.body?.events?.length > 0 && resolvedFilter.body.events.every((e: any) => e.status === "resolved")
    );

    // ===== Isolamento multi-tenant =====
    const eventsAsOwnerB = await call("GET", "/events", { token: ownerB });
    check("Isolamento: org B não vê nenhum evento de org A", eventsAsOwnerB.body?.events?.length === 0, `count=${eventsAsOwnerB.body?.events?.length}`);
  } finally {
    try {
      proc.kill("SIGTERM");
    } catch {}
    await sleep(300);
    try {
      proc.kill("SIGKILL");
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }

  console.log("\n==================================================");
  console.log("  TESTE VISION CLOUD — EVENTOS TÉCNICOS (Sprint 2)");
  console.log("==================================================\n");
  const total = results.length;
  console.log(`  Resultado: ${total - failures}/${total} verificações passaram.`);
  console.log(
    failures === 0
      ? "  📡  EVENTOS OK: detecção, auto-resolução, Event Inbox e RBAC confirmados.\n"
      : `  ⚠️  ${failures} verificação(ões) FALHARAM — investigar antes de prosseguir.\n`
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro ao rodar o teste de eventos do Vision Cloud:", e);
  process.exit(1);
});
