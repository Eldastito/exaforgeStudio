/**
 * TEST — PRD 2 F7 (§38): refino da priorização de impacto com dois FATORES
 * SITUACIONAIS que o score de 5 fatores (§9.2) não media — PRESSÃO DE PRAZO (SLA)
 * e IRREVERSIBILIDADE. Ambos boosts MULTIPLICATIVOS que defaultam a 0 (identidade)
 * quando o sinal não os carrega → zero regressão (mesma mecânica da F5/goal).
 *
 * Prova (determinístico, sem IA):
 *   - slaPressure: sem prazo → 0; prazo distante (>horizonte) → 0; prazo no fio
 *     → >0; prazo estourado → 1; `now` injetável;
 *   - irreversibility: sem hint → 0; hint low/irreversible → 1; high/reversible → 0;
 *   - no score: sinal com prazo no fio > sinal idêntico sem prazo; sinal
 *     irreversível > sinal idêntico reversível; ambos os componentes expostos;
 *   - baseline: sinal sem prazo/hint tem score IDÊNTICO ao de antes (boost 0);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:impact-sla-reversibility
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-impact-sla-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-impact-sla-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");
  const { ImpactPrioritizationService: P } = await import("../src/server/ImpactPrioritizationService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
  const H = 72 * 3600 * 1000;

  // ===== 1. slaPressure puro (now injetável) =====
  const now = 1_000_000_000_000;
  check("1.1 sem prazo → 0", P.slaPressure({}, now) === 0);
  check("1.2 prazo além do horizonte (30 dias) → 0", P.slaPressure({ expires_at: new Date(now + 30 * 24 * 3600 * 1000).toISOString() }, now) === 0);
  check("1.3 prazo estourado → 1", P.slaPressure({ expires_at: new Date(now - 3600 * 1000).toISOString() }, now) === 1);
  check("1.4 prazo no meio do horizonte (36h) → ~0.5", near(P.slaPressure({ expires_at: new Date(now + H / 2).toISOString() }, now), 0.5));
  check("1.5 prazo no limite exato do horizonte → 0", P.slaPressure({ expires_at: new Date(now + H).toISOString() }, now) === 0);
  check("1.6 prazo inválido → 0 (fail-safe)", P.slaPressure({ expires_at: "não-é-data" }, now) === 0);

  // ===== 2. irreversibility puro (do hint em evidence) =====
  const ev = (o: any) => ({ evidence_json: JSON.stringify(o) });
  check("2.1 sem hint → 0", P.irreversibility(ev({})) === 0);
  check("2.2 hint low → 1 (pouco reversível = janela fecha)", P.irreversibility(ev({ reversibility: "low" })) === 1);
  check("2.3 hint irreversible → 1", P.irreversibility(ev({ reversibility: "irreversible" })) === 1);
  check("2.4 hint high/reversible → 0", P.irreversibility(ev({ reversibility: "high" })) === 0 && P.irreversibility(ev({ reversibility: "reversible" })) === 0);
  check("2.5 hint medium → 0.5", P.irreversibility(ev({ reversibility: "medium" })) === 0.5);
  check("2.6 hint desconhecido → 0 (não presume)", P.irreversibility(ev({ reversibility: "talvez" })) === 0);

  // ===== 3. Baseline: sinal sem prazo/hint = score idêntico ao pré-F7 =====
  // baseScore de um sinal isolado (único na unidade) é conhecido: normImpact=1.
  const orgBase = mkOrg();
  BS.publish(orgBase, { domain: "sales", signalType: "plain", severity: "risk", basis: "fact", confidence: 0.9, sourceService: "test", impactAmount: 1000, impactUnit: "BRL", evidence: {}, dedupeKey: "b1" });
  const base = P.prioritize(orgBase).global[0];
  // normImpact=1*0.4 + urgency(risk .7)*0.2 + conf .9*0.15 + strategic(sales .8)*0.15 + actionability(fact .9, sem action)*0.1
  const expectedBase = 1 * 0.4 + 0.7 * 0.2 + 0.9 * 0.15 + 0.8 * 0.15 + 0.9 * 0.1;
  check("3.1 sem prazo/hint: score = base puro (boosts 0)", near(base.score, Math.round(expectedBase * 10000) / 10000));
  check("3.2 componentes F7 expostos e zerados", base.components.slaPressure === 0 && base.components.irreversibility === 0);

  // ===== 4. SLA sobe a prioridade =====
  const orgSla = mkOrg();
  BS.publish(orgSla, { domain: "sales", signalType: "no_deadline", severity: "risk", basis: "fact", confidence: 0.9, sourceService: "test", impactAmount: 1000, impactUnit: "BRL", evidence: {}, dedupeKey: "n1" });
  BS.publish(orgSla, { domain: "sales", signalType: "tight_deadline", severity: "risk", basis: "fact", confidence: 0.9, sourceService: "test", impactAmount: 1000, impactUnit: "BRL", evidence: {}, dedupeKey: "n2", expiresAt: iso(3600 * 1000) });
  const sla = P.prioritize(orgSla);
  const noDl = sla.global.find((p: any) => p.signalType === "no_deadline");
  const tight = sla.global.find((p: any) => p.signalType === "tight_deadline");
  check("4.1 sinal com prazo no fio > sinal idêntico sem prazo", tight.score > noDl.score && tight.rank < noDl.rank);
  check("4.2 slaPressure do sinal urgente > 0; do outro = 0", tight.components.slaPressure > 0 && noDl.components.slaPressure === 0);
  check("4.3 boost é multiplicativo (~ base * (1 + 0.4*sla))", near(tight.score, Math.round(noDl.score * (1 + 0.4 * tight.components.slaPressure) * 10000) / 10000));

  // ===== 5. Irreversibilidade sobe a prioridade =====
  const orgIrr = mkOrg();
  BS.publish(orgIrr, { domain: "sales", signalType: "reversible_case", severity: "risk", basis: "fact", confidence: 0.9, sourceService: "test", impactAmount: 1000, impactUnit: "BRL", evidence: { reversibility: "high" }, dedupeKey: "r1" });
  BS.publish(orgIrr, { domain: "sales", signalType: "irreversible_case", severity: "risk", basis: "fact", confidence: 0.9, sourceService: "test", impactAmount: 1000, impactUnit: "BRL", evidence: { reversibility: "low" }, dedupeKey: "r2" });
  const irr = P.prioritize(orgIrr);
  const rev = irr.global.find((p: any) => p.signalType === "reversible_case");
  const noRev = irr.global.find((p: any) => p.signalType === "irreversible_case");
  check("5.1 sinal irreversível > sinal idêntico reversível", noRev.score > rev.score && noRev.rank < rev.rank);
  check("5.2 irreversibility exposto (1 vs 0)", noRev.components.irreversibility === 1 && rev.components.irreversibility === 0);
  check("5.3 boost multiplicativo (~ base * (1 + 0.3*1))", near(noRev.score, Math.round(rev.score * (1 + 0.3) * 10000) / 10000));

  // ===== 6. Isolamento =====
  const orgB = mkOrg();
  check("6.1 org sem sinais → sem prioridades", P.prioritize(orgB).global.length === 0);

  console.log("\n=== TEST: Impact SLA + Reversibility F7 (PRD 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Impact SLA + Reversibility F7 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
