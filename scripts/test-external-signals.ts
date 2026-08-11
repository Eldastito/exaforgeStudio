/**
 * TEST — PRD 2 F10 (§48-51, §10C, CA2): External signal contract (molde). Um
 * conector externo entrega um sinal JÁ CAPTURADO e o Radar o normaliza no ledger
 * canônico, com PROVENIÊNCIA obrigatória e SEM promover a fato não verificado.
 *
 * Prova (determinístico, sem rede/IA):
 *   - opt-in: sem a flag, ingest() é no-op ('disabled');
 *   - proveniência dura: falta source|externalId|domain|content → recusa;
 *   - dedupe por (source, externalId): reingerir o MESMO item ATUALIZA (não duplica);
 *   - basis: estimate default; fact SÓ com verifiable (senão rebaixa §13); hypothesis ok;
 *   - severidade derivada de rating/sentiment quando não explícita; explícita vence;
 *   - proveniência gravada no evidence (source/externalId/url); autor MASCARADO (LGPD);
 *   - confiança externa < 1 (verificável 0.7, senão 0.5);
 *   - aparece no attention feed como sinal normalizado;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:external-signals
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-external-signals-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-external-signals-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");
  const { ExternalSignalService: ES } = await import("../src/server/ExternalSignalService.js");

  const mkOrg = (ext = 1) => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, radar_external_signals_enabled) VALUES (?, ?, 'X', 'active', ?)`).run(randomUUID(), id, ext);
    return id;
  };
  const sigOf = (id: string) => db.prepare(`SELECT * FROM business_signals WHERE id = ?`).get(id) as any;
  const evOf = (id: string) => { try { return JSON.parse(sigOf(id).evidence_json || "{}"); } catch { return {}; } };

  // ===== 1. Opt-in =====
  const orgOff = mkOrg(0);
  const off = ES.ingest(orgOff, { source: "reclame_aqui", externalId: "r1", domain: "reputation", content: "péssimo atendimento" });
  check("1.1 sem flag → disabled (no-op)", off.ok === false && off.reason === "disabled");
  check("1.2 sem flag não publica nada", BS.list(orgOff, {}).length === 0);

  const org = mkOrg(1);

  // ===== 2. Proveniência obrigatória (§49) =====
  check("2.1 falta source → recusa", ES.ingest(org, { source: "", externalId: "x", domain: "reputation", content: "c" }).reason === "missing_source");
  check("2.2 falta externalId → recusa", ES.ingest(org, { source: "s", externalId: "", domain: "reputation", content: "c" }).reason === "missing_external_id");
  check("2.3 falta domain → recusa", ES.ingest(org, { source: "s", externalId: "x", domain: "", content: "c" }).reason === "missing_domain");
  check("2.4 content vazio → recusa", ES.ingest(org, { source: "s", externalId: "x", domain: "reputation", content: "   " }).reason === "empty_content");

  // ===== 3. Ingestão + proveniência no evidence =====
  const i1 = ES.ingest(org, { source: "reclame_aqui", externalId: "RA-100", domain: "reputation", content: "Comprei e não entregaram. Péssimo.", url: "https://reclameaqui.com.br/x/RA-100", author: "cliente_muito_irritado_123", rating: 1 });
  check("3.1 ingere ok (deduped false)", i1.ok === true && i1.deduped === false);
  const s1 = sigOf(i1.signalId!);
  const e1 = evOf(i1.signalId!);
  check("3.2 origem=external + proveniência (source/externalId/url) no evidence", e1.origin === "external" && e1.source === "reclame_aqui" && e1.externalId === "RA-100" && e1.url.includes("RA-100"));
  check("3.3 source_entity_* = proveniência do provedor", s1.source_entity_type === "reclame_aqui" && s1.source_entity_id === "RA-100" && s1.source_service === "ExternalSignalService");
  check("3.4 autor MASCARADO (LGPD, não vaza PII)", typeof e1.author === "string" && e1.author.includes("***") && !e1.author.includes("irritado"));

  // ===== 4. Severidade derivada de rating (1/5 → risk) =====
  check("4.1 rating baixo → risk", s1.severity === "risk" && i1.severity === "risk");
  const pos = ES.ingest(org, { source: "google_reviews", externalId: "G-1", domain: "reputation", content: "Excelente!", rating: 5 });
  check("4.2 rating alto → info", sigOf(pos.signalId!).severity === "info");
  const neu = ES.ingest(org, { source: "google_reviews", externalId: "G-2", domain: "reputation", content: "ok", sentiment: "neutral" });
  check("4.3 sentiment neutro → attention", sigOf(neu.signalId!).severity === "attention");
  const explicit = ES.ingest(org, { source: "market_intel", externalId: "M-1", domain: "sales", content: "concorrente baixou preço", severity: "critical", rating: 5 });
  check("4.4 severidade explícita vence a derivada", sigOf(explicit.signalId!).severity === "critical");

  // ===== 5. basis: fact só com verifiable (§13) =====
  const factNoVer = ES.ingest(org, { source: "reclame_aqui", externalId: "RA-200", domain: "reputation", content: "reclamação", basis: "fact" });
  check("5.1 fact SEM verifiable → rebaixa pra estimate", factNoVer.basis === "estimate" && sigOf(factNoVer.signalId!).basis === "estimate");
  const factVer = ES.ingest(org, { source: "reclame_aqui", externalId: "RA-201", domain: "reputation", content: "review objetivo", basis: "fact", verifiable: true });
  check("5.2 fact COM verifiable → fato; confiança 0.7", factVer.basis === "fact" && sigOf(factVer.signalId!).confidence === 0.7);
  const hyp = ES.ingest(org, { source: "market_intel", externalId: "M-2", domain: "sales", content: "talvez percam share", basis: "hypothesis" });
  check("5.3 hypothesis persiste; confiança externa < 1 (0.5)", sigOf(hyp.signalId!).basis === "hypothesis" && sigOf(hyp.signalId!).confidence === 0.5);

  // ===== 6. Dedupe por (source, externalId) — idempotência de conector (§7.1) =====
  const reopen = ES.ingest(org, { source: "reclame_aqui", externalId: "RA-100", domain: "reputation", content: "Atualização: resolveram parcialmente.", rating: 3 });
  check("6.1 reingerir o MESMO item ATUALIZA (mesmo id, deduped)", reopen.deduped === true && reopen.signalId === i1.signalId);
  check("6.2 conteúdo/severidade atualizados (rating 3 → attention)", sigOf(i1.signalId!).severity === "attention" && evOf(i1.signalId!).content.includes("parcialmente"));
  check("6.3 sem duplicar linha (RA-100 continua 1 sinal)", (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id=? AND source_entity_id='RA-100'`).get(org) as any).n === 1);

  // ===== 7. Aparece no attention feed como sinal normalizado =====
  const att = BS.attention(org, {});
  check("7.1 sinais externos no feed transversal", att.items.some((it: any) => it.type === "external_signal" && it.domain === "reputation"));

  // ===== 8. Isolamento =====
  const orgB = mkOrg(1);
  check("8.1 org B não enxerga sinais externos da org A", BS.list(orgB, {}).length === 0);

  console.log("\n=== TEST: External Signals F10 (PRD 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ External Signals F10 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
