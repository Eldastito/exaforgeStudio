/**
 * inspect-kpi-signals.ts — diagnóstico READ-ONLY de por que a aba Operações
 * mostra (ou não) o bloco "Copy calibrada & indicação" (ADR-155).
 *
 * O endpoint `GET /api/runtime/operations/kpis` devolve os business_signals
 * ABERTOS de 3 tipos: collection_ab_result, sales_recovery_ab_result,
 * referral_program_result. Cada um é publicado por um *MeasurementService que
 * faz SKIP quando não há dado:
 *   - collection_ab_result       → skip se totalActions === 0
 *   - sales_recovery_ab_result   → skip se totalTickets === 0
 *   - referral_program_result    → skip se codesIssued === 0
 *
 * Este script NÃO importa db.ts (que rodaria initDb e escreveria schema).
 * Abre o mesmo arquivo em modo `readonly: true` → é impossível escrever ou
 * alterar schema. Espelha as queries de gate de cada MeasurementService pra
 * imprimir os números reais por org — sem tocar em nada.
 *
 * Uso:
 *   npx tsx scripts/inspect-kpi-signals.ts            # resumo de todas as orgs
 *   npx tsx scripts/inspect-kpi-signals.ts <orgId>    # detalhe de uma org
 *   DATA_DIR=/data npx tsx scripts/inspect-kpi-signals.ts   # aponta o banco
 *   npx tsx scripts/inspect-kpi-signals.ts --db /caminho/zappflow.db <orgId>
 */

import Database from "better-sqlite3";
import path from "path";

const MIN_SAMPLE = 5; // igual aos MeasurementServices (abaixo disso não elege vencedor)

// ── Resolve args / caminho do banco ──────────────────────────────────────────
const argv = process.argv.slice(2);
let dbPathArg: string | null = null;
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--db") { dbPathArg = argv[++i]; continue; }
  positional.push(argv[i]);
}
const orgIdArg = positional[0] || null;

const dataDir = process.env.DATA_DIR || process.cwd();
const dbPath = dbPathArg || path.join(dataDir, "zappflow.db");

let db: Database.Database;
try {
  // readonly: true  → nenhuma escrita possível. fileMustExist evita criar um
  // banco novo vazio por engano se o caminho estiver errado.
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
} catch (e: any) {
  console.error(`\n✗ Não consegui abrir o banco em modo leitura: ${dbPath}`);
  console.error(`  ${e?.message || e}`);
  console.error(`\n  Dica: rode a partir da raiz do projeto, ou passe DATA_DIR / --db <caminho>.`);
  console.error(`  Em produção (Coolify) o banco costuma estar em /data/zappflow.db → use DATA_DIR=/data.\n`);
  process.exit(1);
}

// ── Helpers defensivos (não quebram se faltar tabela/coluna) ─────────────────
function tableExists(name: string): boolean {
  const r = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  return !!r;
}
function cols(table: string): string[] {
  try { return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => String(c.name)); }
  catch { return []; }
}
/** Query escalar → número, ou null se a tabela/coluna não existir. */
function num(sql: string, ...args: any[]): number | null {
  try { return Number((db.prepare(sql).get(...args) as any)?.n || 0); }
  catch { return null; }
}
function rows(sql: string, ...args: any[]): any[] {
  try { return db.prepare(sql).all(...args) as any[]; }
  catch { return []; }
}
const fmt = (v: number | null) => (v === null ? "n/d" : String(v));
const yn = (b: boolean) => (b ? "✅ SIM" : "❌ não");

// ── Gates por org (espelham os MeasurementServices) ──────────────────────────
interface OrgReport {
  orgId: string;
  name: string | null;
  collectionActions: number | null;
  collectionByVariant: Record<string, number>;
  salesTickets: number | null;
  salesTouches: number | null;
  salesAttributions: number | null;
  salesByVariant: Record<string, number>;
  referralCodes: number | null;
  referred: number | null;
  welcomeIssued: number | null;
  qualified: number | null;
  openSignals: { type: string; count: number }[];
}

function reportFor(orgId: string, name: string | null): OrgReport {
  // collection_ab_result — totalActions: ações de cobrança com ≥1 follow-up
  const collectionActions = num(
    `SELECT COUNT(*) AS n FROM decision_actions a
      WHERE a.organization_id = ?
        AND a.command_type = 'collection_send_reminder'
        AND EXISTS (SELECT 1 FROM collection_followup_attempts f
                     WHERE f.action_id = a.id AND f.organization_id = a.organization_id)`,
    orgId,
  );
  const collectionByVariant: Record<string, number> = {};
  for (const r of rows(
    `SELECT COALESCE(variant,'control') AS variant, COUNT(*) AS n FROM (
        SELECT (SELECT f.variant FROM collection_followup_attempts f
                 WHERE f.action_id = a.id AND f.organization_id = a.organization_id
                 ORDER BY f.attempt_number DESC LIMIT 1) AS variant
          FROM decision_actions a
         WHERE a.organization_id = ? AND a.command_type = 'collection_send_reminder'
           AND EXISTS (SELECT 1 FROM collection_followup_attempts f2
                        WHERE f2.action_id = a.id AND f2.organization_id = a.organization_id)
     ) GROUP BY COALESCE(variant,'control')`,
    orgId,
  )) collectionByVariant[String(r.variant) === "calibrated" ? "calibrated" : "control"] = (collectionByVariant[String(r.variant) === "calibrated" ? "calibrated" : "control"] || 0) + Number(r.n);

  // sales_recovery_ab_result — totalTickets: tickets tocados
  const salesTickets = num(
    `SELECT COUNT(*) AS n FROM (SELECT ticket_id FROM sales_recovery_touches
       WHERE organization_id = ? GROUP BY ticket_id)`,
    orgId,
  );
  const salesTouches = num(`SELECT COUNT(*) AS n FROM sales_recovery_touches WHERE organization_id = ?`, orgId);
  const salesAttributions = num(`SELECT COUNT(*) AS n FROM sales_recovery_attributions WHERE organization_id = ?`, orgId);
  const salesByVariant: Record<string, number> = {};
  for (const r of rows(
    `SELECT COALESCE(variant,'control') AS variant, COUNT(*) AS n FROM (
        SELECT (SELECT t2.variant FROM sales_recovery_touches t2
                 WHERE t2.ticket_id = t.ticket_id AND t2.organization_id = t.organization_id
                 ORDER BY t2.sent_at DESC LIMIT 1) AS variant
          FROM sales_recovery_touches t WHERE t.organization_id = ? GROUP BY t.ticket_id
     ) GROUP BY COALESCE(variant,'control')`,
    orgId,
  )) salesByVariant[String(r.variant) === "calibrated" ? "calibrated" : "control"] = (salesByVariant[String(r.variant) === "calibrated" ? "calibrated" : "control"] || 0) + Number(r.n);

  // referral_program_result — codesIssued + breakdown
  const referralCodes = num(`SELECT COUNT(*) AS n FROM referral_codes WHERE organization_id = ?`, orgId);
  const referred = num(`SELECT COUNT(*) AS n FROM contacts WHERE organization_id = ? AND referred_by_contact_id IS NOT NULL`, orgId);
  const welcomeIssued = num(`SELECT COUNT(*) AS n FROM coupons WHERE organization_id = ? AND kind = 'referral_welcome'`, orgId);
  const qualified = num(`SELECT COUNT(*) AS n FROM coupons WHERE organization_id = ? AND kind = 'referral_reward'`, orgId);

  // sinais já abertos dos 3 tipos (o que o endpoint devolveria de fato)
  const openSignals = rows(
    `SELECT signal_type AS type, COUNT(*) AS count FROM business_signals
      WHERE organization_id = ? AND status = 'open'
        AND signal_type IN ('collection_ab_result','sales_recovery_ab_result','referral_program_result')
      GROUP BY signal_type`,
    orgId,
  ).map((r) => ({ type: String(r.type), count: Number(r.count) }));

  return {
    orgId, name, collectionActions, collectionByVariant, salesTickets, salesTouches,
    salesAttributions, salesByVariant, referralCodes, referred, welcomeIssued, qualified, openSignals,
  };
}

// ── Descobre as orgs ─────────────────────────────────────────────────────────
function orgNameColumn(): string | null {
  if (!tableExists("organizations")) return null;
  const c = cols("organizations");
  for (const cand of ["name", "business_name", "company_name", "display_name", "trade_name"]) {
    if (c.includes(cand)) return cand;
  }
  return null;
}
function listOrgs(): { id: string; name: string | null }[] {
  const nameCol = orgNameColumn();
  if (tableExists("organizations")) {
    return rows(`SELECT id, ${nameCol ? nameCol : "NULL"} AS name FROM organizations ORDER BY name`)
      .map((r) => ({ id: String(r.id), name: r.name != null ? String(r.name) : null }));
  }
  // Fallback: união dos org ids que aparecem nas tabelas de gate + sinais.
  const set = new Set<string>();
  for (const t of ["collection_followup_attempts", "sales_recovery_touches", "referral_codes", "business_signals"]) {
    if (tableExists(t)) for (const r of rows(`SELECT DISTINCT organization_id AS id FROM ${t}`)) set.add(String(r.id));
  }
  return [...set].map((id) => ({ id, name: null }));
}

// ── Impressão ────────────────────────────────────────────────────────────────
function verdict(rep: OrgReport) {
  const colOk = (rep.collectionActions || 0) > 0;
  const recOk = (rep.salesTickets || 0) > 0;
  const refOk = (rep.referralCodes || 0) > 0;
  return { colOk, recOk, refOk, wouldReturn: rep.openSignals.reduce((s, x) => s + x.count, 0) };
}

function printDetail(rep: OrgReport) {
  const v = verdict(rep);
  const cc = rep.collectionByVariant, sc = rep.salesByVariant;
  console.log(`\n════════════════════════════════════════════════════════════════`);
  console.log(`ORG  ${rep.orgId}${rep.name ? `  (${rep.name})` : ""}`);
  console.log(`════════════════════════════════════════════════════════════════`);

  console.log(`\n① collection_ab_result  →  publica? ${yn(v.colOk)}   (gate: totalActions > 0)`);
  console.log(`   ações de cobrança c/ follow-up (totalActions): ${fmt(rep.collectionActions)}`);
  console.log(`   por variante: control=${cc.control || 0}  calibrated=${cc.calibrated || 0}   ` +
    `(elege vencedor só com ambas ≥ ${MIN_SAMPLE})`);

  console.log(`\n② sales_recovery_ab_result  →  publica? ${yn(v.recOk)}   (gate: totalTickets > 0)`);
  console.log(`   tickets tocados (totalTickets): ${fmt(rep.salesTickets)}   ` +
    `touches: ${fmt(rep.salesTouches)}   atribuições: ${fmt(rep.salesAttributions)}`);
  console.log(`   por variante: control=${sc.control || 0}  calibrated=${sc.calibrated || 0}   ` +
    `(vencedor só com ambas ≥ ${MIN_SAMPLE})`);

  console.log(`\n③ referral_program_result  →  publica? ${yn(v.refOk)}   (gate: codesIssued > 0)`);
  console.log(`   códigos emitidos (codesIssued): ${fmt(rep.referralCodes)}   indicados: ${fmt(rep.referred)}`);
  console.log(`   cupons boas-vindas: ${fmt(rep.welcomeIssued)}   recompensas (qualified): ${fmt(rep.qualified)}`);

  console.log(`\n▸ Sinais ABERTOS hoje (o que o endpoint devolve de fato):`);
  if (rep.openSignals.length === 0) console.log(`   (nenhum) → GET /api/runtime/operations/kpis devolve { signals: [] } → bloco escondido`);
  else for (const s of rep.openSignals) console.log(`   • ${s.type}: ${s.count}`);

  const anyGate = v.colOk || v.recOk || v.refOk;
  console.log(`\n⇒ Conclusão: ${
    rep.openSignals.length > 0
      ? `o bloco APARECE (${v.wouldReturn} sinal(is) publicado(s)).`
      : anyGate
        ? `há dado pra publicar, mas nenhum sinal aberto ainda — provável que o Scheduler não tenha rodado o publishAll (ou o sinal foi resolvido). O bloco aparece no próximo tick.`
        : `sem dado em nenhum dos 3 gates → nada a publicar → bloco escondido por design.`
  }`);
}

function printSummaryRow(rep: OrgReport) {
  const v = verdict(rep);
  const nm = (rep.name || "").slice(0, 22).padEnd(22);
  console.log(
    `${rep.orgId.slice(0, 20).padEnd(20)}  ${nm}  ` +
    `col:${v.colOk ? "✅" : "❌"}  rec:${v.recOk ? "✅" : "❌"}  ref:${v.refOk ? "✅" : "❌"}  ` +
    `sinais_abertos:${v.wouldReturn}`,
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
console.log(`\nBanco (readonly): ${dbPath}`);

// Aviso se alguma tabela de gate não existe nesse banco.
for (const t of ["decision_actions", "collection_followup_attempts", "sales_recovery_touches",
  "sales_recovery_attributions", "referral_codes", "coupons", "contacts", "business_signals"]) {
  if (!tableExists(t)) console.log(`⚠ tabela ausente neste banco: ${t} (contagens correlatas sairão como "n/d")`);
}

if (orgIdArg) {
  const nameCol = orgNameColumn();
  const name = nameCol
    ? (rows(`SELECT ${nameCol} AS name FROM organizations WHERE id = ?`, orgIdArg)[0]?.name ?? null)
    : null;
  printDetail(reportFor(orgIdArg, name != null ? String(name) : null));
} else {
  const orgs = listOrgs();
  console.log(`\n${orgs.length} org(s) encontradas. Resumo (col=cobrança, rec=recuperação, ref=indicação):\n`);
  console.log(`${"orgId".padEnd(20)}  ${"nome".padEnd(22)}  gates                       sinais`);
  console.log("─".repeat(96));
  const withSignals: string[] = [];
  for (const o of orgs) {
    const rep = reportFor(o.id, o.name);
    printSummaryRow(rep);
    if (verdict(rep).wouldReturn > 0) withSignals.push(o.id);
  }
  console.log("─".repeat(96));
  console.log(`\n${withSignals.length} org(s) com bloco visível hoje${withSignals.length ? `: ${withSignals.join(", ")}` : "."}`);
  console.log(`\nPara o detalhe de uma org (números por gate), rode:`);
  console.log(`  npx tsx scripts/inspect-kpi-signals.ts <orgId>\n`);
}

db.close();
