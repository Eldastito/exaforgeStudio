/**
 * TEST — PRD 1 Fase 8 (§42-47): entrega proativa event-driven. O Fala Tu fala
 * PRIMEIRO quando algo urgente aparece na Smart Inbox.
 *
 * Prova (determinístico; push injetado; `now` fixo):
 *   - seleciona só o URGENTE (aprovações + riscos críticos), ignora info/proposta;
 *   - 1 push agregado (§44); dedup por item (2ª passada não repete, §44);
 *   - quiet hours (§45): fora da janela não envia;
 *   - escopo por papel: vendedor não é alertado do risco financeiro;
 *   - marca só após envio: sem inscrição → não marca (retenta depois).
 *
 * Uso: npm run test:falatu-proactive
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-proactive-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-proactive-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const AWAKE = new Date("2026-08-10T18:00:00Z"); // 15h SP → dentro da janela
const QUIET = new Date("2026-08-10T06:00:00Z"); // 03h SP → quiet hours

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuProactiveService: FP } = await import("../src/server/FalaTuProactiveService.js");
  const { FalaTuPushService: PS } = await import("../src/server/FalaTuPushService.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const org = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, falatu_proactive_alerts_enabled) VALUES (?, ?, 'X', 'active', 1)`).run(randomUUID(), org);
  PermissionService.seedSystemProfiles(org);
  const userFor = (key: string) => ({ userId: randomUUID(), role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id, role: key });
  const owner = userFor("owner"), vendedor = userFor("vendedor");

  const sub = (userId: string, tag: string) => PS.subscribe(org, userId, { endpoint: `https://push.example/${tag}`, keys: { p256dh: "k", auth: "a" } });
  sub(owner.userId, "owner"); sub(vendedor.userId, "vend");

  // Urgentes: 1 aprovação (sales) + 1 risco crítico (finance). Ruído: info + proposta.
  db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, approval_policy, created_by, priority_score) VALUES (?, ?, 'sales', 'refund', 'Aprovar compra grande', 'awaiting_approval', 'single', 'rule', 10)`).run(randomUUID(), org);
  BS.publish(org, { domain: "finance", signalType: "cash_low", severity: "critical", basis: "fact", confidence: 0.9, sourceService: "test", dedupeKey: "r1", impactAmount: 9000, impactUnit: "BRL", evidence: {} });
  BS.publish(org, { domain: "tasks", signalType: "tasks_summary", severity: "info", basis: "fact", confidence: 1, sourceService: "test", dedupeKey: "i1", evidence: {} });
  db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, approval_policy, created_by) VALUES (?, ?, 'sales', 'x', 'Proposta', 'proposed', 'single', 'rule')`).run(randomUUID(), org);

  const mkPush = () => { const got: any[] = []; return { got, fn: async (_s: any, json: string) => { got.push(JSON.parse(json)); } }; };

  // ===== 1. Owner: fala primeiro, 1 push com aprovação + risco =====
  const p1 = mkPush();
  const r1 = await FP.deliver(org, owner, { now: AWAKE, push: p1.fn });
  check("1.1 entregou (delivered>0) 2 itens urgentes", r1.delivered > 0 && r1.items === 2);
  check("1.2 um único push agregado", p1.got.length === 1);
  check("1.3 título menciona aprovação e risco", /aprova/i.test(p1.got[0]?.title) && /risco/i.test(p1.got[0]?.title));
  check("1.4 ignora info/proposta (só urgente)", r1.items === 2);

  // ===== 2. Dedup: 2ª passada não repete (§44) =====
  const p2 = mkPush();
  const r2 = await FP.deliver(org, owner, { now: AWAKE, push: p2.fn });
  check("2.1 2ª passada: nada novo (already_sent)", r2.delivered === 0 && r2.skipped === "already_sent" && p2.got.length === 0);

  // ===== 3. Quiet hours (§45) =====
  const p3 = mkPush();
  const other = userFor("gerente"); sub(other.userId, "ger");
  const r3 = await FP.deliver(org, other, { now: QUIET, push: p3.fn });
  check("3.1 fora da janela: skipped quiet_hours, sem push", r3.skipped === "quiet_hours" && p3.got.length === 0);

  // ===== 4. Escopo por papel: vendedor não é alertado do risco financeiro =====
  const p4 = mkPush();
  const r4 = await FP.deliver(org, vendedor, { now: AWAKE, push: p4.fn });
  check("4.1 vendedor recebe só a aprovação de sales (1 item), sem o risco finance", r4.items === 1 && !/risco/i.test(p4.got[0]?.title || ""));

  // ===== 5. Marca só após envio: sem inscrição → não marca, retenta depois =====
  const semSub = userFor("financeiro"); // vê o risco financeiro crítico
  const r5a = await FP.deliver(org, semSub, { now: AWAKE, push: mkPush().fn });
  check("5.1 sem inscrição → não entrega (no_subscription)", r5a.delivered === 0 && r5a.skipped === "no_subscription");
  sub(semSub.userId, "fin");
  const p5 = mkPush();
  const r5b = await FP.deliver(org, semSub, { now: AWAKE, push: p5.fn });
  check("5.2 após inscrever: o item NÃO foi marcado antes → agora entrega", r5b.delivered > 0 && p5.got.length === 1);

  // ===== 6. Opt-in por org =====
  check("6.1 flag de opt-in respeitada (enabled=true)", FP.enabled(org) === true);

  console.log("\n=== TEST: Entrega proativa (PRD 1 Fase 8) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Entrega proativa (Fase 8) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
