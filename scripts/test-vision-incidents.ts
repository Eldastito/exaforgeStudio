/**
 * TESTE DO VISION CLOUD — OCORRÊNCIAS E BOTÃO DE PÂNICO (Fase 2)
 * ------------------------------------------------------------------
 * Sobe o processo real do vision-cloud e prova, com chamadas HTTP reais:
 *   - criação manual de ocorrência e resolução (RBAC restrito a papéis de
 *     gestão: vision_admin/security_operator/operations_manager);
 *   - escalonamento de um evento em ocorrência (ação "escalate" em
 *     /events/:id/review), com RBAC mais restrito que as demais ações de
 *     revisão (portaria_operator pode reconhecer um evento, mas não pode
 *     escalar sozinho);
 *   - botão de pânico cria evento crítico + ocorrência com legal_hold=1
 *     atomicamente, e é restrito aos papéis certos (evidence_auditor NÃO
 *     pode acionar pânico);
 *   - isolamento multi-tenant em ocorrências.
 *
 * Uso:  npm run test:vision-incidents
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

const JWT_SECRET = "test-secret-vision-incidents-1234567890";
const PORT = 29000 + Math.floor(Math.random() * 3000);
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

async function call(method: string, urlPath: string, opts: { token?: string; body?: any } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE_URL}${urlPath}`, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vision-incidents-"));

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

    // Usuários com papéis específicos (concedidos pelo owner) para testar
    // as diferenças de RBAC entre revisão comum, escalonamento e pânico.
    await call("POST", "/role-assignments", { token: ownerA, body: { user_id: "u-portaria", role: "portaria_operator" } });
    await call("POST", "/role-assignments", { token: ownerA, body: { user_id: "u-auditor", role: "evidence_auditor" } });
    const portariaA = token(orgA, "u-portaria", "agent");
    const auditorA = token(orgA, "u-auditor", "agent");

    // ===== Ocorrência manual =====
    const createIncident = await call("POST", "/incidents", { token: ownerA, body: { title: "Vazamento na garagem", severity: "media" } });
    check("Ocorrência manual pode ser criada por papel de gestão", createIncident.status === 201, `status=${createIncident.status}`);
    const incidentId = createIncident.body?.incident?.id;

    const createIncidentAsPortaria = await call("POST", "/incidents", { token: portariaA, body: { title: "Não deveria criar" } });
    check("RBAC: portaria_operator NÃO pode criar ocorrência diretamente (403)", createIncidentAsPortaria.status === 403, `status=${createIncidentAsPortaria.status}`);

    const resolveIncident = await call("POST", `/incidents/${incidentId}/resolve`, { token: ownerA });
    check("Ocorrência pode ser resolvida", resolveIncident.status === 200 && resolveIncident.body?.incident?.status === "resolved");

    const resolveAgain = await call("POST", `/incidents/${incidentId}/resolve`, { token: ownerA });
    check("Resolver ocorrência já resolvida é rejeitado (400)", resolveAgain.status === 400, `status=${resolveAgain.status}`);

    // ===== Escalonamento de evento -> ocorrência =====
    const site = await call("POST", "/sites", { token: ownerA, body: { name: "Site" } });
    const register = await call("POST", "/gateways/register", { token: ownerA, body: { site_id: site.body.site.id, name: "GW" } });
    const gatewayId = register.body?.gateway?.id;
    const apiKey = register.body?.api_key;
    // Nunca manda heartbeat -> o monitor levaria minutos p/ marcar offline;
    // criamos o evento manualmente via pânico? Não — testamos escalonamento
    // a partir de um evento técnico real: forçamos via heartbeat + espera
    // não é prático aqui, então usamos o próprio pânico como gerador de
    // evento para testar a ação "escalate" sobre um evento JÁ existente
    // (o pânico cria a ocorrência sozinho, mas o evento gerado por ele
    // também pode, em tese, ser escalado de novo — usamos isso só como
    // fonte de um `event_id` válido para o teste de RBAC do "escalate").
    void apiKey;
    void gatewayId;

    const panicForEvent = await call("POST", "/panic", { token: ownerA, body: { site_id: site.body.site.id } });
    const eventIdForEscalation = panicForEvent.body?.event?.id;

    const escalateAsPortaria = await call("POST", `/events/${eventIdForEscalation}/review`, { token: portariaA, body: { action: "escalate" } });
    check(
      "RBAC: portaria_operator pode reconhecer evento, mas NÃO pode escalar para ocorrência (403)",
      escalateAsPortaria.status === 403,
      `status=${escalateAsPortaria.status}`
    );

    const acknowledgeAsPortaria = await call("POST", `/events/${eventIdForEscalation}/review`, { token: portariaA, body: { action: "acknowledge" } });
    check("RBAC: portaria_operator PODE reconhecer (acknowledge) o mesmo evento", acknowledgeAsPortaria.status === 200, `status=${acknowledgeAsPortaria.status}`);

    const escalateAsOwner = await call("POST", `/events/${eventIdForEscalation}/review`, { token: ownerA, body: { action: "escalate" } });
    check(
      "Escalonamento cria uma ocorrência linkada ao evento",
      escalateAsOwner.status === 200 && !!escalateAsOwner.body?.incident?.id && escalateAsOwner.body?.incident?.source_event_id === eventIdForEscalation,
      `status=${escalateAsOwner.status} incident=${JSON.stringify(escalateAsOwner.body?.incident)}`
    );
    check("Evento escalado muda de status para 'escalated'", escalateAsOwner.body?.event?.status === "escalated");

    // ===== Botão de pânico =====
    const panic = await call("POST", "/panic", { token: portariaA, body: { site_id: site.body.site.id, reason: "Assalto em andamento" } });
    check(
      "Pânico cria evento crítico + ocorrência com legal_hold=1 atomicamente",
      panic.status === 201 &&
        panic.body?.event?.severity === "critica" &&
        panic.body?.incident?.is_panic === 1 &&
        panic.body?.incident?.legal_hold === 1 &&
        panic.body?.incident?.source_event_id === panic.body?.event?.id,
      `status=${panic.status} body=${JSON.stringify(panic.body)}`
    );

    const panicAsAuditor = await call("POST", "/panic", { token: auditorA, body: { site_id: site.body.site.id } });
    check("RBAC: evidence_auditor NÃO pode acionar o pânico (403)", panicAsAuditor.status === 403, `status=${panicAsAuditor.status}`);

    // ===== Isolamento multi-tenant =====
    const incidentsAsOwnerB = await call("GET", "/incidents", { token: ownerB });
    check("Isolamento: org B não vê nenhuma ocorrência de org A", incidentsAsOwnerB.body?.incidents?.length === 0, `count=${incidentsAsOwnerB.body?.incidents?.length}`);
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
  console.log("  TESTE VISION CLOUD — OCORRÊNCIAS E PÂNICO");
  console.log("==================================================\n");
  const total = results.length;
  console.log(`  Resultado: ${total - failures}/${total} verificações passaram.`);
  console.log(
    failures === 0
      ? "  🚨  OCORRÊNCIAS/PÂNICO OK: RBAC, escalonamento e isolamento confirmados.\n"
      : `  ⚠️  ${failures} verificação(ões) FALHARAM — investigar antes de prosseguir.\n`
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro ao rodar o teste de ocorrências/pânico:", e);
  process.exit(1);
});
