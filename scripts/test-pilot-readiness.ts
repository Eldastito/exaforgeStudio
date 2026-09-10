/**
 * TEST — F7.3 (RF §21 §531/§602 / Gate G7): prontidão de AMPLIAÇÃO do piloto.
 *
 * Prova, offline (tmp db), que `PilotReadinessService.assess` COMPÕE read-only as
 * superfícies existentes (migração F4 + filas F6 + canais F1.2d) num veredito
 * ADVISÓRIO dos gates de reconciliação — "ampliar só com gates cumpridos":
 *  - elo quebrado / estado divergente na migração → BLOQUEIA (§15.1/§602);
 *  - fila presa acima do limite / `unknown` não reconciliado → BLOQUEIA (§14/§602);
 *  - webhook rejeitado num canal → BLOQUEIA (recebimento não confiável, A10);
 *  - org reconciliada (sem elo quebrado/divergência/fila presa/rejeição) → ready;
 *  - falhas permanentes/transitórias e migráveis pendentes = WARNINGS, não bloqueiam;
 *  - limiares configuráveis; read-only (não muda nada); isolado por org.
 *
 * Uso: npm run test:pilot-readiness
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pilot-ready-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pilot-ready-1";
process.env.CONTINUITY_DELIVERY_MAX_ATTEMPTS = "2";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { PilotReadinessService: PR } = await import("../src/server/PilotReadinessService.js");
  const { TaskService } = await import("../src/server/TaskService.js");
  const { recordWebhookHit } = await import("../src/server/webhookSecurity.js");

  const mkOrg = (org: string, flagsOn: boolean) =>
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, falatu_bridge_tasks_enabled, falatu_bridge_lists_enabled) VALUES (?, ?, 'X', 'active', ?, ?)`)
      .run(`os-${org}`, org, flagsOn ? 1 : 0, flagsOn ? 1 : 0);
  const mkFtTask = (org: string, title: string, bridged: string | null, completed = 0) =>
    db.prepare(`INSERT INTO falatu_tasks (id, organization_id, user_id, title, completed, inbox_item_id, bridged_task_id) VALUES (?, ?, 'U', ?, ?, ?, ?)`)
      .run(randomUUID(), org, title, completed, `ib-${randomUUID()}`, bridged);
  const mkCh = (org: string, status = "connected") => { const id = `ch_${randomUUID().slice(0, 6)}`; db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, token_encrypted) VALUES (?, ?, 'whatsapp_cloud', 'n', ?, ?, 'TOK')`).run(id, org, `id_${randomUUID().slice(0,4)}`, status); return id; };
  const enqueue = (org: string, ch: string, status: string, opts: { ageHours?: number; failureClass?: string } = {}) => {
    const nextAt = opts.ageHours ? `datetime('now','-${opts.ageHours} hours')` : `datetime('now','+1 hour')`;
    db.prepare(`INSERT INTO message_deliveries (id, organization_id, message_id, channel_id, recipient, content, status, max_attempts, attempt_count, next_attempt_at, failure_class) VALUES (?, ?, ?, ?, '5511', 'x', ?, 6, 0, ${nextAt}, ?)`)
      .run(randomUUID(), org, randomUUID(), ch, status, opts.failureClass || null);
  };

  // ═══ ORG A — piloto COM pendências (deve bloquear) ═══
  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A, true);
  const chOk = mkCh(A, "connected");
  // migração: 1 divergente + 1 elo quebrado + 1 ok + 1 migrável
  const canonOpen = TaskService.create(A, { title: "canon-open", source: "falatu" }, "U");
  mkFtTask(A, "t-ok", canonOpen.id, 0);
  const canonOpen2 = TaskService.create(A, { title: "canon-open2", source: "falatu" }, "U");
  mkFtTask(A, "t-divergent", canonOpen2.id, 1); // silo feita × canon aberta
  mkFtTask(A, "t-broken", "ghost-task", 0);
  mkFtTask(A, "t-unlinked", null, 0);
  // filas: 1 preso há 3h + 1 unknown
  enqueue(A, chOk, "queued", { ageHours: 3 });
  enqueue(A, chOk, "unknown");
  enqueue(A, chOk, "failed", { failureClass: "permanent" });
  enqueue(A, chOk, "sent");

  const rA = PR.assess(A, { maxQueueAgeSec: 3600, maxUnknown: 0 });
  check("1.1 org com pendências → NÃO ready", rA.ready === false);
  check("1.2 migração bloqueia por elo quebrado", rA.migration.ready === false && rA.migration.blockers.some((b) => b.includes("quebrado")));
  check("1.3 migração bloqueia por estado divergente", rA.migration.blockers.some((b) => b.includes("divergente")));
  check("1.4 migração migrável pendente é WARNING (não bloqueia por si)", rA.migration.warnings.some((w) => w.includes("migrável")));
  check("1.5 fila bloqueia por item preso acima do limite", rA.queue.ready === false && rA.queue.blockers.some((b) => b.includes("presa")));
  check("1.6 fila bloqueia por unknown não reconciliado", rA.queue.blockers.some((b) => b.includes("indeterminado")));
  check("1.7 falha permanente é WARNING (esperada), não bloqueio", rA.queue.warnings.some((w) => w.includes("permanente")));
  check("1.8 blockers agregados incluem migração+fila", rA.blockers.length >= 4);

  // ── webhook rejeitado → canal bloqueia (recebimento não confiável) ──
  recordWebhookHit(false, "segredo_incorreto");
  const rAws = PR.assess(A);
  check("1.9 webhook rejeitado → canal NÃO ready + bloqueio A10", rAws.channels.ready === false && rAws.channels.blockers.some((b) => b.includes("REJEITADO")));

  // ═══ ORG B — reconciliada (deve ficar ready) ═══
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B, true);
  const chB = mkCh(B, "connected");
  // migração limpa: só vínculos coerentes
  const cb = TaskService.create(B, { title: "cb", source: "falatu" }, "U");
  mkFtTask(B, "b-ok", cb.id, 0);
  // filas saudáveis: enviados/entregues, nada preso, nada unknown
  enqueue(B, chB, "sent");
  enqueue(B, chB, "delivered");
  recordWebhookHit(true, "recebido"); // webhook healthy p/ todos (estado global de teste)

  const rB = PR.assess(B);
  check("2.1 org reconciliada → migração ready", rB.migration.ready === true && rB.migration.blockers.length === 0);
  check("2.2 org reconciliada → fila ready", rB.queue.ready === true);
  check("2.3 org reconciliada → canais ready (webhook healthy)", rB.channels.ready === true);
  check("2.4 org reconciliada → GATE ready (pode ampliar)", rB.ready === true && rB.blockers.length === 0);
  check("2.5 veredito é advisório (nota explícita)", /ADVIS[ÓO]RIO/i.test(rB.note));

  // ── limiar configurável: tolerar 1 unknown reergue a fila da org A? só o unknown. ──
  enqueue(B, chB, "unknown");
  const rBstrict = PR.assess(B, { maxUnknown: 0 });
  const rBloose = PR.assess(B, { maxUnknown: 1 });
  check("3.1 limiar maxUnknown=0 → 1 unknown bloqueia a fila", rBstrict.queue.ready === false);
  check("3.2 limiar maxUnknown=1 → tolera 1 unknown (fila ready)", rBloose.queue.ready === true);

  // ── isolamento + read-only ──
  const C = `org_C_${randomUUID().slice(0, 6)}`; mkOrg(C, false);
  const rC = PR.assess(C);
  check("4.1 org vazia → sem blockers de A/B (isolamento)", rC.migration.detail.brokenLinks === 0 && rC.queue.detail.queued === 0);
  // read-only: reassess de A não muda contagens
  const rA2 = PR.assess(A);
  check("4.2 read-only: reassess estável (mesmos blockers de migração)", rA2.migration.blockers.length === rA.migration.blockers.length);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} pilot-readiness: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
