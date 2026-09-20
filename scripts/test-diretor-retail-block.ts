/**
 * TESTE — Bloco "Varejo — vendas por loja" no panorama do Diretor IA (20/09/2026).
 * -----------------------------------------------------------------------------
 * Incidente TOULON: "Zapp, como foram as vendas da Avenida Brasil?" não era
 * respondível — nenhum caminho da IA (Diretor/pergunta_negocio nem o raio-x do
 * orquestrador) recebia venda POR LOJA, e o modelo "prometia verificar com a
 * equipe". O bloco novo DERIVA dos fechamentos reais (retail_daily_closings).
 *
 * Prova, offline:
 *  - bloco lista cada loja ativa com acumulado do mês + último fechamento;
 *  - fechamento REJEITADO nunca soma; loja sem fechamento aparece honesta
 *    ("sem fechamento no mês"), nunca vira 0 inventado;
 *  - dinheiro é role-gated: canSeeMoney:false → bloco NÃO entra no panorama;
 *  - org sem loja ativa → bloco vazio (0-regressão pra org sem varejo);
 *  - fiação: buildPanorama (com dinheiro) carrega o bloco e o raio-x do
 *    orquestrador referencia o mesmo bloco (fonte única);
 *  - isolamento multi-tenant.
 *
 * Uso: npm run test:diretor-retail-block
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-dirretail-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-dirretail-1234567890";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ExecutiveAdvisorService } = await import("../src/server/ExecutiveAdvisorService.js");

  const mkOrg = (tag: string) => {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), orgId, `Rede ${tag}`);
    return orgId;
  };
  const mkStore = (org: string, name: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active) VALUES (?, ?, ?, 1)`).run(id, org, name);
    return id;
  };
  const month = new Date().toISOString().slice(0, 7);
  const d = (day: string) => `${month}-${day}`;
  const mkClosing = (org: string, storeId: string, date: string, total: number, status = "reconciled") => {
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), org, storeId, date, status, total);
  };

  const A = mkOrg("A");
  const avBrasil = mkStore(A, "Avenida Brasil");
  const centro = mkStore(A, "Centro");
  mkStore(A, "Sem Fechamento");
  mkClosing(A, avBrasil, d("01"), 5000);
  mkClosing(A, avBrasil, d("02"), 3000);
  mkClosing(A, avBrasil, d("03"), 9999, "rejected"); // nunca soma
  mkClosing(A, centro, d("02"), 1200.5);

  // ── 1) Conteúdo do bloco. ──
  const b = ExecutiveAdvisorService.retailStoresBlock(A);
  check("1.1 bloco presente com o cabeçalho de varejo por loja", b.includes("VAREJO — VENDAS POR LOJA"), b.slice(0, 60));
  check("1.2 Avenida Brasil com acumulado certo (rejeitado não soma)", b.includes("Avenida Brasil: R$ 8000.00 no mês (2 fechamento(s))"), b);
  check("1.3 último fechamento da Avenida Brasil é o dia 02 (03 foi rejeitado)", b.includes(`último fechamento ${d("02")}: R$ 3000.00`), "");
  check("1.4 Centro com o próprio número", b.includes("Centro: R$ 1200.50 no mês (1 fechamento(s))"), "");
  check("1.5 loja sem fechamento aparece honesta (nunca 0 inventado)", b.includes("Sem Fechamento: sem fechamento no mês"), "");
  check("1.6 total da rede soma só o válido", b.includes("Total da rede no mês: R$ 9200.50"), "");

  // ── 2) Gate de dinheiro + inércia. ──
  const pMoney = ExecutiveAdvisorService.buildPanorama(A, { canSeeMoney: true });
  const pNoMoney = ExecutiveAdvisorService.buildPanorama(A, { canSeeMoney: false });
  check("2.1 panorama COM dinheiro carrega o bloco", pMoney.includes("VAREJO — VENDAS POR LOJA"));
  check("2.2 sem permissão de dinheiro o bloco NÃO entra (§73)", !pNoMoney.includes("VAREJO — VENDAS POR LOJA"));
  check("2.3 org sem loja ativa → bloco vazio (0-regressão)", ExecutiveAdvisorService.retailStoresBlock(mkOrg("Z")) === "");

  // ── 3) Fiação: o raio-x do orquestrador usa o MESMO bloco (fonte única). ──
  const orcSrc = fs.readFileSync(path.join(process.cwd(), "src/server/AIOrchestratorService.ts"), "utf8");
  check("3.1 raio-x do orquestrador referencia retailStoresBlock", orcSrc.includes("retailStoresBlock("));

  // ── 4) Isolamento multi-tenant. ──
  const B = mkOrg("B");
  mkStore(B, "Loja B1");
  check("4.1 bloco de B não vê as lojas de A", !ExecutiveAdvisorService.retailStoresBlock(B).includes("Avenida Brasil"));

  console.log("\n=== TEST: Diretor IA — vendas por loja no panorama ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
