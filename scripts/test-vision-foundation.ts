/**
 * TESTE DO VISION CLOUD — FUNDAÇÃO (Sprint 1: sites, gateways, dispositivos,
 * câmeras, RBAC)
 * ------------------------------------------------------------------
 * Sobe o processo REAL do vision-cloud (não uma simulação) contra um banco
 * temporário e prova, com chamadas HTTP de verdade:
 *   - isolamento multi-tenant nas 4 tabelas novas (sites/gateways/devices/
 *     cameras) — mesmo padrão de scripts/test-tenant-isolation.ts;
 *   - RBAC granular: usuário comum sem vision_role_assignments não pode
 *     criar recursos; owner/admin do core sempre pode (bootstrap); depois de
 *     receber o papel vision_admin, um usuário comum também pode;
 *   - fluxo de registro + heartbeat de gateway (chave de API, não JWT):
 *     chave errada é rejeitada, chave certa atualiza status/heartbeat;
 *   - o endpoint de teste de conexão de dispositivo responde honestamente
 *     "não implementado" (não finge testar um stream que não existe).
 *
 * Uso:  npm run test:vision-foundation
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

const JWT_SECRET = "test-secret-vision-foundation-1234567890";
const PORT = 21000 + Math.floor(Math.random() * 4000);
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

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vision-foundation-"));

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
    check("vision-cloud sobe e responde /health", up);
    if (!up) throw new Error("vision-cloud não subiu: " + out);

    // Identidades de teste — dois tenants (A, B), dois usuários em A.
    const orgA = "org-a-" + Date.now();
    const orgB = "org-b-" + Date.now();
    const ownerA = token(orgA, "user-a-owner", "owner");
    const agentA = token(orgA, "user-a-agent", "agent"); // sem vision_role_assignments ainda
    const ownerB = token(orgB, "user-b-owner", "owner");

    // ===== RBAC: bootstrap por owner/admin do core =====
    const createSiteAsOwner = await call("POST", "/sites", { token: ownerA, body: { name: "Condomínio A", address: "Rua A, 1" } });
    check("RBAC: owner do core cria site sem vision_role_assignments (bootstrap)", createSiteAsOwner.status === 201, `status=${createSiteAsOwner.status}`);
    const siteAId = createSiteAsOwner.body?.site?.id;

    // ===== RBAC: usuário comum sem papel Vision é bloqueado =====
    const createSiteAsAgent = await call("POST", "/sites", { token: agentA, body: { name: "Não deveria criar" } });
    check("RBAC: agent comum sem papel Vision recebe 403 ao tentar criar site", createSiteAsAgent.status === 403, `status=${createSiteAsAgent.status}`);

    // ===== RBAC: conceder papel e verificar que passa a funcionar =====
    const grantRole = await call("POST", "/role-assignments", {
      token: ownerA,
      body: { user_id: "user-a-agent", role: "vision_admin" },
    });
    check("RBAC: owner concede papel vision_admin ao agent", grantRole.status === 201, `status=${grantRole.status}`);

    const createSiteAfterGrant = await call("POST", "/sites", { token: agentA, body: { name: "Torre B" } });
    check("RBAC: agent com papel vision_admin agora consegue criar site", createSiteAfterGrant.status === 201, `status=${createSiteAfterGrant.status}`);

    const grantInvalidRole = await call("POST", "/role-assignments", { token: ownerA, body: { user_id: "x", role: "papel_invalido" } });
    check("RBAC: papel inválido é rejeitado (400)", grantInvalidRole.status === 400, `status=${grantInvalidRole.status}`);

    // ===== Isolamento multi-tenant =====
    const siteAsOwnerA = await call("GET", "/sites", { token: ownerA });
    const siteAsOwnerB = await call("GET", "/sites", { token: ownerB });
    check(
      "Isolamento: org B não vê nenhum site de org A",
      Array.isArray(siteAsOwnerB.body?.sites) && siteAsOwnerB.body.sites.length === 0,
      `orgA vê ${siteAsOwnerA.body?.sites?.length} sites; orgB vê ${siteAsOwnerB.body?.sites?.length}`
    );
    check("Isolamento: org A vê os 2 sites que criou", siteAsOwnerA.body?.sites?.length === 2);

    // ===== Gateway: registro + heartbeat por chave de API (não JWT) =====
    const registerGateway = await call("POST", "/gateways/register", {
      token: ownerA,
      body: { site_id: siteAId, name: "Gateway Portaria" },
    });
    check("Gateway: registro retorna api_key em texto puro (só desta vez)", registerGateway.status === 201 && typeof registerGateway.body?.api_key === "string", `status=${registerGateway.status}`);
    const gatewayId = registerGateway.body?.gateway?.id;
    const apiKey = registerGateway.body?.api_key;

    const heartbeatWrongKey = await call("POST", `/gateways/${gatewayId}/heartbeat`, { gatewayKey: "vgw_chave_errada", body: { agent_version: "0.1.0" } });
    check("Gateway: heartbeat com chave ERRADA é rejeitado (401)", heartbeatWrongKey.status === 401, `status=${heartbeatWrongKey.status}`);

    const heartbeatOk = await call("POST", `/gateways/${gatewayId}/heartbeat`, { gatewayKey: apiKey, body: { agent_version: "1.2.3" } });
    check("Gateway: heartbeat com chave CORRETA é aceito", heartbeatOk.status === 200 && heartbeatOk.body?.ok === true, `status=${heartbeatOk.status}`);

    const gatewayHealth = await call("GET", `/gateways/${gatewayId}/health`, { token: ownerA });
    check(
      "Gateway: heartbeat atualiza status para 'online' e grava last_heartbeat_at",
      gatewayHealth.body?.gateway?.status === "online" && !!gatewayHealth.body?.gateway?.last_heartbeat_at && gatewayHealth.body?.gateway?.agent_version === "1.2.3",
      `status=${gatewayHealth.body?.gateway?.status} heartbeat=${gatewayHealth.body?.gateway?.last_heartbeat_at}`
    );

    const heartbeatNoAuth = await call("POST", `/gateways/${gatewayId}/heartbeat`, { body: {} });
    check("Gateway: heartbeat sem nenhuma chave é rejeitado (401)", heartbeatNoAuth.status === 401, `status=${heartbeatNoAuth.status}`);

    // ===== Dispositivos: cadastro + teste de conexão honesto (não implementado) =====
    const createDevice = await call("POST", "/devices", {
      token: ownerA,
      body: { site_id: siteAId, gateway_id: gatewayId, device_type: "camera", vendor: "Hikvision", model: "DS-2CD", compatibility_status: "compativel_direto" },
    });
    check("Dispositivo: cadastro manual funciona", createDevice.status === 201, `status=${createDevice.status}`);
    const deviceId = createDevice.body?.device?.id;

    const testDevice = await call("POST", `/devices/${deviceId}/test`, { token: ownerA });
    check(
      "Dispositivo: /test responde 501 'não implementado' — NÃO finge testar stream real",
      testDevice.status === 501 && testDevice.body?.error === "not_implemented",
      `status=${testDevice.status} body=${JSON.stringify(testDevice.body)}`
    );

    // ===== Câmeras: cadastro + filtro por site + PATCH (enable/disable) =====
    const createCamera = await call("POST", "/cameras", {
      token: ownerA,
      body: { site_id: siteAId, device_id: deviceId, gateway_id: gatewayId, name: "Câmera Portaria 1", area_name: "Portaria" },
    });
    check("Câmera: cadastro funciona", createCamera.status === 201, `status=${createCamera.status}`);
    const cameraId = createCamera.body?.camera?.id;

    const disableCamera = await call("PATCH", `/cameras/${cameraId}`, { token: ownerA, body: { is_enabled: false } });
    check("Câmera: desabilitar preserva o registro (PATCH, não DELETE)", disableCamera.status === 200 && disableCamera.body?.camera?.is_enabled === 0, `is_enabled=${disableCamera.body?.camera?.is_enabled}`);

    const camerasBySite = await call("GET", `/cameras?site_id=${siteAId}`, { token: ownerA });
    check("Câmera: filtro por site_id retorna só as câmeras daquele site", camerasBySite.body?.cameras?.length === 1, `count=${camerasBySite.body?.cameras?.length}`);

    // ===== Isolamento cruzado: org B não vê nada de A (gateway/device/camera) =====
    const gatewaysAsOwnerB = await call("GET", "/gateways", { token: ownerB });
    const devicesAsOwnerB = await call("GET", "/devices", { token: ownerB });
    const camerasAsOwnerB = await call("GET", "/cameras", { token: ownerB });
    check(
      "Isolamento: org B não vê gateways/dispositivos/câmeras de org A",
      gatewaysAsOwnerB.body?.gateways?.length === 0 && devicesAsOwnerB.body?.devices?.length === 0 && camerasAsOwnerB.body?.cameras?.length === 0,
      `gateways=${gatewaysAsOwnerB.body?.gateways?.length} devices=${devicesAsOwnerB.body?.devices?.length} cameras=${camerasAsOwnerB.body?.cameras?.length}`
    );

    // ===== Sem token nenhum: 401 em rota protegida =====
    const noToken = await call("GET", "/sites");
    check("Segurança: rota sem token nenhum retorna 401", noToken.status === 401, `status=${noToken.status}`);
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
  console.log("  TESTE VISION CLOUD — FUNDAÇÃO (Sprint 1)");
  console.log("==================================================\n");
  const total = results.length;
  console.log(`  Resultado: ${total - failures}/${total} verificações passaram.`);
  console.log(
    failures === 0
      ? "  🏗️  FUNDAÇÃO OK: isolamento multi-tenant, RBAC e fluxo de gateway confirmados.\n"
      : `  ⚠️  ${failures} verificação(ões) FALHARAM — investigar antes de prosseguir.\n`
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro ao rodar o teste de fundação do Vision Cloud:", e);
  process.exit(1);
});
