/**
 * TEST — Creative Learning (PRD 10 / ADR-167 F13). DB-backed, determinístico.
 * Prova (§42/§184, RN-EL-1/3/4): percepção→…→APRENDIZADO no domínio social.
 *   - SÓ `assured` ensina forte (DONE≠exemplo): publicação executada mas não confirmada
 *     não aprende; após F12 (confirmada+medida) → aprende no MOTOR ÚNICO (PatternMemory);
 *   - desfecho DETERMINÍSTICO do engajamento MEDIDO (worked/no_effect), nunca inventa;
 *   - idempotente por creative:<actionId> (sweep repetido não dobra);
 *   - opt-in (pattern_memory); eficácia por ângulo criativo; isolamento.
 *
 * Uso: npm run test:creative-learning
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clearn-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-clearn-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const tick = () => new Promise((r) => setImmediate(r));

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { GovernedPublishService: GP } = await import("../src/server/GovernedPublishService.js");
  const { DecisionActionService: DA } = await import("../src/server/DecisionActionService.js");
  const { SocialAttributionService: ATTR } = await import("../src/server/SocialAttributionService.js");
  const { CreativeLearningService: CL } = await import("../src/server/CreativeLearningService.js");
  const { OutcomeAssuranceService } = await import("../src/server/OutcomeAssuranceService.js");

  const A = "org_cl_A", B = "org_cl_B";
  const approver = "user-appr";
  const setup = (org: string, pm: number) => {
    db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(`os-${org}`, org);
    db.prepare(`UPDATE organization_settings SET vertical='moda', pattern_memory=? WHERE organization_id = ?`).run(pm, org);
  };
  setup(A, 1); setup(B, 1);

  // publica governado + confirma via F12
  const pub = async (org: string, variantKey: string, likes: number) => {
    const a = GP.propose(org, { channel: "stub", caption: "c", mediaRef: "art:1", variantKey, correlationId: `corr-${variantKey}` });
    DA.approve(org, a.id, approver, {});
    const ex = await GP.execute(org, a.id);
    return { id: a.id, ref: ex.result?.externalRef as string, likes };
  };
  const seedAnalytics = (org: string, ref: string, likes: number) =>
    db.prepare(`INSERT INTO social_post_metrics (id, organization_id, channel, post_external_id, published_at, likes, comments, shares, saves, analytics_available)
                VALUES (?, ?, 'stub', ?, '2026-08-13T12:00:00Z', ?, 0, 0, 0, 1)`).run(randomUUID(), org, ref, likes);
  const waitDone = async (id: string) => { for (let i = 0; i < 40; i++) { await tick(); if ((db.prepare(`SELECT status FROM decision_actions WHERE id = ?`).get(id) as any)?.status === "done") return; } };

  // ═══════════════ 1. NÃO-assured não aprende (RN-EL-1) ═══════════════
  const p1 = await pub(A, "sig-1:A", 40);
  const early = CL.learnFromAction(A, p1.id);
  check("1.1 executado mas não confirmado → não aprende (nao_assured)", early.learned === false && early.reason === "nao_assured");

  // ═══════════════ 2. após F12 (assured) → aprende no motor único ═══════════════
  seedAnalytics(A, p1.ref, 40);
  ATTR.resolvePending(A);
  await waitDone(p1.id);
  check("2.0 ação virou assured", OutcomeAssuranceService.assessAction(A, p1.id).assuranceState === "assured");
  const learned = CL.learnFromAction(A, p1.id);
  check("2.1 aprende (worked, engajamento medido)", learned.learned === true && learned.outcome === "worked" && learned.engagement === 40);
  check("2.2 padrão criativo no domínio social_creative", learned.patternKey === "moda:A:stub:image" && !!learned.patternId);
  const pat = db.prepare(`SELECT domain FROM business_patterns WHERE id = ?`).get(learned.patternId) as any;
  check("2.3 gravado no MOTOR ÚNICO (business_patterns social_creative)", pat?.domain === "social_creative");
  const oc = db.prepare(`SELECT source, outcome FROM business_pattern_outcomes WHERE action_id = ?`).get(p1.id) as any;
  check("2.4 outcome com procedência 'assured'", oc?.source === "assured" && oc?.outcome === "worked");

  // ═══════════════ 3. idempotência (RN-EL-4) ═══════════════
  const again = CL.learnFromAction(A, p1.id);
  check("3.1 reaprender é no-op idempotente", again.idempotent === true && again.learned === false);
  check("3.2 não dobra o ledger de outcomes", (db.prepare(`SELECT COUNT(*) n FROM business_pattern_outcomes WHERE action_id = ?`).get(p1.id) as any).n === 1);

  // ═══════════════ 4. sweep + eficácia por ângulo ═══════════════
  const p2 = await pub(A, "sig-2:B", 5); seedAnalytics(A, p2.ref, 5); ATTR.resolvePending(A); await waitDone(p2.id);
  const sw = CL.sweep(A);
  check("4.1 sweep aprende o novo assured (B)", sw.learned === 1);
  const eff = CL.effectiveness(A);
  check("4.2 eficácia por ângulo criativo (2 padrões: A e B)", eff.length === 2);

  // ═══════════════ 5. opt-in ═══════════════
  db.prepare(`UPDATE organization_settings SET pattern_memory = 0 WHERE organization_id = ?`).run(A);
  check("5.1 motor desligado → pattern_memory_off (não aprende)", CL.learnFromAction(A, p1.id).reason === "pattern_memory_off");
  db.prepare(`UPDATE organization_settings SET pattern_memory = 1 WHERE organization_id = ?`).run(A);

  // ═══════════════ 6. isolamento multi-tenant ═══════════════
  check("6.1 B não aprende ação de A", CL.learnFromAction(B, p1.id).reason === "acao_nao_encontrada");
  check("6.2 B sem padrões criativos próprios", CL.effectiveness(B).length === 0);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} creative-learning: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
