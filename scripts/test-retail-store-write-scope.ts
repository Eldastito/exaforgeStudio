/**
 * TESTE — trava POR LOJA nas rotas de ESCRITA da Retail Ops (levantamento de 01/10/2026; ADR-173).
 * Achado: o gerente (admin COM loja atribuída) passava `requireRole("owner","admin")` e escrevia em QUALQUER loja
 * (fechamento, cota, escala, estoque, malote, lotação de vendedor...) e alterava configuração da rede inteira.
 * Prova, por HTTP: gerente da loja A leva 403 na loja B e passa na própria; config da rede é só de owner/co-admin;
 * aprovar fechamento é do DONO (a menos que ele libere os gerentes); co-admin sem loja e owner seguem como antes.
 * Uso:  npm run test:retail-store-write-scope
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-store-write-scope-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-store-write-scope-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));
  const express = (await import("express")).default;
  const { default: retailRoutes } = await import("../src/server/routes/retailops.js");
  const { RetailStoreService: Stores } = await import("../src/server/RetailStoreService.js");
  const { RetailStoreScopeService: Scope } = await import("../src/server/RetailStoreScopeService.js");

  const app = express();
  app.use(express.json());
  app.use("/api/retailops", (req: any, _res: any, next: any) => {
    req.organizationId = req.headers["x-test-org"] || null;
    req.user = { userId: req.headers["x-test-user"] || "u1", role: req.headers["x-test-role"] || "owner", organizationId: req.organizationId };
    next();
  }, retailRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/retailops`;
  const call = async (method: string, p: string, org: string, who: "owner" | "ger" | "co" | "agent", body?: any) => {
    const hdr: Record<string, string> = { owner: "owner|u_owner", ger: "admin|u_ger", co: "admin|u_co", agent: "agent|u_agent" };
    const [role, user] = hdr[who].split("|");
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-test-org": org, "x-test-role": role, "x-test-user": user }, body: body ? JSON.stringify(body) : undefined });
    let j: any = null; try { j = await r.json(); } catch { /* sem corpo */ }
    return { status: r.status, body: j };
  };

  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const mk = (org: string, name: string) => Stores.create(org, { name, code: name.slice(0, 4) + randomUUID().slice(0, 3) } as any).id;
  const S1 = mk(A, "Minha"), S2 = mk(A, "Outra"), S3 = mk(A, "Terceira"), SB = mk(B, "LojaB");
  Scope.setForUser(A, "u_ger", [S1], "u_owner");                 // gerente = admin COM a loja S1; u_co = admin sem loja
  const D = "2026-09-30";
  let dayN = 0;
  const closingOf = (st: string, status = "received", v = 100) => { const id = randomUUID(); const date = dayN++ === 0 ? D : `2026-08-${String(dayN).padStart(2, "0")}`; db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, ?, ?, ?)`).run(id, A, st, date, status, v); return id; };
  const c1 = closingOf(S1), c2 = closingOf(S2);
  const resp2 = randomUUID(); db.prepare(`INSERT INTO retail_store_responsibles (id, organization_id, store_id, name, whatsapp_identifier) VALUES (?, ?, ?, 'R', '5521999999999')`).run(resp2, A, S2);
  const alert2 = randomUUID(); db.prepare(`INSERT INTO retail_stock_alerts (id, organization_id, store_id, status) VALUES (?, ?, ?, 'open')`).run(alert2, A, S2);
  const tr = (o: string, d: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stock_transfers (id, organization_id, origin_store_id, dest_store_id, status) VALUES (?, ?, ?, ?, 'in_transit')`).run(id, A, o, d); return id; };
  const t23 = tr(S2, S3), t21 = tr(S2, S1);
  const rec2 = randomUUID(); db.prepare(`INSERT INTO retail_goods_receipts (id, organization_id, store_id, status) VALUES (?, ?, ?, 'open')`).run(rec2, A, S2);
  const prod = randomUUID(); db.prepare(`INSERT INTO products_services (id, organization_id, name, type) VALUES (?, ?, 'P', 'product')`).run(prod, A);

  // ── (1) gerente da loja S1 NÃO escreve na loja S2 ──
  const other: Array<[string, string, any?]> = [
    ["POST", "/closings", { storeId: S2, closingDate: D }],
    ["POST", `/closings/${c2}/inform`, { informedTotal: 50 }],
    ["POST", `/closings/${c2}/quota`, { amount: 1 }],
    ["POST", `/closings/${c2}/detailed`, { details: {} }],
    ["DELETE", `/closings/${c2}`],
    ["POST", "/quotas", { storeId: S2, quotaDate: D, quotaAmount: 1 }],
    ["POST", "/quotas/distribute-monthly", { storeId: S2, month: "2026-10", monthlyAmount: 1000 }],
    ["PUT", "/schedule", { storeId: S2, start: D, end: D, entries: [] }],
    ["POST", "/schedule/copy-week", { storeId: S2, fromStart: D, toStart: "2026-10-07" }],
    ["PUT", "/schedule/off-pattern", { storeId: S2, patterns: [] }],
    ["POST", "/schedule/apply-template", { storeId: S2, start: D, end: D }],
    ["PUT", "/seller-quotas", { storeId: S2, weekStart: D, quotas: [] }],
    ["POST", "/stock/adjust", { storeId: S2, productServiceId: prod, delta: 1 }],
    ["POST", `/stock/alerts/${alert2}/resolve`, {}],
    ["POST", "/boletas/day/open", { storeId: S2, initialNumber: "1" }],
    ["POST", "/boletas/click", { storeId: S2 }],
    ["PUT", `/stores/${S2}/card-brands`, { brands: [] }],
    ["POST", `/stores/${S2}/responsibles`, { name: "X", whatsapp: "5521988888888" }],
    ["PATCH", `/responsibles/${resp2}`, { name: "Y" }],
    ["DELETE", `/responsibles/${resp2}`],
    ["POST", "/receiving", { storeId: S2 }],
    ["POST", `/receiving/${rec2}/scan`, { ean: "1" }],
    ["POST", `/receiving/${rec2}/confirm`, {}],
    ["POST", "/scan/receive", { ean: "1", qty: 1, storeId: S2 }],
    ["PUT", "/online-reserve/item", { storeId: S2, productId: prod, qty: 1 }],
    ["POST", "/transfers", { originStoreId: S2, destStoreId: S3, items: [] }],
    ["POST", `/transfers/${t23}/receive`, {}],
    ["POST", `/transfers/${t23}/cancel`, {}],
    ["PUT", "/cash/day-override", { storeId: S2, date: D, amount: 1 }],
    ["POST", "/cash/week/reopen", { storeId: S2, weekStart: D }],
    ["POST", `/sellers/${randomUUID()}/assignments`, { storeId: S2, type: "fixed", startDate: D }],
  ];
  const bad1: string[] = [];
  for (const [m, p, b] of other) { const r = await call(m, p, A, "ger", b); if (r.status !== 403) bad1.push(`${m} ${p.replace(/[0-9a-f-]{36}/g, ":id")}→${r.status}`); }
  check(`gerente da loja S1: ${other.length} escritas na loja S2 respondem 403`, bad1.length === 0, bad1.join(" | "));

  // ── (2) a PRÓPRIA loja segue funcionando (não travei o dia a dia) ──
  const own: Array<[string, string, any, number[]]> = [
    ["POST", "/closings", { storeId: S1, closingDate: "2026-09-29" }, [201]],
    ["POST", `/closings/${c1}/inform`, { informedTotal: 120 }, [200]],
    ["POST", `/closings/${c1}/quota`, { amount: 500 }, [200]],
    ["POST", "/quotas", { storeId: S1, quotaDate: D, quotaAmount: 700 }, [201]],
    ["PUT", "/schedule", { storeId: S1, start: D, end: D, entries: [] }, [200]],
    ["POST", "/stock/adjust", { storeId: S1, productServiceId: prod, delta: 1 }, [200]],
    ["POST", "/transfers", { originStoreId: S2, destStoreId: S1, items: [] }, [400]],   // passa a trava (any-side); 400 = validação de itens
    ["POST", `/transfers/${t21}/cancel`, {}, [200, 400]],                                // recebe/cancela transferência que CHEGA na loja dele
  ];
  const bad2: string[] = [];
  for (const [m, p, b, ok] of own) { const r = await call(m, p, A, "ger", b); if (!ok.includes(r.status)) bad2.push(`${m} ${p.replace(/[0-9a-f-]{36}/g, ":id")}→${r.status}`); }
  check("gerente da loja S1: as mesmas escritas na PRÓPRIA loja continuam passando", bad2.length === 0, bad2.join(" | "));
  const own2 = ["PUT /cash/day-override", "POST /cash/week/reopen"];
  const r5 = await call("PUT", "/cash/day-override", A, "ger", { storeId: S1, date: D, amount: 10 });
  check("malote: gerente mexe no da PRÓPRIA loja (day-override 200) e é barrado no da outra", r5.status === 200 && (await call("PUT", "/cash/day-override", A, "ger", { storeId: S2, date: D, amount: 10 })).status === 403, own2.join());

  // ── (3) loja não identificável → 403 para restrito (nunca "na dúvida, libera") ──
  const ghost = randomUUID();
  const g1 = await call("POST", `/closings/${ghost}/inform`, A, "ger", { informedTotal: 1 });
  const g2 = await call("POST", "/receiving", A, "ger", {});
  const g3 = await call("POST", `/closings/${ghost}/inform`, A, "co", { informedTotal: 1 });
  check("restrito + fechamento inexistente/sem loja no pedido → 403; co-admin sem loja → 404 (validação normal)", g1.status === 403 && g2.status === 403 && g3.status === 404, JSON.stringify([g1.status, g2.status, g3.status]));

  // ── (4) config da REDE: owner e co-admin passam; gerente leva 403 ──
  const net: Array<[string, string, any?]> = [
    ["PUT", "/revenue-bridge", { enabled: false }], ["PUT", "/official-sale-source", { source: "folha" }], ["POST", "/signals/refresh", {}],
    ["PUT", "/online-reserve/flag", { enabled: false }], ["PUT", "/online-reserve/default-seller", { userId: null }], ["POST", "/online-reserve/confirm", {}],
    ["PUT", "/patterns/flag", { enabled: false }], ["POST", "/patterns/learn", {}], ["POST", "/reconciliation/import", {}],
    ["POST", "/stock-mode", { mode: "supervisor" }], ["POST", `/stock-mode/store/${S2}`, { mode: null }], ["POST", `/stock-mode/graduate/${S2}`, {}],
    ["POST", "/activation/activate", {}], ["POST", "/activation/deactivate", {}], ["POST", "/card-acquirer/import", {}], ["PUT", "/card-receivable-mode", { mode: "x" }],
    ["PUT", "/sellers/123", { name: "Z" }], ["DELETE", `/sellers/${randomUUID()}`], ["PUT", `/sellers/${randomUUID()}/stores`, { storeIds: [S2] }],
    ["DELETE", `/sellers/aliases/${randomUUID()}`], ["POST", "/pdv-catalog/backfill", {}], ["PUT", "/feature-flags/business_date", { enabled: true }],
    ["POST", "/quotas/import", { rows: [] }], ["POST", "/quotas/suggest", { date: D }], ["POST", "/tasks/generate-day", { date: D }],
    ["POST", "/stock-policies", { storeId: S2 }], ["DELETE", `/stock-policies/${randomUUID()}`], ["DELETE", `/sellers/absences/${randomUUID()}`],
    ["PUT", "/seller-scoreboard/fortnight-visibility", { enabled: true }], ["PUT", "/month-weeks", {}], ["POST", "/dashboard/money-audit/refresh", {}],
    ["POST", "/impact/baseline/capture", {}], ["POST", "/pricing/apply", {}], ["POST", "/diagnostic/apply", {}], ["PUT", "/closing-approval-policy", { managerCanApprove: true }],
  ];
  const badG: string[] = [], badO: string[] = [], badC: string[] = [];
  for (const [m, p, b] of net) {
    const tag = `${m} ${p.replace(/[0-9a-f-]{36}/g, ":id")}`;
    if ((await call(m, p, A, "ger", b)).status !== 403) badG.push(tag);
    if ([401, 403].includes((await call(m, p, A, "owner", b)).status)) badO.push(tag);
    if ([401, 403].includes((await call(m, p, A, "co", b)).status)) badC.push(tag);
  }
  // o teste acima pode ter ligado a política com owner; volta ao padrão (OFF) p/ a seção seguinte
  db.prepare(`UPDATE organization_settings SET retail_manager_can_approve = 0 WHERE organization_id = ?`).run(A);
  check(`gerente: ${net.length} rotas de config da rede respondem 403`, badG.length === 0, badG.join(" | "));
  check("owner: nenhuma dessas é barrada (0-regressão)", badO.length === 0, badO.join(" | "));
  check("co-admin (admin sem loja): nenhuma dessas é barrada (0-regressão)", badC.length === 0, badC.join(" | "));
  check("agent: rotas de config seguem 403", (await call("PUT", "/feature-flags/business_date", A, "agent", { enabled: true })).status === 403);

  // ── (5) aprovação do fechamento é do DONO, a menos que ele libere ──
  const c1b = closingOf(S1, "received", 300);
  const a1 = await call("POST", `/closings/${c1b}/approve`, A, "ger");
  const a2 = await call("POST", `/closings/${c1b}/reject`, A, "ger");
  check("gerente informa mas NÃO aprova nem rejeita o fechamento da própria loja (403, política padrão)", a1.status === 403 && a2.status === 403 && /dono/i.test(a1.body?.error || ""), JSON.stringify([a1.status, a2.status]));
  const pol0 = await call("GET", "/closing-approval-policy", A, "ger");
  check("política padrão: gerente NÃO aprova (managerCanApprove=false)", pol0.status === 200 && pol0.body?.managerCanApprove === false);
  check("gerente não consegue liberar a si mesmo (PUT da política = 403)", (await call("PUT", "/closing-approval-policy", A, "ger", { managerCanApprove: true })).status === 403);
  check("política exige boolean (400)", (await call("PUT", "/closing-approval-policy", A, "owner", { managerCanApprove: "sim" })).status === 400);
  const ap = await call("POST", `/closings/${c1b}/approve`, A, "owner");
  check("owner aprova (0-regressão)", ap.status === 200 && ap.body?.status === "approved", JSON.stringify(ap.body?.status));
  const e1 = await call("POST", `/closings/${c1b}/inform`, A, "ger", { informedTotal: 1 });
  const e2 = await call("DELETE", `/closings/${c1b}`, A, "ger");
  check("fechamento APROVADO: o gerente não reescreve nem exclui (senão burlaria a aprovação)", e1.status === 403 && e2.status === 403, JSON.stringify([e1.status, e2.status]));
  check("co-admin sem loja aprova (como antes)", (await call("POST", `/closings/${c2}/approve`, A, "co")).status === 200);
  const on = await call("PUT", "/closing-approval-policy", A, "owner", { managerCanApprove: true });
  check("dono libera o gerente (PUT 200, managerCanApprove=true)", on.status === 200 && on.body?.managerCanApprove === true);
  const c1c = closingOf(S1, "received", 400);
  check("liberado: gerente aprova o fechamento da PRÓPRIA loja…", (await call("POST", `/closings/${c1c}/approve`, A, "ger")).status === 200);
  const c2b = closingOf(S2, "received", 400);
  check("…mas continua barrado na OUTRA loja (a trava por loja vale mesmo liberado)", (await call("POST", `/closings/${c2b}/approve`, A, "ger")).status === 403);
  check("liberado: gerente volta a poder corrigir fechamento aprovado da própria loja", (await call("POST", `/closings/${c1c}/inform`, A, "ger", { informedTotal: 410 })).status === 200);

  // ── (6) isolamento entre orgs ──
  const iso = await call("POST", "/closings", B, "owner", { storeId: S1, closingDate: D });
  check("isolamento: owner da org B não abre fechamento em loja da org A (404)", iso.status === 404, String(iso.status));
  const xorg: Array<[string, string, any?]> = [
    ["POST", "/quotas", { storeId: S1, quotaDate: D, quotaAmount: 1 }],
    ["PUT", "/schedule", { storeId: S1, start: D, end: D, entries: [] }],
    ["POST", "/stock/adjust", { storeId: S1, productServiceId: prod, delta: 1 }],
    ["POST", "/boletas/day/open", { storeId: S1, initialNumber: "1" }],
    ["POST", "/receiving", { storeId: S1 }],
    ["POST", `/stores/${S1}/responsibles`, { name: "X", whatsapp: "5521988888888" }],
    ["PUT", `/stores/${S1}/card-brands`, { brands: [] }],
    ["PUT", "/online-reserve/item", { storeId: S1, productId: prod, qty: 1 }],
    ["POST", "/transfers", { originStoreId: S1, destStoreId: SB, items: [] }],
    ["PUT", "/cash/day-override", { storeId: S1, date: D, amount: 1 }],
  ];
  const badX: string[] = [];
  for (const [m, p, b] of xorg) { const r = await call(m, p, B, "owner", b); if (r.status >= 200 && r.status < 300) badX.push(`${m} ${p.replace(/[0-9a-f-]{36}/g, ":id")}→${r.status}`); }
  check("isolamento: owner da org B não escreve em loja da org A em nenhuma dessas rotas (nenhum 2xx)", badX.length === 0, badX.join(" | "));
  const isoG = await call("POST", "/closings", B, "ger", { storeId: SB, closingDate: D });
  check("isolamento: o mesmo user id sem loja atribuída na org B segue irrestrito lá (escopo é por org)", isoG.status === 201, String(isoG.status));

  server.close();
  const pass = results.filter((r) => r.ok).length;
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${!r.ok && r.detail ? `\n      ↳ ${r.detail}` : ""}`);
  console.log(failures ? `\n${failures} FALHA(S) (${pass}/${results.length} ok)` : `\n${pass}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
