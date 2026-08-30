/**
 * ROLLOUT — Estúdio de Criação GLOBAL (módulo `estudio`).
 *
 * Torna o Estúdio disponível para TODAS as organizações: habilita o módulo
 * `estudio` em toda org com lista explícita de módulos que ainda não o tem.
 * Aditivo e idempotente (não remove nada; orgs com enabled_modules NULL já
 * enxergam tudo). O teto de plano continua valendo em runtime.
 *
 * Rodar UMA vez após o deploy que colocou `estudio` no preset de todas as
 * verticais:  npm run backfill:studio-global
 */
import { ModuleService } from "../src/server/ModuleService.js";

async function main() {
  console.log("\n=== Rollout: Estúdio de Criação global (módulo `estudio`) ===\n");
  const r = ModuleService.enableOptionalModuleForAllOrgs("estudio");
  console.log(`orgs com lista explícita varridas: ${r.scanned}`);
  console.log(`orgs que passaram a ter o Estúdio: ${r.updated}`);
  console.log("(orgs com enabled_modules NULL já enxergavam tudo — não precisam.)");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
