/**
 * TEST — Fatia 4d.1 (ADR-152): CLI de rollout dos pilotos do Runtime.
 *
 * Cobre `RuntimePilotService.findOrgs/plan/apply`:
 *   1. findOrgs por substring (case-insensitive, isolamento entre matches)
 *   2. plan: flags default 0, tuning com defaults, prereqs zerados, PENDÊNCIAS
 *   3. plan: prereqs contam canais/contatos/owners/openaiKey corretamente
 *   4. plan: policiesReady detecta ausência e divergência (autonomy/mode/active)
 *   5. plan: readiness = BLOQUEADO se sub-piloto sem master
 *   6. plan: readiness = PRONTO só quando nada em warning/blocker
 *   7. apply: liga flags (opt-in) e não desliga flags não passadas
 *   8. apply: grava tuning só quando veio no opts
 *   9. apply: idempotente (2x apply produz mesmo plan)
 *  10. apply: cascade — --collection sem runtime lança erro
 *  11. apply: cascade — --followup sem --sales-recovery lança erro
 *  12. apply: validação numérica (out-of-range recusado)
 *  13. apply: seed-policies cria row nova + corrige row com autonomy errado
 *  14. apply: seed-policies só toca policies dos sub-pilotos ligados (não vaza)
 *  15. apply: audit RUNTIME_PILOT_APPLY com opts + before + seededPolicies
 *  16. cross-tenant: apply em orgA não afeta orgB
 *  17. org inexistente/soft-deleted: plan/apply erro
 *
 * Uso: npm run test:pilot-runtime
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pilot-runtime-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-pilot-runtime-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RuntimePilotService } = await import("../src/server/RuntimePilotService.js");

  // ── Setup 2 orgs ativas + 1 soft-deleted ────────────────────────
  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const orgDeleted = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Toulon Piloto A', 'active', 'moda')`)
    .run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Outra Empresa B', 'active')`)
    .run(randomUUID(), orgB);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, deleted_at) VALUES (?, ?, 'Toulon Piloto (removido)', 'inactive', CURRENT_TIMESTAMP)`)
    .run(randomUUID(), orgDeleted);

  // ===== 1. findOrgs =====
  const foundToulon = RuntimePilotService.findOrgs("toulon");
  check("findOrgs('toulon') retorna 1 (soft-deleted não conta)",
    foundToulon.length === 1 && foundToulon[0].orgId === orgA);
  const foundCase = RuntimePilotService.findOrgs("PILOTO");
  check("findOrgs case-insensitive", foundCase.length === 1 && foundCase[0].orgId === orgA);
  const foundNone = RuntimePilotService.findOrgs("nada-que-existe-xyz");
  check("findOrgs sem match → array vazio", Array.isArray(foundNone) && foundNone.length === 0);

  // ===== 2. plan default (sem prereqs) =====
  const p0 = RuntimePilotService.plan(orgA);
  check("plan default: runtime=off", p0.flags.runtime === false);
  check("plan default: todos os sub-pilotos off",
    !p0.flags.collection && !p0.flags.salesRecovery && !p0.flags.followup && !p0.flags.attribution);
  check("plan default: tuning tem defaults do db",
    p0.tuning.collectionR2Days === 3 && p0.tuning.collectionR3Days === 7
    && p0.tuning.stalledDays === 10 && p0.tuning.replyWindowDays === 14
    && p0.tuning.followupGapDays === 5 && p0.tuning.attributionWindowDays === 30);
  check("plan default: prereqs zerados", p0.prereqs.channelsConnected === 0
    && p0.prereqs.contactsCount === 0 && p0.prereqs.ownersCount === 0);
  check("plan default: openaiKey false (env não setada no teste)", p0.prereqs.openaiKey === false);
  check("plan default: readiness = PRONTO (nada ligado, nada a exigir)", p0.readiness === "PRONTO");

  // ===== 3. Setup de prereqs: canal WhatsApp conectado, contatos, owner ativo =====
  const chanId = randomUUID();
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?, ?, 'whatsapp', 'WA principal', 'connected')`)
    .run(chanId, orgA);
  // Canal em outra org NÃO conta (isolamento)
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?, ?, 'whatsapp', 'WA B', 'connected')`)
    .run(randomUUID(), orgB);
  // Canal desconectado NÃO conta
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?, ?, 'whatsapp', 'WA secundário', 'disconnected')`)
    .run(randomUUID(), orgA);
  // Contatos
  for (let i = 0; i < 3; i++) {
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, identifier) VALUES (?, ?, ?, ?)`)
      .run(randomUUID(), orgA, chanId, `5511900000${i}`);
  }
  // Owner
  const profOwnerId = randomUUID();
  db.prepare(`INSERT INTO role_profiles (id, organization_id, name, system_key, is_system) VALUES (?, ?, 'Dono', 'owner', 1)`)
    .run(profOwnerId, orgA);
  db.prepare(`INSERT INTO users (id, organization_id, email, role_profile_id, global_status) VALUES (?, ?, 'dono@toulon.com', ?, 'active')`)
    .run(randomUUID(), orgA, profOwnerId);

  const p1 = RuntimePilotService.plan(orgA);
  check("prereqs.channelsConnected conta só WhatsApp connected dessa org", p1.prereqs.channelsConnected === 1);
  check("prereqs.contactsCount = 3", p1.prereqs.contactsCount === 3);
  check("prereqs.ownersCount = 1", p1.prereqs.ownersCount === 1);
  check("plan pós-setup ainda PRONTO (nada ligado exigindo prereqs)", p1.readiness === "PRONTO");

  // ===== 4. Cascade em plan: liga sub-piloto sem master → BLOQUEADO =====
  db.prepare(`UPDATE organization_settings SET collection_cadence_enabled = 1 WHERE organization_id = ?`).run(orgA);
  const pCasc = RuntimePilotService.plan(orgA);
  check("cascade: cobrança sem runtime → BLOQUEADO", pCasc.readiness === "BLOQUEADO");
  check("cascade: blockers mencionam runtime", pCasc.blockers.some((b) => b.includes("execution_runtime_enabled")));
  // Limpa pra próximos casos
  db.prepare(`UPDATE organization_settings SET collection_cadence_enabled = 0 WHERE organization_id = ?`).run(orgA);

  // ===== 5. apply — liga runtime =====
  const pA1 = RuntimePilotService.apply(orgA, { runtime: true });
  check("apply --runtime liga execution_runtime_enabled", pA1.flags.runtime === true);
  check("apply --runtime NÃO liga sub-pilotos", !pA1.flags.collection && !pA1.flags.salesRecovery);
  // Idempotente
  const pA2 = RuntimePilotService.apply(orgA, { runtime: true });
  check("apply --runtime 2x é idempotente", pA2.flags.runtime === true);

  // ===== 6. apply — cascade lança erro =====
  let threw = "";
  try { RuntimePilotService.apply(orgB, { collection: true }); } catch (e: any) { threw = e.message; }
  check("apply --collection em org sem runtime lança erro", /Ligue --runtime/.test(threw));
  threw = "";
  try { RuntimePilotService.apply(orgA, { followup: true }); } catch (e: any) { threw = e.message; }
  check("apply --followup sem sales_recovery lança erro", /Ligue --sales-recovery/.test(threw));
  threw = "";
  try { RuntimePilotService.apply(orgA, { attribution: true }); } catch (e: any) { threw = e.message; }
  check("apply --attribution sem sales_recovery lança erro", /Ligue --sales-recovery/.test(threw));

  // ===== 7. apply — cascade OK quando master vem no MESMO comando =====
  const pMega = RuntimePilotService.apply(orgB, {
    runtime: true, collection: true, salesRecovery: true, followup: true, attribution: true,
  });
  check("apply mega: runtime+todos sub-pilotos liga tudo",
    pMega.flags.runtime && pMega.flags.collection && pMega.flags.salesRecovery
    && pMega.flags.followup && pMega.flags.attribution);

  // ===== 8. apply — validação numérica =====
  threw = "";
  try { RuntimePilotService.apply(orgA, { collectionR2Days: 0 }); } catch (e: any) { threw = e.message; }
  check("collection-r2-days=0 recusado (min=1)", /collection-r2-days/.test(threw));
  threw = "";
  try { RuntimePilotService.apply(orgA, { attributionWindowDays: 91 }); } catch (e: any) { threw = e.message; }
  check("attribution-window-days=91 recusado (max=90)", /attribution-window/.test(threw));
  threw = "";
  try { RuntimePilotService.apply(orgA, { followupGapDays: 5.5 }); } catch (e: any) { threw = e.message; }
  check("followup-gap-days=5.5 recusado (inteiro)", /followup-gap-days/.test(threw));

  // ===== 9. apply — tuning só grava quando veio =====
  const pTune = RuntimePilotService.apply(orgA, { stalledDays: 20, replyWindowDays: 21 });
  check("tuning stalledDays gravado", pTune.tuning.stalledDays === 20);
  check("tuning replyWindowDays gravado", pTune.tuning.replyWindowDays === 21);
  check("tuning collectionR2Days INALTERADO (não veio no opts)", pTune.tuning.collectionR2Days === 3);
  check("flags NÃO ativadas por tuning-only apply", !pTune.flags.salesRecovery);

  // ===== 10. seed-policies — cria + corrige row incorreta =====
  // Pre-condição: orgA agora precisa de sales_recovery ligado pra semear as dele.
  // Criamos uma policy de cobrança com autonomy errado, uma de recovery inexistente.
  db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'runtime', 'runtime_step_send_reminder', 'observe', 'shadow', 1)`)
    .run(randomUUID(), orgA);
  const pSeed = RuntimePilotService.apply(orgA, {
    collection: true, salesRecovery: true, seedPolicies: true,
  });
  check("apply liga collection + salesRecovery", pSeed.flags.collection && pSeed.flags.salesRecovery);
  const polCol1 = db.prepare(`SELECT autonomy_level, execution_mode FROM agent_policies WHERE organization_id = ? AND domain = 'runtime' AND action_type = 'runtime_step_send_reminder'`).get(orgA) as any;
  check("seed-policies CORRIGE autonomy_level pra execute", polCol1?.autonomy_level === "execute");
  check("seed-policies CORRIGE execution_mode pra approved_execution", polCol1?.execution_mode === "approved_execution");
  const polCol2 = db.prepare(`SELECT autonomy_level, execution_mode FROM agent_policies WHERE organization_id = ? AND domain = 'runtime' AND action_type = 'collection_send_reminder'`).get(orgA) as any;
  check("seed-policies CRIA row nova pra collection_send_reminder", polCol2?.autonomy_level === "execute" && polCol2?.execution_mode === "approved_execution");
  const polRec1 = db.prepare(`SELECT autonomy_level FROM agent_policies WHERE organization_id = ? AND domain = 'runtime' AND action_type = 'runtime_step_propose'`).get(orgA) as any;
  const polRec2 = db.prepare(`SELECT autonomy_level FROM agent_policies WHERE organization_id = ? AND domain = 'runtime' AND action_type = 'sales_recovery_propose_message'`).get(orgA) as any;
  check("seed-policies também semeia policies do sales_recovery", polRec1?.autonomy_level === "execute" && polRec2?.autonomy_level === "execute");
  check("plan.policiesReady.collection = true pós-seed", pSeed.prereqs.policiesReady.collection === true);
  check("plan.policiesReady.salesRecovery = true pós-seed", pSeed.prereqs.policiesReady.salesRecovery === true);

  // Idempotente: 2x seed não duplica (unique constraint) e não muda valores corretos.
  const polCountBefore = (db.prepare(`SELECT COUNT(*) c FROM agent_policies WHERE organization_id = ? AND domain = 'runtime'`).get(orgA) as any).c;
  RuntimePilotService.apply(orgA, { seedPolicies: true, collection: true, salesRecovery: true });
  const polCountAfter = (db.prepare(`SELECT COUNT(*) c FROM agent_policies WHERE organization_id = ? AND domain = 'runtime'`).get(orgA) as any).c;
  check("seed-policies 2x é idempotente (não duplica)", polCountBefore === polCountAfter);

  // ===== 11. seed-policies NÃO toca sub-piloto desligado (não vaza) =====
  // orgC virgem: liga só runtime + collection + seed → NÃO deve semear sales_recovery.
  const orgC = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org C', 'active')`)
    .run(randomUUID(), orgC);
  RuntimePilotService.apply(orgC, { runtime: true, collection: true, seedPolicies: true });
  const polRecC = db.prepare(`SELECT COUNT(*) c FROM agent_policies WHERE organization_id = ? AND action_type LIKE 'sales_recovery%'`).get(orgC) as any;
  check("seed-policies não semeia sales_recovery quando ele NÃO está ligado", polRecC.c === 0);
  const polColC = db.prepare(`SELECT COUNT(*) c FROM agent_policies WHERE organization_id = ? AND action_type IN ('runtime_step_send_reminder','collection_send_reminder')`).get(orgC) as any;
  check("seed-policies semeia collection (que ESTÁ ligado) na orgC", polColC.c === 2);

  // ===== 12. audit RUNTIME_PILOT_APPLY =====
  const audits = db.prepare(`SELECT metadata_json FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'RUNTIME_PILOT_APPLY' ORDER BY created_at`)
    .all(orgA) as any[];
  check("audit RUNTIME_PILOT_APPLY foi registrado em orgA", audits.length >= 3);
  const lastMeta = JSON.parse(audits[audits.length - 1].metadata_json);
  check("audit inclui seededPolicies quando --seed-policies passa", Array.isArray(lastMeta.seededPolicies) && lastMeta.seededPolicies.length > 0);
  check("audit inclui before-state (baseline)", typeof lastMeta.before === "object" && "runtime" in lastMeta.before);
  check("audit inclui opts.tuning", typeof lastMeta.opts?.tuning === "object");

  // ===== 13. Isolamento cross-tenant =====
  const pB = RuntimePilotService.plan(orgB);
  check("orgB não herda mudanças de orgA (channelsConnected)", pB.prereqs.channelsConnected === 1);
  check("orgB tuning intactos (defaults)", pB.tuning.stalledDays === 10);
  const polB = db.prepare(`SELECT COUNT(*) c FROM agent_policies WHERE organization_id = ? AND domain = 'runtime'`).get(orgB) as any;
  check("orgB não recebeu policies semeadas de orgA", polB.c === 0);

  // ===== 14. Org inexistente/soft-deleted =====
  threw = "";
  try { RuntimePilotService.plan("org_inexistente"); } catch (e: any) { threw = e.message; }
  check("plan(orgId inexistente) lança erro", /Organização não encontrada/.test(threw));
  threw = "";
  try { RuntimePilotService.plan(orgDeleted); } catch (e: any) { threw = e.message; }
  check("plan(orgId soft-deleted) lança erro (deleted_at != NULL)", /Organização não encontrada/.test(threw));
  threw = "";
  try { RuntimePilotService.apply(orgDeleted, { runtime: true }); } catch (e: any) { threw = e.message; }
  check("apply em org soft-deleted lança erro", /Organização não encontrada/.test(threw));

  // ===== 15. Warnings acumulam quando piloto ligado sem pré-reqs =====
  const orgD = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org D sem prereqs', 'active')`)
    .run(randomUUID(), orgD);
  RuntimePilotService.apply(orgD, { runtime: true, collection: true, salesRecovery: true });
  const pD = RuntimePilotService.plan(orgD);
  check("orgD sem prereqs → warnings acumulam", pD.warnings.length >= 4);
  check("orgD sem prereqs → readiness = PENDENCIAS (não BLOQUEADO)", pD.readiness === "PENDENCIAS");
  check("warning: sem canal WhatsApp", pD.warnings.some((w) => /WhatsApp/i.test(w)));
  check("warning: sem contatos", pD.warnings.some((w) => /contatos/i.test(w)));
  check("warning: sem owner", pD.warnings.some((w) => /owner/i.test(w)));
  check("warning: sem OpenAI key", pD.warnings.some((w) => /OPENAI/i.test(w)));

  // ===== Resultado =====
  console.log("\n=== Pilot Runtime (F4d.1) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? "  (" + r.note + ")" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
