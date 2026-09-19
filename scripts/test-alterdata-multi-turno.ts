/**
 * TESTE — 19/09/2026: multi-TURNO do DataCaixa (caso Toulon "R$ 100 sumiram").
 * -----------------------------------------------------------------------------
 * Bug real de produção: a cliente somou as formas do fechamento (800 + 389,70 +
 * 1.178,90 = R$ 2.368,60) e a tela mostrava R$ 2.268,60 — exatamente R$ 100 a
 * menos. Causa: o delta do DataCaixa entrega cada TURNO fechado uma vez; com o
 * turno 1 (R$ 100) fechado de manhã e o turno 2 (R$ 2.268,60) à noite, cada
 * sync via só UM turno e o `applyPdvTotal` SOBRESCREVIA o system_total com o
 * subset do último delta.
 *
 * Prova, offline (HTTP fake, dois syncs com deltas disjuntos):
 *  - sync 1 (só turno 1) → system_total = 100;
 *  - sync 2 (só turno 2) → system_total = 2.368,60 (SOMA, não substituição —
 *    o valor pré-fix era 2.268,60);
 *  - turno reenviado (caixa reaberto/refechado) substitui SÓ aquele turno;
 *  - merge unitário do applyPdvTurnoTotals + divergência derivada do dia inteiro;
 *  - PIX do resumo entra nas formas do auto-closing (antes descartado);
 *  - isolamento multi-tenant.
 *
 * Uso: npm run test:alterdata-multi-turno
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alterdata-turno-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-alterdata-turno-1234567890";
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
  const { AlterdataConnectorService, __setAlterdataTokenHttpForTests } = await import("../src/server/AlterdataConnectorService.js");
  const { __setAlterdataSyncHttpForTests } = await import("../src/server/AlterdataSyncService.js");
  const { AlterdataSyncRunner } = await import("../src/server/AlterdataSyncRunner.js");
  const { RetailReconciliationService } = await import("../src/server/RetailReconciliationService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const storeA = RetailStoreService.create(A, { name: "Av. Brasil", code: "1005", whatsappIdentifier: "5521900001005" });
  // 2ª loja com turno ÚNICO cujo resumo tem PIX — prova o fix do PAY_TITLES no
  // PRIMEIRO preenchimento (o auto-closing só grava as formas quando informed=0).
  const storePix = RetailStoreService.create(A, { name: "Carioca", code: "1006", whatsappIdentifier: "5521900001006" });

  __setAlterdataTokenHttpForTests(async () => resp(200, { access_token: "tok-1", expires_in: 3600 }));
  AlterdataConnectorService.saveSettings(A, {
    enabled: true, environment: "homolog", rede: "TOULON", filiais: ["1005"],
    basePattern: "toulon-{module}.apimodaup.com.br",
    authConfig: { clientId: "int@toulon", clientSecret: "s3nh4" },
  });
  AlterdataConnectorService.setPdvAutoClosing(A, true);

  const hoje = new Date().toISOString().slice(0, 10);
  // Fase controla o QUE o delta do DataCaixa entrega em cada sync (turnos
  // fechando em horários diferentes — o cenário real do bug).
  let fase: 1 | 2 = 1;
  __setAlterdataSyncHttpForTests(async (url: string) => {
    // Delta do DataCaixa: sync 1 entrega SÓ o turno 1; sync 2 SÓ o turno 2.
    if (url.includes("/DataCaixa/versao/")) {
      if (fase === 1 && url.includes("/DataCaixa/versao/0")) {
        return resp(200, { success: true, data: [
          { data: `${hoje}T00:00:00`, filial: "1005", turno: 1, finalizado2: 1, controleVersao: 900 },
          { data: `${hoje}T00:00:00`, filial: "1006", turno: 1, finalizado2: 1, controleVersao: 900 },
        ] });
      }
      if (fase === 2 && url.includes("/DataCaixa/versao/900")) {
        return resp(200, { success: true, data: [{ data: `${hoje}T00:00:00`, filial: "1005", turno: 2, finalizado2: 1, controleVersao: 950 }] });
      }
      return resp(200, { success: true, data: [] });
    }
    // Resumo por turno: turno 1 = a venda da manhã (R$ 100); turno 2 = o resto
    // do dia (R$ 2.268,60 = dinheiro 700 + pix 389,70 + cartão 1.178,90).
    if (url.includes(`/ResumoFecharMovimento/1005/${hoje}/1`)) {
      return resp(200, { success: true, data: [{ titulo: "Total de Vendas", valor: 100 }, { titulo: "Dinheiro", valor: 100 }] });
    }
    if (url.includes(`/ResumoFecharMovimento/1005/${hoje}/2`)) {
      return resp(200, { success: true, data: [
        { titulo: "Total de Vendas", valor: 2268.6 }, { titulo: "Dinheiro", valor: 700 }, { titulo: "PIX", valor: 389.7 }, { titulo: "Cartão", valor: 1178.9 },
      ] });
    }
    // Loja Carioca (turno único, COM PIX no resumo) — prova o fix do PAY_TITLES.
    if (url.includes(`/ResumoFecharMovimento/1006/${hoje}/1`)) {
      return resp(200, { success: true, data: [
        { titulo: "Total de Vendas", valor: 2368.6 }, { titulo: "Dinheiro", valor: 800 }, { titulo: "PIX", valor: 389.7 }, { titulo: "Cartão", valor: 1178.9 },
      ] });
    }
    // Todos os demais recursos do sync: stream vazio (não interessam aqui).
    return resp(200, { success: true, data: [] });
  });

  const closingRow = () => db.prepare(
    `SELECT id, system_total, system_turnos_json, informed_total FROM retail_daily_closings WHERE organization_id=? AND store_id=? AND closing_date=?`
  ).get(A, storeA.id, hoje) as any;

  // ── 1) Sync 1: só o turno 1 fechou → system_total = 100. ──
  await AlterdataSyncRunner.runOrg(A);
  const c1 = closingRow();
  check("1.1 sync 1 grava o turno 1 (system_total = 100)", Number(c1?.system_total) === 100, JSON.stringify(c1));
  check("1.2 turno registrado na chave dele", JSON.parse(c1?.system_turnos_json || "{}")["1"] === 100, c1?.system_turnos_json);

  // ── 2) Sync 2: só o turno 2 no delta → system_total SOMA os dois turnos. ──
  fase = 2;
  await AlterdataSyncRunner.runOrg(A);
  const c2 = closingRow();
  check("2.1 O BUG DA CLIENTE: dia inteiro = 2.368,60 (não 2.268,60)", Number(c2?.system_total) === 2368.6, `system_total=${c2?.system_total}`);
  const turnos = JSON.parse(c2?.system_turnos_json || "{}");
  check("2.2 os DOIS turnos preservados ({1:100, 2:2268.6})", turnos["1"] === 100 && turnos["2"] === 2268.6, c2?.system_turnos_json);

  // ── 3) PIX entra nas formas do auto-closing (antes descartado). ──
  const cPix = db.prepare(`SELECT id, informed_total FROM retail_daily_closings WHERE organization_id=? AND store_id=? AND closing_date=?`).get(A, storePix.id, hoje) as any;
  const pay = db.prepare(`SELECT payment_method, informed_amount FROM retail_daily_closing_items WHERE closing_id=? ORDER BY payment_method`).all(cPix?.id) as any[];
  check("3.1 PIX presente nas formas (389,70)", pay.some((p) => p.payment_method === "pix" && Number(p.informed_amount) === 389.7), JSON.stringify(pay));
  check("3.2 formas + total do caso real (800 + 389,70 + 1.178,90 = 2.368,60)", Number(cPix?.informed_total) === 2368.6 && pay.length === 3, JSON.stringify({ informed: cPix?.informed_total, pay }));

  // ── 4) Turno reenviado (caixa reaberto/refechado) substitui SÓ aquele turno. ──
  const r4 = RetailReconciliationService.applyPdvTurnoTotals(A, storeA.id, hoje, { "2": 2270 });
  check("4.1 reenvio do turno 2 atualiza só ele (total 100 + 2270 = 2370)", r4.mergedTotal === 2370 && r4.turnos["1"] === 100 && r4.turnos["2"] === 2270, JSON.stringify(r4.turnos));

  // ── 5) Divergência derivada do dia INTEIRO (informado × soma dos turnos). ──
  db.prepare(`UPDATE retail_daily_closings SET informed_total = 2370 WHERE id = ?`).run(c2.id);
  const r5 = RetailReconciliationService.applyPdvTurnoTotals(A, storeA.id, hoje, {});
  check("5.1 informado = soma dos turnos → divergência ok", r5.status === "ok" && r5.divergence === 0, JSON.stringify(r5));

  // ── 6) Isolamento: outra org com o mesmo código não é tocada. ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  const storeB = RetailStoreService.create(B, { name: "Outra", code: "1005" });
  const cB = db.prepare(`SELECT 1 FROM retail_daily_closings WHERE organization_id=? AND store_id=?`).get(B, storeB.id);
  check("6.1 org B intocada", !cB);

  __setAlterdataSyncHttpForTests(null);
  __setAlterdataTokenHttpForTests(null);

  console.log("\n=== TEST: Multi-turno do DataCaixa (R$ 100 que sumiam) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
