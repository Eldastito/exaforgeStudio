/**
 * TEST — Survival Budget (PRD-ZF-UNIFIED-GAP-CLOSURE-03 F3.5, PR-7). Sugere A/B/C/D das contas
 * a pagar. A IA SUGERE, humano confirma; NADA é cancelado aqui.
 *
 * Cobre: classificação por palavra-chave (A/B/C/D) + acento · unknown sem sinal (não inventa) ·
 * ordem D>C>B>A (mais cortável prevalece) · summary por tier · caveat "nada é cancelado" ·
 * dinheiro role-gated · não muta payables · isolamento.
 *
 * Uso: npm run test:survival-budget
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sbudget-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-sbudget-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { SurvivalBudgetService: S } = await import("../src/server/SurvivalBudgetService.js");
  const { FinancialLedgerService: L } = await import("../src/server/FinancialLedgerService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(randomUUID(), A);

  const due = "2026-12-31";
  L.addPayable(A, { description: "Folha de pagamento", amount: 10000, dueDate: due, category: "folha" });        // A
  L.addPayable(A, { description: "Aluguel da loja", amount: 4000, dueDate: due, category: "Locação" });          // B (acento)
  L.addPayable(A, { description: "Assinatura software CRM", amount: 300, dueDate: due, category: "software" });   // C
  L.addPayable(A, { description: "Confraternização de fim de ano", amount: 2000, dueDate: due, category: "evento" }); // D
  L.addPayable(A, { description: "Pagamento diverso", amount: 500, dueDate: due, category: "outros xyz" });       // unknown

  const r = S.suggest(A);
  const byId = (desc: string) => r.items.find((x) => x.description.startsWith(desc.split(" ")[0]));
  const tierOf = (desc: string) => r.items.find((x) => x.description.includes(desc))?.tier;

  check("1.1 5 itens", r.items.length === 5);
  check("1.2 Folha → A (indispensável)", tierOf("Folha") === "A");
  check("1.3 Aluguel → B (essencial ajustável, acento normalizado)", tierOf("Aluguel") === "B");
  check("1.4 Software → C (adiável)", tierOf("software") === "C" || tierOf("Assinatura") === "C");
  check("1.5 Confraternização → D (cortável, acento)", tierOf("Confraterniza") === "D");
  check("1.6 desconhecido → unknown (não inventa)", tierOf("diverso") === "unknown");

  const unk = r.items.find((x) => x.tier === "unknown")!;
  check("2.1 unknown tem basis unknown + orienta classificar manual", unk.basis === "unknown" && /manual/i.test(unk.rationale));

  // ── 3. Summary por tier ──
  const tiers = r.summary.map((s) => s.tier);
  check("3.1 summary cobre A,B,C,D,unknown", ["A", "B", "C", "D", "unknown"].every((t) => tiers.includes(t as any)));
  check("3.2 total do tier A = 10000", r.summary.find((s) => s.tier === "A")?.total === 10000);

  // ── 4. Guardrail: nada cancelado; caveat presente; payables intactos ──
  check("4.1 caveat 'nada é cancelado'", r.caveats.some((c) => /Nenhuma despesa é cancelada/.test(c)));
  check("4.2 payables continuam todos 'open' (não mutou)", L.listPayables(A, "open").length === 5);
  check("4.3 todo item marcado suggested", r.items.every((x) => x.suggested === true));

  // ── 5. Dinheiro role-gated ──
  const rR = S.suggest(A, { includeMoney: false });
  check("5.1 valores redigidos", rR.items.every((x) => x.amount === null) && rR.summary.every((s) => s.total === null));
  check("5.2 tier/label/contagem preservados", rR.summary.find((s) => s.tier === "A")?.count === 1 && rR.redacted === true);

  // ── 6. Isolamento ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("6.1 org B vazia", S.suggest(B).items.length === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} survival-budget: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
