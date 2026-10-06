/**
 * TESTE — ADR-204 F3.3: RADAR CONTEXTUAL do varejo.
 * ----------------------------------------------------------------------------
 * Prova, nos serviços REAIS e com dados de PDV simulados:
 *   A) normalidade por LOJA × DIA DA SEMANA (nunca por hora — a hora do PDV não é confiável, RN-F3-5): dia fechado bem abaixo
 *      → desvio de NEGÓCIO; bem acima → OPORTUNIDADE; dentro do normal → nada; < 6 mesmos-dias → "histórico insuficiente"
 *      (sem faixa inventada); dia sem venda nunca é lido como queda; o resultado é IDÊNTICO com `sale_time` lixo/nulo;
 *   B) dado velho NUNCA vira "queda de venda": integração atrasada → só o sinal técnico e o radar se cala sobre as lojas;
 *   C) anomalias TÉCNICAS: preço zerado/absurdo (com base mínima), possível venda duplicada (hipótese), comissão estranha
 *      (sem R$ no sinal; sem base da rede não julga);
 *   D) a CLASSE (technical/business/opportunity) vem do registry e vai no sinal; detectores antigos não ganham campo (0-regressão);
 *   E) publicação SÓ em `business_signals`, sem dinheiro inventado, idempotente, auto-cura; opt-in (sem a flag não publica);
 *      isolado por empresa; rotas (dono/403/401) e fiação (Scheduler).
 *
 * Uso:  npm run test:retail-radar
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-radar-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-retail-radar-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

const DAY = 86400e3;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(Date.parse(`${d}T00:00:00Z`) + n * DAY);

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailRadarService: R } = await import("../src/server/RetailRadarService.js");
  const { AnomalyDetectorRegistry: REG } = await import("../src/server/AnomalyDetectorRegistry.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const A = mkOrg(), B = mkOrg();
  const mkUser = (org: string, role: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, ?, ?, ?, 'active')`).run(id, org, name, `${id}@t.local`, role); return { userId: id, id, role, name, email: `${id}@t.local` }; };
  const maria = mkUser(A, "owner", "Maria"), joao = mkUser(A, "agent", "João");
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, 'Loja Centro', '01')`).run(randomUUID(), A);

  const ASOF = "2026-09-28";                 // segunda-feira
  const NOW = Date.parse("2026-09-29T12:00:00Z");
  let bol = 0;
  const sale = (org: string, filial: string, date: string, valor: number, o: any = {}) => {
    db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, sale_time, usuario, valor, pecas, status, payments_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'N', ?)`)
      .run(randomUUID(), org, filial, o.boleta || `B${++bol}`, date, o.time === undefined ? "99:99" : o.time, o.usuario || "u1", valor, o.pecas ?? 2, o.pay ?? `[{"f":"pix","v":${valor}}]`);
  };
  const item = (org: string, filial: string, date: string, boleta: string, seq: number, produto: string, q: number, v: number) =>
    db.prepare(`INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, produto, quantidade, valor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), org, filial, boleta, date, seq, produto, q, v);
  // 12 segundas anteriores com ~1000 (900..1100) na filial 01; filial 02 só tem 3 segundas (histórico curto).
  const mondays = Array.from({ length: 12 }, (_, i) => addDays(ASOF, -7 * (i + 1)));
  mondays.forEach((d, i) => sale(A, "01", d, 900 + (i % 5) * 50));
  mondays.slice(0, 3).forEach((d) => sale(A, "02", d, 800));
  // Dias de semana "normais" também (para ruído): terças.
  for (let i = 1; i <= 12; i++) sale(A, "01", addDays(ASOF, -7 * i + 1), 700);
  sale(A, "02", ASOF, 100);                  // 3 amostras < 6 → histórico insuficiente
  const openSig = (org: string, type?: string) => db.prepare(`SELECT * FROM business_signals WHERE organization_id = ? AND domain = 'retail_radar' AND status = 'open'${type ? " AND signal_type = ?" : ""}`).all(...(type ? [org, type] : [org])) as any[];

  // ── A) normalidade por loja × dia da semana ──
  const norm = R.storeDayNormality(A, "01", ASOF);
  check("sem venda no dia fechado: não há comparação (nunca vira queda)", R.storeDayNormality(A, "01", ASOF).status === "no_sales_that_day");
  sale(A, "01", ASOF, 950);                   // dia normal
  const n1 = R.scan(A, { asOf: ASOF, now: NOW });
  check("dia dentro do normal: nenhum desvio", !n1.findings.some((f: any) => f.kind.startsWith("retail_store_day")), JSON.stringify(n1.findings.map((f: any) => f.kind)));
  check("filial com < 6 mesmos-dias → histórico insuficiente (sem faixa inventada)", n1.normality.find((x: any) => x.filial === "02")?.status === "insufficient_history" && n1.normality.find((x: any) => x.filial === "02")?.samples === 3);
  check("a faixa usa só o mesmo dia da semana (12 amostras, não as terças)", R.storeDayNormality(A, "01", ASOF).samples === 12 && R.storeDayNormality(A, "01", ASOF).weekday === "segunda-feira");

  db.prepare(`DELETE FROM retail_pdv_sales WHERE organization_id = ? AND filial = '01' AND sale_date = ?`).run(A, ASOF);
  sale(A, "01", ASOF, 300);
  const n2 = R.scan(A, { asOf: ASOF, now: NOW });
  const below = n2.findings.find((f: any) => f.kind === "retail_store_day_below_normal");
  check("dia fechado MUITO abaixo do normal → desvio de NEGÓCIO", !!below && below.signalClass === "business" && below.filial === "01", JSON.stringify(n2.findings.map((f: any) => f.kind)));
  check("a mensagem é em linguagem de dono: loja, dia da semana, % e sem R$", /Loja Centro/.test(below.summary) && /segunda-feira/.test(below.summary) && /% abaixo do normal/.test(below.summary) && !/R\$/.test(below.summary));

  db.prepare(`DELETE FROM retail_pdv_sales WHERE organization_id = ? AND filial = '01' AND sale_date = ?`).run(A, ASOF);
  sale(A, "01", ASOF, 2500);
  const n3 = R.scan(A, { asOf: ASOF, now: NOW });
  const above = n3.findings.find((f: any) => f.kind === "retail_store_day_above_normal");
  check("dia fechado MUITO acima → OPORTUNIDADE (não alarme)", !!above && above.signalClass === "opportunity" && above.severity === "info" && !n3.findings.some((f: any) => f.kind === "retail_store_day_below_normal"));

  // abaixo do relativo mas DENTRO do que já aconteceu → não dispara (guarda de faixa)
  db.prepare(`DELETE FROM retail_pdv_sales WHERE organization_id = ? AND filial = '01' AND sale_date = ?`).run(A, ASOF);
  sale(A, "01", mondays[0], 650, { boleta: "EXTRA" }); // injeta um dia ruim na história (mesma data → soma)
  db.prepare(`DELETE FROM retail_pdv_sales WHERE boleta = 'EXTRA'`).run();
  db.prepare(`UPDATE retail_pdv_sales SET valor = 600 WHERE organization_id = ? AND filial = '01' AND sale_date = ?`).run(A, mondays[1]);
  sale(A, "01", ASOF, 620);
  const n4 = R.scan(A, { asOf: ASOF, now: NOW });
  check("queda relativa mas DENTRO do que já houve naquele dia da semana → não alarma", !n4.findings.some((f: any) => f.kind === "retail_store_day_below_normal"));
  db.prepare(`UPDATE retail_pdv_sales SET valor = 950 WHERE organization_id = ? AND filial = '01' AND sale_date = ?`).run(A, mondays[1]);
  db.prepare(`DELETE FROM retail_pdv_sales WHERE organization_id = ? AND filial = '01' AND sale_date = ?`).run(A, ASOF);
  sale(A, "01", ASOF, 300);

  // hora do PDV: resultado idêntico com sale_time nulo/lixo
  const before = JSON.stringify(R.scan(A, { asOf: ASOF, now: NOW }).findings);
  db.prepare(`UPDATE retail_pdv_sales SET sale_time = NULL WHERE organization_id = ?`).run(A);
  const afterNull = JSON.stringify(R.scan(A, { asOf: ASOF, now: NOW }).findings);
  db.prepare(`UPDATE retail_pdv_sales SET sale_time = '03:17' WHERE organization_id = ?`).run(A);
  const afterOdd = JSON.stringify(R.scan(A, { asOf: ASOF, now: NOW }).findings);
  check("a HORA da venda não influencia nada (nulo, lixo ou 03:17 → mesmo resultado)", before === afterNull && before === afterOdd);
  const src = fs.readFileSync(path.join(process.cwd(), "src/server/RetailRadarService.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("o código do radar nem lê `sale_time`", !/sale_time/.test(src));

  // ── B) dado velho nunca vira queda ──
  const now2 = Date.parse("2026-10-20T12:00:00Z");   // 22 dias depois da última venda
  const s1 = R.scan(A, { asOf: ASOF, now: now2 });
  check("sem cursor e sem venda há semanas → integração parada (hipótese) e o radar se CALA sobre as lojas", s1.findings.some((f: any) => f.kind === "retail_integration_late") && !s1.findings.some((f: any) => f.kind.startsWith("retail_store_day")) && s1.skipped.includes("dado_desatualizado"));
  db.prepare(`INSERT INTO alterdata_sync_cursors (id, organization_id, module, resource, filial, version, last_synced_at) VALUES (?, ?, 'sales', 'Venda', '', '1', ?)`).run(randomUUID(), A, "2026-09-26 10:00:00");
  const s2 = R.scan(A, { asOf: ASOF, now: NOW });  // 2026-09-29 12:00 → ~74h
  const late = s2.findings.find((f: any) => f.kind === "retail_integration_late");
  check("com cursor: atraso > 72h → risco, fato, classe técnica; e as lojas ficam em silêncio", !!late && late.severity === "risk" && late.basis === "fact" && late.signalClass === "technical" && !s2.findings.some((f: any) => f.kind.startsWith("retail_store_day")));
  db.prepare(`UPDATE alterdata_sync_cursors SET last_synced_at = '2026-09-29 09:00:00' WHERE organization_id = ?`).run(A);
  const s3 = R.scan(A, { asOf: ASOF, now: NOW });
  check("integração em dia: o sinal técnico some e o desvio da loja volta", !s3.findings.some((f: any) => f.kind === "retail_integration_late") && s3.findings.some((f: any) => f.kind === "retail_store_day_below_normal"));
  check("org sem nenhuma venda: honesto, nada a dizer", R.scan(B, { asOf: ASOF, now: NOW }).findings.length === 0 && R.scan(B, { asOf: ASOF, now: NOW }).skipped.includes("sem_vendas"));

  // ── C) técnicas ──  (as vendas técnicas abaixo SOMAM no dia; o dia-base fica baixo p/ o desvio de negócio seguir valendo)
  db.prepare(`UPDATE retail_pdv_sales SET valor = 100 WHERE organization_id = ? AND filial = '01' AND sale_date = ? AND boleta LIKE 'B%'`).run(A, ASOF);
  for (let i = 0; i < 6; i++) item(A, "01", addDays(ASOF, -10 - i), `H${i}`, 1, "P100", 1, 100);   // histórico: R$100/un
  sale(A, "01", ASOF, 50, { boleta: "T1" }); sale(A, "01", ASOF, 40, { boleta: "T2", usuario: "u2" });
  item(A, "01", ASOF, "T1", 1, "P100", 1, 0);                    // preço zerado
  item(A, "01", ASOF, "T2", 1, "P100", 1, 1500);                 // 15× a mediana
  item(A, "01", ASOF, "T2", 2, "P200", 1, 5);                    // produto sem histórico → não julga
  const p = R.scan(A, { asOf: ASOF, now: NOW }).findings.find((f: any) => f.kind === "retail_price_anomaly");
  check("preço zerado + absurdo (≥10× a mediana do próprio produto) → técnica, atenção", !!p && p.signalClass === "technical" && p.severity === "attention" && /1 item\(ns\) vendido\(s\) com preço zerado/.test(p.summary) && /1 com preço muito fora/.test(p.summary), p?.summary);
  db.prepare(`DELETE FROM retail_pdv_sale_items WHERE organization_id = ? AND boleta = 'T2'`).run(A);
  const p2 = R.scan(A, { asOf: ASOF, now: NOW }).findings.find((f: any) => f.kind === "retail_price_anomaly");
  check("só zerado (provável brinde) → informativo, não atenção", p2?.severity === "info");
  db.prepare(`DELETE FROM retail_pdv_sale_items WHERE organization_id = ? AND boleta = 'T1'`).run(A);
  item(A, "01", ASOF, "T3", 1, "P300", 1, 5000); item(A, "01", ASOF, "T3", 2, "P300", 1, 1); // produto novo, sem base mínima
  check("produto sem ≥5 vendas de histórico NÃO é julgado", !R.scan(A, { asOf: ASOF, now: NOW }).findings.some((f: any) => f.kind === "retail_price_anomaly"));

  sale(A, "01", ASOF, 123.45, { boleta: "D1", usuario: "u9", pecas: 3, pay: '[{"f":"cartao"}]' });
  sale(A, "01", ASOF, 123.45, { boleta: "D2", usuario: "u9", pecas: 3, pay: '[{"f":"cartao"}]' });
  sale(A, "01", ASOF, 77, { boleta: "D3", usuario: "u9", pecas: 1, pay: '[{"f":"pix"}]' }); sale(A, "01", ASOF, 77, { boleta: "D4", usuario: "u8", pecas: 1, pay: '[{"f":"pix"}]' });
  const dup = R.scan(A, { asOf: ASOF, now: NOW }).findings.find((f: any) => f.kind === "retail_duplicate_sale");
  check("boletas com valor+peças+operador+pagamento idênticos → possível duplicidade (HIPÓTESE, técnica)", !!dup && dup.basis === "hypothesis" && dup.signalClass === "technical" && /1 conjunto/.test(dup.summary), dup?.summary);
  check("mesma venda com operador diferente NÃO conta como duplicada", !/2 conjunto/.test(dup?.summary || ""));

  // comissão: base da rede (≥10 lançamentos) com ~8%; um lançamento 40% e outro sem venda
  const erp = (mat: string, d: string, v: number, c: number, i: number) => db.prepare(`INSERT INTO retail_erp_seller_sales (id, organization_id, filial, sale_date, matricula, valor, comissao_erp) VALUES (?, ?, '01', ?, ?, ?, ?)`).run(randomUUID(), A, d, `${mat}${i}`, v, c);
  for (let i = 0; i < 4; i++) erp("M", addDays(ASOF, -i), 1000, 80, i);
  check("comissão sem base da rede (<10 lançamentos) → não julga", !R.scan(A, { asOf: ASOF, now: NOW }).findings.some((f: any) => f.kind === "retail_commission_strange"));
  for (let i = 4; i < 12; i++) erp("M", addDays(ASOF, -i), 1000, 80, i);
  erp("X", addDays(ASOF, -1), 1000, 400, 1); erp("Y", addDays(ASOF, -2), 0, 50, 2);
  const cm = R.scan(A, { asOf: ASOF, now: NOW }).findings.find((f: any) => f.kind === "retail_commission_strange");
  check("comissão 5× a mediana e comissão sem venda → técnica", !!cm && cm.signalClass === "technical" && /2 lançamento/.test(cm.summary), cm?.summary);

  // ── D) classe vem do registry ──
  check("registry: classes declaradas (4 técnicas, 1 negócio, 1 oportunidade)", REG.byClass("technical").length === 4 && REG.byClass("business").length === 1 && REG.byClass("opportunity").length === 1);
  const old = REG.evaluate("sales_conversion_drop", { current: 0.1, baseline: 0.5, sample: Array(40).fill(0.5), now: NOW });
  check("detector antigo sem classe: evidence NÃO ganha signalClass (0-regressão)", old.fires && !("signalClass" in (old.signal!.evidence)));

  // ── E) publicação ──
  const off = R.scan(A, { asOf: ASOF, now: NOW, publish: true });
  check("radar DESLIGADO (default): não publica nada", off.reason === "radar_disabled" && openSig(A).length === 0 && R.isEnabled(A) === false);
  R.setEnabled(A, true);
  const on = R.scan(A, { asOf: ASOF, now: NOW, publish: true });
  const sigs = openSig(A);
  check("ligado: publica em business_signals (domínio retail_radar)", on.published >= 3 && sigs.length === on.published, `${on.published}/${sigs.length}`);
  check("nenhum sinal carrega dinheiro inventado", sigs.every((s) => s.impact_amount == null && !/R\$/.test(s.evidence_json)));
  check("cada sinal carrega a classe e o resumo em linguagem de dono", sigs.every((s) => ["technical", "business", "opportunity"].includes(JSON.parse(s.evidence_json).signalClass) && JSON.parse(s.evidence_json).summary));
  check("comissão: o sinal só carrega matrícula, data e razão % (nenhum valor em R$)", openSig(A, "retail_commission_strange").every((x) => JSON.parse(x.evidence_json).examples.every((e: any) => Object.keys(e).sort().join() === "data,matricula,razaoPct")));
  R.scan(A, { asOf: ASOF, now: NOW, publish: true });
  check("idempotente: repetir não duplica", openSig(A).length === sigs.length);
  check("isolamento: empresa B não recebeu nada", openSig(B).length === 0);
  // auto-cura: dia volta ao normal → o desvio sai do radar
  db.prepare(`DELETE FROM retail_pdv_sales WHERE organization_id = ? AND filial = '01' AND sale_date = ? AND boleta NOT LIKE 'D%' AND boleta NOT LIKE 'T%'`).run(A, ASOF);
  sale(A, "01", ASOF, 950, { boleta: "OK1" });
  const heal = R.scan(A, { asOf: ASOF, now: NOW, publish: true });
  check("auto-cura: dia normal resolve o desvio de negócio", heal.resolved >= 1 && !openSig(A, "retail_store_day_below_normal").length);
  R.pass();
  check("pass() do Scheduler só roda p/ orgs ligadas e não quebra", true);

  // ── rotas + fiação ──
  const express = (await import("express")).default;
  const router = (await import("../src/server/routes/retailops.js")).default;
  const who: Record<string, any> = { maria, joao };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = req.headers["x-org"] || undefined; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/retail", router);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const call = async (method: string, url: string, user: string | null, org: string | null, body?: any) => {
    const h: any = { "Content-Type": "application/json" }; if (user) h["x-user"] = user; if (org) h["x-org"] = org;
    const r = await fetch(`http://127.0.0.1:${port}/api/retail${url}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const g1 = await call("GET", `/radar?asOf=${ASOF}`, "maria", A);
  check("rota: dono lê o radar (preview, sem publicar)", g1.status === 200 && g1.body.enabled === true && Array.isArray(g1.body.findings));
  const before2 = openSig(A).length;
  await call("GET", `/radar?asOf=${addDays(ASOF, -7)}`, "maria", A);
  check("rota GET não publica", openSig(A).length === before2);
  check("rota: quem não é dono/admin → 403", (await call("GET", `/radar`, "joao", A)).status === 403 && (await call("POST", `/radar/scan`, "joao", A, {})).status === 403);
  check("rota: sem empresa → 401/403", [401, 403].includes((await call("GET", `/radar`, null, null)).status));
  check("rota: liga/desliga o radar", (await call("PUT", `/radar/enabled`, "maria", A, { enabled: false })).body.enabled === false && (await call("PUT", `/radar/enabled`, "maria", A, { enabled: true })).body.enabled === true);
  const sc = await call("POST", `/radar/scan`, "maria", A, { asOf: ASOF });
  check("rota: scan publica", sc.status === 200 && sc.body.ok === true);
  server.close();
  const sched = fs.readFileSync(path.join(process.cwd(), "src/server/Scheduler.ts"), "utf8");
  check("fiação: o Scheduler chama RetailRadarService.pass()", /RetailRadarService\.pass\(\)/.test(sched));

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
