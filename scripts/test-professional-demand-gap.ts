/**
 * TEST — Sinal proativo de gap de demanda (ADR-180 F9.2). DB-backed, det., isolado.
 * Prova: pressão ALTA → publica `professional_network/demand_gap` no `business_signals`
 * (idempotente por serviço, sem inventar dinheiro); quando o gap fecha → RESOLVE
 * (self-healing); pass só toca org com a rede habilitada; isolado por org.
 *
 * Uso: npm run test:professional-demand-gap
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-demandgap-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-demandgap-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PRO } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService: REL } = await import("../src/server/ClinicProfessionalRelationshipService.js");
  const { ProfessionalBookingService: BOOK } = await import("../src/server/ProfessionalBookingService.js");
  const { ProfessionalDemandService: DEM } = await import("../src/server/ProfessionalDemandService.js");
  const { BusinessSignalService: SIG } = await import("../src/server/BusinessSignalService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  // A habilitada; B NÃO (pra provar o gate do pass).
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'A', 'active', 'petshop', 1)`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'B', 'active', 'petshop', 0)`).run(randomUUID(), B);
  const svc = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'service', 'Cardiologia')`).run(svc, A);
  const pid = PRO.upsertIdentity({ name: "Dra. Cardio", council: "CRMV-SP", registrationNumber: "12345" }, A).id;
  const rel = REL.invite(A, { professionalId: pid, permissions: { services: [svc] } }).id; REL.accept(A, rel);

  const gaps = () => SIG.list(A, { status: "open" }).filter((s: any) => s.signal_type === "professional_network/demand_gap");

  // 0. Sem demanda → nada publicado.
  DEM.publishGaps(A);
  check("0.1 sem demanda → nenhum sinal", gaps().length === 0);

  // 1. 3 waitlist de cardio → pressão alta → publica 1 sinal.
  for (let i = 0; i < 3; i++) BOOK.waitlist(A, { relationshipId: rel, serviceId: svc, contactId: `c${i}` });
  const r1 = DEM.publishGaps(A);
  check("1.1 publica 1 gap", r1.published === 1 && gaps().length === 1);
  const g = gaps()[0];
  check("1.2 sinal é do serviço certo, sem inventar dinheiro", g.source_entity_id === svc && (g.impact_amount === null || g.impact_amount === 0));
  check("1.3 evidence traz sugestão", /considere/i.test(JSON.parse(g.evidence_json || "{}").suggestion || ""));

  // 2. Idempotente: rodar de novo não duplica (dedupe por serviço).
  DEM.publishGaps(A);
  check("2.1 idempotente (1 sinal aberto)", gaps().length === 1);

  // 3. Fecha o gap: atende muito (met alto) → pressão cai → self-heal resolve.
  for (let i = 0; i < 10; i++) db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, scheduled_start, status, network_relationship_id, network_service_id) VALUES (?, ?, 'c0', 'Atd', ?, 'completed', ?, ?)`).run(randomUUID(), A, new Date().toISOString(), rel, svc);
  const r3 = DEM.publishGaps(A);
  check("3.1 gap fechado → resolvido (self-healing)", r3.resolved === 1 && gaps().length === 0);

  // 4. pass() só toca org habilitada. (met=10 do passo 3 → precisa de demanda ≥ 10 p/ alta.)
  for (let i = 0; i < 10; i++) BOOK.waitlist(A, { relationshipId: rel, serviceId: svc, contactId: `d${i}` });
  DEM.pass();
  check("4.1 pass publica na org habilitada", gaps().length >= 1);
  check("4.2 org B (rede off) sem sinal", SIG.list(B, { status: "open" }).filter((s: any) => s.signal_type === "professional_network/demand_gap").length === 0);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-demand-gap: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
