/**
 * TESTE — Gerente de loja só LÊ os dados da própria loja (ADR-173, lado da LEITURA)
 * ----------------------------------------------------------------------------
 * O gerente é "admin COM loja atribuída". A trava de ESCRITA já existia
 * (`requireStoreAccess`), mas várias rotas de LEITURA da Operação da Rede devolviam a
 * rede inteira, ou aceitavam o `storeId` de OUTRA loja só checando que a loja existe
 * na org. Este teste é a rede de segurança: sobe a API real (router `retailops`) com
 * 2 lojas na MESMA org, cada uma com dados distintos e MARCADORES únicos, e percorre
 * TODAS as rotas GET do router como gerente da loja A, tentando (a) sem `storeId` e
 * (b) com o `storeId` da loja B. Nenhum corpo de resposta pode conter marcador da B.
 * Também prova que o gerente ENXERGA o que é da própria loja (A) e que o dono vê tudo.
 *
 * Uso:  npm run test:retail-manager-read-scope
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";
import express from "express";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mgr-read-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-mgr-read-scope-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreScopeService } = await import("../src/server/RetailStoreScopeService.js");
  const router = (await import("../src/server/routes/retailops.js")).default;
  const { todaySP } = await import("../src/server/spDate.js");

  const ORG = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'TOULON', 'active')`).run(randomUUID(), ORG);

  const A = randomUUID(), B = randomUUID(), C = randomUUID();
  const mkStore = (id: string, name: string, code: string) => db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, ?, ?, 1)`).run(id, ORG, name, code);
  mkStore(A, "Loja Carioca-AAA", "AAA"); mkStore(B, "Loja Alfa-AVB-Zeta", "ZZB"); mkStore(C, "Loja Terceira-CCC", "CCC");

  const today = todaySP();
  const D = "2026-10-01";
  const exec = (sql: string, ...a: any[]) => db.prepare(sql).run(...a);

  // ── dados distintos por loja ──
  const closingIds: Record<string, string> = {};
  for (const [sid, amount, tag] of [[A, 1111.11, "A"], [B, 7777.77, "B"]] as const) {
    for (const d of [today, D]) {
      const id = randomUUID(); if (d === today) closingIds[tag] = id;
      exec(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total) VALUES (?, ?, ?, ?, 'approved', ?, ?)`, id, ORG, sid, d, amount, amount);
      exec(`INSERT INTO retail_daily_closing_items (id, organization_id, closing_id, payment_method, informed_amount, system_amount, difference_amount) VALUES (?, ?, ?, 'dinheiro', ?, ?, 0)`, randomUUID(), ORG, id, amount, amount);
    }
    for (const d of [today, D]) exec(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount) VALUES (?, ?, ?, ?, ?)`, randomUUID(), ORG, sid, d, sid === A ? 2222 : 4321);
    exec(`INSERT INTO retail_store_monthly_goals (id, organization_id, store_id, month, goal_amount) VALUES (?, ?, ?, ?, ?)`, randomUUID(), ORG, sid, "2026-10", sid === A ? 50000 : 99999);
    exec(`INSERT INTO retail_cash_deposits (id, organization_id, store_id, deposit_date, amount, depositor) VALUES (?, ?, ?, ?, ?, ?)`, randomUUID(), ORG, sid, D, sid === A ? 1500 : 6666.66, sid === A ? "DepositanteA" : "DepositanteB");
    exec(`INSERT INTO retail_boleta_days (id, organization_id, store_id, day, initial_number) VALUES (?, ?, ?, ?, ?)`, randomUUID(), ORG, sid, D, sid === A ? 1001 : 55555);
    exec(`INSERT INTO retail_boleta_days (id, organization_id, store_id, day, initial_number) VALUES (?, ?, ?, ?, ?)`, randomUUID(), ORG, sid, today, sid === A ? 1002 : 55556);
    const sellerId = randomUUID(), nm = sid === A ? "SellerAlfaA" : "SellerZetaB";
    exec(`INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, ?, ?, 1)`, sellerId, ORG, sid === A ? "9001" : "9002", nm);
    exec(`INSERT INTO retail_seller_store_assignments (id, organization_id, seller_id, store_id, is_primary, active) VALUES (?, ?, ?, ?, 1, 1)`, randomUUID(), ORG, sellerId, sid);
    for (const d of [today, D]) exec(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status) VALUES (?, ?, ?, ?, ?, ?, 'work')`, randomUUID(), ORG, sid, d, sid === A ? "9001" : "9002", sid === A ? "VendedoraDaA" : "VendedoraDaB");
    exec(`INSERT INTO retail_seller_quotas (id, organization_id, store_id, seller_key, seller_name, week_start, quota_amount) VALUES (?, ?, ?, ?, ?, ?, ?)`, randomUUID(), ORG, sid, sid === A ? "9001" : "9002", nm, "2026-10-01", sid === A ? 3000 : 3333.33);
    exec(`INSERT INTO retail_boleta_events (id, organization_id, store_id, day, boleta_number, seq, seller_name, status) VALUES (?, ?, ?, ?, ?, 1, ?, 'active')`, randomUUID(), ORG, sid, D, sid === A ? 1001 : 55555, sid === A ? "SellerAlfaA" : "SellerZetaB");
    for (const d of [today, D]) exec(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, sale_time, vendedor, valor, pecas, status) VALUES (?, ?, ?, ?, ?, '10:00:00', ?, ?, 2, 'N')`, randomUUID(), ORG, sid === A ? "AAA" : "ZZB", `${sid === A ? "1" : "2"}${d.replace(/-/g, "")}`, d, nm, sid === A ? 1234.56 : 8888.88);
  }
  // transferência só entre B e C (o gerente da A não faz parte)
  exec(`INSERT INTO retail_stock_transfers (id, organization_id, origin_store_id, dest_store_id, status, note) VALUES (?, ?, ?, ?, 'pending', 'TransfBC')`, randomUUID(), ORG, B, C);

  // ── usuários: dono + gerente (admin COM loja A) ──
  const mkUser = (role: string, email: string) => { const id = randomUUID(); exec(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, ?, ?, ?, 'active')`, id, ORG, email, email, role); return id; };
  const ownerId = mkUser("owner", "dono@t.com"), mgrId = mkUser("admin", "gerente@t.com");
  RetailStoreScopeService.setForUser(ORG, mgrId, [A], ownerId);

  // ── mini-app com o router real; o "login" é um header ──
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => {
    const who = String(req.headers["x-who"] || "");
    req.organizationId = ORG;
    req.user = who === "owner" ? { userId: ownerId, role: "owner", organizationId: ORG } : { userId: mgrId, role: "admin", organizationId: ORG };
    next();
  });
  app.use("/api/retailops", router);
  const server = http.createServer(app);
  const port: number = await new Promise((r) => server.listen(0, () => r((server.address() as any).port)));
  const get = async (who: "owner" | "mgr", url: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/retailops${url}`, { headers: { "x-who": who } });
    return { status: res.status, text: await res.text() };
  };

  const B_MARK = /Alfa-AVB-Zeta|\bZZB\b|7777\.77|4321|99999|DepositanteB|6666\.66|55555|55556|VendedoraDaB|SellerZetaB|8888\.88|3333\.33|TransfBC/;
  const bId = B;
  const A_MARK = /Carioca-AAA|\bAAA\b|1111\.11|2222|DepositanteA|VendedoraDaA|SellerAlfaA/;

  // ── enumera TODAS as rotas GET do router (fonte da verdade = o arquivo) ──
  const src = fs.readFileSync(path.join(process.cwd(), "src/server/routes/retailops.ts"), "utf8");
  const getRoutes = [...src.matchAll(/^router\.get\("([^"]+)"/gm)].map((m) => m[1]).filter((p) => !/export|diagnostic\/questions|scan\/lookup/.test(p));
  check("enumerou as rotas GET do router (>60)", getRoutes.length > 60, String(getRoutes.length));

  const subst = (p: string, sid: string) => p.replace(/:storeId|:id(?=\/|$)/g, (m) => (p.startsWith("/closings/") ? closingIds.B : p.startsWith("/transfers/") ? "x" : sid)).replace(/:[A-Za-z]+/g, "x");
  const qs = (sid: string | null) => `?${sid ? `storeId=${sid}&` : ""}date=${D}&day=${D}&month=2026-10&start=2026-09-01&end=2026-10-31&weekStart=2026-09-28&period=month`;

  const leaks: string[] = [];
  const blind = new Set(getRoutes);
  for (const p of getRoutes) {
    for (const sid of [null, bId]) {
      const url = subst(p, bId) + qs(sid);
      const m = await get("mgr", url);
      if (m.status === 200 && B_MARK.test(m.text)) leaks.push(`${p} ${sid ? "(storeId=B)" : "(lista)"}`);
      const o = await get("owner", url);
      if (o.status === 200 && B_MARK.test(o.text)) blind.delete(p);
    }
  }
  check("NENHUMA rota GET devolve dado da loja B ao gerente da loja A", leaks.length === 0, leaks.join(" | "));
  // a cobertura do scanner: o dono TEM que ver marcador da B nas rotas que carregam dado de loja
  const mustCover = ["/closings", "/closings/week", "/quotas", "/boletas/day", "/boletas/history", "/cash/ledger", "/seller-quotas", "/schedule", "/schedule/day-roster", "/transfers", "/dashboard/money-audit"];
  const notCovered = mustCover.filter((p) => blind.has(p));
  check("scanner enxerga o dado da B pelo dono nas rotas-chave (não é cego)", notCovered.length === 0, notCovered.join(", "));

  // ── o gerente ENXERGA o que é da própria loja ──
  const ownAt = async (url: string) => { const r = await get("mgr", url); return r.status === 200 && A_MARK.test(r.text); };
  check("gerente vê o fechamento da própria loja", await ownAt(`/closings?date=${today}`));
  check("gerente vê a cota da própria loja", await ownAt(`/quotas?date=${today}`));
  check("gerente vê o caixa/depósitos da própria loja", await ownAt(`/cash/ledger?storeId=${A}&month=2026-10`));
  check("gerente vê a escala da própria loja", await ownAt(`/schedule?storeId=${A}&start=2026-09-28&end=2026-10-04`));
  check("gerente vê as boletas da própria loja", (await get("mgr", `/boletas/day?storeId=${A}&day=${D}`)).status === 200);

  check("gerente vê as vendas por vendedor do PDV da própria loja", await ownAt(`/pdv-sellers?start=2026-09-01&end=2026-10-31`));
  const ps = JSON.parse((await get("mgr", `/pdv-sellers?start=2026-09-01&end=2026-10-31`)).text || "{}");
  check("…sem a comissão estimada (política de rede, do dono)", ps.commissionPercent === null && (ps.sellers || []).every((x: any) => x.commission === null));
  check("gerente vê a meta mensal só da própria loja", await ownAt(`/monthly-goals?month=2026-10`) && !/99999/.test((await get("mgr", `/monthly-goals?month=2026-10`)).text));
  const sl = JSON.parse((await get("mgr", `/sellers`)).text || "{}");
  check("lista de vendedores do gerente = só os da loja dele", (sl.sellers || []).length === 1 && sl.sellers[0].name === "SellerAlfaA", JSON.stringify(sl.sellers));
  check("gerente vê o histórico mensal só da própria loja", await ownAt(`/dashboard/monthly?month=2026-10`) && JSON.parse((await get("mgr", `/dashboard/monthly?month=2026-10`)).text).commissionEstimate === null);
  check("rota de rede continua barrada ao gerente (resultado/lucro por loja)", (await get("mgr", `/stores-result?period=month`)).status === 403);

  // ── ataque direto por id: loja B / fechamento da B / transferência B→C ──
  for (const [label, url] of [["fechamento da B", `/closings/${closingIds.B}`], ["caixa da B", `/cash/ledger?storeId=${B}&month=2026-10`], ["escala da B", `/schedule?storeId=${B}&start=2026-09-28&end=2026-10-04`], ["boletas da B", `/boletas/day?storeId=${B}&day=${D}`], ["cota de vendedor da B", `/seller-quotas?storeId=${B}&month=2026-10`]] as [string, string][]) {
    const r = await get("mgr", url);
    check(`gerente NÃO abre ${label} (403/404)`, r.status === 403 || r.status === 404, `${r.status}`);
  }

  // ── o dono segue vendo TUDO (0-regressão) ──
  const oc = await get("owner", `/closings?date=${today}`);
  check("dono vê os fechamentos das 2 lojas", /1111\.11/.test(oc.text) && /7777\.77/.test(oc.text));

  console.log("\n=== Gerente de loja: leitura só da própria loja ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} retail-manager-read-scope: ${results.length - failures}/${results.length} checks`);
  server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } process.exit(1); });
