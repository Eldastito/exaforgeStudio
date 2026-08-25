/**
 * TEST — Business Vision (ADR-190 F3, CEO Operating Layer). A visão é INTENÇÃO HUMANA (§12): o
 * serviço só grava o que o dono escreveu (nunca inventa); patch parcial; sem dado → null + defined:false.
 * Persistência mínima em organization_settings (D6, sem tabela nova). Isolado por org.
 *
 * Uso: npm run test:executive-vision
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-evis-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-evis-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ExecutiveVisionService: V } = await import("../src/server/ExecutiveVisionService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Clínica', 'active')`).run(randomUUID(), A);

  // ── 1. Sem visão → tudo null + defined:false (honesto) ──
  const v0 = V.get(A);
  check("1.1 sem visão: campos null + defined false", v0.statement === null && v0.horizon === null && v0.strategicPriority === null && v0.defined === false);

  // ── 2. Dono declara a visão (intenção humana) ──
  const v1 = V.save(A, { statement: "Ser a principal clínica veterinária premium da região", horizon: "36 meses", strategicPriority: "crescimento sustentável" }, "u1");
  check("2.1 visão gravada + defined true", v1.statement?.includes("premium") === true && v1.horizon === "36 meses" && v1.strategicPriority === "crescimento sustentável" && v1.defined === true);
  check("2.2 registra quem definiu + quando", v1.updatedBy === "u1" && !!v1.updatedAt);

  // ── 3. Patch PARCIAL: só o campo passado muda; ausente NÃO é tocado ──
  const v2 = V.save(A, { strategicPriority: "eficiência operacional" }, "u2");
  check("3.1 patch parcial (prioridade mudou, statement/horizon intactos)", v2.strategicPriority === "eficiência operacional" && v2.statement?.includes("premium") === true && v2.horizon === "36 meses" && v2.updatedBy === "u2");

  // ── 4. String vazia LIMPA o campo (dono removeu) ──
  const v3 = V.save(A, { horizon: "" }, "u1");
  check("4.1 string vazia limpa (horizon null)", v3.horizon === null && v3.statement !== null);

  // ── 5. Persistiu em organization_settings (D6 — sem tabela nova) ──
  const row = db.prepare(`SELECT vision_statement s, strategic_priority p FROM organization_settings WHERE organization_id=?`).get(A) as any;
  check("5.1 persistido nas colunas de organization_settings", row.s?.includes("premium") === true && row.p === "eficiência operacional");

  // ── 6. Isolamento ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(randomUUID(), B);
  check("6.1 isolamento (B sem visão)", V.get(B).defined === false && V.get(A).defined === true);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} executive-vision: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
