/**
 * TESTE — 19/09/2026: CHECKLIST VIVO de implantação da rede (Central de Saúde).
 * -------------------------------------------------------------------------------
 * Desdobramento do Guia de Implantação Varejo: o serviço DERIVA por query
 * (RN-004, sem tabela nova, read-only) as lacunas de fundação que zeraram as
 * telas da TOULON e a Central de Saúde mostra o que falta e onde resolver.
 *
 * Prova:
 *  - gate por módulo (org sem retail → applicable:false);
 *  - org vazia → itens todo (lojas, WhatsApp) e SEM itens dependentes de loja;
 *  - detectores acusam com prova: código faltando vira TODO só com PDV em uso;
 *    filial órfã só quando há venda sem loja casando; depósito só quando houve
 *    dinheiro no fechamento; matrícula do PDV sem cadastro;
 *  - cada correção vira 'ok' SOZINHA (checklist vivo, sem estado);
 *  - implantação completa → done === total;
 *  - isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-setup-checklist
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-setup-check-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-setup-check-1";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const today = new Date().toISOString().slice(0, 10);

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { RetailSetupChecklistService: Svc } = await import("../src/server/RetailSetupChecklistService.js");

  const mkOrg = (id: string, modules: string | null) =>
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, enabled_modules) VALUES (?, ?, 'T', 'active', 'moda', ?)`)
      .run(randomUUID(), id, modules);
  // Add-on `retail` exige enabled_modules EXPLÍCITO (ADR-084: NULL/legado não
  // liga add-on — "atuar no varejo ≠ operar uma rede de lojas").
  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A, '["catalogo","vendas","retail"]');
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B, '["vendas"]');   // retail DESLIGADO
  const C = `org_C_${randomUUID().slice(0, 6)}`; mkOrg(C, '["retail"]');   // isolamento
  const item = (r: any, id: string) => r.items.find((i: any) => i.id === id);

  // ── 1) Gate por módulo. ──
  const rB = Svc.checklist(B);
  check("1.1 org sem módulo retail → applicable:false", rB.applicable === false && rB.items.length === 0);

  // ── 2) Org vazia: fundação toda pendente, sem itens dependentes de loja. ──
  const r2 = Svc.checklist(A);
  check("2.1 applicable + progresso 0", r2.applicable === true && r2.done === 0 && r2.total > 0);
  check("2.2 lojas = todo", item(r2, "stores")?.status === "todo");
  check("2.3 WhatsApp da empresa = todo", item(r2, "whatsapp_channel")?.status === "todo");
  check("2.4 sem loja → sem itens de escala/cota/margem", !item(r2, "schedule") && !item(r2, "quotas") && !item(r2, "margins"));
  check("2.5 todo vem antes de ok na ordenação", r2.items[0].status !== "ok");

  // ── 3) Loja sem código/WhatsApp/margem: avisos certos, sem PDV código é WARN. ──
  const s1 = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active) VALUES (?, ?, 'Av. Brasil', 1)`).run(s1, A);
  const r3 = Svc.checklist(A);
  check("3.1 lojas = ok", item(r3, "stores")?.status === "ok");
  check("3.2 código faltando SEM PDV em uso → warn (não todo)", item(r3, "store_codes")?.status === "warn", item(r3, "store_codes")?.status);
  check("3.3 WhatsApp da loja = warn nomeando a loja", item(r3, "store_whatsapp")?.status === "warn" && /Av\. Brasil/.test(item(r3, "store_whatsapp")?.detail || ""));
  check("3.4 margem = warn · escala = todo · cotas = todo", item(r3, "margins")?.status === "warn" && item(r3, "schedule")?.status === "todo" && item(r3, "quotas")?.status === "todo");
  check("3.5 sem PDV → sem item de filial órfã", !item(r3, "orphan_filiais"));

  // ── 4) PDV em uso: código vira TODO, órfã acusada, matrícula sem cadastro. ──
  db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor_codigo, valor, status) VALUES (?, ?, '1005', 'B1', ?, '1065003', 199.9, 'N')`)
    .run(randomUUID(), A, today);
  const r4 = Svc.checklist(A);
  check("4.1 com PDV, código faltando vira TODO", item(r4, "store_codes")?.status === "todo");
  check("4.2 filial órfã acusada (1005 sem loja casando)", item(r4, "orphan_filiais")?.status === "todo" && /1005/.test(item(r4, "orphan_filiais")?.detail || ""));
  check("4.3 vendedores = todo (nenhum cadastrado)", item(r4, "sellers")?.status === "todo");

  // ── 5) Correções viram 'ok' SOZINHAS (derivado, sem estado). ──
  db.prepare(`UPDATE retail_stores SET code = '1005', whatsapp_identifier = '5521999990001', gross_margin_percent = 55 WHERE id = ?`).run(s1);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, '1065003', 'Luíz Augusto', 1)`).run(randomUUID(), A);
  const r5 = Svc.checklist(A);
  check("5.1 código ok + órfã some", item(r5, "store_codes")?.status === "ok" && item(r5, "orphan_filiais")?.status === "ok");
  check("5.2 vendedores ok (matrícula do PDV cadastrada)", item(r5, "sellers")?.status === "ok", JSON.stringify(item(r5, "sellers")));
  check("5.3 WhatsApp da loja + margem ok", item(r5, "store_whatsapp")?.status === "ok" && item(r5, "margins")?.status === "ok");

  // ── 6) Escala + cota + fechamento + dinheiro→depósito. ──
  db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, status) VALUES (?, ?, ?, ?, 'mat:1065003', 'work')`)
    .run(randomUUID(), A, s1, today);
  db.prepare(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount) VALUES (?, ?, ?, ?, 3000)`)
    .run(randomUUID(), A, s1, today);
  const closingId = randomUUID();
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status) VALUES (?, ?, ?, ?, 'approved')`)
    .run(closingId, A, s1, today);
  db.prepare(`INSERT INTO retail_daily_closing_items (id, organization_id, closing_id, payment_method, informed_amount) VALUES (?, ?, ?, 'dinheiro', 250)`)
    .run(randomUUID(), A, closingId);
  const r6 = Svc.checklist(A);
  check("6.1 escala + cotas + fechamento ok", item(r6, "schedule")?.status === "ok" && item(r6, "quotas")?.status === "ok" && item(r6, "closings")?.status === "ok");
  check("6.2 dinheiro no fechamento SEM depósito → warn (Em caixa infla)", item(r6, "deposits")?.status === "warn");
  db.prepare(`INSERT INTO retail_cash_deposits (id, organization_id, store_id, deposit_date, amount) VALUES (?, ?, ?, ?, 250)`)
    .run(randomUUID(), A, s1, today);
  check("6.3 depósito registrado → ok", item(Svc.checklist(A), "deposits")?.status === "ok");

  // ── 7) WhatsApp conectado fecha a implantação. ──
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'evolution', 'W', 'inst_a', 'connected')`)
    .run(randomUUID(), A);
  const r7 = Svc.checklist(A);
  check("7.1 canal conectado → ok", item(r7, "whatsapp_channel")?.status === "ok");
  check("7.2 implantação COMPLETA: done === total", r7.done === r7.total, `${r7.done}/${r7.total}`);

  // ── 8) Isolamento: org C não herda nada da A. ──
  const rC = Svc.checklist(C);
  check("8.1 org C começa do zero (lojas todo)", rC.applicable === true && item(rC, "stores")?.status === "todo" && rC.done === 0);

  console.log("\n=== TEST: Checklist vivo de implantação (Central de Saúde) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
