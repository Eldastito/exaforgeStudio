/**
 * TESTE — ADR-085: adoção / uso correto (sinal determinístico factual)
 * -------------------------------------------------------------------
 * Prova, offline, o índice de implantação e os bloqueios acionáveis:
 *   - org sem nada configurado → bloqueios críticos, score baixo;
 *   - configurando etapa a etapa o score sobe;
 *   - loja sem número aparece como bloqueio nominal (cobrança não sai);
 *   - com tudo configurado → 100% e sem bloqueios; isolamento por org.
 *
 * Uso:  npm run test:retail-adoption
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-adoption-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-adoption-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailActivationService } = await import("../src/server/RetailActivationService.js");
  const { RetailCommissionService } = await import("../src/server/RetailCommissionService.js");
  const { RetailAdoptionService } = await import("../src/server/RetailAdoptionService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);

  const has = (steps: any[], key: string) => steps.find((s) => s.key === key)?.done === true;

  // ---- 1. Nada configurado ----
  const s0 = RetailAdoptionService.status(A);
  check("Vazio: nenhuma etapa concluída", s0.score.completed === 0);
  check("Vazio: há bloqueios críticos", s0.blockers.some((b: any) => b.severity === "critical"));

  // ---- 2. Configurando etapa a etapa ----
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?, ?, 'evolution', 'Canal', 'connected')`).run(randomUUID(), A);
  check("Canal conectado → etapa done", has(RetailAdoptionService.status(A).steps, "channel_connected"));

  RetailActivationService.activate(A, "u1");
  check("Retail ativado → etapa done", has(RetailAdoptionService.status(A).steps, "retail_activated"));

  const s1 = RetailStoreService.create(A, { name: "Loja Com Zap", whatsappIdentifier: "5511999990001" });
  const s2 = RetailStoreService.create(A, { name: "Loja Sem Zap" }); // sem número
  const st = RetailAdoptionService.status(A);
  check("Lojas cadastradas → etapa done", has(st.steps, "stores_registered"));
  check("Loja sem número → 'stores_have_whatsapp' NÃO done", !has(st.steps, "stores_have_whatsapp"));
  check("Bloqueio nomeia a loja sem número", st.blockers.some((b: any) => b.key === "stores_have_whatsapp" && b.detail.includes("Loja Sem Zap")));

  RetailStoreService.update(A, s2.id, { whatsappIdentifier: "5511999990002" }, "u1");
  check("Número preenchido → 'stores_have_whatsapp' done", has(RetailAdoptionService.status(A).steps, "stores_have_whatsapp"));

  db.prepare(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_amount, quota_date) VALUES (?, ?, ?, 8000, date('now'))`).run(randomUUID(), A, s1.id);
  check("Cota do mês → etapa done", has(RetailAdoptionService.status(A).steps, "quotas_set"));

  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, date('now'), 'received', 1000)`).run(randomUUID(), A, s1.id);
  check("Fechamento recente → etapa done", has(RetailAdoptionService.status(A).steps, "closings_flowing"));

  RetailCommissionService.createRule(A, { name: "5%", scope: "store", calculationType: "percent_sales", config: { percent: 5 } }, "u1");
  check("Regra de comissão → etapa done", has(RetailAdoptionService.status(A).steps, "commission_rules"));

  // ---- 3. Tudo configurado ----
  const full = RetailAdoptionService.status(A);
  check("Implantação 100% e sem bloqueios", full.score.percent === 100 && full.blockers.length === 0);

  // ---- 4. Isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("Isolamento: org B começa do zero", RetailAdoptionService.status(B).score.completed === 0);

  console.log("\n=== ADR-085: adoção / uso correto (sinal determinístico) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
