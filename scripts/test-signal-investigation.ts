/**
 * TEST — PRD 2 F6.1 (§32-34, §13): pipeline de investigação determinístico.
 * Causas-candidatas com evidência a favor/contra + confiança, SEM IA. Nunca
 * promove hipótese a fato (basis hypothesis; manchete "provável").
 *
 * Cenário §33: conversão caiu; correlaciona com tempo de resposta alto → causa
 * provável "demora no follow-up"; tráfego caindo CONTRADIZ e baixa a confiança.
 *
 * Uso: npm run test:signal-investigation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-signal-invest-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-signal-invest-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");
  const { SignalInvestigationService: INV } = await import("../src/server/SignalInvestigationService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const org = mkOrg();
  const pub = (over: any) => BS.publish(org, { severity: "risk", basis: "fact", confidence: 0.9, sourceService: "test", evidence: {}, ...over });

  // sku-M: conversion_drop + response_delay (apoia "follow-up")
  const conv = pub({ domain: "sales", signalType: "conversion_drop", dedupeKey: "m-conv", subjectType: "product", subjectId: "sku-M", impactAmount: 13400, impactUnit: "BRL" });
  pub({ domain: "sales", signalType: "response_delay", dedupeKey: "m-resp", subjectType: "product", subjectId: "sku-M" });

  // ===== 1. Causa provável com evidência a favor =====
  const inv1 = INV.investigate(org, conv.id);
  const followUp = inv1.candidateCauses.find((c: any) => /follow-up/i.test(c.cause));
  check("1.1 sem IA (aiUsed false)", inv1.aiUsed === false);
  check("1.2 causa 'follow-up' com evidência a favor (response_delay)", !!followUp && followUp.supportingEvidence.some((e: any) => e.type === "response_delay"));
  check("1.3 confiança boostada pela evidência (0.5 base + 0.15 = 0.65)", near(followUp.confidence, 0.65));
  check("1.4 basis hypothesis em TODAS as candidatas (§13 nunca vira fato)", inv1.candidateCauses.every((c: any) => c.basis === "hypothesis"));
  check("1.5 manchete PROVÁVEL + correlação≠causalidade", /prov[aá]vel/i.test(inv1.headline) && /correla/i.test(inv1.headline));

  // ===== 2. Evidência CONTRA baixa a confiança =====
  pub({ domain: "sales", signalType: "traffic_drop", dedupeKey: "m-traffic", subjectType: "product", subjectId: "sku-M" });
  const inv2 = INV.investigate(org, conv.id);
  const fu2 = inv2.candidateCauses.find((c: any) => /follow-up/i.test(c.cause));
  check("2.1 traffic_drop entra como evidência CONTRA o follow-up", fu2.contradictingEvidence.some((e: any) => e.type === "traffic_drop"));
  check("2.2 confiança do follow-up cai (0.5 + 0.15 − 0.2 = 0.45)", near(fu2.confidence, 0.45));
  check("2.3 a causa 'tráfego' aparece com apoio", inv2.candidateCauses.some((c: any) => /tr[aá]fego/i.test(c.cause) && c.supportingEvidence.length > 0));

  // ===== 3. Sem correlação → manchete honesta (só candidatas) =====
  const lone = pub({ domain: "sales", signalType: "conversion_drop", dedupeKey: "n-conv", subjectType: "product", subjectId: "sku-N" });
  const inv3 = INV.investigate(org, lone.id);
  check("3.1 sem evidência → manchete admite insuficiência", /insuficient/i.test(inv3.headline) && inv3.candidateCauses.every((c: any) => c.supportingEvidence.length === 0));

  // ===== 4. Tipo sem hipótese → vazio + nota (F6.2) =====
  const other = pub({ domain: "tasks", signalType: "some_unknown_signal", dedupeKey: "x", subjectType: "task", subjectId: "t-1" });
  const inv4 = INV.investigate(org, other.id);
  check("4.1 sem template → candidatas vazias + nota apontando F6.2", inv4.candidateCauses.length === 0 && /F6\.2|IA/i.test(inv4.note || ""));

  // ===== 5. Isolamento + não encontrado =====
  const orgB = mkOrg();
  check("5.1 sinal de A não investiga sob B (not found)", INV.investigate(orgB, conv.id).found === false);

  console.log("\n=== TEST: Investigation pipeline F6.1 (PRD 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Investigation pipeline F6.1 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
