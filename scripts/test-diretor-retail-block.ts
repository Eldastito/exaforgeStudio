/**
 * TESTE — Bloco "Varejo — vendas por loja" no panorama do Diretor IA (20/09/2026).
 * -----------------------------------------------------------------------------
 * Incidente TOULON (2 rodadas):
 *  1ª) "Zapp, como foram as vendas da Avenida Brasil?" não era respondível —
 *      nenhum caminho da IA recebia venda POR LOJA.
 *  2ª) o bloco vazou um fechamento 'pending' de DATA FUTURA com R$ 0,00 como
 *      "último fechamento" — 'pending' é PLACEHOLDER pré-criado com a cota
 *      (RetailClosingService.getOrCreate), nunca é venda; e a pergunta comum
 *      ("vendas de ONTEM") não tinha resposta direta.
 *
 * Prova, offline:
 *  - acumulado do mês por loja só com fechamento REAL (pending/rejected fora);
 *  - linha de ONTEM por loja: valor quando fechado; "ainda não enviado" quando
 *    pendente/ausente (nunca R$ 0,00 inventado);
 *  - fechamento de data FUTURA ou pending nunca vira "último fechamento";
 *  - dinheiro role-gated (§73); org sem loja ativa → bloco vazio;
 *  - fiação: buildPanorama + raio-x do orquestrador usam o mesmo bloco;
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

  // Mesma régua de datas do bloco (fuso do negócio).
  const tz = process.env.TZ_DISPLAY || "America/Sao_Paulo";
  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const addDays = (date: string, n: number) => new Date(Date.parse(date + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
  const ontem = addDays(hoje, -1);
  const anteontem = addDays(hoje, -2);
  const futuro = addDays(hoje, 5);
  const month = hoje.slice(0, 7);
  const inMonth = (d: string) => d.slice(0, 7) === month;

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
  const mkClosing = (org: string, storeId: string, date: string, total: number, status = "reconciled", quota = 0) => {
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, quota_amount) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), org, storeId, date, status, total, quota);
  };

  const A = mkOrg("A");
  const avBrasil = mkStore(A, "Avenida Brasil");
  const centro = mkStore(A, "Centro");
  mkStore(A, "Sem Fechamento");
  mkClosing(A, avBrasil, anteontem, 5000, "reconciled");
  mkClosing(A, avBrasil, ontem, 3000, "received", 2800); // bateu a cota (+200)
  mkClosing(A, avBrasil, futuro, 0, "pending");        // placeholder futuro — o bug da 2ª rodada
  mkClosing(A, centro, anteontem, 1200.5, "approved");
  mkClosing(A, centro, ontem, 0, "pending");           // ontem ainda não enviado
  mkClosing(A, centro, hoje, 9999, "rejected");        // rejeitado nunca soma

  const expAv = (inMonth(anteontem) ? 5000 : 0) + (inMonth(ontem) ? 3000 : 0);
  const expCentro = inMonth(anteontem) ? 1200.5 : 0;
  const brl = (v: number) => `R$ ${v.toFixed(2)}`;

  // ── 1) Conteúdo do bloco. ──
  const b = ExecutiveAdvisorService.retailStoresBlock(A);
  check("1.1 bloco presente com o cabeçalho de varejo por loja", b.includes("VAREJO — VENDAS POR LOJA"), b.slice(0, 60));
  check("1.2 Avenida Brasil: acumulado só com fechamento REAL", expAv > 0 ? b.includes(`Avenida Brasil: ${brl(expAv)} no mês`) : b.includes("Avenida Brasil: sem fechamento no mês"), b);
  check("1.3 ONTEM da Avenida Brasil responde direto com o valor", b.includes(`ontem (${ontem}): ${brl(3000)}`), "");
  check("1.3b ONTEM traz cota e resultado no formato do Informe (bateu/faltou)", b.includes(`cota ${brl(2800)} → BATEU (+${brl(200)})`), b);
  check("1.4 último fechamento é ONTEM — o pending FUTURO nunca aparece", b.includes(`último fechamento ${ontem}: ${brl(3000)}`) && !b.includes(futuro), "");
  check("1.5 ONTEM pendente do Centro é honesto (nunca R$ 0,00 inventado)", b.includes(`Centro:`) && b.includes("fechamento ainda não enviado"), "");
  check("1.6 loja sem fechamento aparece honesta", b.includes("Sem Fechamento: sem fechamento no mês"), "");
  check("1.7 total da rede soma só o REAL (pending/rejected fora)", b.includes(`Total da rede no mês: ${brl(expAv + expCentro)}`), b.slice(-80));

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
