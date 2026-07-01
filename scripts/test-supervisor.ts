/**
 * TESTE DO SUPERVISOR DE PROCESSO (scripts/supervisor.ts)
 * ------------------------------------------------------------------
 * Prova, de forma automatizada e sem Docker/tini, que o supervisor que sobe
 * `core` + `vision-cloud` em produção se comporta como documentado:
 *   - os dois processos sobem normalmente e recebem SIGTERM corretamente
 *     (shutdown gracioso do "container");
 *   - crash isolado do vision-cloud é reiniciado automaticamente, SEM afetar
 *     o core;
 *   - crash-loop persistente do vision-cloud é interrompido (teto de
 *     tentativas), sem ficar reiniciando para sempre;
 *   - vision-cloud "travado" (não crasha, só para de responder ao /health) é
 *     detectado e reiniciado à força — não é só "crash" que é coberto;
 *   - crash do core derruba o supervisor inteiro (o "container" morre, como
 *     deveria, para o Coolify aplicar a política de restart dele).
 *
 * NÃO testa reaping de processo zumbi/órfão — isso depende do `tini` como
 * PID 1 real dentro de um container/namespace de verdade, não deste
 * supervisor. Ver docs/adr/ADR-008-process-supervisor.md para o teste
 * específico disso (rodado manualmente com `unshare --pid --fork
 * --mount-proc -- tini -- ...`, documentado lá com os resultados).
 *
 * Roda contra stubs (não contra dist/server.cjs nem dist/vision-cloud.cjs
 * reais) via as env vars SUPERVISOR_CORE_SCRIPT/SUPERVISOR_VISION_SCRIPT que
 * scripts/supervisor.ts só aceita para fins de teste (ver comentário lá).
 *
 * Uso:  npm run test:supervisor
 */
import os from "os";
import path from "path";
import fs from "fs";
import { spawn, ChildProcess } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

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

async function waitFor(predicate: () => boolean, timeoutMs: number, pollMs = 50): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(pollMs);
  }
  return predicate();
}

// --- Stubs de core/vision-cloud, gerados num diretório temporário (nada fica
// no repositório depois do teste) ---
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-supervisor-test-"));

const CORE_STUB = path.join(tmpDir, "core-stub.js");
fs.writeFileSync(
  CORE_STUB,
  `
console.log("[core-stub] up pid=" + process.pid);
if (process.env.STUB_BEHAVIOR === "crash-immediately") {
  setTimeout(() => process.exit(1), 150);
} else {
  process.on("SIGTERM", () => { console.log("[core-stub] SIGTERM recebido, saindo"); process.exit(0); });
  setInterval(() => {}, 100000);
}
`
);

const VISION_STUB = path.join(tmpDir, "vision-stub.js");
fs.writeFileSync(
  VISION_STUB,
  `
const http = require("http");
const fs = require("fs");
const port = Number(process.env.STUB_PORT || 3101);
const behavior = process.env.STUB_BEHAVIOR || "normal";
console.log("[vision-stub] up pid=" + process.pid + " behavior=" + behavior);

let healthy = true;
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    if (!healthy) return; // não responde nada -> simula processo travado
    res.writeHead(200); res.end('{"ok":true}');
  } else { res.writeHead(404); res.end(); }
});
server.listen(port);

if (behavior === "crash-once") {
  const flagFile = process.env.STUB_FLAG_FILE;
  if (!fs.existsSync(flagFile)) {
    fs.writeFileSync(flagFile, "1");
    setTimeout(() => process.exit(1), 200);
  }
} else if (behavior === "crash-loop") {
  setTimeout(() => process.exit(1), 150);
} else if (behavior === "hang") {
  setTimeout(() => { healthy = false; console.log("[vision-stub] parou de responder /health (simulando travamento)"); }, 400);
}
process.on("SIGTERM", () => { console.log("[vision-stub] SIGTERM recebido, saindo"); process.exit(0); });
`
);

type Harness = { proc: ChildProcess; output: string[]; exited: boolean; exitCode: number | null };

// Spawna o `tsx` local diretamente (node_modules/.bin/tsx), em vez de passar
// por `npx`. `npx` adiciona mais uma camada de processo no meio que NÃO
// repassa sinal/exit-code de forma confiável para quem o spawnou — seria
// ironicamente o mesmo bug de "sinal não chega no filho certo" que este
// supervisor existe para evitar, só que dentro do próprio teste.
const TSX_BIN = path.join(repoRoot, "node_modules", ".bin", "tsx");

function startSupervisor(env: NodeJS.ProcessEnv): Harness {
  const proc = spawn(process.execPath, [TSX_BIN, path.join(repoRoot, "scripts/supervisor.ts")], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const h: Harness = { proc, output: [], exited: false, exitCode: null };
  proc.stdout!.on("data", (d) => h.output.push(d.toString()));
  proc.stderr!.on("data", (d) => h.output.push(d.toString()));
  proc.on("exit", (code) => {
    h.exited = true;
    h.exitCode = code;
  });
  return h;
}

function countOccurrences(h: Harness, needle: string): number {
  const full = h.output.join("");
  return full.split(needle).length - 1;
}

function contains(h: Harness, needle: string): boolean {
  return h.output.join("").includes(needle);
}

async function stopHarness(h: Harness) {
  if (h.exited) return;
  // SIGTERM primeiro (mesmo caminho gracioso validado no Cenário 1) — dá ao
  // supervisor a chance de encaminhar o sinal para core-stub/vision-stub
  // antes de morrer. SIGKILL não pode ser tratado nem encaminhado pelo
  // supervisor: matar o supervisor direto com SIGKILL órfã os processos-filho
  // dele (eles continuam rodando, escutando porta, etc.) — foi exatamente
  // esse bug que este teste tinha antes de ser corrigido (processos de teste
  // vazando entre cenários). SIGKILL só entra como último recurso.
  try {
    h.proc.kill("SIGTERM");
  } catch {}
  const exitedGracefully = await waitFor(() => h.exited, 3000);
  if (!exitedGracefully) {
    try {
      h.proc.kill("SIGKILL");
    } catch {}
    await waitFor(() => h.exited, 2000);
  }
}

async function main() {
  let port = 20000 + Math.floor(Math.random() * 5000);

  // === Cenário 1: subida normal + SIGTERM propaga e encerra tudo ===
  {
    const h = startSupervisor({
      SUPERVISOR_CORE_SCRIPT: CORE_STUB,
      SUPERVISOR_VISION_SCRIPT: VISION_STUB,
      VISION_CLOUD_PORT: String(port),
      STUB_PORT: String(port),
    });
    const cameUp = await waitFor(() => contains(h, "[core-stub] up") && contains(h, "[vision-stub] up"), 5000);
    check("Cenário 1: core e vision-cloud sobem normalmente", cameUp);

    h.proc.kill("SIGTERM");
    const exited = await waitFor(() => h.exited, 5000);
    check(
      "Cenário 1: SIGTERM propaga para os dois filhos e o supervisor encerra tudo",
      exited && contains(h, "core-stub] SIGTERM") && h.exitCode === 0,
      `exited=${exited} exitCode=${h.exitCode}`
    );
    await stopHarness(h);
  }

  // === Cenário 2: crash isolado do vision-cloud reinicia sozinho, core intacto ===
  {
    port++;
    const flagFile = path.join(tmpDir, "crash-once.flag");
    try { fs.unlinkSync(flagFile); } catch {}
    const h = startSupervisor({
      SUPERVISOR_CORE_SCRIPT: CORE_STUB,
      SUPERVISOR_VISION_SCRIPT: VISION_STUB,
      VISION_CLOUD_PORT: String(port),
      STUB_PORT: String(port),
      STUB_BEHAVIOR: "crash-once",
      STUB_FLAG_FILE: flagFile,
      SUPERVISOR_RETRY_INTERVAL_MS: "300",
    });
    const restarted = await waitFor(() => countOccurrences(h, "[vision-stub] up") >= 2, 5000);
    check(
      "Cenário 2: vision-cloud reinicia sozinho após crash isolado",
      restarted && contains(h, "vision-cloud]*** CAIU ***".replace("]", "] ")),
      `tentativas de subida vistas=${countOccurrences(h, "[vision-stub] up")}`
    );
    check(
      "Cenário 2: core NUNCA é reiniciado por causa do crash do vision-cloud",
      countOccurrences(h, "[core-stub] up") === 1
    );
    await stopHarness(h);
  }

  // === Cenário 3: crash-loop persistente do vision-cloud atinge o teto e para ===
  {
    port++;
    const MAX = 2;
    const h = startSupervisor({
      SUPERVISOR_CORE_SCRIPT: CORE_STUB,
      SUPERVISOR_VISION_SCRIPT: VISION_STUB,
      VISION_CLOUD_PORT: String(port),
      STUB_PORT: String(port),
      STUB_BEHAVIOR: "crash-loop",
      SUPERVISOR_RETRY_INTERVAL_MS: "200",
      SUPERVISOR_MAX_VISION_RESTARTS: String(MAX),
    });
    const gaveUp = await waitFor(() => contains(h, "desistiu após"), 8000);
    check("Cenário 3: supervisor desiste após atingir o teto de tentativas", gaveUp);

    const upCountAtGiveUp = countOccurrences(h, "[vision-stub] up");
    await sleep(1500); // espera extra: NÃO deve subir de novo sozinho
    const upCountAfterWait = countOccurrences(h, "[vision-stub] up");
    check(
      "Cenário 3: depois de desistir, NÃO tenta mais reiniciar sozinho (sem loop infinito)",
      upCountAtGiveUp === upCountAfterWait && upCountAtGiveUp === MAX + 1,
      `subidas=${upCountAfterWait} esperado=${MAX + 1}`
    );
    check("Cenário 3: core continua de pé, nunca afetado pelo crash-loop do vision-cloud", countOccurrences(h, "[core-stub] up") === 1);
    await stopHarness(h);
  }

  // === Cenário 4: vision-cloud "travado" (não crasha, só para de responder) é detectado e reiniciado ===
  {
    port++;
    const h = startSupervisor({
      SUPERVISOR_CORE_SCRIPT: CORE_STUB,
      SUPERVISOR_VISION_SCRIPT: VISION_STUB,
      VISION_CLOUD_PORT: String(port),
      STUB_PORT: String(port),
      STUB_BEHAVIOR: "hang",
      SUPERVISOR_HEALTH_INTERVAL_MS: "300",
      SUPERVISOR_HEALTH_TIMEOUT_MS: "200",
      SUPERVISOR_HEALTH_MAX_FAILURES: "2",
      SUPERVISOR_RETRY_INTERVAL_MS: "200",
    });
    const detected = await waitFor(() => contains(h, "parece travado"), 6000);
    check("Cenário 4: health-check ativo detecta o processo travado (não só crash)", detected);

    // O stub em modo "hang" nunca chama process.exit sozinho — se ele
    // reiniciar, só pode ter sido por causa do SIGKILL forçado do supervisor.
    const restarted = await waitFor(() => countOccurrences(h, "[vision-stub] up") >= 2, 4000);
    check("Cenário 4: processo travado é morto à força e reiniciado", restarted);
    await stopHarness(h);
  }

  // === Cenário 5: core crasha -> supervisor derruba tudo (o "container" morre) ===
  {
    port++;
    const h = startSupervisor({
      SUPERVISOR_CORE_SCRIPT: CORE_STUB,
      SUPERVISOR_VISION_SCRIPT: VISION_STUB,
      VISION_CLOUD_PORT: String(port),
      STUB_PORT: String(port),
      STUB_BEHAVIOR: "crash-immediately",
    });
    const supervisorExited = await waitFor(() => h.exited, 5000);
    check(
      "Cenário 5: crash do core encerra o supervisor inteiro (container cai, Coolify reage)",
      supervisorExited && h.exitCode !== 0 && h.exitCode !== null,
      `exited=${supervisorExited} exitCode=${h.exitCode}`
    );
    await stopHarness(h);
  }

  // ============ RELATÓRIO ============
  console.log("\n==================================================");
  console.log("  TESTE DO SUPERVISOR DE PROCESSO — ZappFlow Vision");
  console.log("==================================================\n");
  const total = results.length;
  console.log(`  Resultado: ${total - failures}/${total} verificações passaram.`);
  console.log(
    failures === 0
      ? "  🛡️  SUPERVISOR OK: isolamento de falha, retry, detecção de hang e shutdown gracioso confirmados.\n"
      : `  ⚠️  ${failures} verificação(ões) FALHARAM — investigar antes de considerar pronto para produção.\n`
  );

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro ao rodar o teste do supervisor:", e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
