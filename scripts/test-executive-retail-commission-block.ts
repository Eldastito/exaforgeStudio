/**
 * TESTE — "VENDAS POR VENDEDOR" no panorama do Diretor Executivo IA.
 * ---------------------------------------------------------------------------
 * O dono perguntou se dava pra saber quanto um vendedor vendeu pelo WhatsApp,
 * conversando com a IA. A resposta: sim — o WhatsApp do gestor (Controller,
 * `wa_gestor_enabled`) agora roteia pergunta livre de negócio pro Diretor
 * Executivo IA (`ExecutiveAdvisorService.ask`), e o Diretor ganhou este bloco
 * com as vendas reais por vendedor/loja do mês corrente (fusão de ZappFlow +
 * manual/foto + ERP + PDV, via `RetailCommissionService.salesBySellerStore`).
 *
 * Este teste prova o bloco em si (`retailCommissionBlock`/`buildPanorama`) —
 * síncronos e sem LLM — não a resposta gerada (`ask()` chama `chat()`, que
 * exige OPENAI_API_KEY; fora do escopo deste teste offline).
 *
 * Uso:  npm run test:executive-retail-commission-block
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-exec-retail-block-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-exec-retail-block-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { ExecutiveAdvisorService } = await import("../src/server/ExecutiveAdvisorService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);

  // Sem o módulo 'retail' ligado: o bloco fica de fora (nem consulta o banco).
  check("módulo retail desligado: bloco vazio", ExecutiveAdvisorService.retailCommissionBlock(A) === "");

  db.prepare("UPDATE organization_settings SET enabled_modules = ? WHERE organization_id = ?").run(JSON.stringify(["retail"]), A);
  check("módulo retail ligado, sem vendas: bloco ainda vazio", ExecutiveAdvisorService.retailCommissionBlock(A) === "");

  const loja = RetailStoreService.create(A, { name: "Loja Centro", code: "1" });
  const hoje = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor, usuario, vendedor_codigo, valor, pecas, status)
    VALUES (?, ?, '1', 'b1', ?, 'OP1', 'M1', 'M1', ?, ?, 'N')`).run(randomUUID(), A, hoje, 850.5, 6);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'M1', 'Marcos')`).run(randomUUID(), A);

  const block = ExecutiveAdvisorService.retailCommissionBlock(A);
  check("bloco tem o cabeçalho 'VENDAS POR VENDEDOR'", block.includes("VENDAS POR VENDEDOR"), block.slice(0, 200));
  check("bloco cita o vendedor (Marcos) e a loja (Loja Centro)", block.includes("Marcos") && block.includes("Loja Centro"), block);
  check("bloco cita o valor vendido (850.50)", block.includes("850.50"), block);
  check("bloco entra no panorama completo do Diretor", ExecutiveAdvisorService.buildPanorama(A).includes("VENDAS POR VENDEDOR"));

  // Vendedor sem nenhuma venda no mês NÃO aparece — o guardrail do prompt avisa
  // pra IA nunca inventar valor de quem não está na lista.
  check("bloco instrui a IA a não inventar vendedor fora da lista", /NUNCA invente/i.test(block));

  // ── Isolamento ─────────────────────────────────────────────────────────────
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  db.prepare("UPDATE organization_settings SET enabled_modules = ? WHERE organization_id = ?").run(JSON.stringify(["retail"]), B);
  check("isolamento: org B (sem vendas) não vê Marcos", ExecutiveAdvisorService.retailCommissionBlock(B) === "");

  console.log("\n=== Diretor IA — bloco 'Vendas por vendedor' (WhatsApp) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
