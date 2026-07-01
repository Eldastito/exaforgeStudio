/**
 * TESTE DO VISION CLOUD — WEBHOOKS DE SAÍDA (Vision Integration Gateway,
 * PRD §16.1/§16.3)
 * ------------------------------------------------------------------
 * Sobe o processo REAL do vision-cloud (com o dispatcher de webhooks
 * acelerado via env vars de teste) E um receptor HTTP real local (fazendo o
 * papel do "sistema externo" que assina os webhooks), e prova com chamadas
 * de verdade:
 *   - assinatura HMAC válida, cabeçalhos corretos (evento, idempotency key);
 *   - pânico dispara 3 tópicos (event.detected, panic.activated,
 *     incident.created) para um webhook inscrito em todos os tópicos;
 *   - filtro por event_types: um webhook inscrito só em
 *     "vision.incident.resolved" NÃO recebe a criação, só a resolução;
 *   - retry com backoff quando o receptor falha, até dar certo;
 *   - esgotamento (status 'exhausted') quando o receptor falha sempre, até
 *     o teto de tentativas — e reprocessamento manual autorizado depois;
 *   - segredo em claro só na criação (nunca exposto de novo);
 *   - URL insegura (loopback) é rejeitada na criação;
 *   - RBAC (só vision_admin) e isolamento multi-tenant.
 *
 * Uso:  npm run test:vision-webhooks
 */
import os from "os";
import http from "http";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { spawn, ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";
import { isSafeWebhookUrl } from "../apps/vision-cloud/webhooks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const TSX_BIN = path.join(repoRoot, "node_modules", ".bin", "tsx");

const JWT_SECRET = "test-secret-vision-webhooks-1234567890";
const VISION_PORT = 26500 + Math.floor(Math.random() * 2000);
const RECEIVER_PORT = 29000 + Math.floor(Math.random() * 2000);
const BASE_URL = `http://127.0.0.1:${VISION_PORT}`;
const RECEIVER_BASE = `http://127.0.0.1:${RECEIVER_PORT}`;

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
  const res = await fetch(`${BASE_URL}${urlPath}`, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
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
async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number, pollMs = 150): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(pollMs);
  }
  return await predicate();
}

// ── Receptor HTTP local (o "sistema externo") ──────────────────────────────
type Received = { path: string; headers: http.IncomingHttpHeaders; body: string };
const received: Received[] = [];
// path -> quantas respostas 500 dar antes de aceitar (200). undefined = sempre 200.
const failUntil: Record<string, number> = {};

const receiver = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const p = req.url || "/";
    received.push({ path: p, headers: req.headers, body });
    const remaining = failUntil[p] || 0;
    if (remaining > 0) {
      failUntil[p] = remaining - 1;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "simulated_failure" }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }
  });
});

function receivedFor(p: string): Received[] {
  return received.filter((r) => r.path === p);
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vision-webhooks-"));
  await new Promise<void>((resolve) => receiver.listen(RECEIVER_PORT, "127.0.0.1", resolve));

  const proc: ChildProcess = spawn(process.execPath, [TSX_BIN, path.join(repoRoot, "apps/vision-cloud/server.ts")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATA_DIR: tmpDir,
      JWT_SECRET,
      VISION_CLOUD_PORT: String(VISION_PORT),
      NODE_ENV: "production",
      VISION_WEBHOOK_DISPATCH_INTERVAL_MS: "300",
      VISION_WEBHOOK_BACKOFF_SECONDS: "1,1,1,1,1,1",
      VISION_WEBHOOK_TIMEOUT_MS: "3000",
      VISION_WEBHOOK_MAX_ATTEMPTS: "3",
      // Só o receptor deste teste roda em loopback (o "sistema externo"
      // fake) — nunca setado em produção. Ver comentário em webhooks.ts.
      VISION_WEBHOOK_ALLOW_LOOPBACK: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout!.on("data", (d) => (out += d.toString()));
  proc.stderr!.on("data", (d) => (out += d.toString()));

  try {
    const up = await waitForHealth(8000);
    check("vision-cloud sobe (com dispatcher de webhooks acelerado para teste)", up);
    if (!up) throw new Error("vision-cloud não subiu: " + out);

    const orgA = "org-a-" + Date.now();
    const orgB = "org-b-" + Date.now();
    const ownerA = token(orgA, "user-a-owner", "owner");
    const ownerB = token(orgB, "user-b-owner", "owner");
    const agentA = token(orgA, "user-a-agent", "agent"); // sem papel Vision

    // ===== RBAC =====
    const noAuth = await call("GET", "/webhooks");
    check("Sem token nenhum: 401", noAuth.status === 401, `status=${noAuth.status}`);
    const asAgent = await call("GET", "/webhooks", { token: agentA });
    check("RBAC: agent comum sem papel Vision não pode ver webhooks (403)", asAgent.status === 403, `status=${asAgent.status}`);

    // ===== URL insegura rejeitada (checagem direta da função pura — o
    // processo em SI roda com VISION_WEBHOOK_ALLOW_LOOPBACK=true só para o
    // receptor deste teste funcionar, então testar via HTTP contra o
    // processo não provaria nada aqui; isso testa a lógica de verdade, sem
    // esse bypass de teste no caminho) =====
    check("isSafeWebhookUrl: loopback IPv4 literal é bloqueado", isSafeWebhookUrl("http://127.0.0.1:9999/x") === false);
    check("isSafeWebhookUrl: 'localhost' é bloqueado", isSafeWebhookUrl("http://localhost/x") === false);
    check("isSafeWebhookUrl: rede privada 10.0.0.0/8 é bloqueada", isSafeWebhookUrl("http://10.1.2.3/x") === false);
    check("isSafeWebhookUrl: rede privada 192.168.0.0/16 é bloqueada", isSafeWebhookUrl("http://192.168.1.5/x") === false);
    check("isSafeWebhookUrl: link-local 169.254.0.0/16 é bloqueado", isSafeWebhookUrl("http://169.254.1.1/x") === false);
    check("isSafeWebhookUrl: protocolo não-http(s) é bloqueado", isSafeWebhookUrl("ftp://example.com/x") === false);
    check("isSafeWebhookUrl: URL malformada é bloqueada", isSafeWebhookUrl("not-a-url") === false);
    check("isSafeWebhookUrl: URL pública https normal é aceita", isSafeWebhookUrl("https://example.com/hook") === true);

    // ===== event_types inválido rejeitado =====
    const badTopic = await call("POST", "/webhooks", { token: ownerA, body: { url: `${RECEIVER_BASE}/hook-a`, event_types: ["vision.made_up_topic"] } });
    check("Tópico de evento inválido é rejeitado (400)", badTopic.status === 400, `status=${badTopic.status}`);

    // ===== Criação: inscrito em TODOS os tópicos =====
    const createAll = await call("POST", "/webhooks", { token: ownerA, body: { url: `${RECEIVER_BASE}/hook-a` } });
    check("Webhook criado (inscrito em todos os tópicos)", createAll.status === 201 && !!createAll.body?.secret, `status=${createAll.status}`);
    const webhookAllId = createAll.body?.webhook?.id;
    const secretAll: string = createAll.body?.secret;

    const listAfterCreate = await call("GET", "/webhooks", { token: ownerA });
    const rowAll = listAfterCreate.body?.webhooks?.find((w: any) => w.id === webhookAllId);
    check("GET /webhooks NUNCA expõe o segredo (nem cifrado)", !!rowAll && !("secret" in rowAll) && !("secret_enc" in rowAll));

    // ===== Botão de pânico deve gerar 3 entregas (event.detected, panic.activated, incident.created) =====
    const panic = await call("POST", "/panic", { token: ownerA, body: { reason: "teste de webhook" } });
    check("Pânico aciona (evento + ocorrência)", panic.status === 201, `status=${panic.status}`);

    const got3 = await waitUntil(() => receivedFor("/hook-a").length >= 3, 8000);
    check("Receptor recebe as 3 entregas do pânico (event.detected + panic.activated + incident.created)", got3, `count=${receivedFor("/hook-a").length}`);

    const deliveries = receivedFor("/hook-a");
    const topics = deliveries.map((d) => d.headers["x-vision-event"]);
    check("Tópicos recebidos batem com o esperado", ["vision.event.detected", "vision.panic.activated", "vision.incident.created"].every((t) => topics.includes(t)), `topics=${topics.join(",")}`);

    // Assinatura válida: o "sistema externo" recalcula o HMAC com o segredo devolvido na criação.
    const sample = deliveries[0];
    const expectedSig = "sha256=" + crypto.createHmac("sha256", secretAll).update(sample.body).digest("hex");
    check("Assinatura HMAC do payload confere com o segredo devolvido na criação", sample.headers["x-vision-signature"] === expectedSig);
    check("Idempotency key presente e não-vazia no header", typeof sample.headers["x-vision-idempotency-key"] === "string" && (sample.headers["x-vision-idempotency-key"] as string).length > 0);

    const payloadParsed = JSON.parse(sample.body);
    check("Payload tem organization_id e event corretos", payloadParsed.organization_id === orgA && !!payloadParsed.event);

    // ===== Filtro por event_types: webhook só para vision.incident.resolved =====
    const createFiltered = await call("POST", "/webhooks", { token: ownerA, body: { url: `${RECEIVER_BASE}/hook-filtered`, event_types: ["vision.incident.resolved"] } });
    check("Webhook filtrado criado (só vision.incident.resolved)", createFiltered.status === 201, `status=${createFiltered.status}`);

    const manualIncident = await call("POST", "/incidents", { token: ownerA, body: { title: "Ocorrência de teste" } });
    const incidentId = manualIncident.body?.incident?.id;
    await sleep(1200); // pelo menos 1 tick do dispatcher
    check("Webhook filtrado NÃO recebe vision.incident.created (fora da inscrição)", receivedFor("/hook-filtered").length === 0, `count=${receivedFor("/hook-filtered").length}`);

    await call("POST", `/incidents/${incidentId}/resolve`, { token: ownerA });
    const gotResolved = await waitUntil(() => receivedFor("/hook-filtered").length === 1, 5000);
    check("Webhook filtrado RECEBE vision.incident.resolved (dentro da inscrição)", gotResolved, `count=${receivedFor("/hook-filtered").length}`);
    check("Evento recebido pelo webhook filtrado é mesmo o 'resolved'", receivedFor("/hook-filtered")[0]?.headers["x-vision-event"] === "vision.incident.resolved");

    // ===== Retry: receptor falha 2x, depois aceita =====
    failUntil["/hook-retry"] = 2;
    const createRetry = await call("POST", "/webhooks", { token: ownerA, body: { url: `${RECEIVER_BASE}/hook-retry`, event_types: ["vision.incident.created"] } });
    const webhookRetryId = createRetry.body?.webhook?.id;
    const manualIncident2 = await call("POST", "/incidents", { token: ownerA, body: { title: "Ocorrência para testar retry" } });

    const succeededAfterRetry = await waitUntil(() => receivedFor("/hook-retry").length >= 3, 8000);
    check("Receptor recebe 3 tentativas (2 falhas + 1 sucesso) antes de aceitar", succeededAfterRetry, `count=${receivedFor("/hook-retry").length}`);

    const deliveriesRetry = await call("GET", `/webhooks/${webhookRetryId}/deliveries`, { token: ownerA });
    const retryDelivery = deliveriesRetry.body?.deliveries?.find((d: any) => d.event_type === "vision.incident.created");
    check("Entrega com retry termina 'success' com attempt_count=3", retryDelivery?.status === "success" && retryDelivery?.attempt_count === 3, `status=${retryDelivery?.status} attempts=${retryDelivery?.attempt_count}`);

    // ===== Esgotamento: receptor falha sempre =====
    failUntil["/hook-exhaust"] = 999;
    const createExhaust = await call("POST", "/webhooks", { token: ownerA, body: { url: `${RECEIVER_BASE}/hook-exhaust`, event_types: ["vision.incident.created"] } });
    const webhookExhaustId = createExhaust.body?.webhook?.id;
    const manualIncident3 = await call("POST", "/incidents", { token: ownerA, body: { title: "Ocorrência para testar esgotamento" } });

    const exhausted = await waitUntil(async () => {
      const d = await call("GET", `/webhooks/${webhookExhaustId}/deliveries`, { token: ownerA });
      const row = d.body?.deliveries?.find((x: any) => x.event_type === "vision.incident.created");
      return row?.status === "exhausted";
    }, 10000, 300);
    check("Entrega esgota (status 'exhausted') após atingir o teto de tentativas (3)", exhausted);

    const deliveriesExhaustBefore = await call("GET", `/webhooks/${webhookExhaustId}/deliveries`, { token: ownerA });
    const exhaustedDelivery = deliveriesExhaustBefore.body?.deliveries?.find((d: any) => d.event_type === "vision.incident.created");
    check("Entrega esgotada tem attempt_count=3 (o teto configurado)", exhaustedDelivery?.attempt_count === 3, `attempts=${exhaustedDelivery?.attempt_count}`);

    // Reprocessamento manual autorizado: agora o receptor aceita.
    failUntil["/hook-exhaust"] = 0;
    const retryCall = await call("POST", `/webhooks/${webhookExhaustId}/deliveries/${exhaustedDelivery.id}/retry`, { token: ownerA });
    check("Reprocessamento manual aceito (200)", retryCall.status === 200 && retryCall.body?.delivery?.status === "pending", `status=${retryCall.status}`);

    const recoveredAfterRetry = await waitUntil(async () => {
      const d = await call("GET", `/webhooks/${webhookExhaustId}/deliveries`, { token: ownerA });
      const row = d.body?.deliveries?.find((x: any) => x.id === exhaustedDelivery.id);
      return row?.status === "success";
    }, 5000, 300);
    check("Após reprocessamento manual, entrega antes esgotada agora tem sucesso", recoveredAfterRetry);

    // ===== Isolamento multi-tenant =====
    const listAsB = await call("GET", "/webhooks", { token: ownerB });
    check("Isolamento: org B não vê webhooks de org A", listAsB.body?.webhooks?.length === 0, `count=${listAsB.body?.webhooks?.length}`);

    const crossOrgGet = await call("GET", `/webhooks/${webhookAllId}/deliveries`, { token: ownerB });
    check("Isolamento: org B não consegue ver entregas do webhook de org A (404)", crossOrgGet.status === 404, `status=${crossOrgGet.status}`);

    // ===== DELETE remove o webhook E suas entregas =====
    const del = await call("DELETE", `/webhooks/${webhookAllId}`, { token: ownerA });
    check("DELETE do webhook funciona", del.status === 200, `status=${del.status}`);
    const getDeliveriesAfterDelete = await call("GET", `/webhooks/${webhookAllId}/deliveries`, { token: ownerA });
    check("Após deletar, o webhook não é mais encontrado (404)", getDeliveriesAfterDelete.status === 404, `status=${getDeliveriesAfterDelete.status}`);
  } finally {
    try { proc.kill("SIGTERM"); } catch {}
    await sleep(300);
    try { proc.kill("SIGKILL"); } catch {}
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  console.log("\n==================================================");
  console.log("  TESTE VISION CLOUD — WEBHOOKS DE SAÍDA");
  console.log("==================================================\n");
  const total = results.length;
  console.log(`  Resultado: ${total - failures}/${total} verificações passaram.`);
  console.log(
    failures === 0
      ? "  🪝  WEBHOOKS OK: assinatura, retry, esgotamento, filtro e RBAC confirmados.\n"
      : `  ⚠️  ${failures} verificação(ões) FALHARAM — investigar antes de prosseguir.\n`
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro ao rodar o teste de webhooks do Vision Cloud:", e);
  process.exit(1);
});
