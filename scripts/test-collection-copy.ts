/**
 * TEST — CollectionCopy / A/B da copy de cobrança (ADR-155 F2.1).
 *
 * Garante: colunas aditivas; variantFor default 'control'; a variante 'control'
 * é BYTE-IDÊNTICA à copy legada (prova de zero mudança em prod + protege o
 * test:cobranca-cadencia); a 'calibrated' difere, mantém valor+vencimento, o
 * aviso final mantém "proteção ao crédito" (CDC) e nenhuma variante usa termo
 * de culpa ("inadimpl…").
 *
 * Uso: npm run test:collection-copy
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-colcopy-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-colcopy-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// Copy legada verbatim (amount=250, dueDate=2026-08-01) — o 'control' NÃO pode driftar disto.
const AMT = 250, DUE = "2026-08-01";
const LEGACY_REMINDER = `Olá! 👋\n\nLembrando do valor de R$ 250,00 com vencimento em 01/08/2026.\n\nPra facilitar, gerei o PIX pra você — o link/QR chega em seguida.\n\nQualquer coisa é só responder por aqui. 🙏`;
const LEGACY_FIRM = `Olá! 🙋\n\nSobre a cobrança de R$ 250,00 que venceu em 01/08/2026: notei que ainda não foi paga.\n\nSe puder acertar via o PIX que enviei antes, resolve rapidinho. Se preferir combinar de outro jeito (parcelar, mudar a data, ou algum problema), é só responder aqui — a gente vê o que dá. 🙏`;
const LEGACY_NOTICE = `Olá 🙋\n\nPrecisamos combinar sobre a cobrança de R$ 250,00 vencida em 01/08/2026. Se não conseguirmos resolver nos próximos dias, vamos precisar informar as agências de proteção ao crédito.\n\nAinda dá tempo — responda aqui e a gente encontra um jeito juntos. 🙏`;

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { CollectionCopy } = await import("../src/server/CollectionCopy.js");

  // ===== 1. Colunas aditivas =====
  const orgCols = (db.prepare(`PRAGMA table_info(organization_settings)`).all() as any[]).map((c) => c.name);
  check("coluna organization_settings.collection_copy_variant existe", orgCols.includes("collection_copy_variant"));
  const attCols = (db.prepare(`PRAGMA table_info(collection_followup_attempts)`).all() as any[]).map((c) => c.name);
  check("coluna collection_followup_attempts.variant existe", attCols.includes("variant"));

  const org = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'varejo')`).run(randomUUID(), org);

  // ===== 2. variantFor default = control =====
  check("variantFor default = control", CollectionCopy.variantFor(org) === "control");

  // ===== 3. control é BYTE-IDÊNTICO ao legado (zero mudança em prod) =====
  check("control.reminder byte-idêntico ao legado", CollectionCopy.reminder("control", { amount: AMT, dueDate: DUE }) === LEGACY_REMINDER);
  check("control.firm byte-idêntico ao legado", CollectionCopy.firm("control", { amount: AMT, dueDate: DUE }) === LEGACY_FIRM);
  check("control.notice byte-idêntico ao legado", CollectionCopy.notice("control", { amount: AMT, dueDate: DUE }) === LEGACY_NOTICE);

  // ===== 4. calibrated difere, mas mantém invariantes =====
  const cReminder = CollectionCopy.reminder("calibrated", { amount: AMT, dueDate: DUE });
  const cFirm = CollectionCopy.firm("calibrated", { amount: AMT, dueDate: DUE });
  const cNotice = CollectionCopy.notice("calibrated", { amount: AMT, dueDate: DUE });
  check("calibrated.reminder difere do control", cReminder !== LEGACY_REMINDER);
  check("calibrated.firm difere do control", cFirm !== LEGACY_FIRM);
  check("calibrated.notice difere do control", cNotice !== LEGACY_NOTICE);
  for (const [name, msg] of [["reminder", cReminder], ["firm", cFirm], ["notice", cNotice]] as const) {
    check(`calibrated.${name} mantém o valor (R$ 250,00)`, msg.includes("250,00"));
    check(`calibrated.${name} mantém o vencimento (01/08/2026)`, msg.includes("01/08/2026"));
    check(`calibrated.${name} sem termo de culpa (inadimpl…)`, !/inadimpl/i.test(msg));
  }
  check("calibrated.notice mantém 'proteção ao crédito' (CDC)", /proteção ao crédito/i.test(cNotice));

  // ===== 5. flag por-org + isolamento =====
  db.prepare(`UPDATE organization_settings SET collection_copy_variant = 'calibrated' WHERE organization_id = ?`).run(org);
  check("variantFor após set = calibrated", CollectionCopy.variantFor(org) === "calibrated");
  db.prepare(`UPDATE organization_settings SET collection_copy_variant = 'lixo' WHERE organization_id = ?`).run(org);
  check("valor inválido cai em control", CollectionCopy.variantFor(org) === "control");

  const org2 = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja2', 'active', 'varejo')`).run(randomUUID(), org2);
  db.prepare(`UPDATE organization_settings SET collection_copy_variant = 'calibrated' WHERE organization_id = ?`).run(org2);
  check("ISOLAMENTO: variante é por-org (org2=calibrated, org=control)", CollectionCopy.variantFor(org2) === "calibrated" && CollectionCopy.variantFor(org) === "control");

  // ===== resultado =====
  console.log("\n=== CollectionCopy — F2.1 ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checagens ok`);
  if (failures > 0) { console.error(`\n❌ ${failures} falha(s)`); process.exit(1); }
  console.log("\n✅ CollectionCopy íntegro");
}

main();
