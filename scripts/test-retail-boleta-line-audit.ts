/**
 * TESTE — RetailBoletaService.lineAudit: regra "5 produtos por boleta" conferida
 * pelos itens REAIS do PDV (retail_pdv_sale_items).
 *
 * Regra da loja: cada boleta tem no máximo 5 LINHAS; cada linha é um produto
 * DISTINTO (código de barras). Várias unidades do MESMO código = 1 linha. O
 * "virtual" tem que encaixar no talão real (5 linhas). Prova:
 *   - conta produtos DISTINTOS por boleta (mesmo código repetido = 1);
 *   - sinaliza boleta que passou de 5 produtos distintos;
 *   - sem PDV sincronizado → hasPdv=false;
 *   - isolamento multi-tenant (filial da org A não vaza pra B).
 *
 * Uso:  npm run test:retail-boleta-line-audit
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-boleta-audit-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-boleta-audit-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailBoletaService } = await import("../src/server/RetailBoletaService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  const lojaA = RetailStoreService.create(A, { name: "Toulon Centro", code: "7" });
  const lojaB = RetailStoreService.create(B, { name: "Outra", code: "7" }); // MESMO code, org diferente
  const DAY = "2026-08-20";

  const insItem = db.prepare(
    `INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, produto, quantidade, valor, vendedor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const addLine = (org: string, filial: string, boleta: string, seq: number, produto: string, qtd = 1) =>
    insItem.run(randomUUID(), org, filial, boleta, DAY, seq, produto, qtd, 100, "V1");

  // ── Sem PDV: nada a auditar ────────────────────────────────────────────────
  const semPdv = RetailBoletaService.lineAudit(A, lojaA.id, DAY);
  check("Sem PDV sincronizado → hasPdv=false", semPdv.hasPdv === false && semPdv.totalBoletas === 0);

  // ── Boleta 001: 3 produtos distintos (um deles com 5 unidades = 1 linha) ────
  addLine(A, "7", "001", 1, "CAMISA-PRETA-G", 5); // 5 unidades, MESMO código = 1 linha
  addLine(A, "7", "001", 2, "CAMISA-VERDE-G", 1);
  addLine(A, "7", "001", 3, "CALCA-JEANS-42", 1);

  // ── Boleta 002: 5 produtos distintos (no limite) ───────────────────────────
  for (let i = 1; i <= 5; i++) addLine(A, "7", "002", i, `PROD-00${i}`, 1);

  // ── Boleta 003: 6 produtos distintos (ESTOUROU a regra) ────────────────────
  for (let i = 1; i <= 6; i++) addLine(A, "7", "003", i, `ITEM-X${i}`, 1);

  // ── Boleta 004: mesmo código repetido em 3 linhas → 1 produto distinto ──────
  addLine(A, "7", "004", 1, "MEIA-BRANCA", 1);
  addLine(A, "7", "004", 2, "MEIA-BRANCA", 1);
  addLine(A, "7", "004", 3, "MEIA-BRANCA", 1);

  const audit = RetailBoletaService.lineAudit(A, lojaA.id, DAY);
  check("hasPdv=true quando há itens", audit.hasPdv === true);
  check("totalBoletas = 4", audit.totalBoletas === 4, `got ${audit.totalBoletas}`);

  const byNum = new Map(audit.boletas.map((b) => [b.boleta, b]));
  check("Boleta 001 → 3 produtos distintos (5 iguais = 1 linha)", byNum.get("001")?.produtos === 3, `got ${byNum.get("001")?.produtos}`);
  check("Boleta 001 → 3 itens (linhas)", byNum.get("001")?.itens === 3, `got ${byNum.get("001")?.itens}`);
  check("Boleta 002 → 5 produtos (no limite, OK)", byNum.get("002")?.produtos === 5);
  check("Boleta 003 → 6 produtos (estourou)", byNum.get("003")?.produtos === 6);
  check("Boleta 004 → 1 produto distinto (3 linhas do mesmo código)", byNum.get("004")?.produtos === 1, `got ${byNum.get("004")?.produtos}`);

  check("overLimit tem só a boleta 003", audit.overLimit.length === 1 && audit.overLimit[0].boleta === "003" && audit.overLimit[0].produtos === 6, JSON.stringify(audit.overLimit));

  // ── Limite customizado ─────────────────────────────────────────────────────
  const audit3 = RetailBoletaService.lineAudit(A, lojaA.id, DAY, 3);
  check("maxLinhas=3 → 002(5) e 003(6) estouram", audit3.overLimit.map((b) => b.boleta).sort().join(",") === "002,003", JSON.stringify(audit3.overLimit));

  // ── Isolamento: org B (mesmo code '7') não vê os itens da org A ─────────────
  const auditB = RetailBoletaService.lineAudit(B, lojaB.id, DAY);
  check("Isolamento: org B não enxerga boletas da org A", auditB.hasPdv === false && auditB.totalBoletas === 0);

  console.log("\n=== TEST: RetailBoletaService.lineAudit (5 produtos/boleta pelo PDV) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
