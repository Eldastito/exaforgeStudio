/**
 * Piloto Runtime (ADR-152 F4d.1) — lógica do CLI de ativação.
 *
 * Ativa os pilotos Cobrança (F4b*) e Recuperação Comercial (F4c*) numa
 * organização real, idempotente e auditado. Segue o padrão TOULON
 * (ADR-150) — `find → diagnóstico → apply`.
 *
 * Roda NO SERVIDOR (onde o DATA_DIR aponta pro banco real). Sem cadeia
 * de banco no ar, aborta antes de importar qualquer service (importar
 * db.js CRIA o arquivo se não existir e um typo de diretório viraria
 * banco vazio silencioso).
 *
 * Fluxo seguro:
 *   1. `--find <termo>`                 → lista orgs candidatas (só leitura)
 *   2. `--org <id>`                     → diagnóstico só-leitura (plan)
 *   3. `--org <id> --apply [opções]`    → liga flags + tuning + policies
 *
 * Opções principais (opt-in — cada uma liga UMA flag):
 *   --runtime            execution_runtime_enabled          (master gate)
 *   --collection         collection_cadence_enabled         (cadência cobrança)
 *   --sales-recovery     sales_recovery_enabled             (piloto recuperação)
 *   --followup           sales_recovery_followup_enabled    (cadência recuperação)
 *   --attribution        sales_recovery_attribution_enabled (revenue recuperado)
 *   --seed-policies      semeia agent_policies dos sub-pilotos ligados
 *                        (autonomy=execute + execution_mode=approved_execution)
 *
 * Cascade (falha rápido pra evitar "liguei mas não roda"):
 *   --collection|--sales-recovery       exigem --runtime (ou runtime já ligado)
 *   --followup|--attribution            exigem --sales-recovery (ou já ligada)
 *
 * Opções de tuning (só grava se veio no comando):
 *   --collection-r2-days N   --collection-r3-days N   --collection-grace-days N
 *   --stalled-days N         --reply-window-days N    --followup-gap-days N
 *   --attribution-window N
 *
 * G-4c-1 preservada: modo `autonomous` NUNCA é setado por este CLI —
 * está BLOQUEADO na decisão #4 (revisão LGPD). Piloto sempre roda em
 * `approved_execution` (dono clica pra aprovar cada envio).
 *
 * Local (dev):     npm run pilot:runtime -- --find toulon
 * Produção (dist): node dist/pilot-runtime.cjs --find toulon
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
  console.log(`\nFLAGS:`);
  console.log(`  execution_runtime:            ${plan.flags.runtime ? "LIGADO" : "desligado"}`);
  console.log(`  collection_cadence:           ${plan.flags.collection ? "LIGADO" : "desligado"}`);
  console.log(`  sales_recovery:               ${plan.flags.salesRecovery ? "LIGADO" : "desligado"}`);
  console.log(`  sales_recovery_followup:      ${plan.flags.followup ? "LIGADO" : "desligado"}`);
  console.log(`  sales_recovery_attribution:   ${plan.flags.attribution ? "LIGADO" : "desligado"}`);
  console.log(`\nTUNING (dias):`);
  console.log(`  collection R2/R3/graça:       ${plan.tuning.collectionR2Days}/${plan.tuning.collectionR3Days}/${plan.tuning.collectionGraceDays}`);
  console.log(`  recovery stalled/reply/gap:   ${plan.tuning.stalledDays}/${plan.tuning.replyWindowDays}/${plan.tuning.followupGapDays}`);
  console.log(`  atribuição (janela):          ${plan.tuning.attributionWindowDays}`);
  console.log(`\nPRÉ-REQS:`);
  console.log(`  WhatsApp conectados:          ${plan.prereqs.channelsConnected}`);
  console.log(`  Contatos importados:          ${plan.prereqs.contactsCount}`);
  console.log(`  Owners ativos:                ${plan.prereqs.ownersCount}`);
  console.log(`  OPENAI_API_KEY:               ${plan.prereqs.openaiKey ? "sim" : "não"}`);
  console.log(`  Policies cobrança OK:         ${plan.prereqs.policiesReady.collection ? "sim" : "não"}`);
  console.log(`  Policies recuperação OK:      ${plan.prereqs.policiesReady.salesRecovery ? "sim" : "não"}`);
  console.log(`\nProntidão: ${plan.readiness}`);
  for (const b of plan.blockers as string[]) console.log(`  ✗ ${b}`);
  for (const w of plan.warnings as string[]) console.log(`  ⚠ ${w}`);
  if (!plan.blockers.length && !plan.warnings.length) console.log("  ✓ Sem pendências.");
}

function printUsage() {
  console.log("Uso do pilot:runtime (ADR-152 F4d.1):");
  console.log("  --find <nome>                          busca orgs por substring do nome");
  console.log("  --org <id>                             diagnóstico só-leitura");
  console.log("  --org <id> --apply --runtime           liga o gate master (execution_runtime_enabled)");
  console.log("  --org <id> --apply --collection        liga a cadência automática de cobrança");
  console.log("  --org <id> --apply --sales-recovery    liga o piloto de recuperação comercial");
  console.log("  --org <id> --apply --followup          liga a cadência multi-tentativa de recuperação");
  console.log("  --org <id> --apply --attribution       liga a atribuição real de revenue recuperado");
  console.log("  --seed-policies                        semeia agent_policies dos pilotos ligados");
  console.log("Tuning (opcional, em --apply):");
  console.log("  --collection-r2-days N (1..30)      --collection-r3-days N (1..60)   --collection-grace-days N (0..14)");
  console.log("  --stalled-days N (1..90)            --reply-window-days N (1..60)     --followup-gap-days N (1..30)");
  console.log("  --attribution-window N (1..90)");
  console.log("\nCascade (falha rápido):");
  console.log("  --collection|--sales-recovery      exigem --runtime (ou runtime já ligado)");
  console.log("  --followup|--attribution           exigem --sales-recovery");
  console.log("\nExemplo típico de rollout de nova org piloto:");
  console.log("  node dist/pilot-runtime.cjs --org <id> --apply \\\\");
  console.log("     --runtime --collection --sales-recovery --followup --attribution --seed-policies");
}

export async function runRuntimePilotCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  // GUARDA DO BANCO — antes de importar qualquer service (importar db.js
  // CRIA o arquivo se não existir; typo no DATA_DIR viraria banco vazio novo).
  const fs = await import("fs");
  const path = await import("path");
  const dataDir = process.env.DATA_DIR || process.cwd();
  const dbPath = path.join(dataDir, "zappflow.db");
  console.log(`Banco: ${dbPath}${process.env.DATA_DIR ? "" : "  (DATA_DIR não definido — usando o diretório atual)"}`);
  if (!fs.existsSync(dbPath)) {
    console.error(`\n✗ zappflow.db NÃO existe aí — diretório errado ou sem DATA_DIR do app.`);
    console.error(`  1. cd para a pasta do app (onde vive o dist/server.cjs) OU`);
    console.error(`  2. exporte o mesmo DATA_DIR que o servidor usa (ex.: DATA_DIR=/data node dist/pilot-runtime.cjs ...)`);
    console.error(`  Dica: ache o banco com  find / -name zappflow.db 2>/dev/null`);
    return 1;
  }

  const { RuntimePilotService } = await import("../src/server/RuntimePilotService.js");

  if (args.find) {
    const orgs = RuntimePilotService.findOrgs(String(args.find));
    if (!orgs.length) { console.log(`Nenhuma org com nome contendo "${args.find}".`); return 1; }
    console.log(`Orgs encontradas (${orgs.length}):`);
    for (const o of orgs) console.log(`  ${o.orgId}  ${o.name}  vertical=${o.vertical || "—"}  status=${o.status}`);
    console.log(`\nAgora: --org <id> pro diagnóstico; --org <id> --apply pra ativar.`);
    return 0;
  }

  const orgId = args.org ? String(args.org) : null;
  if (!orgId) { printUsage(); return 1; }

  if (!args.apply) {
    try {
      printPlan(RuntimePilotService.plan(orgId));
    } catch (e: any) {
      console.error(`\n✗ ${e?.message || e}`);
      return 1;
    }
    console.log("\n(Diagnóstico só-leitura. Adicione --apply pra ativar.)");
    return 0;
  }

  const numArg = (k: string) => (args[k] != null && args[k] !== true ? Number(args[k]) : undefined);
  const opts: any = {};
  if (args.runtime === true) opts.runtime = true;
  if (args.collection === true) opts.collection = true;
  if (args["sales-recovery"] === true) opts.salesRecovery = true;
  if (args.followup === true) opts.followup = true;
  if (args.attribution === true) opts.attribution = true;
  if (args["seed-policies"] === true) opts.seedPolicies = true;
  opts.collectionR2Days = numArg("collection-r2-days");
  opts.collectionR3Days = numArg("collection-r3-days");
  opts.collectionGraceDays = numArg("collection-grace-days");
  opts.stalledDays = numArg("stalled-days");
  opts.replyWindowDays = numArg("reply-window-days");
  opts.followupGapDays = numArg("followup-gap-days");
  opts.attributionWindowDays = numArg("attribution-window-days");

  let plan;
  try {
    plan = RuntimePilotService.apply(orgId, opts);
  } catch (e: any) {
    console.error(`\n✗ Falha ao aplicar: ${e?.message || e}`);
    return 1;
  }
  console.log("✅ Piloto aplicado (idempotente — rodar de novo só re-aplica).");
  printPlan(plan);
  return plan.readiness === "BLOQUEADO" ? 1 : 0;
}
