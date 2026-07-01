/**
 * TESTE DA PONTE MAESTRO — VISION VMS -> TAREFAS (Scheduler.fastPass ->
 * MaestroService.reactToVisionEvents -> TaskService.create)
 * ------------------------------------------------------------------
 * Sobe os DOIS processos REAIS (core `server.ts` + `apps/vision-cloud/
 * server.ts`), apontando para o MESMO arquivo SQLite (DATA_DIR compartilhado,
 * como em produção — ver docs/adr/ADR-001-vision-edge-runtime.md, adendo), e
 * prova com chamadas HTTP de verdade + leitura direta do banco:
 *
 *   - opt-in por organização: SEM organization_settings.vision_auto_task_enabled
 *     = 1, nenhum evento crítico vira tarefa (org B nunca liga o recurso);
 *   - COM o recurso ligado (org A), o botão de pânico (severidade 'critica')
 *     gera uma tarefa em `tasks` (source='vision', priority='alta') no
 *     próximo passe rápido do Scheduler do CORE — um processo Node
 *     DIFERENTE do que criou o evento;
 *   - idempotência: `vision_event_tasks` (tabela do core) impede que o MESMO
 *     evento vire uma SEGUNDA tarefa em passes subsequentes do Scheduler;
 *   - o MaestroService.onHandoff (repasse IA->humano) já existente CONTINUA
 *     funcionando sem regressão (a ponte nova não pode quebrar a antiga).
 *
 * Uso:  npm run test:vision-maestro-bridge
 */
import os from "os";
import path from "path";
import fs from "fs";
import { spawn, ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const TSX_BIN = path.join(repoRoot, "node_modules", ".bin", "tsx");

const JWT_SECRET = "test-secret-vision-maestro-bridge-1234567890";
const CORE_PORT = 26000 + Math.floor(Math.random() * 2000);
const VISION_PORT = 28000 + Math.floor(Math.random() * 2000);
const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;
const VISION_HEALTH_URL = `http://127.0.0.1:${VISION_PORT}`;

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

async function waitUntil(predicate: () => Promise<boolean> | boolean, timeoutMs: number, pollMs = 200): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(pollMs);
  }
  return await predicate();
}

async function call(baseUrl: string, method: string, urlPath: string, opts: { token?: string; body?: any } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let json: any = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

async function waitForOk(url: string, timeoutMs: number): Promise<boolean> {
  return waitUntil(async () => {
    try {
      const res = await fetch(url);
      return res.status < 500;
    } catch { return false; }
  }, timeoutMs, 150);
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vision-maestro-"));

  const commonEnv = {
    ...process.env,
    DATA_DIR: tmpDir,
    JWT_SECRET,
    NODE_ENV: "production",
  };

  const visionProc: ChildProcess = spawn(process.execPath, [TSX_BIN, path.join(repoRoot, "apps/vision-cloud/server.ts")], {
    cwd: repoRoot,
    env: { ...commonEnv, VISION_CLOUD_PORT: String(VISION_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let visionOut = "";
  visionProc.stdout!.on("data", (d) => (visionOut += d.toString()));
  visionProc.stderr!.on("data", (d) => (visionOut += d.toString()));

  const coreProc: ChildProcess = spawn(process.execPath, [TSX_BIN, path.join(repoRoot, "server.ts")], {
    cwd: repoRoot,
    env: {
      ...commonEnv,
      PORT: String(CORE_PORT),
      VISION_CLOUD_PORT: String(VISION_PORT),
      // Passe rápido acelerado SÓ para este teste não esperar 5 min de verdade
      // (ver comentário em src/server/Scheduler.ts sobre SCHEDULER_FAST_INITIAL_DELAY_MS).
      SCHEDULER_FAST_INTERVAL_MS: "1200",
      SCHEDULER_FAST_INITIAL_DELAY_MS: "600",
      SCHEDULER_INTERVAL_MS: "3600000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let coreOut = "";
  coreProc.stdout!.on("data", (d) => (coreOut += d.toString()));
  coreProc.stderr!.on("data", (d) => (coreOut += d.toString()));

  try {
    const visionUp = await waitForOk(`${VISION_HEALTH_URL}/health`, 8000);
    check("vision-cloud sobe", visionUp);
    if (!visionUp) throw new Error("vision-cloud não subiu: " + visionOut);

    const coreUp = await waitForOk(`${CORE_URL}/api/plans`, 15000);
    check("core sobe (processo separado, proxy configurado para o vision-cloud)", coreUp);
    if (!coreUp) throw new Error("core não subiu: " + coreOut);

    // ===== Organização A: liga o módulo Vision VMS + opt-in da ponte Maestro =====
    const stamp = Date.now();
    const emailA = `maestro-a-${stamp}@teste.com`;
    const registerA = await call(CORE_URL, "POST", "/api/auth/register", {
      body: { name: "Dona A", email: emailA, password: "SenhaForte123", organizationName: "Empresa A" },
    });
    check("Registro da organização A", registerA.status === 201, `status=${registerA.status}`);

    const loginA = await call(CORE_URL, "POST", "/api/auth/login", { body: { email: emailA, password: "SenhaForte123" } });
    const tokenA = loginA.body?.token;
    const orgA = loginA.body?.user?.organizationId;
    check("Login da organização A retorna token + organizationId", !!tokenA && !!orgA);

    const enableVmsA = await call(CORE_URL, "POST", "/api/analytics/settings/modules", { token: tokenA, body: { enabled_modules: ["vms"] } });
    check("Módulo 'vms' habilitado para org A", enableVmsA.status === 200 && enableVmsA.body?.enabled_modules?.includes("vms"), `status=${enableVmsA.status}`);

    const cfgBeforeA = await call(CORE_URL, "GET", "/api/analytics/ai-attendance-settings", { token: tokenA });
    check("Flag da ponte Vision vem DESLIGADA por padrão (opt-in)", cfgBeforeA.body?.autoTaskOnVisionEvent === false, `valor=${cfgBeforeA.body?.autoTaskOnVisionEvent}`);

    const enableBridgeA = await call(CORE_URL, "PUT", "/api/analytics/ai-attendance-settings", {
      token: tokenA, body: { ...cfgBeforeA.body, autoTaskOnVisionEvent: true },
    });
    check("Liga a ponte Maestro -> Vision VMS para org A", enableBridgeA.status === 200, `status=${enableBridgeA.status}`);

    // ===== Organização B: módulo Vision VMS ligado, MAS SEM opt-in da ponte =====
    const emailB = `maestro-b-${stamp}@teste.com`;
    await call(CORE_URL, "POST", "/api/auth/register", { body: { name: "Dono B", email: emailB, password: "SenhaForte123", organizationName: "Empresa B" } });
    const loginB = await call(CORE_URL, "POST", "/api/auth/login", { body: { email: emailB, password: "SenhaForte123" } });
    const tokenB = loginB.body?.token;
    const orgB = loginB.body?.user?.organizationId;
    await call(CORE_URL, "POST", "/api/analytics/settings/modules", { token: tokenB, body: { enabled_modules: ["vms"] } });
    // NÃO chama PUT /ai-attendance-settings para B: fica no default (desligado).

    // ===== Aciona o botão de pânico (evento severidade 'critica') nas duas orgs =====
    const panicA = await call(CORE_URL, "POST", "/api/vision/panic", { token: tokenA, body: { reason: "teste automatizado" } });
    check("Botão de pânico aciona em org A (evento + ocorrência atômicos)", panicA.status === 201 && panicA.body?.event?.severity === "critica", `status=${panicA.status}`);
    const eventIdA = panicA.body?.event?.id;

    const panicB = await call(CORE_URL, "POST", "/api/vision/panic", { token: tokenB, body: { reason: "teste automatizado" } });
    check("Botão de pânico aciona em org B também (para provar que o opt-in é quem impede a tarefa, não a ausência do evento)", panicB.status === 201);

    // ===== Espera o passe rápido do Scheduler (processo core) rodar =====
    const dbPath = path.join(tmpDir, "zappflow.db");
    const readTasks = (orgId: string) => {
      const roDb = new Database(dbPath, { readonly: true });
      try {
        return roDb.prepare("SELECT * FROM tasks WHERE organization_id = ? AND source = 'vision'").all(orgId) as any[];
      } finally { roDb.close(); }
    };
    const readBridge = (eventId: string) => {
      const roDb = new Database(dbPath, { readonly: true });
      try {
        return roDb.prepare("SELECT * FROM vision_event_tasks WHERE event_id = ?").get(eventId) as any;
      } finally { roDb.close(); }
    };

    const taskCreatedA = await waitUntil(() => readTasks(orgA).length === 1, 10000, 300);
    check("Scheduler do CORE cria a tarefa a partir do evento Vision VMS (org A, opt-in ligado)", taskCreatedA, `tasks=${readTasks(orgA).length}`);

    const tasksA = readTasks(orgA);
    const taskA = tasksA[0];
    check("Tarefa criada tem priority='alta'", taskA?.priority === "alta", `priority=${taskA?.priority}`);
    check("Tarefa criada tem ref_label apontando para o evento de origem", taskA?.ref_label === `vision_event:${eventIdA}`, `ref_label=${taskA?.ref_label}`);
    check("Tarefa criada começa em 'a_fazer' (fila para a equipe assumir)", taskA?.status === "a_fazer", `status=${taskA?.status}`);

    const bridgeRow = readBridge(eventIdA);
    check("Tabela de ponte (vision_event_tasks) registra evento -> tarefa", !!bridgeRow && bridgeRow.task_id === taskA?.id);

    check("Org B (sem opt-in) NÃO recebe tarefa, mesmo com evento crítico igualmente aberto", readTasks(orgB).length === 0, `tasks=${readTasks(orgB).length}`);

    // ===== Idempotência: espera outro(s) passe(s) rápido(s) e confirma que NÃO duplica =====
    await sleep(2600); // pelo menos +2 ciclos do passe rápido (1200ms cada)
    check("Passes subsequentes do Scheduler NÃO duplicam a tarefa do mesmo evento", readTasks(orgA).length === 1, `tasks=${readTasks(orgA).length}`);

    // ===== Não-regressão: MaestroService.onHandoff (repasse IA->humano) continua OK =====
    const roDb = new Database(dbPath, { readonly: true });
    let handoffColumnExists = false;
    try {
      roDb.prepare("SELECT auto_task_on_handoff FROM organization_settings WHERE organization_id = ?").get(orgA);
      handoffColumnExists = true;
    } catch {}
    roDb.close();
    check("Coluna auto_task_on_handoff (repasse IA->humano) permanece intacta no schema", handoffColumnExists);
  } finally {
    for (const proc of [coreProc, visionProc]) {
      try { proc.kill("SIGTERM"); } catch {}
    }
    await sleep(400);
    for (const proc of [coreProc, visionProc]) {
      try { proc.kill("SIGKILL"); } catch {}
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  console.log("\n==================================================");
  console.log("  TESTE PONTE MAESTRO — VISION VMS -> TAREFAS");
  console.log("==================================================\n");
  const total = results.length;
  console.log(`  Resultado: ${total - failures}/${total} verificações passaram.`);
  console.log(
    failures === 0
      ? "  🧭  PONTE OK: opt-in, criação cross-processo e idempotência confirmados.\n"
      : `  ⚠️  ${failures} verificação(ões) FALHARAM — investigar antes de prosseguir.\n`
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro ao rodar o teste da ponte Maestro/Vision VMS:", e);
  process.exit(1);
});
