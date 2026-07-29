/**
 * TESTE — Diagnóstico "byFilial" do /pdv-seller-diagnosis (anomalia do
 * vendedor, agora por LOJA).
 * ---------------------------------------------------------------------------
 * Contexto: o dono da Toulon reportou que o extrato por loja/vendedor mostra,
 * numa loja (Nova Iguaçu), um ÚNICO "vendedor" cujo valor bate EXATAMENTE com
 * o total da loja inteira — parecendo que a segmentação não é real ali. A
 * investigação confirmou que o `GROUP BY` da apuração está correto; o
 * problema é que o campo que a Alterdata manda como vendedor (CAI_USUARIO →
 * `vendedor_codigo`) pode não variar por pessoa em algumas lojas (login/
 * terminal compartilhado) — o mesmo tipo de anomalia já visto antes com a
 * `matricula` do operador, agora possivelmente reaparecendo no CAI_USUARIO.
 *
 * Este teste prova a query SQL do `byFilial` (extensão de
 * `GET /pdv-seller-diagnosis`, `src/server/routes/retailops.ts`): ela deve
 * apontar corretamente quantos códigos de vendedor DISTINTOS aparecem em cada
 * loja e marcar `risco: true` quando uma loja com volume razoável de vendas
 * só tem 1 código — o dado concreto que o gestor leva pro suporte da
 * Alterdata pra provar que o campo não está individualizando ali.
 *
 * Uso:  npm run test:pdv-seller-diagnosis-by-filial
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pdv-diag-filial-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-pdv-diag-filial-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

// Mesma query da rota (src/server/routes/retailops.ts, GET /pdv-seller-diagnosis).
function byFilial(db: any, orgId: string) {
  const raw = db.prepare(
    `SELECT s.filial, COALESCE(st.name, 'Filial ' || s.filial) AS loja, COUNT(*) AS vendas,
            COUNT(DISTINCT COALESCE(NULLIF(s.vendedor_codigo, ''), s.vendedor)) AS vendedores_distintos,
            COUNT(DISTINCT NULLIF(s.vendedor_codigo, '')) AS cai_usuario_distintos,
            COUNT(DISTINCT s.vendedor) AS operadores_distintos
       FROM retail_pdv_sales s
       LEFT JOIN retail_stores st ON st.organization_id = s.organization_id AND st.code = s.filial AND st.active = 1
      WHERE s.organization_id = ? AND COALESCE(s.status, 'N') <> 'C'
      GROUP BY s.filial ORDER BY vendas DESC`
  ).all(orgId) as any[];
  return raw.map((r) => ({ ...r, risco: Number(r.vendedores_distintos) <= 1 && Number(r.vendas) > 5 }));
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const nova = RetailStoreService.create(A, { name: "Nova Iguaçu", code: "9" });
  const avBrasil = RetailStoreService.create(A, { name: "Av. Brasil", code: "1" });

  const sale = (filial: string, boleta: string, vendCod: string, date: string, valor: number) =>
    db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor, usuario, vendedor_codigo, valor, status)
      VALUES (?, ?, ?, ?, ?, 'OP1', ?, ?, ?, 'N')`).run(randomUUID(), A, filial, boleta, date, vendCod, vendCod, valor);

  // Nova Iguaçu: 10 vendas, TODAS com o MESMO código de vendedor — a anomalia
  // relatada (um "vendedor" só absorvendo a loja inteira).
  for (let i = 0; i < 10; i++) sale("9", `nova-${i}`, "V-UNICO", "2026-07-05", 100);

  // Av. Brasil: 10 vendas, 3 códigos DIFERENTES — segmentação real por vendedor.
  for (let i = 0; i < 4; i++) sale("1", `av-a-${i}`, "V1", "2026-07-05", 100);
  for (let i = 0; i < 4; i++) sale("1", `av-b-${i}`, "V2", "2026-07-05", 100);
  for (let i = 0; i < 2; i++) sale("1", `av-c-${i}`, "V3", "2026-07-05", 100);

  const rows = byFilial(db, A);
  const rNova = rows.find((r: any) => r.filial === "9");
  const rAv = rows.find((r: any) => r.filial === "1");

  check("Nova Iguaçu: 1 vendedor distinto pra 10 vendas", rNova?.vendedores_distintos === 1 && rNova?.vendas === 10, JSON.stringify(rNova));
  check("Nova Iguaçu: risco = true (poucos códigos, muitas vendas)", rNova?.risco === true, JSON.stringify(rNova));
  check("Av. Brasil: 3 vendedores distintos pra 10 vendas", rAv?.vendedores_distintos === 3 && rAv?.vendas === 10, JSON.stringify(rAv));
  check("Av. Brasil: risco = false (segmentação real)", rAv?.risco === false, JSON.stringify(rAv));
  check("Nomes de loja resolvidos (não 'Filial X')", rNova?.loja === "Nova Iguaçu" && rAv?.loja === "Av. Brasil", JSON.stringify({ rNova, rAv }));

  // Loja pequena (poucas vendas) com 1 vendedor só NÃO é risco — não há dado
  // suficiente pra suspeitar (o limiar de "vendas > 5" existe pra isso).
  const pequena = RetailStoreService.create(A, { name: "Quiosque", code: "5" });
  for (let i = 0; i < 3; i++) sale("5", `q-${i}`, "V-UNICO2", "2026-07-05", 50);
  const rowsPequena = byFilial(db, A);
  const rPequena = rowsPequena.find((r: any) => r.filial === "5");
  check("Loja pequena (3 vendas, 1 vendedor): risco = false (amostra pequena demais)", rPequena?.risco === false, JSON.stringify(rPequena));

  // ── Isolamento ─────────────────────────────────────────────────────────────
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  const rowsB = byFilial(db, B);
  check("Isolamento: org B sem linhas", rowsB.length === 0);

  console.log("\n=== Diagnóstico byFilial — anomalia do vendedor por loja ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
