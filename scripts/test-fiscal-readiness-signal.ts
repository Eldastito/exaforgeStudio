/**
 * TEST — Sinal proativo de prontidão fiscal (ADR-187 F2). DB-backed, determinístico.
 * Prova: publica business_signal (fiscal_readiness/incomplete) quando o tenant tem blocker de
 * IDENTIDADE; hipótese + impactAmount null; nunca decision_action; self-healing (resolve ao
 * completar / reabre ao recorrer); dedupe; pass() só orgs formalizadas (com CNPJ); não sinaliza
 * pendência de plataforma/Senado; isolamento.
 *
 * Uso: npm run test:fiscal-readiness-signal
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-frsig-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-frsig-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FiscalReadinessService: FR } = await import("../src/server/FiscalReadinessService.js");
  const { FiscalProfileService } = await import("../src/server/FiscalProfileService.js");

  const sig = (org: string) => db.prepare(`SELECT status FROM business_signals WHERE organization_id=? AND domain='fiscal_readiness' AND dedupe_key='fiscal_readiness:incomplete'`).get(org) as any;

  // A: formalizada (CNPJ) mas perfil incompleto (falta regime + ibge) → publica.
  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, comigo_cnpj, address_state) VALUES (?, ?, 'O', 'active', '12345678000199', 'SP')`).run(randomUUID(), A);
  const r1 = FR.publishReadinessSignal(A);
  check("1.1 publicou o sinal (blocker de identidade)", r1.published === true);
  const row = db.prepare(`SELECT basis, impact_amount, severity FROM business_signals WHERE organization_id=? AND dedupe_key='fiscal_readiness:incomplete'`).get(A) as any;
  check("1.2 hypothesis + impact null (não inventa)", row.basis === "hypothesis" && row.impact_amount == null);
  check("1.3 severity attention", row.severity === "attention");

  // 2. Nunca cria decision_action.
  check("2.1 zero decision_action", (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=?`).get(A) as any).n === 0);

  // 3. Dedupe.
  FR.publishReadinessSignal(A);
  check("3.1 dedupe (1 linha)", (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id=? AND dedupe_key='fiscal_readiness:incomplete'`).get(A) as any).n === 1);

  // 4. Self-healing: completa o perfil → sem blocker → resolve.
  FiscalProfileService.save(A, { regime: "presumido", municipalityIbge: "3550308" });
  const r4 = FR.publishReadinessSignal(A);
  check("4.1 completou → resolved", r4.published === false && sig(A)?.status === "resolved");

  // 5. Recorre: apaga o regime → volta o blocker → reabre.
  db.prepare(`UPDATE organization_settings SET fiscal_regime = NULL WHERE organization_id = ?`).run(A);
  const r5 = FR.publishReadinessSignal(A);
  check("5.1 recorre → republica/reabre", r5.published === true && sig(A)?.status !== "resolved");

  // 6. Org SEM CNPJ (não formalizada) → pass() não sinaliza (Reforma não acionável ainda).
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, address_state) VALUES (?, ?, 'O', 'active', 'RJ')`).run(randomUUID(), B);
  FR.pass();
  check("6.1 sem CNPJ → pass não sinaliza", !sig(B));

  // 7. Org completa → nunca sinaliza.
  const C = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, comigo_cnpj, fiscal_regime, fiscal_municipality_ibge, address_state) VALUES (?, ?, 'O', 'active', '99999999000199', 'presumido', '3304557', 'RJ')`).run(randomUUID(), C);
  const rC = FR.publishReadinessSignal(C);
  check("7.1 completa → não publica", rC.published === false && !sig(C));

  // 8. Isolamento: sinal de A não aparece em B/C.
  check("8.1 isolado (A tem, B/C não)", !!sig(A) && !sig(B) && !sig(C));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} fiscal-readiness-signal: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
