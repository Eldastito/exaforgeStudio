/**
 * TESTE — métrica executiva `sla_compliance` (CEO Operating Layer).
 * ----------------------------------------------------------------------------
 * Gap: o registro `BusinessGoalService.METRICS` do pilar OPERAÇÕES não tinha a
 * métrica de SLA de atendimento, apesar de a fonte (`TicketSlaService`) existir.
 * Esta fatia adiciona `sla_compliance` (percent, operations, betterDirection up)
 * DERIVADA das colunas persistidas do SLA — read-only (o `evaluateOrg`, que tem
 * efeito colateral, NUNCA é chamado na leitura).
 *
 * Prova:
 *  - registrada no pilar operations, unit percent, betterDirection up;
 *  - compliance = (avaliados − estourados)/avaliados; null sem avaliados;
 *  - availability honesta: available só com tickets avaliados; SLA off → unavailable;
 *  - `measure` devolve value=null/basis=unknown quando indisponível (não inventa 100%);
 *  - `compliance()` é READ-ONLY (não altera tickets, não notifica); isolamento por org.
 *
 * Uso:  npm run test:business-goal-sla
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sla-metric-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-sla-metric-1";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessGoalService: BG } = await import("../src/server/BusinessGoalService.js");
  const { TicketSlaService } = await import("../src/server/TicketSlaService.js");

  const mkOrg = (id: string, slaOn: boolean) => db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, sla_monitor_enabled) VALUES (?, ?, 'T', 'active', ?)`).run(randomUUID(), id, slaOn ? 1 : 0);
  // ticket com SLA já avaliado (sla_due_at setado) + flag de estouro.
  const mkTicket = (org: string, breached: 0 | 1, evaluated = true) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, sla_due_at, sla_breached) VALUES (?, ?, 'c1', 'open', ?, ?)`)
      .run(id, org, evaluated ? "2026-09-10 12:00:00" : null, breached);
    return id;
  };

  // ── 1. registro executivo ──
  check("1.1 sla_compliance é métrica conhecida", BG.isKnownMetric("sla_compliance"));
  const d = BG.describe("sla_compliance");
  check("1.2 pilar operations, unit percent, betterDirection up", d?.pillar === "operations" && d?.unit === "percent" && d?.betterDirection === "up");
  check("1.3 aparece no metricsByPillar.operations", BG.metricsByPillar().operations.some((m) => m.metricKey === "sla_compliance"));

  // ── 2. org com SLA ligado + tickets avaliados (4 avaliados, 1 estourado = 75%) ──
  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A, true);
  mkTicket(A, 0); mkTicket(A, 0); mkTicket(A, 0); mkTicket(A, 1);
  const comp = TicketSlaService.compliance(A);
  check("2.1 compliance: 4 avaliados, 1 estourado", comp.evaluated === 4 && comp.breached === 1);
  check("2.2 compliancePct = 75", comp.compliancePct === 75);
  check("2.3 availability available (há avaliados)", BG.availability(A, "sla_compliance") === "available");
  check("2.4 currentValue = 75", BG.currentValue(A, "sla_compliance") === 75);
  const meas = BG.measure(A, "sla_compliance");
  check("2.5 measure: value=75, basis derived", meas?.value === 75 && meas?.basis === "derived");

  // ── 3. read-only: compliance() não muda tickets nem cria efeito ──
  const before = (db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(sla_breached),0) b FROM tickets WHERE organization_id = ?`).get(A) as any);
  TicketSlaService.compliance(A); TicketSlaService.compliance(A);
  const after = (db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(sla_breached),0) b FROM tickets WHERE organization_id = ?`).get(A) as any);
  check("3.1 compliance() é read-only (tickets inalterados)", before.n === after.n && before.b === after.b);

  // ── 4. SLA ligado mas SEM tickets avaliados → unavailable + null (não inventa 100%) ──
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B, true);
  check("4.1 sem avaliados → compliancePct null", TicketSlaService.compliance(B).compliancePct === null);
  check("4.2 sem avaliados → availability unavailable", BG.availability(B, "sla_compliance") === "unavailable");
  const measB = BG.measure(B, "sla_compliance");
  check("4.3 measure: value null + basis unknown (não inventa)", measB?.value === null && measB?.basis === "unknown");

  // ── 5. SLA DESLIGADO → unavailable + tudo zero/null (0-regressão) ──
  const C = `org_C_${randomUUID().slice(0, 6)}`; mkOrg(C, false);
  mkTicket(C, 1); // mesmo com ticket avaliado, SLA off ignora
  check("5.1 SLA off → evaluated 0 + null", TicketSlaService.compliance(C).evaluated === 0 && TicketSlaService.compliance(C).compliancePct === null);
  check("5.2 SLA off → availability unavailable", BG.availability(C, "sla_compliance") === "unavailable");

  // ── 6. isolamento ──
  check("6.1 org A não contamina B", TicketSlaService.compliance(A).evaluated === 4 && TicketSlaService.compliance(B).evaluated === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} business-goal-sla: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
