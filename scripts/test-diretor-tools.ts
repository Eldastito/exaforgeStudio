/**
 * TESTE — F1 do Diretor IA com ferramentas de consulta aterradas
 * (docs/prd/PLANO-DIRETOR-IA-FERRAMENTAS.md).
 * -----------------------------------------------------------------------------
 * Prova, offline e SEM LLM (ferramenta é código determinístico — RN-DIR-1):
 *  - vendas_por_loja: período/loja resolvidos deterministicamente; dia único
 *    traz cota→bateu/faltou; pending/futuro NUNCA é venda (régua do #1722);
 *    loja sem fechamento → honesto (nunca 0 inventado);
 *  - fechamentos_status: enviados × pendentes × divergentes por dia;
 *  - estoque_loja: disponível−reservado por loja, produto por termo; sem match
 *    → honesto; negativo sinalizado;
 *  - metas_progresso: deriva do BusinessGoalService; meta em R$ some pra papel
 *    sem dinheiro (§73);
 *  - cardápio (§73): ferramenta money:true nem aparece/roda pra papel restrito;
 *  - loja ambígua → clarify (nunca chuta); período inválido → erro;
 *  - isolamento multi-tenant.
 *
 * Uso: npm run test:diretor-tools
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-dirtools-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-dirtools-1234567890";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ExecutiveQueryToolsService: T } = await import("../src/server/ExecutiveQueryToolsService.js");
  const { BusinessGoalService } = await import("../src/server/BusinessGoalService.js");

  const tz = process.env.TZ_DISPLAY || "America/Sao_Paulo";
  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const addDays = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
  const ontem = addDays(hoje, -1), anteontem = addDays(hoje, -2), futuro = addDays(hoje, 5);

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
  const mkClosing = (org: string, storeId: string, date: string, total: number, status = "reconciled", quota = 0, div = "not_checked") => {
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, quota_amount, divergence_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), org, storeId, date, status, total, quota, div);
  };

  const A = mkOrg("A");
  const avBrasil = mkStore(A, "Av. brasil");
  const carioca = mkStore(A, "Carioca");
  const grandeRio = mkStore(A, "Grande Rio");
  mkClosing(A, avBrasil, ontem, 5476.7, "received", 5200);
  mkClosing(A, avBrasil, anteontem, 3297.9, "reconciled", 3000);
  mkClosing(A, avBrasil, futuro, 0, "pending", 4000);           // placeholder futuro
  mkClosing(A, carioca, ontem, 3038, "received", 3800, "divergent");
  mkClosing(A, carioca, anteontem, 969, "approved", 900);
  // Grande Rio: ontem só placeholder pending (não enviou).
  mkClosing(A, grandeRio, ontem, 0, "pending", 5800);

  // ── 1) vendas_por_loja ──
  const v1 = T.run(A, "vendas_por_loja", { store: "avenida brasil", period: "ontem" });
  check("1.1 loja resolvida por substring ('avenida brasil' → Av. brasil)", v1.ok && !!v1.summary?.includes("Av. brasil"), v1.summary || v1.clarify || v1.error || "");
  check("1.2 dia único traz venda + cota → BATEU", !!v1.summary?.includes("R$ 5476.70") && !!v1.summary?.includes("BATEU (+R$ 276.70)"), v1.summary || "");
  const v2 = T.run(A, "vendas_por_loja", { period: "ontem" });
  check("1.3 sem loja = rede toda + total (pending do Grande Rio fora)", !!v2.summary?.includes("Carioca") && !!v2.summary?.includes("Total: R$ 8514.70"), v2.summary || "");
  const v3 = T.run(A, "vendas_por_loja", { store: "grande rio", period: "ontem" });
  check("1.4 loja com só placeholder pending → honesto, nunca 0 inventado", !!v3.summary?.includes("nenhum fechamento REAL"), v3.summary || "");
  const v4 = T.run(A, "vendas_por_loja", { store: "av", period: "semana" });
  check("1.5 período multi-dia agrega e conta dias fechados", v4.ok && !!v4.summary?.includes("2 dia(s) fechado(s)"), v4.summary || v4.clarify || "");
  const v5 = T.run(A, "vendas_por_loja", { from: anteontem, to: futuro });
  check("1.6 faixa explícita com fim no futuro é clampada em hoje", v5.ok && !(v5.data?.period?.to > hoje), JSON.stringify(v5.data?.period));
  check("1.7 período inválido → erro tipado", T.run(A, "vendas_por_loja", { period: "trimestre" }).error === "invalid_period");
  const amb = T.run(A, "vendas_por_loja", { store: "rio", period: "ontem" });
  // 'rio' casa Grande Rio e... só uma? 'Carioca' não contém 'rio'? contém: ca-RIO-ca → ambíguo de verdade.
  check("1.8 loja ambígua → clarify (nunca chuta)", !!amb.clarify && amb.clarify.includes("Qual"), amb.clarify || amb.summary || "");

  // ── 2) fechamentos_status ──
  const f1 = T.run(A, "fechamentos_status", { date: "ontem" });
  check("2.1 enviados × pendentes × divergentes", !!f1.summary?.includes("Pendentes: Grande Rio") && !!f1.summary?.includes("DIVERGÊNCIA") && !!f1.summary?.includes("Carioca"), f1.summary || "");
  check("2.2 ferramenta sem dinheiro não expõe R$", !f1.summary?.includes("R$"), f1.summary || "");

  // ── 3) estoque_loja ──
  const prodId = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Camisa Polo Azul Ref 123', 129.9, 1)`).run(prodId, A);
  db.prepare(`INSERT INTO retail_store_inventory (id, organization_id, store_id, product_service_id, quantity_available, quantity_reserved) VALUES (?, ?, ?, ?, 8, 2)`).run(randomUUID(), A, avBrasil, prodId);
  db.prepare(`INSERT INTO retail_store_inventory (id, organization_id, store_id, product_service_id, quantity_available, quantity_reserved) VALUES (?, ?, ?, ?, -1, 0)`).run(randomUUID(), A, carioca, prodId);
  const e1 = T.run(A, "estoque_loja", { product: "ref 123" });
  check("3.1 estoque por loja (disponível − reservado)", !!e1.summary?.includes("Av. brasil 6 un."), e1.summary || "");
  check("3.2 negativo sinalizado pra conferência", !!T.run(A, "estoque_loja", { product: "ref 123" }).summary?.includes("NEGATIVO"), "");
  check("3.3 produto sem match → honesto (não inventa estoque)", !!T.run(A, "estoque_loja", { product: "tenis inexistente" }).summary?.includes("não invente"), "");
  check("3.4 sem argumento de produto → missing_arg", T.run(A, "estoque_loja", {}).error === "missing_arg");
  void e1;

  // ── 4) metas_progresso + §73 ──
  BusinessGoalService.set(A, { metric: "revenue", targetAmount: 100000 });
  const m1 = T.run(A, "metas_progresso", {}, { canSeeMoney: true });
  check("4.1 meta definida aparece com distância à meta", !!m1.summary?.includes("meta R$ 100000.00"), m1.summary || "");
  const m2 = T.run(A, "metas_progresso", {}, { canSeeMoney: false });
  check("4.2 papel sem dinheiro NÃO vê meta em R$ (§73)", !m2.summary?.includes("R$"), m2.summary || "");

  // ── 5) Cardápio e gate de dinheiro ──
  check("5.1 cardápio completo pra quem vê dinheiro", T.list({ canSeeMoney: true }).some((t) => t.name === "vendas_por_loja"));
  check("5.2 vendas_por_loja SOME do cardápio de papel restrito", !T.list({ canSeeMoney: false }).some((t) => t.name === "vendas_por_loja"));
  check("5.3 rodar ferramenta de dinheiro sem permissão → forbidden_money", T.run(A, "vendas_por_loja", { period: "ontem" }, { canSeeMoney: false }).error === "forbidden_money");
  check("5.4 ferramenta inexistente → tool_not_found", T.run(A, "ferramenta_x", {}).error === "tool_not_found");

  // ── 6) Isolamento multi-tenant ──
  const B = mkOrg("B");
  mkStore(B, "Loja B1");
  const vb = T.run(B, "vendas_por_loja", { period: "ontem" });
  check("6.1 org B não vê lojas/vendas de A", !vb.summary?.includes("Av. brasil") && !vb.summary?.includes("5476"), vb.summary || "");
  check("6.2 loja de A não resolve pra B", !!T.run(B, "vendas_por_loja", { store: "carioca", period: "ontem" }).clarify);

  console.log("\n=== TEST: F1 — ferramentas de consulta do Diretor IA ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
