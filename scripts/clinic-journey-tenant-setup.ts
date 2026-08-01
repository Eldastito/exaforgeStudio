/**
 * OP RUNBOOK — Setup da Jornada de Tratamento por tenant
 * -------------------------------------------------------------------
 * Habilita a Jornada de Tratamento (ADR-145 backend + ADR-146 UI)
 * numa organização específica, de forma IDEMPOTENTE (rodar N vezes
 * é seguro). Todos os passos abaixo verificam antes de mutar.
 *
 * Uso:
 *   tsx scripts/clinic-journey-tenant-setup.ts <orgId> [--cycle-requires-guide] [--dry-run]
 *
 *   orgId                     obrigatório
 *   --cycle-requires-guide    setar clinic_cycle_requires_guide=1 (RN-005 §8);
 *                             ciclos nascem 'pending_authorization' até uma
 *                             guia emitida ser amarrada. Use pra clientes
 *                             que operam SÓ com plano/convênio.
 *   --dry-run                 imprime o que faria, sem mutar nada.
 *
 * Sai com código 0 se pronto pra go-live; 1 se há bloqueadores
 * (ex.: profissional ativo sem PIN). Warnings ficam no stderr mas
 * não bloqueiam a saída.
 *
 * Fluxo:
 *   1. Backfill de especialidades (F35 legacy migration idempotente).
 *      Migra clinic_professionals.specialty (string livre pré-145)
 *      → clinic_specialties + clinic_professional_specialties (N:N).
 *   2. Valida cobertura: N profissionais ativos, N com specialty
 *      linkada, N com pin_hash configurado.
 *      - Sem PIN: BLOQUEIA. Alta/reopen (F39) exige PIN e sem ele
 *        o médico não consegue dar alta = paciente fica ativo pra
 *        sempre. É melhor bloquear no setup do que descobrir no
 *        primeiro dia.
 *      - Sem specialty: WARN. Profissional continua atendendo
 *        (aditivo), mas não entra na Jornada até ser vinculado.
 *   3. Aplica clinic_cycle_requires_guide se pedido (RN-005 §8).
 *   4. Imprime relatório final.
 *
 * NÃO cria feature flag "clinic_module_enabled" porque este repo
 * não usa esse padrão — módulo Clínica é sempre-on quando existe
 * organization_settings com módulo clinic configurado. A Jornada
 * aparece na UI (ADR-146) quando há episódios ativos (o header
 * F56 auto-esconde caso contrário).
 *
 * Reversível?
 *   - Backfill: sim (dados novos ficam; delete manual se precisar).
 *   - cycle_requires_guide: sim (rodar com flag ausente não desliga
 *     — pra desligar use SQL: UPDATE organization_settings SET
 *     clinic_cycle_requires_guide=0 WHERE organization_id=?).
 *   - Nada é destrutivo. Nada usa DELETE.
 */
import { randomUUID } from "crypto";

type Flags = { orgId: string; cycleRequiresGuide: boolean; dryRun: boolean };

function parseArgs(argv: string[]): Flags {
  const args = argv.slice(2);
  const orgId = args.find(a => !a.startsWith("--"));
  if (!orgId) {
    console.error("Uso: tsx scripts/clinic-journey-tenant-setup.ts <orgId> [--cycle-requires-guide] [--dry-run]");
    process.exit(2);
  }
  return {
    orgId,
    cycleRequiresGuide: args.includes("--cycle-requires-guide"),
    dryRun: args.includes("--dry-run"),
  };
}

async function main() {
  const flags = parseArgs(process.argv);
  const { default: db } = await import("../src/server/db.js");
  const { ClinicSpecialtyService } = await import("../src/server/ClinicSpecialtyService.js");

  // ── Sanity: org existe ────────────────────────────────────────────
  const org = db.prepare(
    `SELECT organization_id, business_name FROM organization_settings WHERE organization_id = ?`
  ).get(flags.orgId) as any;
  if (!org) {
    console.error(`ERRO: organização "${flags.orgId}" não encontrada em organization_settings.`);
    process.exit(1);
  }

  console.log("=".repeat(70));
  console.log(`SETUP JORNADA DE TRATAMENTO — ${org.business_name || flags.orgId}`);
  console.log(`orgId: ${flags.orgId}${flags.dryRun ? "   [DRY RUN]" : ""}`);
  console.log("=".repeat(70));

  // ── Passo 1: Backfill de especialidades (F35 idempotente) ────────
  console.log("\n[1/3] Backfill de especialidades (F35 legacy migration)…");
  const legacyCount = (db.prepare(
    `SELECT COUNT(*) AS c FROM clinic_professionals
      WHERE organization_id = ? AND specialty IS NOT NULL AND TRIM(specialty) != ''`
  ).get(flags.orgId) as any).c;
  console.log(`      Profissionais com specialty (string legada): ${legacyCount}`);

  let backfillSummary = { specialtiesCreated: 0, linksCreated: 0, linksAlreadyExisted: 0 };
  if (flags.dryRun) {
    console.log("      [dry-run] rodaria backfillFromLegacy(orgId).");
  } else {
    backfillSummary = ClinicSpecialtyService.backfillFromLegacy(flags.orgId, "runbook-setup");
    console.log(`      → Specialties criadas: ${backfillSummary.specialtiesCreated}`);
    console.log(`      → Vínculos criados:    ${backfillSummary.linksCreated}`);
    console.log(`      → Vínculos existentes: ${backfillSummary.linksAlreadyExisted}`);
  }

  // ── Passo 2: Cobertura ────────────────────────────────────────────
  console.log("\n[2/3] Validando cobertura (profissionais / especialidade / PIN)…");
  const profs = db.prepare(
    `SELECT p.id, p.name, p.active, p.pin_hash,
            (SELECT COUNT(*) FROM clinic_professional_specialties ps
              WHERE ps.organization_id = ? AND ps.professional_id = p.id AND ps.active = 1) AS specialty_count
       FROM clinic_professionals p
      WHERE p.organization_id = ?`
  ).all(flags.orgId, flags.orgId) as any[];
  const active = profs.filter(p => Number(p.active) === 1);
  const withPin = active.filter(p => !!p.pin_hash);
  const withSpecialty = active.filter(p => Number(p.specialty_count) > 0);
  const missingPin = active.filter(p => !p.pin_hash);
  const missingSpecialty = active.filter(p => Number(p.specialty_count) === 0);

  console.log(`      Profissionais ativos:            ${active.length}`);
  console.log(`      Com PIN configurado:             ${withPin.length}`);
  console.log(`      Com pelo menos 1 especialidade:  ${withSpecialty.length}`);

  const warnings: string[] = [];
  const blockers: string[] = [];

  if (missingPin.length > 0) {
    blockers.push(
      `${missingPin.length} profissional(is) ativo(s) sem PIN — alta/reopen (F39) NÃO funciona sem PIN.\n` +
      `      Use: POST /api/clinic/professionals/:id/pin  {"pin":"1234"}\n` +
      `      Faltando: ${missingPin.map(p => `${p.name} (${p.id})`).join(", ")}`
    );
  }
  if (missingSpecialty.length > 0) {
    warnings.push(
      `${missingSpecialty.length} profissional(is) sem especialidade vinculada — continuam atendendo,\n` +
      `      mas não entram na Jornada até ter vínculo.\n` +
      `      Faltando: ${missingSpecialty.map(p => `${p.name} (${p.id})`).join(", ")}`
    );
  }

  // ── Passo 3: cycle_requires_guide opt-in ─────────────────────────
  console.log("\n[3/3] Opt-in de RN-005 §8 (clinic_cycle_requires_guide)…");
  const current = db.prepare(
    `SELECT clinic_cycle_requires_guide FROM organization_settings WHERE organization_id = ?`
  ).get(flags.orgId) as any;
  const currentValue = Number(current?.clinic_cycle_requires_guide ?? 0);
  console.log(`      Estado atual: ${currentValue === 1 ? "ATIVO" : "inativo"}`);

  if (flags.cycleRequiresGuide) {
    if (currentValue === 1) {
      console.log("      → já estava ativo, nada a fazer (idempotente).");
    } else if (flags.dryRun) {
      console.log("      [dry-run] setaria clinic_cycle_requires_guide=1.");
    } else {
      db.prepare(
        `UPDATE organization_settings SET clinic_cycle_requires_guide = 1 WHERE organization_id = ?`
      ).run(flags.orgId);
      console.log("      → Ativado. Ciclos novos nascerão 'pending_authorization' até ter guia issued.");
    }
  } else if (currentValue === 1) {
    console.log("      → mantido ativo (script não desativa por segurança — use SQL manual).");
  } else {
    console.log("      → mantido inativo. Passe --cycle-requires-guide pra ativar.");
  }

  // ── Relatório final ──────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log("RELATÓRIO FINAL");
  console.log("=".repeat(70));

  if (warnings.length > 0) {
    console.log("\nAVISOS (não bloqueiam go-live):");
    for (const w of warnings) console.log(`  ⚠  ${w}`);
  }
  if (blockers.length > 0) {
    console.log("\nBLOQUEADORES (resolver antes de habilitar pra usuário):");
    for (const b of blockers) console.log(`  ✗  ${b}`);
    console.log("\nStatus: NÃO PRONTO. Resolva os bloqueadores acima e rode novamente.");
    process.exit(1);
  }

  console.log("\nStatus: PRONTO pra Jornada de Tratamento.");
  console.log("Próximos passos (op):");
  console.log("  1. Confirmar com a clínica quais especialidades ficam VISÍVEIS (checar aba");
  console.log("     Especialidades no ClinicAgendaView — F51).");
  console.log("  2. Abrir 1 episódio de teste + 1 ciclo + 1 sessão em grupo (smoke visual).");
  console.log("  3. Emitir 1 guia TISS de teste (se o cliente usa convênio).");
  console.log("  4. Se convênio: rodar novamente com --cycle-requires-guide.");
  console.log("");
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
