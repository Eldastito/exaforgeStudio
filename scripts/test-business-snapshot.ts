/**
 * TEST — Business Snapshot V2 + Diretor vê finanças (ADR-135, Epic 1).
 * Determinístico, sem chave de IA (buildPanorama não chama o LLM).
 *
 * Uso: npm run test:business-snapshot
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-snapv2-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-snapv2-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FinancialLedgerService: F } = await import("../src/server/FinancialLedgerService.js");
  const { BusinessSnapshotV2Service: V2 } = await import("../src/server/BusinessSnapshotV2Service.js");
  const { ExecutiveAdvisorService: Diretor } = await import("../src/server/ExecutiveAdvisorService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();
  F.recordEvent(orgA, { direction: "in", amount: 5000 });                                  // caixa 5000
  F.addPayable(orgA, { description: "Fornecedor", amount: 2000, dueDate: "2030-12-01" });   // a pagar 2000
  F.addReceivable(orgA, { description: "Cliente atrasado", amount: 700, dueDate: "2020-01-01", probability: 1 }); // vencido 700

  // ===== 1. Snapshot V2: domínio finance reusa os motores determinísticos =====
  const snap = V2.build(orgA);
  const fin = snap?.domains?.finance;
  check("snapshot tem o domínio finance disponível", fin && fin.available === true);
  check("caixa vem do FinancialLedger (5000, basis=fact)", fin.caixa.value === 5000 && fin.caixa.basis === "fact");
  check("a pagar reflete o fato (2000)", fin.aPagar.value === 2000);
  check("a receber destaca o vencido (700 de 700)", fin.aReceber.value === 700 && fin.aReceber.vencido === 700);
  check("previsão de caixa é ESTIMATIVA (não fato)", fin.previsaoCaixa.basis === "estimate");
  check("DRE presente com origem", !!fin.dre && (fin.dre.source === "ManagerialDreService" || fin.dre.available === false));
  check("snapshot traz qualidade dos dados e prioridades", snap.dataQuality !== undefined && Array.isArray(snap.topPriorities));

  // ===== 2. Adapter falha isolado: domínio inválido não derruba o snapshot =====
  const snapEmpty = V2.build(mkOrg());
  check("org vazia ainda gera snapshot (finance available, caixa 0)", snapEmpty.domains.finance.available === true && snapEmpty.domains.finance.caixa.value === 0);

  // ===== 3. Feature-flag: Diretor só vê o V2 quando ligado =====
  const off = Diretor.buildPanorama(orgA);
  check("flag DESLIGADA: panorama do Diretor NÃO tem o bloco V2 (compatível)", !/PANORAMA FINANCEIRO V2/.test(off));
  db.prepare("UPDATE organization_settings SET diretor_snapshot_v2 = 1 WHERE organization_id = ?").run(orgA);
  const on = Diretor.buildPanorama(orgA);
  check("flag LIGADA: panorama do Diretor injeta o bloco V2", /PANORAMA FINANCEIRO V2/.test(on));
  check("flag LIGADA: o Diretor recebe o caixa REAL (5000) no contexto", /5000/.test(on));
  check("instrução anti-invenção presente no bloco V2", /NUNCA invente/i.test(on));

  // ===== 4. Isolamento =====
  const other = mkOrg();
  check("isolamento: outra org tem caixa 0 no snapshot", V2.build(other).domains.finance.caixa.value === 0);

  console.log("\n=== TEST: Business Snapshot V2 — Diretor vê finanças (ADR-135) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Business Snapshot V2 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
