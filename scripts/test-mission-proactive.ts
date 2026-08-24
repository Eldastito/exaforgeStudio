/**
 * TEST — Proactive Missions (ADR-189 F11, Mission OS). DB-backed, determinístico.
 * Prova: sinais abertos viram PROPOSTAS de missão (mapa determinístico domínio→forma); postura
 * shadow-first (off → nada; shadow → calcula sem gravar; suggest → grava rascunho system_generated);
 * 'auto' recusado; missão proativa nasce draft/off (nunca executa); dedup por signal:<id>; domínio
 * não mapeado ignorado; isolamento.
 *
 * Uso: npm run test:mission-proactive
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mpro-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mpro-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
function throws(fn: () => any): boolean { try { fn(); return false; } catch { return true; } }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MissionProactiveService: P } = await import("../src/server/MissionProactiveService.js");
  const { MissionService: M } = await import("../src/server/MissionService.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");

  const mkOrg = () => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, mission_layer_enabled) VALUES (?, ?, 'O', 'active', 1)`).run(randomUUID(), o); return o; };
  const sigCollection = (org: string) => BS.publish(org, { domain: "collection", signalType: "overdue", severity: "risk", basis: "hypothesis", confidence: 0.5, impactAmount: 12400, sourceService: "test", evidence: {}, dedupeKey: `collection:${randomUUID()}` });

  const A = mkOrg();
  sigCollection(A);

  // 1. scan deriva proposta (mapa determinístico) — read-only, nada gravado.
  const before = (db.prepare(`SELECT COUNT(*) n FROM missions WHERE organization_id=?`).get(A) as any).n;
  const proposals = P.scan(A);
  check("1.1 sinal de cobrança → proposta collect_receivable", proposals.length === 1 && proposals[0].shape.intentId === "collect_receivable");
  check("1.2 scan é read-only (nada gravado)", (db.prepare(`SELECT COUNT(*) n FROM missions WHERE organization_id=?`).get(A) as any).n === before);

  // 2. Postura: 'auto' recusado; default off.
  check("2.1 modo default off", P.mode(A) === "off");
  check("2.2 'auto' recusado (nunca executa sozinha)", throws(() => P.setMode(A, "auto")));

  // 3. shadow → calcula, não grava.
  const rS = P.run(A, { mode: "shadow" });
  check("3.1 shadow → propõe mas não grava", rS.proposals.length === 1 && rS.created.length === 0 && (db.prepare(`SELECT COUNT(*) n FROM missions WHERE organization_id=?`).get(A) as any).n === 0);

  // 4. suggest → grava rascunho system_generated, nasce draft/off (nunca executa).
  P.setMode(A, "suggest");
  const rG = P.run(A);
  check("4.1 suggest → cria missão system_generated draft/off", rG.created.length === 1 && rG.created[0].source === "system_generated" && rG.created[0].status === "draft" && rG.created[0].autonomyLevel === "off");
  check("4.2 zero decision_action (nunca executa)", (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=?`).get(A) as any).n === 0);

  // 5. Dedup por signal:<id> — rodar de novo não duplica.
  const rG2 = P.run(A);
  check("5.1 idempotente (não duplica pelo mesmo sinal)", rG2.created.length === 0 && (db.prepare(`SELECT COUNT(*) n FROM missions WHERE organization_id=? AND source='system_generated'`).get(A) as any).n === 1);

  // 6. Domínio não mapeado → ignorado (não força missão).
  const B = mkOrg();
  BS.publish(B, { domain: "random_unmapped", signalType: "whatever", severity: "attention", basis: "hypothesis", confidence: 0.5, impactAmount: null, sourceService: "test", evidence: {}, dedupeKey: `x:${randomUUID()}` });
  check("6.1 domínio não mapeado → sem proposta", P.scan(B).length === 0);

  // 7. off → run não grava.
  const C = mkOrg();
  sigCollection(C);
  const rOff = P.run(C, { mode: "off" });
  check("7.1 off → nada gravado", rOff.created.length === 0 && (db.prepare(`SELECT COUNT(*) n FROM missions WHERE organization_id=?`).get(C) as any).n === 0);

  // 8. Isolamento: a missão proativa de A não vaza pra B.
  check("8.1 isolado (A tem system_generated, B não)", (db.prepare(`SELECT COUNT(*) n FROM missions WHERE organization_id=? AND source='system_generated'`).get(A) as any).n === 1 && (db.prepare(`SELECT COUNT(*) n FROM missions WHERE organization_id=? AND source='system_generated'`).get(B) as any).n === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mission-proactive: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
