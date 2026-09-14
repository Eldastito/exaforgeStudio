/**
 * TEST — Backfill de FECHAMENTO por filial (recuperação de loja cadastrada DEPOIS).
 * ----------------------------------------------------------------------------
 * O delta do DataCaixa é um stream global desde 2017 — uma loja cadastrada
 * depois do 1º sync não recupera os fechamentos recentes nem por sync comum
 * (cursor só avança) nem por resync (volta pra 2017). `backfillFilialClosings`
 * busca DIRETO os últimos N dias da filial pelos endpoints por-data
 * (ResumoFecharMovimento) e grava o system_total (e, com auto-closing, o
 * fechamento pendente). Prova, offline (HTTP fake):
 *   - grava system_total nos dias com "Total de Vendas" > 0; pula os dias 0;
 *   - com auto-closing: preenche informado + formas de pagamento do PDV;
 *   - filial sem loja cadastrada → skippedNoStore (não inventa);
 *   - idempotente (rodar de novo não muda os valores);
 *   - isolamento multi-tenant (não toca a loja de OUTRA org com o mesmo código).
 *
 * Uso: npm run test:alterdata-backfill-closings
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alterdata-backfill-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-alterdata-backfill-1234567890";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

function resp(status: number, body: any, headers: Record<string, string> = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: status >= 200 && status < 300, status, headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null }, json: async () => body, text: async () => JSON.stringify(body) };
}

const dateNDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { AlterdataConnectorService, __setAlterdataTokenHttpForTests } = await import("../src/server/AlterdataConnectorService.js");
  const { __setAlterdataSyncHttpForTests } = await import("../src/server/AlterdataSyncService.js");
  const { AlterdataSyncRunner } = await import("../src/server/AlterdataSyncRunner.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  // Loja "Grande Rio" código 1006 na org A; OUTRA org B tem uma loja com o MESMO
  // código (isolamento: o backfill da A não pode tocar a da B).
  const storeA = RetailStoreService.create(A, { name: "Grande Rio", code: "1006", whatsappIdentifier: "5521900001006" });
  const storeB = RetailStoreService.create(B, { name: "Outra Rede", code: "1006", whatsappIdentifier: "5521900002006" });

  __setAlterdataTokenHttpForTests(async () => resp(200, { access_token: "tok-1", expires_in: 3600 }));
  // Config mínima só p/ resolver a base URL do módulo 'sales' e o token.
  AlterdataConnectorService.saveSettings(A, {
    enabled: true, environment: "homolog", rede: "TOULON", filiais: ["1006"],
    basePattern: "toulon-{module}.apimodaup.com.br",
    authConfig: { clientId: "int@toulon", clientSecret: "s3nh4" },
  });
  AlterdataConnectorService.setPdvAutoClosing(A, true);

  // Dias com caixa fechado (Total de Vendas > 0): ontem e 3 dias atrás. Todo o
  // resto responde 0 (caixa não fechado / inexistente). Turno 2 sempre 0.
  const d1 = dateNDaysAgo(1);
  const d3 = dateNDaysAgo(3);
  __setAlterdataSyncHttpForTests(async (url: string) => {
    if (url.includes(`/ResumoFecharMovimento/1006/${d1}/1`)) {
      return resp(200, { success: true, data: [
        { titulo: "Total de Vendas", valor: 1500.5 }, { titulo: "Dinheiro", valor: 500.5 }, { titulo: "Cartão", valor: 1000.0 }, { titulo: "Sangria", valor: 50 },
      ] });
    }
    if (url.includes(`/ResumoFecharMovimento/1006/${d3}/1`)) {
      return resp(200, { success: true, data: [{ titulo: "Total de Vendas", valor: 800.0 }, { titulo: "Dinheiro", valor: 800.0 }] });
    }
    // Qualquer outro dia/turno: caixa não fechado → tudo zero.
    return resp(200, { success: true, data: [{ titulo: "Total de Vendas", valor: 0 }] });
  });

  // ===== 1. Backfill grava system_total nos dias com venda =====
  const r1 = await AlterdataSyncRunner.backfillFilialClosings(A, "1006", 90);
  check("backfill aplica exatamente 2 dias (ontem e 3 dias atrás)", r1.applied === 2, JSON.stringify(r1));
  check("backfill sem loja pulada (código casou)", r1.skippedNoStore === 0, JSON.stringify(r1));
  // Verdade-de-campo: nome da loja resolvida + registros persistidos + amostra.
  check("resultado carrega o NOME da loja resolvida (Grande Rio)", r1.storeName === "Grande Rio" && r1.storeId === storeA.id, JSON.stringify({ storeName: r1.storeName, storeId: r1.storeId }));
  check("persisted RE-LÊ do banco os fechamentos com sistema>0 (=2)", r1.persisted === 2, `persisted=${r1.persisted}`);
  check("amostra traz (data,total) dos dias aplicados", Array.isArray(r1.sample) && r1.sample.length === 2 && r1.sample.some((s) => s.date === d1 && s.total === 1500.5), JSON.stringify(r1.sample));

  const c1 = db.prepare(`SELECT system_total, informed_total, status, divergence_status FROM retail_daily_closings WHERE organization_id=? AND store_id=? AND closing_date=?`).get(A, storeA.id, d1) as any;
  check("system_total do dia 1 gravado (1500.5)", Number(c1?.system_total) === 1500.5, JSON.stringify(c1));
  const c3 = db.prepare(`SELECT system_total FROM retail_daily_closings WHERE organization_id=? AND store_id=? AND closing_date=?`).get(A, storeA.id, d3) as any;
  check("system_total do dia 3 gravado (800)", Number(c3?.system_total) === 800, JSON.stringify(c3));

  // ===== 2. Auto-closing: informado + formas de pagamento do PDV =====
  check("auto: fechamento preenchido com o total do PDV (informado=1500.5, received)", Number(c1?.informed_total) === 1500.5 && c1?.status === "received", JSON.stringify(c1));
  check("auto: divergência ok (informado = PDV)", c1?.divergence_status === "ok", String(c1?.divergence_status));
  const c1id = db.prepare(`SELECT id FROM retail_daily_closings WHERE organization_id=? AND store_id=? AND closing_date=?`).get(A, storeA.id, d1) as any;
  const pay = db.prepare(`SELECT payment_method, informed_amount FROM retail_daily_closing_items WHERE closing_id=? ORDER BY payment_method`).all(c1id.id) as any[];
  check("auto: formas de pagamento do PDV (cartao 1000 + dinheiro 500.5)", pay.length === 2 && pay[0]?.payment_method === "cartao" && Number(pay[0]?.informed_amount) === 1000 && pay[1]?.payment_method === "dinheiro" && Number(pay[1]?.informed_amount) === 500.5, JSON.stringify(pay));

  // ===== 3. Dia sem venda NÃO cria fechamento com valor =====
  const d2 = dateNDaysAgo(2);
  const c2 = db.prepare(`SELECT system_total FROM retail_daily_closings WHERE organization_id=? AND store_id=? AND closing_date=?`).get(A, storeA.id, d2) as any;
  check("dia sem caixa fechado não ganha system_total (>0)", !c2 || !(Number(c2?.system_total) > 0), JSON.stringify(c2));

  // ===== 4. Isolamento multi-tenant: a loja da org B (mesmo código) intocada ====
  const cB = db.prepare(`SELECT system_total FROM retail_daily_closings WHERE organization_id=? AND store_id=? AND closing_date=?`).get(B, storeB.id, d1) as any;
  check("isolamento: loja de OUTRA org com mesmo código não é tocada", !cB, JSON.stringify(cB));

  // ===== 5. Idempotência: rodar de novo não muda os valores =====
  const r2 = await AlterdataSyncRunner.backfillFilialClosings(A, "1006", 90);
  check("idempotente: reaplica os mesmos 2 dias", r2.applied === 2, JSON.stringify(r2));
  const c1b = db.prepare(`SELECT COUNT(*) AS n FROM retail_daily_closing_items WHERE closing_id=?`).get(c1id.id) as any;
  check("idempotente: não duplica formas de pagamento (segue 2)", Number(c1b?.n) === 2, JSON.stringify(c1b));

  // ===== 6. Filial sem loja cadastrada → skippedNoStore (não inventa) =====
  const r3 = await AlterdataSyncRunner.backfillFilialClosings(A, "9999", 90);
  check("filial sem loja → skippedNoStore, nada aplicado", r3.skippedNoStore === 1 && r3.applied === 0, JSON.stringify(r3));

  __setAlterdataSyncHttpForTests(null);
  __setAlterdataTokenHttpForTests(null);

  console.log("\n=== TEST: Backfill de fechamento por filial (recuperação) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
