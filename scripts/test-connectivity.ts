/**
 * TESTE — Conectividade honesta + guardrail de salvamento em degradação
 * (PDR TOULON, Fatia 5 / CONN-001/002/005).
 * ---------------------------------------------------------------------------
 * Parte A — lógica PURA (`@/src/lib/connectivity`):
 *   - deriveConnectivity cobre os 4 estados (online/realtime_degraded/
 *     api_degraded/offline) a partir de rede × API × socket;
 *   - classifyApi (ok/slow/down) pelo resultado do probe + limiar de latência;
 *   - CONN-002: o texto do estado só-WebSocket promete que consultas e
 *     salvamentos continuam.
 *
 * Parte B — CONN-005 (guardrail de fonte): o OUTBOX SILENCIOSO do cliente
 *   (enqueueMessage / getOutbox().enqueue) só pode ser usado por caminhos de
 *   MENSAGEM/CAPTURA — NUNCA por operação financeira/comissão (que exige
 *   resposta do servidor). Um `apiFetch` financeiro que caísse no outbox
 *   silencioso quebraria este teste.
 *
 * Determinístico e offline.
 *
 * Uso:  npm run test:connectivity
 */
import fs from "fs";
import path from "path";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { deriveConnectivity, classifyApi, CONNECTIVITY_META } = await import("../src/lib/connectivity.js");

  // ===== Parte A: lógica pura =====
  check("online + socket ok + API ok → online", deriveConnectivity(true, true, "ok") === "online");
  check("socket caído + API ok → realtime_degraded", deriveConnectivity(true, false, "ok") === "realtime_degraded");
  check("API down (socket up) → api_degraded", deriveConnectivity(true, true, "down") === "api_degraded");
  check("API lenta → api_degraded", deriveConnectivity(true, true, "slow") === "api_degraded");
  check("sem rede vence tudo → offline", deriveConnectivity(false, true, "ok") === "offline" && deriveConnectivity(false, false, "down") === "offline");
  check("API desconhecida + socket ok → online (otimista)", deriveConnectivity(true, true, "unknown") === "online");

  check("classifyApi(false) → down", classifyApi(false, 10) === "down");
  check("classifyApi(true, 3000) → slow", classifyApi(true, 3000) === "slow");
  check("classifyApi(true, 100) → ok", classifyApi(true, 100) === "ok");
  check("classifyApi(true, null) → ok", classifyApi(true, null) === "ok");

  check("CONNECTIVITY_META tem os 4 estados", ["online", "realtime_degraded", "api_degraded", "offline"].every((k) => !!(CONNECTIVITY_META as any)[k]?.label));
  check("CONN-002: realtime_degraded promete consultas/salvamentos", /consultas e salvamentos continuam/i.test(CONNECTIVITY_META.realtime_degraded.text));
  check("CONN-002: não usa só 'Instável' no realtime_degraded", CONNECTIVITY_META.realtime_degraded.label !== "Instável");

  // ===== Parte B: guardrail CONN-005 =====
  const SRC = path.resolve("src");
  const OUTBOX_CALL = /\benqueueMessage\s*\(|getOutbox\s*\(\s*\)\s*\.\s*enqueue\s*\(/;
  // Caminhos AUTORIZADOS a usar o outbox silencioso (mensagem/captura).
  const ALLOW = new Set(["store/useStore.ts", "lib/falatu/offlineQueue.ts", "lib/comigo/offlineQueue.ts"]);
  const FINANCIAL = /(retail|closing|commission|comiss|pricing|precific|boleta|financ)/i;

  const offenders: string[] = [];
  const financialOffenders: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (full.includes(path.join("lib", "continuity"))) continue; walk(full); continue; }
      if (!/\.(ts|tsx)$/.test(ent.name)) continue;
      const rel = path.relative(SRC, full).split(path.sep).join("/");
      const content = fs.readFileSync(full, "utf8");
      if (OUTBOX_CALL.test(content)) {
        if (!ALLOW.has(rel)) offenders.push(rel);
        if (FINANCIAL.test(rel)) financialOffenders.push(rel);
      }
    }
  };
  walk(SRC);

  check("outbox silencioso usado só nos caminhos de mensagem/captura", offenders.length === 0, offenders.join(", "));
  check("CONN-005: nenhum caminho financeiro/comissão enfileira silenciosamente", financialOffenders.length === 0, financialOffenders.join(", "));

  console.log("\n=== TEST: Conectividade honesta + CONN-005 (Fatia 5) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
