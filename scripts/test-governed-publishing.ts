/**
 * TEST — Governed Publishing (PRD 10 / ADR-167 F11). DB-backed, determinístico (stub).
 * Prova (D4, RN-SI-03): a publicação é COMANDO GOVERNADO, não efeito direto.
 *   - propor NÃO publica: nasce aguardando aprovação (governança on por default);
 *   - executar sem aprovação é recusado (choke-point);
 *   - aprovar + executar publica (stub) + arma ConfirmationEngine (PUBLISHED≠RESULTADO)
 *     + audita em action_execution_log; nada de tabela/runtime paralelo (§42);
 *   - IDEMPOTÊNCIA DURÁVEL: 2º execute é barrado (action_already_executed);
 *   - degradação honesta: canal sem capacidade → falha (não finge publicado);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:governed-publishing
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-govpub-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-govpub-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { GovernedPublishService: GP } = await import("../src/server/GovernedPublishService.js");
  const { DecisionActionService: DA } = await import("../src/server/DecisionActionService.js");
  const { SocialConnectionService: SC } = await import("../src/server/SocialConnectionService.js");

  const A = "org_gp_A", B = "org_gp_B";
  const approver = "user-appr-1";

  // ═══════════════ 1. propor NÃO publica (governança on) ═══════════════
  const proposed = GP.propose(A, { channel: "stub", caption: "linho", mediaRef: "art:1", correlationId: "corr-1", variantKey: "sig:A" });
  check("1.1 ação nasce aguardando aprovação (policy single)", proposed.status === "awaiting_approval");
  check("1.2 comando governado social_publish + fio", proposed.command_type === "social_publish" && proposed.correlation_id === "corr-1");
  const noExec = db.prepare(`SELECT COUNT(*) n FROM action_execution_log WHERE action_id = ? AND mode='execute' AND status='done'`).get(proposed.id) as any;
  check("1.3 nada publicado ainda (nenhum execute done)", noExec.n === 0);

  // ═══════════════ 2. executar sem aprovação é recusado (choke-point) ═══════════════
  let blocked = false;
  try { await GP.execute(A, proposed.id); } catch { blocked = true; }
  check("2.1 execute antes de aprovar → recusado", blocked);
  check("2.2 recusa auditada (action_not_approved)", (db.prepare(`SELECT COUNT(*) n FROM action_execution_log WHERE action_id = ? AND error_code='action_not_approved'`).get(proposed.id) as any).n >= 1);

  // ═══════════════ 3. aprovar + executar publica + arma confirmação ═══════════════
  DA.approve(A, proposed.id, approver, {});
  check("3.1 ação aprovada", DA.get(A, proposed.id).status === "approved");
  const exec = await GP.execute(A, proposed.id);
  check("3.2 executou com efeito social_published", exec.ok === true && exec.result?.effect === "social_published" && !!exec.result?.externalRef);
  const logDone = db.prepare(`SELECT COUNT(*) n FROM action_execution_log WHERE action_id = ? AND mode='execute' AND status='done'`).get(proposed.id) as any;
  check("3.3 execução auditada como done (choke-point, sem runtime paralelo)", logDone.n === 1);
  const conf = db.prepare(`SELECT confirmation_method, status FROM action_confirmations WHERE organization_id = ? AND action_id = ?`).get(A, proposed.id) as any;
  check("3.4 ConfirmationEngine armado (social_publish, pending — PUBLISHED≠RESULTADO)", conf?.confirmation_method === "social_publish" && conf?.status === "pending");

  // ═══════════════ 4. IDEMPOTÊNCIA DURÁVEL (2º execute barrado) ═══════════════
  let dup = false;
  try { await GP.execute(A, proposed.id); } catch (e: any) { dup = /idempot|already/i.test(String(e?.message || e)); }
  check("4.1 2º execute barrado (action_already_executed) — durável", dup);
  check("4.2 confirmação não duplicou", (db.prepare(`SELECT COUNT(*) n FROM action_confirmations WHERE action_id = ?`).get(proposed.id) as any).n === 1);

  // ═══════════════ 5. degradação honesta: canal sem capacidade ═══════════════
  // conexão read-only (stub sem publish) pro canal tiktok.
  SC.setConfig(A, "tiktok", { capabilities: { canPublish: false } }, { provider: "stub", enabled: true });
  const ro = GP.propose(A, { channel: "tiktok", caption: "x", mediaRef: "art:2" });
  DA.approve(A, ro.id, approver, {});
  let honest = false;
  try { await GP.execute(A, ro.id); } catch { honest = true; }
  check("5.1 canal sem capacidade → execute falha (não finge publicado)", honest);
  check("5.2 falha auditada (failed), sem confirmação", (db.prepare(`SELECT COUNT(*) n FROM action_execution_log WHERE action_id = ? AND status='failed'`).get(ro.id) as any).n >= 1 && (db.prepare(`SELECT COUNT(*) n FROM action_confirmations WHERE action_id = ?`).get(ro.id) as any).n === 0);
  check("5.3 ação NÃO virou done (efeito não saiu)", (db.prepare(`SELECT status FROM decision_actions WHERE id = ?`).get(ro.id) as any).status !== "done");

  // ═══════════════ 6. isolamento multi-tenant ═══════════════
  let iso = false;
  try { await GP.execute(B, proposed.id); } catch { iso = true; }
  check("6.1 org B não executa ação de A", iso);
  check("6.2 B não tem ações de publicação", (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id = ? AND action_type='social_publish'`).get(B) as any).n === 0);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} governed-publishing: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
