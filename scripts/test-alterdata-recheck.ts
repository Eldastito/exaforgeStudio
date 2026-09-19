/**
 * TESTE — 19/09/2026: RECONFERÊNCIA automática dos últimos dias (2ª metade do
 * caso Toulon "faltam R$ 3.108,10 de cartão").
 * -----------------------------------------------------------------------------
 * O Raio-X provou: os cartões/TEF entram no caixa da Alterdata HORAS depois do
 * turno fechar. O delta do DataCaixa entrega cada turno UMA vez e não o
 * revisita — um dia lido cedo demais ficava com valor PARCIAL até alguém
 * apertar "Recuperar fechamentos" (folha R$ 5.476,80 × tela R$ 2.368,60).
 *
 * Prova, offline (HTTP fake):
 *  - sync 1 lê o dia PARCIAL (2.368,60) e o auto-closing espelha o informado;
 *  - sync 2 imediato: reconferência THROTTLED (não martela a API a cada 15 min);
 *  - janela vencida → sync 3 SELF-HEAL: sistema E espelho vão pra 5.476,80;
 *  - espelho PDV desatualizado NÃO vira "perda" falsa (guard no gancho);
 *  - informado HUMANO (manual) nunca é tocado — divergência real segue flagrada
 *    e a perda legítima segue lançada;
 *  - org sem PDV vivo não gasta 1 chamada de resumo; isolamento multi-tenant.
 *
 * Uso: npm run test:alterdata-recheck
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alterdata-recheck-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-alterdata-recheck-1234567890";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

function resp(status: number, body: any, headers: Record<string, string> = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: status >= 200 && status < 300, status, headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null }, json: async () => body, text: async () => JSON.stringify(body) };
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailClosingService } = await import("../src/server/RetailOpsService.js");
  const { AlterdataConnectorService, __setAlterdataTokenHttpForTests } = await import("../src/server/AlterdataConnectorService.js");
  const { __setAlterdataSyncHttpForTests } = await import("../src/server/AlterdataSyncService.js");
  const { AlterdataSyncRunner } = await import("../src/server/AlterdataSyncRunner.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const storeA = RetailStoreService.create(A, { name: "Av. Brasil", code: "1005", whatsappIdentifier: "5521900001005" });
  // 2ª loja: o informado vira MANUAL (humano) — prova que a reconferência nunca
  // o toca e que a perda LEGÍTIMA (falta real) segue sendo lançada.
  const storeM = RetailStoreService.create(A, { name: "Manual", code: "1007", whatsappIdentifier: "5521900001007" });

  __setAlterdataTokenHttpForTests(async () => resp(200, { access_token: "tok-1", expires_in: 3600 }));
  AlterdataConnectorService.saveSettings(A, {
    enabled: true, environment: "homolog", rede: "TOULON", filiais: ["1005"],
    basePattern: "toulon-{module}.apimodaup.com.br",
    authConfig: { clientId: "int@toulon", clientSecret: "s3nh4" },
  });
  AlterdataConnectorService.setPdvAutoClosing(A, true);

  const hoje = new Date().toISOString().slice(0, 10);
  // fase 1 = leitura CEDO (TEF ainda não caiu no caixa); fase 2 = TEF chegou.
  let fase: 1 | 2 = 1;
  let resumoCalls = 0;
  __setAlterdataSyncHttpForTests(async (url: string) => {
    if (url.includes("/DataCaixa/versao/")) {
      // Delta: só o sync 1 entrega os turnos fechados; depois, nada novo.
      if (fase === 1 && url.includes("/DataCaixa/versao/0")) {
        return resp(200, { success: true, data: [
          { data: `${hoje}T00:00:00`, filial: "1005", turno: 1, finalizado2: 1, controleVersao: 900 },
          { data: `${hoje}T00:00:00`, filial: "1007", turno: 1, finalizado2: 1, controleVersao: 900 },
        ] });
      }
      return resp(200, { success: true, data: [] });
    }
    if (url.includes("/ResumoFecharMovimento/")) {
      resumoCalls++;
      // Av. Brasil, turno 1: parcial na fase 1; TEF completo na fase 2.
      if (url.includes(`/ResumoFecharMovimento/1005/${hoje}/1`)) {
        return fase === 1
          ? resp(200, { success: true, data: [{ titulo: "Total de Vendas", valor: 2368.6 }, { titulo: "Dinheiro", valor: 800 }, { titulo: "PIX", valor: 389.7 }, { titulo: "Cartão", valor: 1178.9 }] })
          : resp(200, { success: true, data: [{ titulo: "Total de Vendas", valor: 5476.8 }, { titulo: "Dinheiro", valor: 800 }, { titulo: "Cartão", valor: 4676.8 }] });
      }
      if (url.includes(`/ResumoFecharMovimento/1007/${hoje}/1`)) {
        return fase === 1
          ? resp(200, { success: true, data: [{ titulo: "Total de Vendas", valor: 1000 }, { titulo: "Dinheiro", valor: 1000 }] })
          : resp(200, { success: true, data: [{ titulo: "Total de Vendas", valor: 1500 }, { titulo: "Dinheiro", valor: 1500 }] });
      }
      // Turno 2 / dias anteriores: sem caixa (total 0 → reconferência não inventa).
      return resp(200, { success: true, data: [{ titulo: "Total de Vendas", valor: 0 }] });
    }
    return resp(200, { success: true, data: [] });
  });

  const closingRow = (storeId: string) => db.prepare(
    `SELECT id, system_total, system_turnos_json, informed_total, source, status, divergence_status FROM retail_daily_closings WHERE organization_id=? AND store_id=? AND closing_date=?`
  ).get(A, storeId, hoje) as any;

  // ── 1) Sync 1: dia PARCIAL — auto-closing espelha o informado. ──
  await AlterdataSyncRunner.runOrg(A);
  const c1 = closingRow(storeA.id);
  check("1.1 sistema grava o parcial (2.368,60)", Number(c1?.system_total) === 2368.6, JSON.stringify(c1));
  check("1.2 informado espelhado do PDV (source='pdv')", Number(c1?.informed_total) === 2368.6 && c1?.source === "pdv", `informed=${c1?.informed_total} source=${c1?.source}`);
  check("1.3 reconferência da 1ª passada é idempotente (divergência ok)", c1?.divergence_status === "ok", c1?.divergence_status);
  const cursorAfter1 = Number(AlterdataConnectorService.getCursor(A, "_meta", "lastRecheck", "")) || 0;
  check("1.4 throttle armado (cursor lastRecheck setado)", cursorAfter1 > 0, String(cursorAfter1));

  // Loja Manual: humano sobrescreve o informado (source vira 'manual').
  const cm1 = closingRow(storeM.id);
  RetailClosingService.setInformed(A, cm1.id, { informedTotal: 1000, source: "manual" });

  // ── 2) TEF chegou, mas sync imediato: reconferência THROTTLED. ──
  fase = 2;
  const callsBefore2 = resumoCalls;
  await AlterdataSyncRunner.runOrg(A);
  const c2 = closingRow(storeA.id);
  check("2.1 dentro da janela NÃO re-lê o resumo (0 chamadas)", resumoCalls === callsBefore2, `calls=${resumoCalls - callsBefore2}`);
  check("2.2 valor parcial permanece (heal só na janela)", Number(c2?.system_total) === 2368.6, String(c2?.system_total));

  // ── 3) Janela vencida → SELF-HEAL (o caso Toulon sem apertar botão). ──
  AlterdataConnectorService.setCursor(A, "_meta", "lastRecheck", "", String(Date.now() - 7 * 3600_000));
  await AlterdataSyncRunner.runOrg(A);
  const c3 = closingRow(storeA.id);
  check("3.1 O CASO TOULON: sistema se corrige sozinho (5.476,80)", Number(c3?.system_total) === 5476.8, String(c3?.system_total));
  check("3.2 turno substituído na chave dele", JSON.parse(c3?.system_turnos_json || "{}")["1"] === 5476.8, c3?.system_turnos_json);
  check("3.3 espelho PDV acompanha (informado 5.476,80, segue 'pdv')", Number(c3?.informed_total) === 5476.8 && c3?.source === "pdv", `informed=${c3?.informed_total} source=${c3?.source}`);
  const items3 = db.prepare(`SELECT payment_method, informed_amount FROM retail_daily_closing_items WHERE closing_id=? ORDER BY payment_method`).all(c3?.id) as any[];
  check("3.4 formas refeitas do dia inteiro (dinheiro 800 + cartão 4.676,80)", items3.length === 2 && items3.some((i) => i.payment_method === "cartao" && Number(i.informed_amount) === 4676.8), JSON.stringify(items3));
  check("3.5 divergência fecha sozinha (ok, não divergente)", c3?.divergence_status === "ok", c3?.divergence_status);
  const lossA = db.prepare(`SELECT COUNT(*) n FROM loss_events WHERE organization_id=? AND source=?`).get(A, `retail_closing:${c3?.id}`) as any;
  check("3.6 espelho desatualizado NÃO vira perda falsa", Number(lossA?.n) === 0, `losses=${lossA?.n}`);

  // Loja Manual: informado humano intocado; falta REAL segue flagrada + perda lançada.
  const cm3 = closingRow(storeM.id);
  check("3.7 informado MANUAL nunca é tocado (segue 1.000)", Number(cm3?.informed_total) === 1000 && cm3?.source === "manual", `informed=${cm3?.informed_total} source=${cm3?.source}`);
  check("3.8 divergência real flagrada pro humano (sistema 1.500)", Number(cm3?.system_total) === 1500 && cm3?.divergence_status === "divergent", `system=${cm3?.system_total} status=${cm3?.divergence_status}`);
  const lossM = db.prepare(`SELECT COUNT(*) n, MAX(amount) amount FROM loss_events WHERE organization_id=? AND source=?`).get(A, `retail_closing:${cm3?.id}`) as any;
  check("3.9 perda LEGÍTIMA (falta de 500) segue lançada", Number(lossM?.n) === 1 && Number(lossM?.amount) === 500, JSON.stringify(lossM));

  // ── 4) Observabilidade: reconferência registrada no ledger do sync. ──
  const ledgerRow = db.prepare(
    `SELECT r.status, r.imported FROM alterdata_sync_run_resources r
       JOIN alterdata_sync_runs runs ON runs.id = r.run_id
      WHERE runs.organization_id = ? AND r.resource = 'DataCaixa/Reconferencia'
      ORDER BY r.finished_at DESC LIMIT 1`
  ).get(A) as any;
  check("4.1 ledger registra a reconferência (ready, imported>0)", ledgerRow?.status === "ready" && Number(ledgerRow?.imported) > 0, JSON.stringify(ledgerRow));

  // ── 5) Org sem PDV vivo: nem UMA chamada de resumo gasta. ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  RetailStoreService.create(B, { name: "Sem PDV", code: "2001" });
  AlterdataConnectorService.saveSettings(B, {
    enabled: true, environment: "homolog", rede: "TOULON", filiais: ["2001"],
    basePattern: "toulon-{module}.apimodaup.com.br",
    authConfig: { clientId: "int@toulon", clientSecret: "s3nh4" },
  });
  const callsBefore5 = resumoCalls;
  await AlterdataSyncRunner.runOrg(B);
  check("5.1 org sem fechamento de PDV não re-lê resumo nenhum", resumoCalls === callsBefore5, `calls=${resumoCalls - callsBefore5}`);
  check("5.2 throttle da org B não consumido à toa", !(Number(AlterdataConnectorService.getCursor(B, "_meta", "lastRecheck", "")) > 0));

  // ── 6) Isolamento: nada da org A vazou pra B. ──
  const cB = db.prepare(`SELECT COUNT(*) n FROM retail_daily_closings WHERE organization_id=?`).get(B) as any;
  check("6.1 org B sem fechamentos (isolada)", Number(cB?.n) === 0, String(cB?.n));

  __setAlterdataSyncHttpForTests(null);
  __setAlterdataTokenHttpForTests(null);

  console.log("\n=== TEST: Reconferência automática dos últimos dias (TEF tardio) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
