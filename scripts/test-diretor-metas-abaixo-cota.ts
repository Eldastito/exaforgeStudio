/**
 * TESTE — ferramenta metas_abaixo_cota do Diretor IA (offline, sem LLM).
 * Prova: dias abaixo por loja, quanto faltou/dia, soma dos negativos e saldo do
 * mês; pending/futuro e dias sem cota NÃO entram; loja que bateu não aparece;
 * gate de dinheiro (§73); roteamento determinístico "abaixo da cota".
 * Uso: npm run test:diretor-metas-abaixo-cota
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-metas-cota-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-metas-cota-1234567890";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ExecutiveQueryToolsService: T } = await import("../src/server/ExecutiveQueryToolsService.js");
  const { ExecutiveQueryRouterService: R } = await import("../src/server/ExecutiveQueryRouterService.js");

  const tz = process.env.TZ_DISPLAY || "America/Sao_Paulo";
  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const addDays = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
  const ontem = addDays(hoje, -1);

  const org = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, "Rede X");
  const mkStore = (name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active) VALUES (?, ?, ?, 1)`).run(id, org, name); return id; };
  const mkClosing = (storeId: string, date: string, total: number, quota: number, status = "reconciled") =>
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, quota_amount) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), org, storeId, date, status, total, quota);

  const lojaX = mkStore("Loja X");
  const lojaY = mkStore("Loja Y");
  const d1 = addDays(hoje, -3), d2 = addDays(hoje, -4), d3 = addDays(hoje, -5), d4 = addDays(hoje, -6), d5 = addDays(hoje, -7);
  // Loja X: 2 dias abaixo, 1 acima; 1 pending (cota mas sem fechamento real); 1 sem cota.
  mkClosing(lojaX, d1, 4000, 5000);                 // faltou 1000
  mkClosing(lojaX, d2, 4500, 5000);                 // faltou 500
  mkClosing(lojaX, d3, 3500, 3000);                 // +500 (bateu)
  mkClosing(lojaX, d4, 0, 6000, "pending");         // pending → NÃO entra
  mkClosing(lojaX, d5, 2000, 0);                     // sem cota → NÃO entra
  // Loja Y: bateu todos os dias com cota → não deve aparecer.
  mkClosing(lojaY, d1, 2500, 2000);

  const from = addDays(hoje, -10);
  const res = T.run(org, "metas_abaixo_cota", { from, to: ontem });
  check("1 ok + só 1 loja abaixo (Loja X)", res.ok && res.data?.stores?.length === 1 && res.data.stores[0].name === "Loja X", JSON.stringify(res.data?.stores?.map((s: any) => s.name)) || res.summary || "");
  const x = res.data?.stores?.[0];
  check("2 dois dias abaixo, 3 dias considerados", x?.belowDays?.length === 2 && x?.consideredDays === 3, `below=${x?.belowDays?.length} considered=${x?.consideredDays}`);
  check("3 soma dos dias negativos = -1500", x?.sumBelow === -1500, `sumBelow=${x?.sumBelow}`);
  check("4 saldo do mês (net) = -1000 (dias bons compensam parcial)", x?.netMonth === -1000, `net=${x?.netMonth}`);
  check("5 summary mostra 'faltou R$ 1000.00' e 'faltou R$ 500.00'", !!res.summary?.includes("faltou R$ 1000.00") && !!res.summary?.includes("faltou R$ 500.00"), res.summary || "");
  check("6 pending e sem-cota NÃO contam (senão considerados seria 5)", x?.consideredDays === 3);

  // Gate de dinheiro (§73): ferramenta money → papel restrito não roda.
  const denied = T.run(org, "metas_abaixo_cota", { from, to: ontem }, { canSeeMoney: false });
  check("7 papel sem dinheiro → forbidden_money", denied.ok === false && denied.error === "forbidden_money");

  // Loja específica que bateu tudo → honesto (nenhuma abaixo).
  const soY = T.run(org, "metas_abaixo_cota", { store: "Loja Y", from, to: ontem });
  check("8 loja que bateu → nenhuma abaixo", soY.ok && soY.data?.stores?.length === 0, soY.summary || "");

  // Período sem cota nenhuma → honesto, não inventa.
  const vazio = T.run(org, "metas_abaixo_cota", { from: addDays(hoje, -60), to: addDays(hoje, -50) });
  check("9 sem cota no período → honesto", vazio.ok && vazio.data?.stores?.length === 0 && !!vazio.summary?.includes("Sem cota"), vazio.summary || "");

  // Roteamento determinístico → escolhe a ferramenta certa (não metas_progresso).
  check("10 router: 'quais lojas ficaram abaixo da cota' → metas_abaixo_cota", R.detect(org, "quais lojas ficaram abaixo da cota esse mes")?.tool === "metas_abaixo_cota");
  check("11 router: 'lojas que não bateram a meta' → metas_abaixo_cota", R.detect(org, "lojas que não bateram a meta")?.tool === "metas_abaixo_cota");
  check("12 router: 'quais as metas do mes' (sem 'abaixo') → metas_progresso", R.detect(org, "quais as metas do mes")?.tool === "metas_progresso");

  console.log("\n=== Diretor IA — metas_abaixo_cota ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error("Erro fatal:", e); fs.rmSync(tmpDir, { recursive: true, force: true }); process.exit(1); });
