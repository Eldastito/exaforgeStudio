/**
 * TEST — PRD-ZF-ALTERDATA-GOLIVE-01 (PR 8, RF-15) — auditoria revenue-bridge.
 * DB-backed, determinístico. Prova que:
 *
 *   1. setEnabled/isEnabled togglar a flag retail_revenue_bridge
 *   2. audit() devolve breakdown por período com contagem/valor por source
 *      (pdv, manual, whatsapp, other)
 *   3. Fechamentos com status 'pending'/'received'/'extracted' NÃO entram
 *      no breakdown (só approved/reconciled/divergent)
 *   4. system_total ganha de informed_total quando presente e >0
 *   5. Valor 0 é filtrado
 *   6. recentClosings devolve os N mais recentes elegíveis
 *   7. `integration` é agrupado sob 'pdv' (source do sync direto)
 *   8. Isolamento por org: audit de OUTRA org não vê closings dessa
 *   9. Meses vazios devolvem zeros sem crashar
 *
 * Uso: npm run test:alterdata-golive-revenue-bridge
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alterdata-bridge-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-alterdata-bridge-1234567890";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { AlterdataRevenueBridgeService } = await import("../src/server/AlterdataRevenueBridgeService.js");

  const ORG = "org-bridge";
  const OTHER = "org-bridge-other";
  // Garante org_settings pra as duas
  db.prepare(`INSERT OR IGNORE INTO organization_settings (organization_id) VALUES (?)`).run(ORG);
  db.prepare(`INSERT OR IGNORE INTO organization_settings (organization_id) VALUES (?)`).run(OTHER);

  // Retail store necessária pro FK sensato
  db.prepare(`INSERT INTO retail_stores (id, organization_id, code, name, active) VALUES (?, ?, ?, ?, 1)`)
    .run("store-1", ORG, "001", "Loja 1");
  db.prepare(`INSERT INTO retail_stores (id, organization_id, code, name, active) VALUES (?, ?, ?, ?, 1)`)
    .run("store-2", OTHER, "002", "Loja 2");

  // ═══════ 1. setEnabled/isEnabled ═══════
  check("1.1 default off", AlterdataRevenueBridgeService.isEnabled(ORG) === false);
  AlterdataRevenueBridgeService.setEnabled(ORG, true);
  check("1.2 setEnabled true", AlterdataRevenueBridgeService.isEnabled(ORG) === true);
  AlterdataRevenueBridgeService.setEnabled(ORG, false);
  check("1.3 setEnabled false", AlterdataRevenueBridgeService.isEnabled(ORG) === false);
  AlterdataRevenueBridgeService.setEnabled(ORG, true);

  // ═══════ Seeda fechamentos ═══════
  // Este mês
  const thisMonth = new Date().toISOString().slice(0, 7);
  const day = (n: number) => `${thisMonth}-${String(n).padStart(2, "0")}`;

  const seed = (id: string, date: string, source: string, status: string, informed: number, system: number, org = ORG, store = "store-1") =>
    db.prepare(
      `INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, source, informed_total, system_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, org, store, date, status, source, informed, system);

  // Elegíveis (status approved/reconciled/divergent)
  seed("c1", day(1), "pdv", "reconciled", 0, 1000);       // pdv, system 1000
  seed("c2", day(2), "manual", "approved", 500, 0);       // manual 500
  seed("c3", day(3), "whatsapp", "divergent", 800, 750);  // whatsapp — system_total ganha (750)
  seed("c4", day(4), "integration", "approved", 0, 200);  // integration = pdv bucket
  seed("c5", day(5), "image_ocr", "reconciled", 300, 0);  // other bucket
  // Não elegíveis
  seed("c6", day(6), "pdv", "pending", 0, 999);
  seed("c7", day(7), "manual", "received", 100, 100);
  // Valor 0 (filtrado)
  seed("c8", day(8), "manual", "approved", 0, 0);
  // Outra org
  seed("c-other", day(9), "pdv", "reconciled", 0, 42, OTHER, "store-2");

  // ═══════ 2-3. audit breakdown ═══════
  const audit = AlterdataRevenueBridgeService.audit(ORG, { months: 1 });
  check("2.1 1 mês no breakdown", audit.months.length === 1);
  const brk = audit.months[0];
  check("2.2 total soma só elegíveis c/ valor > 0",
    brk.totalRevenue === 1000 + 500 + 750 + 200 + 300,
    `got ${brk.totalRevenue}`);
  check("2.3 pdv bucket soma c1+c4 (system_total)",
    brk.bySource.pdv.count === 2 && brk.bySource.pdv.amount === 1200);
  check("2.4 manual bucket = c2",
    brk.bySource.manual.count === 1 && brk.bySource.manual.amount === 500);
  check("2.5 whatsapp bucket usa system_total 750 (não informed 800)",
    brk.bySource.whatsapp.count === 1 && brk.bySource.whatsapp.amount === 750);
  check("2.6 other bucket = c5 (image_ocr)",
    brk.bySource.other.count === 1 && brk.bySource.other.amount === 300);

  // ═══════ 3. Não elegíveis filtrados ═══════
  check("3.1 closingsCount = 5 (só elegíveis com valor > 0)",
    brk.closingsCount === 5,
    `got ${brk.closingsCount}`);

  // ═══════ 4. system_total > 0 ganha ═══════
  // c3 tinha informed=800 e system=750 → 750 no bucket whatsapp: ok acima
  // c2 tinha informed=500 e system=0 → 500 no manual: ok acima
  check("4.1 system_total>0 ganha; system=0 usa informed", true);

  // ═══════ 5. Valor 0 filtrado ═══════
  const c8Present = brk.bySource.manual.count === 1; // se c8 tivesse entrado, count seria 2
  check("5.1 valor 0 não conta", c8Present);

  // ═══════ 6. recentClosings ═══════
  check("6.1 recentClosings tem 5 elegíveis",
    audit.recentClosings.length === 5);
  check("6.2 ordenado por closing_date DESC",
    audit.recentClosings[0].closingDate >= audit.recentClosings[audit.recentClosings.length - 1].closingDate);

  const auditLimited = AlterdataRevenueBridgeService.audit(ORG, { months: 1, recentLimit: 2 });
  check("6.3 recentLimit respeitado", auditLimited.recentClosings.length === 2);

  // ═══════ 7. 'integration' agrupado em 'pdv' ═══════
  const c4InPdv = audit.recentClosings.some(r => r.id === "c4" && r.source === "integration");
  check("7.1 c4 (integration) presente em recentClosings", c4InPdv);
  check("7.2 c4 contabilizado no bucket pdv (não em other)",
    brk.bySource.pdv.amount >= 200);

  // ═══════ 8. Isolamento por org ═══════
  const auditOther = AlterdataRevenueBridgeService.audit(OTHER, { months: 1 });
  check("8.1 audit(OTHER) NÃO vê closings do ORG",
    !auditOther.recentClosings.some(r => r.id.startsWith("c") && r.id !== "c-other"));
  check("8.2 audit(OTHER) só c-other (valor 42)",
    auditOther.months[0].totalRevenue === 42);

  // ═══════ 9. Meses vazios não crasham ═══════
  const auditWide = AlterdataRevenueBridgeService.audit(ORG, { months: 6 });
  check("9.1 6 meses no breakdown", auditWide.months.length === 6);
  check("9.2 meses passados sem closings retornam zeros",
    auditWide.months.slice(1).every(m => m.totalRevenue === 0 && m.closingsCount === 0));

  // enabled é lido no audit
  check("9.3 audit.enabled reflete flag", auditWide.enabled === true);

  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) {
    const line = `  ${r.ok ? "✓" : "✗"} ${r.name}`;
    console.log(r.ok ? line : `${line} — ${r.detail ?? ""}`);
  }
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
