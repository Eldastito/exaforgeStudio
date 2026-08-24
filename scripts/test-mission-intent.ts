/**
 * TEST — Intent → Mission (ADR-189 F2, Mission OS). DB-backed, determinístico.
 * Prova: detecção determinística (várias intenções → formato de missão + métrica correta), parsing
 * de valor-alvo (R$ e contagem), frase sem objetivo → isMission:false (não força), SHADOW (propose
 * sem persist não grava; persist cria draft/off/system_proposed e NUNCA decision_action), isolamento.
 *
 * Uso: npm run test:mission-intent
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mintent-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mintent-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MissionIntentService: MI } = await import("../src/server/MissionIntentService.js");
  const { MissionService: M } = await import("../src/server/MissionService.js");

  const mkOrg = () => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, mission_layer_enabled) VALUES (?, ?, 'O', 'active', 1)`).run(randomUUID(), o); return o; };
  const A = mkOrg();

  // 1. Detecção por intenção + métrica.
  const rev = MI.detect("quero vender mais e bater a meta de faturamento");
  check("1.1 'vender mais' → grow_revenue, métrica revenue", rev.isMission && rev.intentId === "grow_revenue" && rev.shape?.targetMetric === "revenue");
  const ag = MI.detect("preciso lotar a agenda da semana que vem");
  check("1.2 'lotar a agenda' → fill_schedule, métrica appointments", ag.isMission && ag.intentId === "fill_schedule" && ag.shape?.targetMetric === "appointments");
  const rec = MI.detect("quero recuperar clientes antigos que pararam de comprar");
  check("1.3 'recuperar clientes antigos' → recover_customer, qualitativa (métrica null)", rec.isMission && rec.intentId === "recover_customer" && rec.shape?.targetMetric === null);
  const cob = MI.detect("preciso cobrar quem está em atraso");
  check("1.4 'cobrar em atraso' → collect_receivable", cob.isMission && cob.intentId === "collect_receivable");

  // 2. Parsing de valor-alvo.
  const v1 = MI.detect("recuperar R$ 20.000 de inadimplência");
  check("2.1 R$ 20.000 → 20000", v1.shape?.targetValue === 20000);
  const v2 = MI.detect("quero atingir R$ 500 mil de faturamento no mês");
  check("2.2 R$ 500 mil → 500000", v2.shape?.targetValue === 500000);
  const v3 = MI.detect("preciso preencher 6 horários vagos");
  check("2.3 '6 horários' → 6 (count)", v3.shape?.targetValue === 6);

  // 3. Frase sem objetivo → não força missão.
  const none = MI.detect("bom dia, tudo bem?");
  check("3.1 sem objetivo → isMission false (não inventa)", none.isMission === false && !none.shape);

  // 4. SHADOW: propose sem persist NÃO grava.
  const before = (db.prepare(`SELECT COUNT(*) n FROM missions WHERE organization_id=?`).get(A) as any).n;
  const p1 = MI.propose(A, "quero vender mais");
  check("4.1 propose sem persist → proposta mas nada gravado", p1.proposal.isMission && p1.mission === null && (db.prepare(`SELECT COUNT(*) n FROM missions WHERE organization_id=?`).get(A) as any).n === before);

  // 5. persist cria draft/off/system_proposed; NUNCA decision_action.
  const p2 = MI.propose(A, "recuperar R$ 20.000 de inadimplência", { persist: true });
  check("5.1 persist → missão draft/off/system_proposed", !!p2.mission && p2.mission!.status === "draft" && p2.mission!.autonomyLevel === "off" && p2.mission!.source === "system_proposed");
  check("5.2 alvo persistido (20000)", p2.mission!.targetValue === 20000);
  check("5.3 zero decision_action (shadow, nunca executa)", (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=?`).get(A) as any).n === 0);

  // 6. Frase não-missão com persist → nada gravado.
  const p3 = MI.propose(A, "obrigado!", { persist: true });
  check("6.1 não-missão com persist → nada gravado", p3.mission === null);

  // 7. Isolamento: a missão persistida é só da org A.
  const B = mkOrg();
  check("7.1 isolamento (A tem a missão, B não)", M.list(A).length >= 1 && M.list(B).length === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mission-intent: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
