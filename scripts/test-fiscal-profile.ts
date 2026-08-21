/**
 * TEST — Perfil Fiscal da org (ADR-181 F1). DB-backed, determinístico, isolado.
 * Prova: nada presumido (regime null sem declarar); save só grava o patch; regime inválido
 * lança; híbrido só liga no Simples; completeness deriva o que falta (RN-FISCAL-4); reflete
 * comigo_cnpj/address_state; isolamento por org.
 *
 * Uso: npm run test:fiscal-profile
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fiscalprof-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-fiscalprof-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FiscalProfileService: FP } = await import("../src/server/FiscalProfileService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, address_state) VALUES (?, ?, 'Loja A', 'active', 'moda', 'RS')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja B', 'active', 'petshop')`).run(randomUUID(), B);

  // 0. Nada presumido: perfil recém-criado tem regime null e híbrido OFF (RN-FISCAL-4/9).
  const p0 = FP.get(A);
  check("0.1 regime não declarado → null (nunca presume MEI/Simples)", p0.regime === null);
  check("0.2 regimeRegularOptin default OFF (Simples default DAS)", p0.regimeRegularOptin === false);
  check("0.3 uf reflete address_state", p0.uf === "RS");
  check("0.4 cnpj null quando não há comigo_cnpj", p0.cnpj === null);

  // 0b. Org inexistente → erro honesto.
  let eOrg = false; try { FP.get("org_inexistente"); } catch (e: any) { eOrg = e.message === "organization_not_found"; }
  check("0.5 org inexistente lança", eOrg);

  // 1. completeness lista o que falta (cnpj, regime, municipalityIbge — uf já tem).
  const c0 = FP.completeness(A);
  check("1.1 incompleto sem cnpj/regime/ibge", c0.complete === false);
  check("1.2 missing traz cnpj+regime+municipalityIbge", c0.missing.includes("cnpj") && c0.missing.includes("regime") && c0.missing.includes("municipalityIbge"));
  check("1.3 uf presente não entra em missing", !c0.missing.includes("uf"));
  check("1.4 regimeIsSimples false sem regime", c0.regimeIsSimples === false);

  // 2. save grava só o patch (regime + município), não zera o resto.
  const p1 = FP.save(A, { regime: "simples", municipalityIbge: "4314902", municipalityName: "Porto Alegre" }, "userA");
  check("2.1 regime salvo", p1.regime === "simples");
  check("2.2 código IBGE só dígitos (7)", p1.municipalityIbge === "4314902");
  check("2.3 município salvo", p1.municipalityName === "Porto Alegre");
  check("2.4 híbrido segue OFF (não pedimos)", p1.regimeRegularOptin === false);

  // 3. Regime inválido lança (não silencia).
  let eReg = false; try { FP.save(A, { regime: "lucro_arbitrado" }); } catch (e: any) { eReg = e.message === "fiscal_regime_invalid"; }
  check("3.1 regime inválido lança", eReg);

  // 4. Híbrido só liga no Simples (RN-FISCAL-9).
  const p2 = FP.save(A, { regimeRegularOptin: true }, "userA"); // regime atual = simples
  check("4.1 híbrido liga no Simples", p2.regimeRegularOptin === true);
  const p3 = FP.save(A, { regime: "presumido", regimeRegularOptin: true }, "userA"); // fora do Simples
  check("4.2 fora do Simples força híbrido OFF", p3.regime === "presumido" && p3.regimeRegularOptin === false);

  // 4b. simples_hibrido também aceita o opt-in.
  const p4 = FP.save(A, { regime: "simples_hibrido", regimeRegularOptin: true }, "userA");
  check("4.3 simples_hibrido aceita opt-in", p4.regimeRegularOptin === true);
  check("4.4 completeness marca regimeIsSimples", FP.completeness(A).regimeIsSimples === true);

  // 5. CNPJ reflete comigo_cnpj (fonte única) — completeness fecha quando tudo presente.
  db.prepare(`UPDATE organization_settings SET comigo_cnpj = '12345678000199' WHERE organization_id = ?`).run(A);
  const c1 = FP.completeness(A);
  check("5.1 cnpj reflete comigo_cnpj", FP.get(A).cnpj === "12345678000199");
  check("5.2 completeness completo com cnpj+regime+ibge+uf", c1.complete === true && c1.missing.length === 0);

  // 6. Isolamento: mexer em A não toca B.
  const pB = FP.get(B);
  check("6.1 B intacto (regime null, sem uf)", pB.regime === null && pB.uf === null);
  FP.save(B, { regime: "mei" }, "userB");
  check("6.2 B salva sozinho, A não muda", FP.get(B).regime === "mei" && FP.get(A).regime === "simples_hibrido");

  // 7. Audit: FISCAL_PROFILE_UPDATE registrado.
  const audit = db.prepare(`SELECT COUNT(*) n FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'FISCAL_PROFILE_UPDATE'`).get(A) as any;
  check("7.1 audit FISCAL_PROFILE_UPDATE gravado", Number(audit?.n) >= 1);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} fiscal-profile: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
