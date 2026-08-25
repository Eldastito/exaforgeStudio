/**
 * TEST — Visão Executiva no panorama do Diretor (ADR-190 F8 / D7). O briefing/ask
 * do Diretor passa a CONSUMIR o Executive Snapshot (F4) + restrição (F5) como TEXTO
 * DETERMINÍSTICO: a IA narra pilares/desvios/constraint, mas os NÚMEROS já vêm
 * derivados (RN-CEO-04 — IA nunca calcula KPI). Testa o construtor de texto
 * (executiveBlock), sem LLM (roda em CI sem chave de IA).
 *
 * Uso: npm run test:executive-briefing-block
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ebrief-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ebrief-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ExecutiveAdvisorService: A } = await import("../src/server/ExecutiveAdvisorService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const { BusinessGoalService } = await import("../src/server/BusinessGoalService.js");
  const { ExecutiveVisionService } = await import("../src/server/ExecutiveVisionService.js");

  const O = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Clínica', 'active')`).run(randomUUID(), O);

  // ── 1. Org vazia: bloco traz os 3 pilares, sem inventar restrição ──
  const b0 = A.executiveBlock(O);
  check("1.1 cabeçalho VISÃO EXECUTIVA presente", b0.includes("VISÃO EXECUTIVA"));
  check("1.2 os 3 pilares nomeados", b0.includes("Comercial") && b0.includes("Operações") && b0.includes("Financeiro"));
  check("1.3 sem restrição sem desvio (não inventa)", !b0.includes("RESTRIÇÃO nº1"));
  check("1.4 revenue disponível aparece como fato (R$)", /Receita do mês R\$/.test(b0));

  // ── 2. Desvio financeiro crítico + meta ameaçada → pior pilar + restrição (hipótese) ──
  BusinessSignalService.publish(O, {
    domain: "finance", signalType: "overdue_spike", severity: "critical", basis: "fact", confidence: 1,
    impactAmount: 5000, impactUnit: "BRL", sourceService: "test", evidence: { n: 4 }, dedupeKey: "fin-crit-1",
  });
  const b1 = A.executiveBlock(O);
  check("2.1 pilar financeiro marcado CRÍTICO", /Financeiro: saúde CRÍTICO/.test(b1));
  check("2.2 pior pilar = Financeiro", /PIOR forma: Financeiro/.test(b1));
  check("2.3 restrição nº1 presente + rotulada HIPÓTESE", b1.includes("RESTRIÇÃO nº1") && b1.includes("HIPÓTESE"));

  // ── 3. Visão declarada aparece no bloco ──
  ExecutiveVisionService.save(O, { statement: "Ser a clínica premium da região" }, "u1");
  const b2 = A.executiveBlock(O);
  check("3.1 visão declarada no bloco", b2.includes("Visão declarada") && b2.includes("premium"));

  // ── 4. Bloco entra no panorama do Diretor (buildPanorama) ──
  const pano = A.buildPanorama(O);
  check("4.1 buildPanorama inclui a Visão Executiva", pano.includes("VISÃO EXECUTIVA"));

  // ── 5. Isolamento: outra org não vê o desvio ──
  const P = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(randomUUID(), P);
  const bp = A.executiveBlock(P);
  check("5.1 org P sem restrição (isolada)", !bp.includes("RESTRIÇÃO nº1"));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} executive-briefing-block: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
