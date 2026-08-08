/**
 * TEST — retry diferenciado soft/hard decline (ADR-155 F2.2).
 *
 * Garante: colunas aditivas; classifyDecline por limiar de dias; a variante
 * `control` IGNORA o decline (byte-idêntica ⇒ zero mudança); a `calibrated`
 * ramifica (soft = re-nudge do PIX; hard = oferece 2ª via atualizada), com
 * ambas mantendo valor+vencimento, sem culpa, e o aviso mantendo o informativo
 * CDC ("proteção ao crédito").
 *
 * Uso: npm run test:collection-decline
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-coldecl-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-coldecl-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const AMT = 250, DUE = "2026-08-01";
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { CollectionCopy } = await import("../src/server/CollectionCopy.js");
  const { CollectionCadenceService } = await import("../src/server/CollectionCadenceService.js");

  // ===== 1. Colunas aditivas =====
  const orgCols = (db.prepare(`PRAGMA table_info(organization_settings)`).all() as any[]).map((c) => c.name);
  check("organization_settings.collection_hard_decline_days existe", orgCols.includes("collection_hard_decline_days"));
  const attCols = (db.prepare(`PRAGMA table_info(collection_followup_attempts)`).all() as any[]).map((c) => c.name);
  check("collection_followup_attempts.decline_type existe", attCols.includes("decline_type"));

  // ===== 2. classifyDecline por limiar =====
  check("20d de atraso, limiar 7 → hard", CollectionCadenceService.classifyDecline(daysAgo(20), 7) === "hard");
  check("2d de atraso, limiar 7 → soft", CollectionCadenceService.classifyDecline(daysAgo(2), 7) === "soft");
  check("2d de atraso, limiar 1 → hard", CollectionCadenceService.classifyDecline(daysAgo(2), 1) === "hard");
  check("20d de atraso, limiar 30 → soft", CollectionCadenceService.classifyDecline(daysAgo(20), 30) === "soft");

  // ===== 3. control IGNORA o decline (byte-idêntico) =====
  check("control.firm ignora decline (soft===hard)", CollectionCopy.firm("control", { amount: AMT, dueDate: DUE }, "soft") === CollectionCopy.firm("control", { amount: AMT, dueDate: DUE }, "hard"));
  check("control.notice ignora decline (soft===hard)", CollectionCopy.notice("control", { amount: AMT, dueDate: DUE }, "soft") === CollectionCopy.notice("control", { amount: AMT, dueDate: DUE }, "hard"));
  check("control default (sem decline) === control soft", CollectionCopy.firm("control", { amount: AMT, dueDate: DUE }) === CollectionCopy.firm("control", { amount: AMT, dueDate: DUE }, "soft"));

  // ===== 4. calibrated ramifica soft vs hard =====
  const firmSoft = CollectionCopy.firm("calibrated", { amount: AMT, dueDate: DUE }, "soft");
  const firmHard = CollectionCopy.firm("calibrated", { amount: AMT, dueDate: DUE }, "hard");
  const noticeSoft = CollectionCopy.notice("calibrated", { amount: AMT, dueDate: DUE }, "soft");
  const noticeHard = CollectionCopy.notice("calibrated", { amount: AMT, dueDate: DUE }, "hard");

  check("calibrated.firm soft != hard", firmSoft !== firmHard);
  check("calibrated.notice soft != hard", noticeSoft !== noticeHard);
  check("firm soft re-nudge do PIX enviado", /PIX que te enviei/i.test(firmSoft));
  check("firm hard oferece 2ª via atualizada", /via atualizada/i.test(firmHard) && /expir/i.test(firmHard));
  check("notice hard oferece via atualizada", /atualizada/i.test(noticeHard));

  // invariantes em TODAS as ramificações calibradas
  for (const [name, msg] of [["firmSoft", firmSoft], ["firmHard", firmHard], ["noticeSoft", noticeSoft], ["noticeHard", noticeHard]] as const) {
    check(`${name} mantém valor (250,00)`, msg.includes("250,00"));
    check(`${name} mantém vencimento (01/08/2026)`, msg.includes("01/08/2026"));
    check(`${name} sem termo de culpa`, !/inadimpl/i.test(msg));
  }
  check("notice soft mantém 'proteção ao crédito' (CDC)", /proteção ao crédito/i.test(noticeSoft));
  check("notice hard mantém 'proteção ao crédito' (CDC)", /proteção ao crédito/i.test(noticeHard));

  // ===== 5. default do padrão calibrated (sem decline explícito) = soft =====
  check("calibrated.firm default === soft", CollectionCopy.firm("calibrated", { amount: AMT, dueDate: DUE }) === firmSoft);

  // ===== resultado =====
  console.log("\n=== Collection decline soft/hard — F2.2 ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checagens ok`);
  if (failures > 0) { console.error(`\n❌ ${failures} falha(s)`); process.exit(1); }
  console.log("\n✅ retry soft/hard íntegro");
}

main();
