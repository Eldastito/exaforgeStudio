/**
 * CLI de ativação do piloto Retail Floor (ADR-150).
 *
 * Entry SEPARADO da lógica (pilot-retail-floor.ts) — mesmo padrão do seeder —
 * para poder ser:
 *   - rodado localmente com tsx:  npm run pilot:retail-floor -- --find toulon
 *   - COMPILADO no build (esbuild → dist/pilot-retail-floor.cjs) e rodado em
 *     produção SEM tsx:  node dist/pilot-retail-floor.cjs --org <id> --apply
 */
import { runPilotCli } from "./pilot-retail-floor.js";

runPilotCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => { console.error(e?.message || e); process.exit(1); });
