/**
 * TEST — Mission Readiness + Risk (ADR-189 F4, Mission OS). DB-backed, determinístico.
 * Prova: compõe dimensões (contract/plan/data/channel/risk) num score só com aplicáveis; missão
 * qualitativa não é penalizada (plan/data = n/a); canal conectado e riscos abertos (Pre-Mortem light)
 * entram; blockers listados; NÃO expõe infra; read-only; isolamento.
 *
 * Uso: npm run test:mission-readiness
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mready-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mready-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MissionReadinessService: R } = await import("../src/server/MissionReadinessService.js");
  const { MissionService: M } = await import("../src/server/MissionService.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");

  const mkOrg = () => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, mission_layer_enabled) VALUES (?, ?, 'O', 'active', 1)`).run(randomUUID(), o); return o; };
  const dim = (r: any, k: string) => r.dimensions.find((d: any) => d.key === k);

  // Org A: missão de receita SEM canal, SEM base/ticket, SEM premissas → várias dimensões não prontas.
  const A = mkOrg();
  const mA = M.create(A, { title: "Bater R$100k", targetMetric: "revenue", targetValue: 100000, deadline: "2026-09-30" });
  const rA = R.assess(A, mA.id, {});
  check("1.1 contract pronto (título+alvo+prazo)", dim(rA, "contract").ready === true);
  check("1.2 plan aplicável mas não pronto (sem premissas → unknown)", dim(rA, "plan").ready === false);
  check("1.3 data não pronto (sem ticket/base)", dim(rA, "data").ready === false);
  check("1.4 channel não pronto (sem canal)", dim(rA, "channel").ready === false);
  check("1.5 blockers listados", rA.blockers.length >= 2 && rA.readyPct < 100);
  check("1.6 humanState 'Precisa de preparo'", rA.humanState === "Precisa de preparo");
  check("1.7 NÃO expõe infra (sem dimensão de CPU/fila/headroom)", !rA.dimensions.some((d: any) => /cpu|fila|headroom|infra|mem[oó]ria/i.test(d.label)));

  // Org B: tudo pronto — canal conectado, ticket/base/premissas ok, sem risco.
  const B = mkOrg();
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp', 'wa', '5511999', 'connected')`).run(randomUUID(), B);
  for (let i = 0; i < 5; i++) db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'C', ?)`).run(randomUUID(), B, `id${i}`);
  const mB = M.create(B, { title: "meta", targetMetric: "revenue", targetValue: 1000, deadline: "2026-12-31" });
  const rB = R.assess(B, mB.id, { avgTicket: 100, saleConversionRate: 0.5, contactConversionRate: 0.5, baseAvailable: 200 });
  check("2.1 channel pronto (canal conectado)", dim(rB, "channel").ready === true);
  check("2.2 plan pronto (cadeia completa) + data pronto", dim(rB, "plan").ready === true && dim(rB, "data").ready === true);
  check("2.3 risk pronto (nenhum risco aberto)", dim(rB, "risk").ready === true && rB.risks.length === 0);
  check("2.4 readyPct 100 + 'Pronta pra começar'", rB.readyPct === 100 && rB.humanState === "Pronta pra começar");

  // 3. Risco antecedente (Pre-Mortem light): sinal risk aberto entra em risks.
  BS.publish(B, { domain: "cash", signalType: "rupture_risk", severity: "risk", basis: "hypothesis", confidence: 0.5, impactAmount: null, sourceService: "test", evidence: {}, dedupeKey: "cash:rupture_risk" });
  const rB2 = R.assess(B, mB.id, { avgTicket: 100, saleConversionRate: 0.5, contactConversionRate: 0.5, baseAvailable: 200 });
  check("3.1 risco aberto surfaçado + dimensão risk não-pronta", rB2.risks.length === 1 && dim(rB2, "risk").ready === false);
  check("3.2 nota menciona risco", /risco/i.test(rB2.note));

  // 3b. AGENDA (F29): a dimensão "data" é POR MÉTRICA — clínica fica pronta por COMPARECIMENTO,
  // sem exigir ticket médio (antes o dado revenue-cêntrico dava falso "falta ticket" na agenda).
  const CL = mkOrg();
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp', 'wa', '5511', 'connected')`).run(randomUUID(), CL);
  for (let i = 0; i < 40; i++) db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, status, scheduled_start) VALUES (?, ?, 'ct', 'C', ?, '2026-07-10 09:00:00')`).run(randomUUID(), CL, i < 32 ? "completed" : "no_show");
  for (let i = 0; i < 100; i++) db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'C', ?)`).run(randomUUID(), CL, `c${i}`);
  const mCL = M.create(CL, { title: "200 atendimentos", targetMetric: "appointments", targetValue: 200, targetUnit: "count", deadline: "2026-12-31" });
  const rCL = R.assess(CL, mCL.id, { bookingConversionRate: 0.3 });
  check("3b.1 agenda: data pronto por COMPARECIMENTO (não exige ticket)", dim(rCL, "data").ready === true && /comparecimento/i.test(dim(rCL, "data").detail));

  // 4. Missão qualitativa: plan/data = n/a (não penaliza o score).
  const mQ = M.create(B, { title: "reduzir tempo de resposta" });
  const rQ = R.assess(B, mQ.id, {});
  check("4.1 qualitativa: plan/data ready=null (n/a)", dim(rQ, "plan").ready === null && dim(rQ, "data").ready === null);

  // 5. Read-only + isolamento.
  const before = (db.prepare(`SELECT COUNT(*) n FROM missions WHERE organization_id=?`).get(B) as any).n;
  R.assess(B, mB.id, {});
  check("5.1 read-only (missões intactas)", (db.prepare(`SELECT COUNT(*) n FROM missions WHERE organization_id=?`).get(B) as any).n === before);
  let isolated = false; try { R.assess(A, mB.id, {}); } catch { isolated = true; }
  check("5.2 cross-org → erro", isolated);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mission-readiness: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
