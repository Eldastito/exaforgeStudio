/**
 * Piloto Retail Floor (ADR-150) — lógica do CLI de ativação.
 *
 * Roda NO SERVIDOR (onde o DATA_DIR aponta pro banco real). Fluxo seguro:
 *   1. `--find toulon`                       → lista as orgs candidatas (só leitura)
 *   2. `--org <id>`                          → diagnóstico (plan, só leitura)
 *   3. `--org <id> --apply [opções]`         → aplica (idempotente, auditado)
 *
 * Opções do apply:
 *   --calibration-days <n>   default 30 (0 = remove a calibração)
 *   --store <code> --manager-email <email>   define o gerente da loja piloto
 *   --digest [--digest-hour <0..23>]         liga o resumo diário WhatsApp
 *
 * Local (dev):     npm run pilot:retail-floor -- --find toulon
 * Produção (dist): node dist/pilot-retail-floor.cjs --find toulon
 */

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next != null && !next.startsWith("--")) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

function printPlan(plan: any) {
  console.log(`\nOrg: ${plan.org.name}  (${plan.org.orgId})  vertical=${plan.org.vertical || "—"}  status=${plan.org.status}`);
  console.log(`Módulo retail_floor: ${plan.moduleEnabled ? "LIGADO" : "desligado"}`);
  console.log(`Settings: fila=${plan.settings.queuePolicy}  auto_close=${plan.settings.autoCloseMinutes}min  calibração=${plan.settings.calibrationUntil || "—"}  resumo_diário=${plan.settings.dailyDigestEnabled ? `ligado ${plan.settings.digestHour}h BRT` : "desligado"}`);
  console.log(`Lojas ativas (${plan.stores.length}):`);
  for (const s of plan.stores) {
    console.log(`  - ${s.name}${s.code ? ` (${s.code})` : ""}  gerente=${s.managerEmail || "—"}  whatsapp=${s.whatsapp || "—"}  responsáveis=${s.responsibles}`);
  }
  console.log(`Vendedores ativos: ${plan.sellers.total} (${plan.sellers.linkedToUser} com login vinculado)`);
  console.log(`Canal WhatsApp: ${plan.channelConnected ? "conectado" : "—"}   Último sync Alterdata: ${plan.alterdataLastSync || "—"}`);
  console.log(`\nProntidão: ${plan.readiness}`);
  for (const item of plan.checklist) console.log(`  ⚠ ${item}`);
  if (!plan.checklist.length) console.log("  ✓ Tudo pronto pro turno de amanhã.");
}

export async function runPilotCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const { RetailFloorPilotService } = await import("../src/server/RetailFloorPilotService.js");

  if (args.find) {
    const orgs = RetailFloorPilotService.findOrgs(String(args.find));
    if (!orgs.length) { console.log(`Nenhuma org com nome contendo "${args.find}".`); return 1; }
    console.log(`Orgs encontradas (${orgs.length}):`);
    for (const o of orgs) console.log(`  ${o.orgId}  ${o.name}  vertical=${o.vertical || "—"}  status=${o.status}`);
    console.log(`\nAgora: --org <id> pro diagnóstico; --org <id> --apply pra ativar.`);
    return 0;
  }

  const orgId = args.org ? String(args.org) : null;
  if (!orgId) {
    console.log("Uso: --find <nome> | --org <id> [--apply] [--calibration-days N] [--store CODE --manager-email EMAIL] [--digest [--digest-hour H]]");
    return 1;
  }

  if (!args.apply) {
    printPlan(RetailFloorPilotService.plan(orgId));
    console.log("\n(Diagnóstico só-leitura. Adicione --apply pra ativar.)");
    return 0;
  }

  const plan = RetailFloorPilotService.apply(orgId, {
    calibrationDays: args["calibration-days"] != null ? Number(args["calibration-days"]) : 30,
    storeCode: args.store ? String(args.store) : null,
    managerEmail: args["manager-email"] ? String(args["manager-email"]) : null,
    digest: args.digest === true ? true : undefined,
    digestHour: args["digest-hour"] != null ? Number(args["digest-hour"]) : null,
  });
  console.log("✅ Piloto aplicado (idempotente — rodar de novo só re-aplica).");
  printPlan(plan);
  return plan.readiness === "PRONTO" ? 0 : 0; // pendências não são erro: o checklist orienta
}
