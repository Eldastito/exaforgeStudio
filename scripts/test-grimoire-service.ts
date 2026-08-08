/**
 * TEST — GrimoireService (ADR-155 F1.2).
 *
 * Prova o runtime do progressive-disclosure: load(orgId, module, stage) retorna
 * SÓ a rubrica roteada no INDEX, isola por módulo (não vaza rubrica de outro),
 * é graceful pra desconhecido, e o compiled.ts está em sync com docs/grimoire/
 * copy/** (freshness). Sem DB — o grimoire é embarcado.
 *
 * Uso: npm run test:grimoire-service
 */
import fs from "fs";
import path from "path";
import { GrimoireService } from "../src/server/GrimoireService.js";
import { GRIMOIRE_RUBRICS } from "../src/server/grimoire/compiled.js";
import { buildGrimoireModule } from "./build-grimoire.js";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const ORG_A = "org_aaaa";
const ORG_B = "org_bbbb";

function main() {
  // ===== 1. Freshness: compiled.ts está em sync com o grimoire =====
  const onDisk = fs.readFileSync(path.resolve("src/server/grimoire/compiled.ts"), "utf8");
  check("compiled.ts em sync com docs/grimoire/copy (rode npm run grimoire:build)", onDisk === buildGrimoireModule());

  // ===== 2. Roteamento =====
  check("stages() traz os 5 estágios", GrimoireService.stages().length === 5);
  const rotaCobrancaCompose = GrimoireService.routes("cobranca", "compose");
  check("routes(cobranca,compose) = dunning + sequence-timing",
    rotaCobrancaCompose.join(",") === "compose/dunning-cadence.md,compose/sequence-timing.md");
  check("routes de módulo desconhecido é vazio", GrimoireService.routes("xpto", "compose").length === 0);

  // ===== 3. load: só o roteado + isolamento por módulo =====
  const cob = GrimoireService.load(ORG_A, "cobranca", "compose");
  check("load(cobranca,compose) found", cob.found);
  check("load(cobranca,compose) tem 2 rubricas", cob.rubricPaths.length === 2);
  check("prompt inclui dunning-cadence", cob.prompt.includes('id="dunning-cadence"'));
  check("prompt inclui sequence-timing", cob.prompt.includes('id="sequence-timing"'));
  check("ISOLAMENTO: cobranca/compose NÃO vaza save-offer-ladder (falatu)", !cob.prompt.includes('id="save-offer-ladder"'));

  const fal = GrimoireService.load(ORG_A, "falatu", "compose");
  check("load(falatu,compose) inclui save-offer-ladder", fal.prompt.includes('id="save-offer-ladder"'));
  check("ISOLAMENTO: falatu/compose NÃO vaza dunning-cadence (cobranca)", !fal.prompt.includes('id="dunning-cadence"'));

  // invariante forte: toda rubrica retornada declara o módulo pedido
  for (const m of ["cobranca", "recuperacao", "falatu"]) {
    let ok = true;
    for (const s of GrimoireService.stages()) for (const r of GrimoireService.load(ORG_A, m, s).rubrics) if (!r.modulos.includes(m)) ok = false;
    check(`ISOLAMENTO: toda rubrica de '${m}' declara '${m}' em modulos`, ok);
  }

  // ===== 4. Progressive disclosure: prompt << dump inteiro =====
  const dumpTodas = Object.values(GRIMOIRE_RUBRICS).map((r) => r.corpo).join("\n\n");
  check("prompt roteado é MENOR que o dump de todas as rubricas", cob.prompt.length < dumpTodas.length);
  check("progressive: cobranca/compose NÃO inclui glossary (tom-de-voz)", !cob.prompt.includes('id="tom-de-voz"'));
  check("progressive: cobranca/compose NÃO inclui guardrails (lgpd-e-whatsapp)", !cob.prompt.includes('id="lgpd-e-whatsapp"'));

  // ===== 5. Bloco <rubrica> bem-formado =====
  const abre = (cob.prompt.match(/<rubrica /g) || []).length;
  const fecha = (cob.prompt.match(/<\/rubrica>/g) || []).length;
  check("blocos <rubrica> abrem e fecham igual", abre === fecha && abre === cob.rubricPaths.length);

  // ===== 6. Graceful: desconhecido não lança =====
  const nada = GrimoireService.load(ORG_A, "modulo-inexistente", "compose");
  check("módulo desconhecido → found=false", !nada.found);
  check("módulo desconhecido → prompt vazio", nada.prompt === "");
  check("módulo desconhecido → rubricPaths vazio", nada.rubricPaths.length === 0);

  // ===== 7. Tenant-first: assinatura exige orgId; camada por-org é F1.3 =====
  check("mesmo conteúdo global entre orgs (por-org é F1.3)",
    GrimoireService.load(ORG_A, "cobranca", "compose").prompt === GrimoireService.load(ORG_B, "cobranca", "compose").prompt);

  // ===== 8. promptFor multi-estágio =====
  const full = GrimoireService.promptFor(ORG_A, "cobranca", ["guardrails", "intake", "compose", "review"]);
  check("promptFor multi-estágio inclui guardrails + intake + compose", full.includes('id="lgpd-e-whatsapp"') && full.includes('id="churn-risk-scoring"') && full.includes('id="dunning-cadence"'));

  // ===== resultado =====
  console.log("\n=== GrimoireService — F1.2 ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checagens ok`);
  if (failures > 0) { console.error(`\n❌ ${failures} falha(s)`); process.exit(1); }
  console.log("\n✅ GrimoireService íntegro");
}

main();
