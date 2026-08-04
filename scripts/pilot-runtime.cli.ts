/**
 * CLI de ativação dos pilotos Runtime (ADR-152 F4d.1).
 *
 * Entry SEPARADO da lógica (`pilot-runtime.ts`) — mesmo padrão do
 * `pilot-retail-floor.cli.ts` — pra poder ser:
 *   - rodado localmente com tsx:  npm run pilot:runtime -- --find toulon
 *   - COMPILADO no build (esbuild → dist/pilot-runtime.cjs) e rodado em
 *     produção SEM tsx:  node dist/pilot-runtime.cjs --org <id> --apply
 */
import { runRuntimePilotCli } from "./pilot-runtime.js";

runRuntimePilotCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => { console.error(e?.message || e); process.exit(1); });
