// Supervisor de processo do container de produção — sobe `core` (dist/server.cjs)
// e `vision-cloud` (dist/vision-cloud.cjs) como processos filhos independentes
// e mantém o Vision Cloud de pé sozinho, sem depender de ninguém reiniciá-lo
// manualmente.
//
// POR QUE ISSO EXISTE: o vision-cloud é isolado por design — um bug nele não
// pode derrubar o core (CRM/WhatsApp/Kanban). Ver docs/adr/ADR-001-vision-edge-
// runtime.md (adendo "Vision Cloud como terceiro serviço"). Rodar os dois
// processos dentro do MESMO container (em vez de dois containers) foi a
// escolha mais simples de operar hoje (Coolify, um único Dockerfile): um
// container, um console de log, sem volume Docker compartilhado entre
// containers. Decisão completa, alternativas descartadas (dois containers) e
// os testes que validaram este mecanismo: docs/adr/ADR-008-process-supervisor.md
//
// TOPOLOGIA DE PROCESSO (ver Dockerfile):
//   tini (PID 1 real, ENTRYPOINT) -> este supervisor -> { core, vision-cloud }
// `tini` existe SÓ para fazer reaping de processo zumbi/órfão (responsabilidade
// de todo PID 1 em container Linux — Node sozinho não faz isso). Este
// supervisor NÃO tenta reimplementar reaping de zumbi; ele delega isso ao tini
// e cuida apenas de orquestração (subir, encaminhar sinal, reiniciar).
//
// ==========================================================================
// SE VOCÊ ESTÁ LENDO ISTO PORQUE ALGO DEU ERRADO EM PRODUÇÃO:
//
//   "vision-cloud *** CAIU ***" no log, uma vez
//     -> Normal. O supervisor já está reiniciando sozinho (ver RETRY_INTERVAL_MS
//        abaixo). O core não foi afetado. Não requer ação.
//
//   "vision-cloud desistiu após N tentativas" no log
//     -> O core continua saudável; SÓ o Vision Cloud está fora do ar
//        (/api/vision/* vai responder 502/504 até isso ser corrigido).
//        1. Rode `docker logs <container> --since 15m | grep vision-cloud`
//           para ver a causa raiz do crash (procure a exceção antes da
//           primeira linha "*** CAIU ***").
//        2. Causas mais comuns: JWT_SECRET ausente/diferente do core, porta
//           VISION_CLOUD_PORT já em uso, DATA_DIR sem permissão de escrita.
//        3. Corrija a causa e faça um redeploy/restart do container — isso
//           reinicia o supervisor do zero (contador de tentativas volta a 0).
//           Não existe hoje um comando para reiniciar só o vision-cloud sem
//           reiniciar o container inteiro.
//
//   "vision-cloud parece travado (health-check falhou N vezes)"
//     -> O processo não crashou, mas parou de responder (loop preso, chamada
//        de rede pendurada, etc.). O supervisor mata o processo à força
//        (SIGKILL) e trata como se tivesse crashado (mesma lógica de retry
//        acima). Se isso repetir, mesma investigação do item anterior.
//
//   Testar tudo isso localmente, sem Docker: ver a seção "TESTE LOCAL" no
//   final deste arquivo.
// ==========================================================================

import { spawn, ChildProcess } from "node:child_process";
import http from "node:http";

// Caminho dos dois processos é fixo em produção (artefatos reais do build),
// mas pode ser sobrescrito por env var — isso existe SÓ para permitir
// `scripts/test-supervisor.ts` testar este arquivo de verdade contra stubs,
// sem precisar mexer nos artefatos reais de `dist/`. Nunca defina essas env
// vars em produção.
const CORE_CMD = "node";
const CORE_ARGS = [process.env.SUPERVISOR_CORE_SCRIPT || "dist/server.cjs"];
const VISION_CMD = "node";
const VISION_ARGS = [process.env.SUPERVISOR_VISION_SCRIPT || "dist/vision-cloud.cjs"];
const VISION_PORT = Number(process.env.VISION_CLOUD_PORT || 3101);

// --- Política de reinício do vision-cloud ---
//
// Escolhemos backoff FIXO (não exponencial) e SEM janela de reset por tempo:
// o "recurso" que a retentativa consome é só um spawn de processo Node local
// (barato), não uma API externa que precisaria ser poupada — não há motivo
// real para escalonar o intervalo. E o reset natural do contador já existe
// (todo redeploy/restart do container recria o supervisor do zero), então uma
// segunda janela de reset por tempo só adicionaria estado para explicar sem
// entregar garantia nova. Se 5 tentativas de 3s falharem (~15s), é sinal de
// bug de configuração — reiniciar para sempre esconderia isso; desistir e
// gritar no log é o comportamento certo.
const MAX_VISION_RESTARTS = Number(process.env.SUPERVISOR_MAX_VISION_RESTARTS || 5);
const RETRY_INTERVAL_MS = Number(process.env.SUPERVISOR_RETRY_INTERVAL_MS || 3000);

// --- Detecção de "travado" (hang), não só "crashou" ---
//
// Um processo que trava (loop síncrono preso, chamada de rede que nunca
// retorna, lock de I/O nunca liberado) NUNCA emite o evento `exit` — a
// checagem de crash sozinha (abaixo) não detecta isso. Por isso pingamos
// ativamente o endpoint /health (já existe, sem autenticação, ver
// apps/vision-cloud/server.ts) e, se ele parar de responder por tempo
// suficiente, tratamos como falha e matamos o processo à força.
// Todos os três abaixo são configuráveis por env var (tanto para operação —
// ajustar sensibilidade em produção se necessário — quanto para
// `scripts/test-supervisor.ts` rodar isso em segundos em vez de minutos).
const HEALTH_CHECK_INTERVAL_MS = Number(process.env.SUPERVISOR_HEALTH_INTERVAL_MS || 10_000);
const HEALTH_CHECK_TIMEOUT_MS = Number(process.env.SUPERVISOR_HEALTH_TIMEOUT_MS || 3_000);
const HEALTH_CHECK_MAX_FAILURES = Number(process.env.SUPERVISOR_HEALTH_MAX_FAILURES || 3); // ~3 checagens seguidas falhando antes de agir

// --- Limite de memória do vision-cloud ---
//
// core e vision-cloud rodam no MESMO container (mesmo cgroup/limite de
// memória do Coolify). Sem isso, um vision-cloud que aloca agressivamente
// antes de crashar poderia ser morto pelo OOM killer do KERNEL — e o kernel
// pode escolher matar o CORE em vez do vision-cloud (a pontuação de OOM não
// obedece "qual processo é menos importante para nós"). Damos um teto de
// heap V8 ao vision-cloud para que ELE se autolimite (erro de JS tratável,
// contabilizado como crash normal) antes de pressionar a memória do
// container inteiro. Ajustável via env var se o perfil de hardware mudar.
const VISION_MAX_OLD_SPACE_MB = Number(process.env.VISION_CLOUD_MAX_OLD_SPACE_MB || 512);

function log(origin: string, msg: string) {
  // Prefixo em toda linha que O SUPERVISOR escreve, para diferenciar de
  // linhas que core/vision-cloud escrevem por conta própria (essas saem
  // "cruas", sem prefixo adicional, porque stdio:'inherit' só compartilha o
  // file descriptor, não intercepta/reformata conteúdo). Tudo cai no mesmo
  // console que o Coolify já mostra hoje — não há novo lugar para procurar log.
  console.log(`[supervisor]${origin} ${msg}`);
}

let core: ChildProcess | null = null;
let vision: ChildProcess | null = null;
let visionRestarts = 0;
let visionHealthTimer: NodeJS.Timeout | null = null;
let visionHealthFailures = 0;
let shuttingDown = false;

function spawnCore() {
  core = spawn(CORE_CMD, CORE_ARGS, { stdio: ["ignore", "inherit", "inherit"], env: process.env });
  log("[core]", `iniciado (pid ${core.pid})`);

  core.on("exit", (code, signal) => {
    // IMPORTANTE: zerar a referência ANTES de chamar shutdownAll. Se não
    // fizermos isso, shutdownAll tentaria escutar um novo evento "exit" neste
    // MESMO ChildProcess — mas "exit" só dispara UMA vez por processo, e já
    // disparou (é o que nos trouxe até aqui). Um listener anexado depois nunca
    // seria chamado, e o supervisor ficaria esperando para sempre por um sinal
    // que já passou (o processo só sairia "por acidente", quando o event loop
    // esvaziasse sozinho, com o código de saída ERRADO — foi exatamente o bug
    // que o teste em scripts/test-supervisor.ts pegou antes desta correção).
    core = null;

    // O core é o processo principal do produto. Se ele sair por qualquer
    // razão que não seja o próprio supervisor pedindo shutdown, o container
    // inteiro deve morrer — o Coolify precisa VER o container cair para
    // aplicar a política de restart/alerta dele, exatamente como acontecia
    // antes deste supervisor existir (quando o core era o próprio PID 1).
    if (shuttingDown) return;
    log("[core]", `saiu inesperadamente (code=${code} signal=${signal}) — encerrando o container.`);
    shutdownAll(code ?? 1);
  });
}

function stopVisionHealthCheck() {
  if (visionHealthTimer) clearInterval(visionHealthTimer);
  visionHealthTimer = null;
  visionHealthFailures = 0;
}

function startVisionHealthCheck() {
  stopVisionHealthCheck();
  visionHealthTimer = setInterval(() => {
    const req = http.get(
      { host: "127.0.0.1", port: VISION_PORT, path: "/health", timeout: HEALTH_CHECK_TIMEOUT_MS },
      (res) => {
        // Só precisa responder alguma coisa dentro do timeout — não valida o
        // corpo. O objetivo é detectar "não responde", não "respondeu certo".
        res.resume();
        if (res.statusCode && res.statusCode < 500) visionHealthFailures = 0;
        else registerHealthFailure(`health-check retornou status ${res.statusCode}`);
      }
    );
    req.on("timeout", () => {
      req.destroy();
      registerHealthFailure(`health-check sem resposta em ${HEALTH_CHECK_TIMEOUT_MS}ms`);
    });
    req.on("error", (e) => {
      // ECONNREFUSED é normal logo após um crash (processo ainda subindo de
      // novo) — só conta como falha de "travado" se vier repetido enquanto o
      // processo deveria estar de pé; o teto de tentativas evita alarme falso
      // isolado.
      registerHealthFailure(`health-check com erro: ${e.message}`);
    });
  }, HEALTH_CHECK_INTERVAL_MS);
}

function registerHealthFailure(reason: string) {
  if (shuttingDown || !vision) return;
  visionHealthFailures++;
  log("[vision-cloud]", `${reason} (falha ${visionHealthFailures}/${HEALTH_CHECK_MAX_FAILURES})`);
  if (visionHealthFailures >= HEALTH_CHECK_MAX_FAILURES) {
    log("[vision-cloud]", `parece travado (sem responder por ~${(HEALTH_CHECK_MAX_FAILURES * HEALTH_CHECK_INTERVAL_MS) / 1000}s) — matando o processo à força (SIGKILL) e tratando como falha.`);
    stopVisionHealthCheck();
    vision.kill("SIGKILL"); // não confiamos em SIGTERM para um processo que já não está respondendo
  }
}

function spawnVision() {
  const env = {
    ...process.env,
    // Teto de heap SÓ para o vision-cloud (ver comentário no topo do arquivo).
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --max-old-space-size=${VISION_MAX_OLD_SPACE_MB}`.trim(),
  };
  vision = spawn(VISION_CMD, VISION_ARGS, { stdio: ["ignore", "inherit", "inherit"], env });
  log("[vision-cloud]", `iniciado (pid ${vision.pid}, tentativa ${visionRestarts + 1}/${MAX_VISION_RESTARTS + 1})`);
  startVisionHealthCheck();

  vision.on("exit", (code, signal) => {
    vision = null;
    stopVisionHealthCheck();
    if (shuttingDown) return;

    // Sempre bem visível no log — nunca falhar em silêncio.
    log("[vision-cloud]", `*** CAIU *** (code=${code} signal=${signal}).`);

    if (visionRestarts >= MAX_VISION_RESTARTS) {
      log(
        "[vision-cloud]",
        `desistiu após ${MAX_VISION_RESTARTS} tentativas — NÃO vai mais reiniciar sozinho. ` +
          `O core continua respondendo normalmente. Corrija a causa raiz (ver linhas acima) e ` +
          `faça um redeploy/restart do container para tentar de novo.`
      );
      return;
    }

    visionRestarts++;
    log("[vision-cloud]", `reiniciando em ${RETRY_INTERVAL_MS}ms (tentativa ${visionRestarts}/${MAX_VISION_RESTARTS})...`);
    setTimeout(() => {
      if (!shuttingDown) spawnVision();
    }, RETRY_INTERVAL_MS);
  });
}

function shutdownAll(exitCode: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopVisionHealthCheck();
  log("[supervisor]", `encerrando processos filhos (exit code ${exitCode})...`);

  // SIGTERM para os dois; se algum não sair a tempo, o Docker/Coolify mata
  // tudo com SIGKILL no timeout dele mesmo (default ~10s) — não precisamos
  // reimplementar esse timeout, só precisamos REPASSAR o sinal para ambos.
  if (vision && !vision.killed) vision.kill("SIGTERM");
  if (core && !core.killed) core.kill("SIGTERM");

  const pending = [core, vision].filter(Boolean) as ChildProcess[];
  if (pending.length === 0) return process.exit(exitCode);

  let remaining = pending.length;
  for (const p of pending) {
    p.once("exit", () => {
      remaining--;
      if (remaining === 0) process.exit(exitCode);
    });
  }
}

// Docker/Coolify mandam SIGTERM em `docker stop`/redeploy. SIGINT é o Ctrl+C
// local (útil rodando o supervisor manualmente, fora do container, para
// debug — ver "TESTE LOCAL" abaixo).
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log("[supervisor]", `recebeu ${sig}, propagando para os filhos...`);
    shutdownAll(0);
  });
}

spawnCore();
spawnVision();

// ==========================================================================
// TESTE LOCAL (sem Docker/tini) — valida spawn, SIGTERM, crash+retry, teto de
// tentativas. NÃO valida reaping de processo-zumbi (isso depende do tini
// como PID 1 real; ver docs/adr/ADR-008-process-supervisor.md para o teste
// específico disso, que não depende deste arquivo).
//
//   npm run build && npm run build:vision-cloud && npm run build:supervisor
//   node dist/supervisor.cjs
//   # noutro terminal, simular um redeploy/docker stop:
//   kill -TERM <pid impresso na primeira linha de log>
//
// Para simular o vision-cloud crashando/travando sem esperar um bug real,
// ver `npm run test:supervisor` (scripts/test-supervisor.ts), que sobe o
// supervisor real contra processos de teste (stubs) que crasham/travam sob
// comando, e verifica automaticamente cada um dos cenários acima.
// ==========================================================================
