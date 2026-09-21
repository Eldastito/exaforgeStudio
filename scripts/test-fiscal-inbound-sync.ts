/**
 * TESTE — FiscalInboundSyncService (ADR-200, Fase 3 PR 3). Provider FAKE
 * (sem rede); storage real em tmp DATA_DIR. Cobre: roteamento por schema,
 * persistência + XML cifrado, CAS do cursor, Ciência da Operação (pendência),
 * ingestão de cancelamento, backoff e dedupe.
 * Uso: npm run test:fiscal-inbound-sync
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fiscal-sync-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-fiscal-sync-1234567890";
process.env.ENCRYPTION_KEY = "test-encryption-key-fiscal-sync-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

const KEY = "35240612345678000199550010000001231000000122";

const PROC_XML = `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe><infNFe Id="NFe${KEY}">
    <ide><mod>55</mod><nNF>123</nNF><serie>1</serie><dhEmi>2024-06-01T10:00:00-03:00</dhEmi></ide>
    <emit><CNPJ>12345678000199</CNPJ><xNome>Fornecedor X</xNome></emit>
    <dest><CNPJ>98765432000155</CNPJ><xNome>Loja A</xNome></dest>
    <det nItem="1"><prod><cProd>FORN-001</cProd><xProd>Produto Teste</xProd><cEAN>7891234567895</cEAN><NCM>12345678</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>10</qCom><vUnCom>5.00</vUnCom><vProd>50.00</vProd></prod></det>
    <total><ICMSTot><vProd>50.00</vProd><vNF>50.00</vNF></ICMSTot></total>
  </infNFe></NFe>
  <protNFe><infProt><chNFe>${KEY}</chNFe><cStat>100</cStat><nProt>135240000000001</nProt><dhRecbto>2024-06-01T10:05:00-03:00</dhRecbto></infProt></protNFe>
</nfeProc>`;

const RES_XML = `<resNFe><chNFe>${KEY}</chNFe><CNPJ>12345678000199</CNPJ><xNome>Fornecedor X</xNome><dhEmi>2024-06-01T10:00:00-03:00</dhEmi><vNF>50.00</vNF><cSitNFe>1</cSitNFe></resNFe>`;

const EVENTO_CANCEL_XML = `<procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <evento><infEvento><chNFe>${KEY}</chNFe><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><dhEvento>2024-06-02T09:00:00-03:00</dhEvento></infEvento></evento>
  <retEvento><infEvento><chNFe>${KEY}</chNFe><cStat>135</cStat><nProt>135240000000009</nProt><dhRegEvento>2024-06-02T09:01:00-03:00</dhRegEvento></infEvento></retEvento>
</procEventoNFe>`;

// Provider fake: fila de lotes; quando acaba, devolve lote terminal (cursor
// parado) pra encerrar o loop. Registra as manifestações enviadas.
class FakeProvider {
  private queue: any[] = [];
  public manifestCalls: any[] = [];
  push(batch: any) { this.queue.push(batch); }
  async probe() { return { connected: true }; }
  async listSinceNsu(input: { cnpj: string; ultNsu: string }) {
    if (this.queue.length) return this.queue.shift();
    return { ultNsu: input.ultNsu, maxNsu: input.ultNsu, documents: [] }; // caught up
  }
  async getByAccessKey() { return { ultNsu: "0", maxNsu: null, documents: [] }; }
  async manifest(input: any) { this.manifestCalls.push(input); return { ok: true, protocol: "135240000012345" }; }
}

async function main() {
  const { FiscalInboundConnectionService } = await import("../src/server/FiscalInboundConnectionService.js");
  const { FiscalInboundSyncService } = await import("../src/server/FiscalInboundSyncService.js");
  const { FiscalXmlStorage } = await import("../src/server/FiscalXmlStorage.js");
  const { default: db } = await import("../src/server/db.js");
  const ORG = "org-sync";

  const c = FiscalInboundConnectionService.create(ORG, {
    environment: "homologation", cnpj: "98.765.432/0001-55",
    clientId: "cid", clientSecret: "sec", manifestationPolicy: "auto_awareness",
  }, "user-1");
  check("conexão criada", c.ok === true, (c as any).reason);
  const conn = (c as any).connection;

  // ---- Passe 1: resumo (resNFe) → persiste + dispara Ciência da Operação -----
  const p1 = new FakeProvider();
  p1.push({ ultNsu: "151", maxNsu: "151", documents: [{ nsu: "151", schema: "resNFe", accessKey: KEY, xml: RES_XML }] });
  const s1 = await FiscalInboundSyncService.syncConnection(ORG, conn.id, { manual: true, provider: p1 as any });
  check("passe 1: 1 documento persistido", s1.persisted === 1, `persisted=${s1.persisted}`);
  check("passe 1: Ciência enviada (manifested)", s1.manifested === 1 && p1.manifestCalls.length === 1);
  check("passe 1: Ciência é tpEvento ciencia_operacao", p1.manifestCalls[0]?.event === "ciencia_operacao");
  const docAfter1 = db.prepare(`SELECT manifestation_state, manifestation_event, content_level FROM fiscal_documents WHERE organization_id = ? AND access_key = ?`).get(ORG, KEY) as any;
  check("passe 1: pendência de manifestação registrada", docAfter1?.manifestation_state === "awareness_requested" && docAfter1?.manifestation_event === "210210");
  check("passe 1: documento é resumo (summary_only)", docAfter1?.content_level === "summary_only");
  const cur1 = FiscalInboundConnectionService.getCursor(ORG, conn.id)!;
  check("passe 1: cursor avançou p/ 151 (CAS, version 1)", cur1.ultNsu === "151" && cur1.version === 1, `ult=${cur1.ultNsu} v=${cur1.version}`);

  // ---- Passe 2: XML completo (procNFe autorizado) → enriquece + guarda XML ----
  const p2 = new FakeProvider();
  p2.push({ ultNsu: "152", maxNsu: "152", documents: [{ nsu: "152", schema: "procNFe", accessKey: KEY, xml: PROC_XML }] });
  const s2 = await FiscalInboundSyncService.syncConnection(ORG, conn.id, { manual: true, provider: p2 as any });
  check("passe 2: documento enriquecido", s2.persisted === 1);
  const docAfter2 = db.prepare(`SELECT content_level, xml_sha256, xml_ref, source_nsu FROM fiscal_documents WHERE organization_id = ? AND access_key = ?`).get(ORG, KEY) as any;
  check("passe 2: subiu p/ authorized_process", docAfter2?.content_level === "authorized_process");
  check("passe 2: XML referenciado + sha", !!docAfter2?.xml_ref && docAfter2?.xml_sha256 === FiscalXmlStorage.sha256(PROC_XML));
  check("passe 2: XML NÃO está no banco (só ref)", !JSON.stringify(docAfter2).includes("<nfeProc"));
  const roundtrip = FiscalXmlStorage.getPrivate(docAfter2.xml_ref);
  check("passe 2: XML cifrado decifra idêntico (round-trip)", roundtrip === PROC_XML);
  // Confirma que em DISCO está cifrado (não texto puro)
  const files = fs.readdirSync(path.join(tmpDir, "fiscal-xml", ORG));
  const rawOnDisk = fs.readFileSync(path.join(tmpDir, "fiscal-xml", ORG, files[0]), "utf8");
  check("passe 2: arquivo em disco cifrado (sem XML puro)", rawOnDisk.startsWith("enc:") && !rawOnDisk.includes("<nfeProc"));

  // ---- Passe 3: cancelamento (procEventoNFe) → situação fiscal cancelled ------
  const p3 = new FakeProvider();
  p3.push({ ultNsu: "153", maxNsu: "153", documents: [{ nsu: "153", schema: "procEventoNFe", accessKey: KEY, xml: EVENTO_CANCEL_XML }] });
  const s3 = await FiscalInboundSyncService.syncConnection(ORG, conn.id, { manual: true, provider: p3 as any });
  check("passe 3: 1 evento + 1 cancelamento", s3.events === 1 && s3.cancellations === 1);
  const docAfter3 = db.prepare(`SELECT fiscal_status, processing_state, cancelled_at FROM fiscal_documents WHERE organization_id = ? AND access_key = ?`).get(ORG, KEY) as any;
  check("passe 3: documento cancelado", docAfter3?.fiscal_status === "cancelled" && docAfter3?.processing_state === "cancelled" && !!docAfter3?.cancelled_at);
  const ev = db.prepare(`SELECT COUNT(*) c FROM fiscal_document_events WHERE organization_id = ? AND access_key = ?`).get(ORG, KEY) as any;
  check("passe 3: evento gravado (idempotente)", ev.c === 1);

  // ---- Backoff: provedor sinaliza 429 → bloqueia, PRESERVA cursor ------------
  const pBlock = new FakeProvider();
  pBlock.push({ ultNsu: "153", maxNsu: "999", documents: [], blocked: { until: new Date(Date.now() + 3600_000).toISOString(), reason: "rate_limited" } });
  const sB = await FiscalInboundSyncService.syncConnection(ORG, conn.id, { manual: true, provider: pBlock as any });
  check("backoff: passe sinaliza blocked", sB.blocked === true && sB.blockedReason === "rate_limited");
  const connBlocked = FiscalInboundConnectionService.get(ORG, conn.id);
  check("backoff: blocked_until gravado", !!connBlocked.blockedUntil);
  check("backoff: cursor preservado em 153", FiscalInboundConnectionService.getCursor(ORG, conn.id)!.ultNsu === "153");

  // ---- Dedupe: reprocessar o mesmo procNFe (NSU novo) NÃO duplica ------------
  const p4 = new FakeProvider();
  p4.push({ ultNsu: "200", maxNsu: "200", documents: [{ nsu: "200", schema: "procNFe", accessKey: KEY, xml: PROC_XML }] });
  const s4 = await FiscalInboundSyncService.syncConnection(ORG, conn.id, { manual: true, provider: p4 as any });
  check("dedupe: reprocesso não conta como persistido novo", s4.persisted === 0, `persisted=${s4.persisted}`);
  const rowCount = db.prepare(`SELECT COUNT(*) c FROM fiscal_documents WHERE organization_id = ? AND access_key = ?`).get(ORG, KEY) as any;
  check("dedupe: 1 único registro por chave", rowCount.c === 1);

  // ---- Isolamento: conexão inexistente lança -------------------------------
  let threw = false;
  try { await FiscalInboundSyncService.syncConnection(ORG, "nao-existe", { manual: true, provider: new FakeProvider() as any }); } catch { threw = true; }
  check("conexão inexistente → lança", threw);

  console.log("\n=== FiscalInboundSyncService — Fase 3 PR 3 (ADR-200) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error("Erro fatal no teste:", e); fs.rmSync(tmpDir, { recursive: true, force: true }); process.exit(1); });
