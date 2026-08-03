/**
 * TESTE — Template de FOLGA por vendedor (ADR-083 Fase G2b).
 * ---------------------------------------------------------------------------
 * Prova as decisões do RetailScheduleTemplateService:
 *   - CRUD do template por loja (regravado inteiro no save);
 *   - applyToRange NÃO sobrescreve dias já lançados (RN-G2b-001) — pula pares
 *     (data, seller) que já têm entrada em `retail_schedule_entries`;
 *   - whoIsOff junta a grade lançada 'off' com o template do dia da semana,
 *     sem duplicar vendedores que já têm linha 'work' ou 'off' na grade;
 *   - isolamento multi-tenant;
 *   - audit event registrado.
 *
 * Uso:  npm run test:retail-schedule-template
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-tmpl-off-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-tmpl-off-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailCommissionRaceService } = await import("../src/server/RetailCommissionRaceService.js");
  const { RetailScheduleTemplateService } = await import("../src/server/RetailScheduleTemplateService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  const loja1 = RetailStoreService.create(A, { name: "Carioca", code: "1" });
  const loja2 = RetailStoreService.create(A, { name: "Iguaçu", code: "2" });

  // ── CRUD ───────────────────────────────────────────────────────────────────
  const saved = RetailScheduleTemplateService.save(A, loja1.id, [
    { sellerKey: "mat:T1", sellerName: "Thamyres", daysOfWeek: [1] },        // segunda
    { sellerKey: "mat:A1", sellerName: "Andressa", daysOfWeek: [2] },        // terça
    { sellerKey: "mat:G1", sellerName: "Gabriel", daysOfWeek: [3, 4] },      // quarta e quinta
  ], "tester");
  check("save retorna 3 vendedores", saved.length === 3, `n=${saved.length}`);
  const listed = RetailScheduleTemplateService.list(A, loja1.id);
  check("list traz Thamyres com [1]", listed.find((p: any) => p.sellerKey === "mat:T1")?.daysOfWeek.join(",") === "1");
  check("list traz Gabriel com [3,4]", listed.find((p: any) => p.sellerKey === "mat:G1")?.daysOfWeek.join(",") === "3,4");
  // Regravação SUBSTITUI tudo (não incrementa).
  RetailScheduleTemplateService.save(A, loja1.id, [
    { sellerKey: "mat:T1", sellerName: "Thamyres", daysOfWeek: [1] },
    { sellerKey: "mat:A1", sellerName: "Andressa", daysOfWeek: [2] },
    { sellerKey: "mat:G1", sellerName: "Gabriel", daysOfWeek: [4] },        // só quinta agora
  ], "tester");
  check("save regrava (Gabriel agora só [4])", RetailScheduleTemplateService.list(A, loja1.id).find((p: any) => p.sellerKey === "mat:G1")?.daysOfWeek.join(",") === "4");

  // ── applyToRange preserva grade lançada (RN-G2b-001) ─────────────────────
  // Agosto/2026: dia 03 é segunda; 04 é terça; 06 é quinta.
  // Pré-lança Thamyres 'work' no dia 03 (segunda) — o template dela é segunda,
  // então NÃO deve substituir esse 'work' por 'off'.
  db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), A, loja1.id, "2026-08-03", "mat:T1", "Thamyres", "work", "tester");

  const applied = RetailScheduleTemplateService.applyToRange(A, loja1.id, "2026-08-01", "2026-08-31", "tester");
  // O que deve entrar:
  //  Segundas de agosto/26: 03, 10, 17, 24, 31 = 5 → menos 1 pré-lançado = 4 novas de Thamyres.
  //  Terças: 04, 11, 18, 25 = 4 novas de Andressa.
  //  Quintas: 06, 13, 20, 27 = 4 novas de Gabriel.
  //  Total = 12 inserted, 1 skipped (Thamyres 03/08).
  check("applyToRange insere 12 folgas novas", applied.inserted === 12, `inserted=${applied.inserted}`);
  check("applyToRange pula 1 pré-lançado (Thamyres 03/08)", applied.skipped === 1, `skipped=${applied.skipped}`);
  const preserved = db.prepare(`SELECT status FROM retail_schedule_entries WHERE organization_id = ? AND store_id = ? AND work_date = '2026-08-03' AND seller_key = 'mat:T1'`).get(A, loja1.id) as any;
  check("Thamyres 03/08 permaneceu 'work' (não virou 'off')", preserved?.status === "work");
  const thamOff10 = db.prepare(`SELECT status FROM retail_schedule_entries WHERE organization_id = ? AND store_id = ? AND work_date = '2026-08-10' AND seller_key = 'mat:T1'`).get(A, loja1.id) as any;
  check("Thamyres 10/08 (seg) foi criada como 'off' pelo template", thamOff10?.status === "off");
  // Rodar de novo é idempotente — nada novo entra.
  const again = RetailScheduleTemplateService.applyToRange(A, loja1.id, "2026-08-01", "2026-08-31", "tester");
  check("Aplicar novamente não insere nada (tudo skipped)", again.inserted === 0 && again.skipped === 13);

  // Intervalo > 100 dias é rejeitado.
  let bigRange = false;
  try { RetailScheduleTemplateService.applyToRange(A, loja1.id, "2026-01-01", "2026-06-30"); } catch (e: any) { bigRange = /grande/.test(e.message); }
  check("applyToRange rejeita intervalo > 100 dias", bigRange);

  // ── whoIsOff ──────────────────────────────────────────────────────────────
  // 10/08 (segunda) — Thamyres deve estar 'off' (veio do template, gravado
  // como 'grid' agora). E, num dia sem grade, deve aparecer via 'template'.
  const off10 = RetailScheduleTemplateService.whoIsOff(A, "2026-08-10", { storeId: loja1.id });
  check("whoIsOff 10/08: Thamyres presente", off10.some((s: any) => s.sellerKey === "mat:T1"));
  check("whoIsOff 10/08: Thamyres com source='grid' (já lançada)", off10.find((s: any) => s.sellerKey === "mat:T1")?.source === "grid");
  // Loja 2 SEM template: 10/08 tem que voltar vazio.
  const off10L2 = RetailScheduleTemplateService.whoIsOff(A, "2026-08-10", { storeId: loja2.id });
  check("whoIsOff loja sem template = vazio", off10L2.length === 0, `n=${off10L2.length}`);
  // Cadastro de template PURO em loja2 (SEM aplicar): whoIsOff deve mostrar
  // via source='template' quando o dia bate.
  RetailScheduleTemplateService.save(A, loja2.id, [
    { sellerKey: "mat:R1", sellerName: "Rafaela", daysOfWeek: [5] }, // sexta
  ]);
  const off14L2 = RetailScheduleTemplateService.whoIsOff(A, "2026-08-14", { storeId: loja2.id }); // sexta
  check("whoIsOff mostra Rafaela via template (sexta, sem grade)", off14L2.find((s: any) => s.sellerKey === "mat:R1")?.source === "template");
  // Rede toda (sem storeId): junta as duas lojas.
  const netFri = RetailScheduleTemplateService.whoIsOff(A, "2026-08-14");
  check("whoIsOff sem storeId agrega REDE toda", netFri.some((s: any) => s.storeId === loja2.id));

  // ── Isolamento multi-tenant ───────────────────────────────────────────────
  check("org B não vê template da org A", RetailScheduleTemplateService.list(B, loja1.id).length === 0);
  check("org B whoIsOff vazio", RetailScheduleTemplateService.whoIsOff(B, "2026-08-10", { storeId: loja1.id }).length === 0);

  // ── Audit ─────────────────────────────────────────────────────────────────
  const audit = db.prepare(`SELECT event_type, COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? GROUP BY event_type`).all(A) as any[];
  check("audit: template SAVED e APPLIED registrados",
    audit.some((a) => a.event_type === "RETAIL_SCHEDULE_TEMPLATE_SAVED") && audit.some((a) => a.event_type === "RETAIL_SCHEDULE_TEMPLATE_APPLIED"));

  // ── Cotas da corrida NÃO mudam com template ──────────────────────────────
  // Sanidade: weeksOfMonth continua o comportamento G2 (5 semanas em agosto/26,
  // 1ª cola 01→08). O template só popula a grade, não altera a corrida.
  const weeks = RetailCommissionRaceService.weeksOfMonth("2026-08");
  check("weeksOfMonth continua com 5 semanas (fase G2 intocada)", weeks.length === 5);

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  → ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} PASS`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
