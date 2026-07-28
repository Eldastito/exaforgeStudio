/**
 * CLI do seeder das contas de referência (peixaria + chaveiro).
 *
 * Entry SEPARADO da lógica (seed-reference-autonomos.ts) para poder ser:
 *   - rodado localmente com tsx:  npm run seed:reference-autonomos
 *   - COMPILADO no build (esbuild → dist/seed-reference-autonomos.cjs) e rodado
 *     em produção/staging SEM tsx:  npm run seed:reference-autonomos:prod
 *     (ou: node dist/seed-reference-autonomos.cjs)
 */
import { runSeed } from "./seed-reference-autonomos.js";

runSeed()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
