/**
 * TESTE — W4 (F7.4): retirada das redundâncias elegíveis, com o "nunca remover"
 * preservado. Piloto aprovado pelo dono (16/09/2026: conexão nova + modo misto +
 * WZ-1 + WZ-2 validados na TOULON).
 * ------------------------------------------------------------------------------
 * Gate de REGRESSÃO por leitura de fonte (molde test:org-group-lint):
 *   1. As rotas legadas NÃO-autenticadas /api/evolution/config e
 *      /api/evolution/instance/connect não têm mais implementação — só o
 *      tombstone 410 (frontend velho em cache recebe erro claro, não 404).
 *   2. Nenhum código de produção chama as rotas legadas.
 *   3. A UI usa exclusivamente o fluxo autenticado F2.1
 *      (/api/channels/whatsapp/provision).
 *   4. PRESERVADOS (a F7.4 §2 manda nunca remover): atalhos wa.me · seed mock
 *      default_org · SQL legado de seleção vivo em EXATAMENTE 1 lugar (o
 *      fallback 0-regressão do resolvedor — não é cópia, é a implementação).
 *
 * Uso:  npm run test:legacy-route-removal
 */
import path from "path";
import fs from "fs";
import { execSync } from "child_process";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function main() {
  const server = read("server.ts");

  // 1) Rotas legadas: só tombstone 410, sem implementação de conexão.
  check("1.1 tombstone 410 registrado pras duas rotas legadas",
    server.includes(`app.post(["/api/evolution/config", "/api/evolution/instance/connect"]`) && server.includes("legacy_route_removed"));
  check("1.2 sem implementação legada de connect (EvolutionService.provision fora do server.ts)",
    !server.includes("EvolutionService.provision") && !server.includes("EvolutionService.getConfig"));
  check("1.3 sem mutação não-autenticada da config (evolutionConfig é const de ENV)",
    /const evolutionConfig = \{/.test(server) && !/let evolutionConfig/.test(server));

  // 2) Nenhum caller das rotas legadas no código de produção (src/ + server.ts).
  let callers = "";
  try {
    callers = execSync(
      `grep -rln "api/evolution/instance/connect\\|api/evolution/config" src --include='*.ts' --include='*.tsx' || true`,
      { cwd: ROOT, encoding: "utf8" }
    ).trim();
  } catch { /* grep sem match sai 1 */ }
  // A única menção permitida é COMENTÁRIO histórico no EvolutionService.
  const offenders = callers.split("\n").filter(f => f && f !== "src/server/EvolutionService.ts");
  check("2.1 nenhum caller das rotas legadas em src/", offenders.length === 0, offenders.join(","));

  // 3) UI 100% no fluxo autenticado F2.1.
  const panel = read("src/features/ChannelsPanel.tsx");
  check("3.1 ChannelsPanel usa o endpoint autenticado", panel.includes("/api/channels/whatsapp/provision"));
  check("3.2 ChannelsPanel não referencia a rota legada", !panel.includes("/api/evolution/instance/connect"));

  // 4) PRESERVADOS (§2 da F7.4 — nunca remover).
  let waMe = "";
  try { waMe = execSync(`grep -rl "wa.me" src/features --include='*.tsx' || true`, { cwd: ROOT, encoding: "utf8" }).trim(); } catch { /* noop */ }
  check("4.1 atalhos wa.me preservados", waMe.length > 0);
  check("4.2 seed mock default_org preservado", server.includes("'default_org'"));
  // Agulha = o SQL A5 EXATO (uma linha, `status != 'disabled'`). A variante
  // Clinic (W2b diferida) usa `status NOT IN ('disabled','disconnected')` —
  // não é cópia A5 e fica fora deste gate de propósito.
  let sqlCopies = "";
  try {
    sqlCopies = execSync(
      `grep -rln "status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1" src/server --include='*.ts' || true`,
      { cwd: ROOT, encoding: "utf8" }
    ).trim();
  } catch { /* noop */ }
  const sqlFiles = sqlCopies.split("\n").filter(Boolean);
  check("4.3 SQL de seleção A5 vive SÓ no resolvedor (fallback 0-regressão)",
    sqlFiles.length === 1 && sqlFiles[0] === "src/server/ChannelBindingService.ts", sqlFiles.join(","));
  // Webhook de inbound segue registrado (a remoção não tocou recebimento).
  check("4.4 webhook /api/webhooks/evolution preservado", server.includes('"/api/webhooks/evolution"'));

  console.log("\n=== TEST: Retirada das rotas legadas (W4) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  process.exit(failures ? 1 : 0);
}

main();
