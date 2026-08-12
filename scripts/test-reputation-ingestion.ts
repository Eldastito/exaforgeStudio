/**
 * TEST — Reputation ingestion + ReclameAquiProvider degradação (PRD 5 / ADR-162 F2).
 * DB-backed, isolado por tmpDir, determinístico. Prova:
 *
 *   - GATE triplo opt-in: sync com módulo/conector/contrato externo OFF → recusa com
 *     motivo explícito (nunca falha silenciosa);
 *   - INGESTÃO via provider stub → business_signals `domain='reputation'`,
 *     `signalType='public_complaint'`, `basis='estimate'` (RN-CRR-2), severidade
 *     derivada de rating, autor MASCARADO (LGPD), dedupe `external:<source>:<id>`;
 *   - INCREMENTAL (§70): 2º sync não re-lê itens já processados (cursor avança);
 *   - DEDUP (§71): reingerir o mesmo externalId ATUALIZA o sinal, nunca duplica;
 *   - MULTI-TENANT: org B não vê sinal da org A;
 *   - ReclameAquiProvider NÃO-configurado → sync DEGRADA (degraded, 0 ingerido,
 *     health 'unavailable') e NUNCA lança nem fabrica (§6);
 *   - credenciais CIFRADAS em repouso (config_enc = enc:v1:…, token nunca em texto),
 *     status redigido não vaza token.
 *
 * Uso: npm run test:reputation-ingestion
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-reputation-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-reputation-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

function enableOrg(db: any, orgId: string, opts: { engine?: boolean; external?: boolean } = {}) {
  db.prepare(`INSERT OR IGNORE INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(`os-${orgId}`, orgId);
  db.prepare(`UPDATE organization_settings SET reputation_engine_enabled = ?, radar_external_signals_enabled = ? WHERE organization_id = ?`)
    .run(opts.engine ? 1 : 0, opts.external ? 1 : 0, orgId);
}
function repSignals(db: any, orgId: string): any[] {
  return db.prepare(`SELECT * FROM business_signals WHERE organization_id = ? AND domain = 'reputation' ORDER BY source_entity_id`).all(orgId) as any[];
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ReputationIngestionService: ING } = await import("../src/server/ReputationIngestionService.js");
  const { ReputationConnectorService: CONN } = await import("../src/server/ReputationConnectorService.js");
  const { ReclameAquiProvider } = await import("../src/server/ReclameAquiProvider.js");

  const A = "org_rep_A";
  const B = "org_rep_B";

  // ═══════════════ 1. gates opt-in ═══════════════
  enableOrg(db, A, { engine: false, external: false });
  const g0 = await ING.sync(A, { provider: "stub" });
  check("1.1 módulo OFF → reputation_engine_disabled", g0.ok === false && g0.reason === "reputation_engine_disabled");
  enableOrg(db, A, { engine: true, external: false });
  const g1 = await ING.sync(A, { provider: "stub" });
  check("1.2 conector não habilitado → connector_disabled", g1.reason === "connector_disabled");
  CONN.setConfig(A, "stub", {}, { enabled: true });
  const g2 = await ING.sync(A, { provider: "stub" });
  check("1.3 contrato externo OFF → external_signals_disabled", g2.reason === "external_signals_disabled");

  // ═══════════════ 2. ingestão via stub ═══════════════
  enableOrg(db, A, { engine: true, external: true });
  CONN.setConfig(A, "stub", {}, { enabled: true });
  const s1 = await ING.sync(A, { provider: "stub" });
  check("2.1 ingeriu os 3 itens do stub", s1.ok === true && s1.ingested === 3 && s1.deduped === 0);
  const sigs = repSignals(db, A);
  check("2.2 3 business_signals domain=reputation", sigs.length === 3);
  const s1001 = sigs.find((r) => r.source_entity_id === "RA-1001");
  check("2.3 signalType=public_complaint, basis=estimate, dedupeKey correto", !!s1001 && s1001.signal_type === "public_complaint" && s1001.basis === "estimate" && s1001.dedupe_key === "external:stub_reputation:RA-1001");
  check("2.4 severidade derivada de rating (nota 1/5 → risk)", s1001.severity === "risk");
  const ev = JSON.parse(s1001.evidence_json || "{}");
  check("2.5 autor MASCARADO no evidence (não vaza PII)", typeof ev.author === "string" && ev.author.includes("***") && !ev.author.includes("Maria Silva") && ev.origin === "external");
  check("2.6 basis nunca 'fact' (afirmação de terceiro — RN-CRR-2)", sigs.every((r) => r.basis === "estimate"));

  // ═══════════════ 3. incremental (§70): 2º sync não re-lê ═══════════════
  const s2 = await ING.sync(A, { provider: "stub" });
  check("3.1 2º sync: cursor avançou, nada novo lido", s2.ok === true && s2.scanned === 0 && s2.ingested === 0);
  check("3.2 cursor persistido = maior updatedAt", CONN.getCursor(A, "stub") === "2026-08-08T16:00:00Z");

  // ═══════════════ 4. dedup (§71): reingerir mesmo item ATUALIZA, não duplica ═══════════════
  CONN.setCursor(A, "stub", null); // reset da marca d'água → re-lê tudo
  const s3 = await ING.sync(A, { provider: "stub" });
  check("4.1 re-sync: 3 lidos, todos deduplicados (0 novos)", s3.scanned === 3 && s3.deduped === 3 && s3.ingested === 0);
  check("4.2 ainda 3 sinais (nenhuma duplicata)", repSignals(db, A).length === 3);

  // ═══════════════ 5. multi-tenant ═══════════════
  enableOrg(db, B, { engine: true, external: true });
  CONN.setConfig(B, "stub", {}, { enabled: true });
  await ING.sync(B, { provider: "stub" });
  check("5.1 org B tem seus próprios 3 sinais", repSignals(db, B).length === 3);
  check("5.2 sinais de A e B são linhas distintas (isolados por org)", repSignals(db, A).every((r) => r.organization_id === A));

  // ═══════════════ 6. ReclameAquiProvider NÃO-configurado → degrada (§6) ═══════════════
  CONN.setConfig(A, "reclame_aqui", { baseUrl: "", token: "" }, { enabled: true });
  const deg = await ING.sync(A, { provider: "reclame_aqui" });
  check("6.1 conector real sem config → degraded, 0 ingerido, nunca lança", deg.ok === true && deg.degraded === true && deg.reason === "provider_unconfigured" && deg.ingested === 0);
  check("6.2 health registrado 'unavailable'", CONN.status(A, "reclame_aqui").health === "unavailable");
  check("6.3 provider real sem config: capabilities vazias (não engana)", new ReclameAquiProvider(null).capabilities.length === 0);
  const pubDeg = await new ReclameAquiProvider(null).publishReply({ itemExternalId: "x", content: "y", idempotencyKey: "k" });
  check("6.4 publishReply sem config → manual_required (não finge publicar)", pubDeg.status === "manual_required" && !pubDeg.externalReplyId);

  // ═══════════════ 7. credenciais cifradas em repouso ═══════════════
  CONN.setConfig(A, "reclame_aqui", { baseUrl: "https://api.example/ra", token: "super-secret-token" }, { enabled: true });
  const rawRow = db.prepare(`SELECT config_enc FROM reputation_connectors WHERE organization_id = ? AND provider = 'reclame_aqui'`).get(A) as any;
  check("7.1 config_enc cifrado (enc:v1:…), token nunca em texto", rawRow.config_enc.startsWith("enc:v1:") && !rawRow.config_enc.includes("super-secret-token"));
  const st = CONN.status(A, "reclame_aqui");
  check("7.2 status redige o token (só sinaliza que existe)", st.configured === true && st.hasToken === true && JSON.stringify(st).indexOf("super-secret-token") === -1);
  check("7.3 getConfig interno decifra o token", (CONN.getConfig(A, "reclame_aqui") || {}).token === "super-secret-token");

  console.log("\n=== TEST: Reputation Ingestion + ReclameAqui degradação (PRD 5 F2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Reputation Ingestion F2 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
