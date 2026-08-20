/**
 * TEST — Métricas + fila de lacunas do Tutor de Ajuda (ADR-179 F4). DB-backed, det.
 * Prova (RN-HELP-1/6, RN-004):
 *   - recordAsk agrega asks/answered por org+módulo (sem texto — minimizado);
 *   - metrics deriva taxa de resposta (null sem asks — null≠0), byModule, openGaps;
 *   - o fluxo real (ZeroTrainingHelpService.answer) alimenta as métricas: pergunta
 *     coberta conta como answered; pergunta sem cobertura conta como unanswered E
 *     entra na fila de lacunas;
 *   - gaps(org) prioriza por hits;
 *   - globalGaps agrega o MESMO texto entre orgs (cross-org p/ curadoria);
 *   - isolamento multi-tenant das métricas.
 *
 * Uso: npm run test:help-gaps
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-help-gaps-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-help-gaps-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { HelpKnowledgeService: KB } = await import("../src/server/HelpKnowledgeService.js");
  const { ZeroTrainingHelpService: HELP } = await import("../src/server/ZeroTrainingHelpService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  const mk = (org: string) => db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status, invisible_ux_enabled) VALUES (?, ?, 'X', 'active', 'varejo', 'autonomo', 'active', 0)`).run(randomUUID(), org);
  mk(A); mk(B);
  PermissionService.seedSystemProfiles(A); PermissionService.seedSystemProfiles(B);
  const prof = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any).id;
  const ownerA = { userId: "u1", email: "a@x.com", role: "owner", role_profile_id: prof(A, "owner"), organizationId: A };

  // ═══════════════ 1. metrics vazio: taxa null (não inventa 0%) ═══════════════
  const m0 = KB.metrics(A);
  check("1.1 sem asks → totalAsks 0", m0.totalAsks === 0);
  check("1.2 sem asks → answerRatePct null (null≠0, RN-HELP)", m0.answerRatePct === null);

  // ═══════════════ 2. recordAsk direto agrega ═══════════════
  KB.recordAsk(A, "vendas", true);
  KB.recordAsk(A, "vendas", true);
  KB.recordAsk(A, "vendas", false);
  const mV = KB.metrics(A);
  check("2.1 3 asks agregados", mV.totalAsks === 3 && mV.answered === 2 && mV.unanswered === 1);
  check("2.2 taxa de resposta = 67%", mV.answerRatePct === 67);
  const modV = mV.byModule.find((x) => x.moduleKey === "vendas");
  check("2.3 byModule vendas com taxa própria", !!modV && modV!.asks === 3 && modV!.answerRatePct === 67);

  // ═══════════════ 3. fluxo real alimenta métricas + fila ═══════════════
  // Pergunta COBERTA (há artigo semeado da Central de Saúde) → answered.
  HELP.answer(A, ownerA, { text: "como funciona a central de saúde?" });
  // Pergunta SEM cobertura → unanswered + vira lacuna.
  HELP.answer(A, ownerA, { text: "como emito nota fiscal eletronica?" });
  HELP.answer(A, ownerA, { text: "como emito nota fiscal eletronica?" }); // repete → hits 2
  const mReal = KB.metrics(A);
  check("3.1 asks aumentaram pelo fluxo real", mReal.totalAsks >= 6);
  check("3.2 há lacuna aberta registrada", mReal.openGaps >= 1);
  const gaps = KB.gaps(A);
  const nf = gaps.find((g) => /nota/.test(g.query));
  check("3.3 fila de lacunas prioriza a dúvida repetida (hits≥2)", !!nf && nf!.hits >= 2);
  check("3.4 fila ordenada por hits desc", gaps.length >= 1 && gaps[0].hits >= (gaps[gaps.length - 1]?.hits ?? 0));

  // ═══════════════ 3b. globalMetrics agrega cross-org (painel master) ═══════════════
  const gm = KB.globalMetrics();
  check("3b.1 globalMetrics soma asks de todas as orgs", gm.totalAsks >= mReal.totalAsks && gm.totalAsks > 0);
  check("3b.2 answerRatePct derivado (0..100)", gm.answerRatePct !== null && gm.answerRatePct >= 0 && gm.answerRatePct <= 100);
  check("3b.3 openGaps agrega (distinct query+módulo)", gm.openGaps >= 1);
  check("3b.4 orgsAsking conta as orgs que perguntaram", gm.orgsAsking >= 1);
  check("3b.5 articlesPublished > 0 (seeds)", gm.articlesPublished > 0);
  check("3b.6 byModule presente", Array.isArray(gm.byModule) && gm.byModule.length >= 1);

  // ═══════════════ 4. globalGaps agrega cross-org ═══════════════
  // A org B pergunta a MESMA coisa → globalGaps soma; org-scoped não vaza.
  const ownerB = { userId: "u2", email: "b@x.com", role: "owner", role_profile_id: prof(B, "owner"), organizationId: B };
  HELP.answer(B, ownerB, { text: "como emito nota fiscal eletronica?" });
  const gg = KB.globalGaps();
  const ggNf = gg.find((g) => /nota/.test(g.query));
  check("4.1 globalGaps soma hits entre orgs", !!ggNf && ggNf!.hits >= 3);
  check("4.2 globalGaps conta nº de orgs distintas", !!ggNf && ggNf!.orgs === 2);

  // ═══════════════ 5. isolamento multi-tenant das métricas ═══════════════
  const mB = KB.metrics(B);
  check("5.1 métricas de B não incluem asks de A", mB.totalAsks === 1);
  const gapsB = KB.gaps(B);
  check("5.2 fila de B só tem a lacuna de B", gapsB.every((g) => /nota/.test(g.query)) && gapsB.length === 1);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} help-gaps: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
