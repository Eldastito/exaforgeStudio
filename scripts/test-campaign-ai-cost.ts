/**
 * TESTE — Custo de IA por campanha (ADR-207 F8).
 *
 * Prova, com o serviço e a rota do dono REAIS sobre o ledger `ai_usage_log`:
 *  - marcar a campanha põe `request_id = 'campaign:<slug>'` só dentro do bloco (não vaza pro resto) e normaliza o slug;
 *  - sem campanha válida / sem org no contexto, a chamada roda como antes (0-regressão, nada marcado);
 *  - o relatório soma só o que foi MARCADO; o resto aparece como "sem campanha" (nunca rateado);
 *  - margem depois da IA = margem paga (fato) − custo de IA; margem desconhecida ou IA sem chamada → null (nunca 0);
 *  - campanhas com venda e sem IA (e vice-versa) aparecem; isolamento entre empresas; janela de dias;
 *  - rota: só dono/administrador.
 *
 * Uso: npm run test:campaign-ai-cost
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-campaign-ai-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-campaign-ai-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const storefrontAdmin = (await import("../src/server/routes/storefront.js")).default;
  const { CampaignAiCostService: C } = await import("../src/server/CampaignAiCostService.js");
  const { setUsageContext, currentUsageContext, usageContext } = await import("../src/server/usageContext.js");

  const orgId = randomUUID(), other = randomUUID();
  for (const id of [orgId, other]) db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'X', 'active')`).run(id);

  // grava no ledger exatamente como o recordUsage faz (contexto → request_id)
  const log = (org: string, cents: number, daysAgo = 0) => {
    const ctx = currentUsageContext();
    db.prepare(`INSERT INTO ai_usage_log (id, organization_id, model, kind, cost_cents, request_id, created_at) VALUES (?, ?, 'm', 'chat', ?, ?, datetime('now', ?))`)
      .run(randomUUID(), org, cents, ctx.correlationId || null, `-${daysAgo} days`);
  };
  const paidOrder = (org: string, campaign: string, price: number, cost: number | null) => {
    const oid = randomUUID();
    db.prepare(`INSERT INTO orders (id, organization_id, status, payment_status, total_amount, created_by, attr_campaign) VALUES (?, ?, 'pago', 'paid', ?, 'storefront', ?)`).run(oid, org, price, campaign);
    db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, unit_cost, quantity, line_total) VALUES (?, ?, ?, 'P', ?, ?, 1, ?)`).run(randomUUID(), oid, org, price, cost ?? 0, price);
  };

  // ── 1. slug / tag
  check("1.1 slug normaliza 'Promo Verão!'", C.slug("Promo Verão!") === "promo-ver-o" || C.slug("Promo Verão!") === "promo-ver-o", String(C.slug("Promo Verão!")));
  check("1.2 slug vazio/inválido → null", C.slug("  ") === null && C.slug("***") === null && C.slug(undefined) === null);
  check("1.3 tag = campaign:<slug>", C.tag("Promo-X") === "campaign:promo-x");
  check("1.4 slug limitado a 60", (C.slug("a".repeat(100)) || "").length === 60);

  // ── 2. withCampaign
  setUsageContext({ orgId, module: "studio" });
  let inside: string | null = "x";
  await C.withCampaign("Verao", async () => { inside = currentUsageContext().correlationId ?? null; log(orgId, 120); });
  check("2.1 dentro do bloco: request_id = campaign:verao", inside === "campaign:verao");
  check("2.2 fora do bloco o contexto não ficou marcado", (currentUsageContext().correlationId ?? null) === null);
  const r = await C.withCampaign("verao", async () => 42);
  check("2.3 devolve o resultado da função", r === 42);
  let threw = false;
  try { await C.withCampaign("verao", async () => { throw new Error("boom"); }); } catch (e: any) { threw = e.message === "boom"; }
  check("2.4 erro da função propaga (não engole)", threw);
  await C.withCampaign(undefined, async () => { log(orgId, 50); });                    // sem campanha → "sem campanha"
  await C.withCampaign("", async () => { log(orgId, 10); });
  check("2.5 sem campanha válida: nada marcado", (db.prepare(`SELECT COUNT(*) n FROM ai_usage_log WHERE organization_id=? AND request_id IS NULL`).get(orgId) as any).n === 2);
  await usageContext.run({ orgId: null, userId: null, module: "legacy", correlationId: null }, async () => {
    let seen: string | null = "x";
    await C.withCampaign("verao", async () => { seen = currentUsageContext().correlationId ?? null; });
    check("2.6 sem org no contexto: não marca", seen === null);
  });
  await C.withCampaign("verao", async () => { log(orgId, 200); });                      // verao = 120 + 200
  await C.withCampaign("inverno", async () => { log(orgId, 80); });                     // inverno = 80, sem venda
  await C.withCampaign("sempre", async () => { log(orgId, 30); });                      // sempre = 30, margem desconhecida
  await C.withCampaign("verao", async () => { log(orgId, 999, 60); });                  // fora da janela de 30d
  await C.withCampaign("verao", async () => { log(other, 777); });                      // outra empresa

  // chamada com correlação que NÃO é de campanha (ex.: Fala Tu) e visita de outro conteúdo da mesma campanha sem pedido
  usageContext.run({ orgId, userId: null, module: "falatu", correlationId: "interaction:abc" }, () => { log(orgId, 5); });
  db.prepare(`INSERT INTO storefront_events (id, organization_id, type, attr_campaign, attr_content) VALUES (?, ?, 'view', 'verao', 'reel-2')`).run(randomUUID(), orgId);

  // vendas: verao margem 100+50 = 150; sempre custo desconhecido; sem-ia vendeu sem IA
  paidOrder(orgId, "verao", 200, 100); paidOrder(orgId, "verao", 100, 50);
  paidOrder(orgId, "sempre", 100, null);
  paidOrder(orgId, "sem-ia", 100, 60);
  paidOrder(other, "verao", 5000, 1);

  // ── 3. relatório
  const rep = C.report(orgId, { days: 30 });
  const by = (c: string) => rep.campaigns.find((x) => x.campaign === c);
  check("3.1 verao soma só marcadas na janela (320)", by("verao")?.aiCostCents === 320, String(by("verao")?.aiCostCents));
  check("3.2 verao conta 2 chamadas", by("verao")?.aiCalls === 2);
  check("3.3 margem paga verao = 150 (fato)", by("verao")?.marginPaid === 150, String(by("verao")?.marginPaid));
  check("3.4 margem depois da IA = 150 − 3,20 = 146,8", by("verao")?.marginAfterAi === 146.8, String(by("verao")?.marginAfterAi));
  check("3.5 inverno: IA sem venda → margem null (não 0)", by("inverno")?.aiCostCents === 80 && by("inverno")?.marginPaid === null && by("inverno")?.marginAfterAi === null);
  check("3.6 sempre: custo da peça desconhecido → margem e margem-após-IA null", by("sempre")?.marginPaid === null && by("sempre")?.marginAfterAi === null && by("sempre")?.aiCostCents === 30);
  check("3.7 sem-ia: vendeu sem chamada marcada → IA null (não R$ 0), margem 40, sem margem-após-IA", by("sem-ia")?.aiCostCents === null && by("sem-ia")?.marginPaid === 40 && by("sem-ia")?.marginAfterAi === null);
  check("3.8 sem campanha = total − marcado (60 + 5 de correlação que não é campanha)", rep.withoutCampaign.aiCostCents === 65 && rep.withoutCampaign.aiCalls === 3, JSON.stringify(rep.withoutCampaign));
  check("3.9 total do período = 320+80+30+65 = 495", rep.totalAiCostCents === 495, String(rep.totalAiCostCents));
  check("3.9b visita de outro conteúdo sem pedido não apaga a margem da campanha", by("verao")?.marginPaid === 150);
  check("3.10 declara que o custo é estimado", rep.basis === "ledger_estimate" && /estimado/i.test(rep.note));
  check("3.11 ordenado por custo de IA desc", rep.campaigns[0].campaign === "verao");
  check("3.12 janela maior enxerga a chamada antiga (1319)", C.report(orgId, { days: 90 }).campaigns.find((x) => x.campaign === "verao")?.aiCostCents === 1319);
  check("3.13 outra empresa não vaza", C.report(other, { days: 30 }).campaigns.find((x) => x.campaign === "verao")?.aiCostCents === 777 && C.report(other, { days: 30 }).totalAiCostCents === 777);
  const empty = C.report(randomUUID(), { days: 30 });
  check("3.14 empresa sem dados: tudo vazio, sem inventar", empty.campaigns.length === 0 && empty.totalAiCostCents === 0 && empty.withoutCampaign.aiCostCents === 0);
  check("3.15 days inválido cai em 30", C.report(orgId, { days: -5 as any }).days >= 1 && C.report(orgId, { days: NaN as any }).days === 30);

  // ── 4. rota
  const mkUser = (org: string, name: string, role: string) => { const id = randomUUID(); db.prepare("INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, ?, ?, ?, 'active')").run(id, org, name, `${name}@${org.slice(0, 4)}.com`, role); return id; };
  const dono = mkUser(orgId, "Bruno", "owner"), atendente = mkUser(orgId, "Ana", "agent");
  const app = express(); app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    const uid = String(req.headers["x-uid"] || "");
    const row = uid ? (db.prepare("SELECT id, organization_id, role FROM users WHERE id = ?").get(uid) as any) : null;
    if (row) { req.organizationId = row.organization_id; req.user = { userId: row.id, role: row.role, organizationId: row.organization_id }; }
    next();
  });
  app.use("/api/storefront", storefrontAdmin);
  const server = http.createServer(app);
  const port: number = await new Promise((rs) => server.listen(0, () => rs((server.address() as any).port)));
  const get = async (uid: string, q = "") => { const rr = await fetch(`http://127.0.0.1:${port}/api/storefront/economics/ai-cost${q}`, { headers: { "x-uid": uid } }); return { status: rr.status, body: await rr.json().catch(() => ({})) as any }; };
  const g1 = await get(dono);
  check("4.1 dono vê o relatório", g1.status === 200 && g1.body.campaigns.length === 4);
  check("4.2 atendente é barrado (dinheiro)", (await get(atendente)).status === 403);
  check("4.3 sem login é barrado", [401, 403].includes((await get("")).status));
  check("4.4 ?days=90 chega ao serviço", (await get(dono, "?days=90")).body.days === 90);
  server.close();

  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
