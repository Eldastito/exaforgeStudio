/**
 * TESTE — Conexão fiscal de entrada + credenciais cifradas (ADR-200, Fase 3).
 * Uso: npm run test:fiscal-connection
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fiscal-conn-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-fiscal-conn-1234567890";
process.env.ENCRYPTION_KEY = "test-encryption-key-dedicada-1234567890"; // ADR-200: fiscal exige chave dedicada

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { FiscalInboundConnectionService } = await import("../src/server/FiscalInboundConnectionService.js");
  const { default: db } = await import("../src/server/db.js");
  const ORG = "org-conn";

  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active) VALUES ('loja-a', ?, 'Loja A', 1)`).run(ORG);

  // Criação
  const c = FiscalInboundConnectionService.create(ORG, {
    environment: "homologation", cnpj: "12.345.678/0001-99", storeId: "loja-a",
    clientId: "cid-123", clientSecret: "secret-xyz", manifestationPolicy: "auto_awareness",
  }, "user-1");
  check("create → ok", c.ok === true, (c as any).reason);
  const conn = (c as any).connection;
  check("cnpj normalizado (14 díg.)", conn.cnpj === "12345678000199");
  check("nasce validating + DESLIGADA", conn.state === "validating" && conn.enabled === false);
  check("política registrada", conn.manifestationPolicy === "auto_awareness");

  // Segredo nunca exposto na visão pública
  const asJson = JSON.stringify(conn);
  check("visão pública sem clientSecret", !asJson.includes("secret-xyz"));
  check("visão pública sem config_enc", !("config_enc" in conn) && !asJson.includes("config_enc"));
  const listed = JSON.stringify(FiscalInboundConnectionService.list(ORG));
  check("list() não vaza segredo", !listed.includes("secret-xyz"));

  // Credenciais só pela leitura interna
  const creds = FiscalInboundConnectionService.getCredentials(ORG, conn.id);
  check("getCredentials decifra internamente", creds?.clientId === "cid-123" && creds?.clientSecret === "secret-xyz" && creds?.scope === "distribuicao-nfe");
  // E no banco está cifrado, não em texto puro
  const rawRow = db.prepare(`SELECT config_enc FROM fiscal_inbound_connections WHERE id = ?`).get(conn.id) as any;
  check("config_enc cifrado no banco (sem texto puro)", !String(rawRow.config_enc).includes("secret-xyz"));

  // Duplicata e validações
  check("duplicata (mesmo cnpj/ambiente) → recusada", FiscalInboundConnectionService.create(ORG, { environment: "homologation", cnpj: "12345678000199", clientId: "x", clientSecret: "y" }).ok === false);
  check("cnpj inválido → recusado", FiscalInboundConnectionService.create(ORG, { environment: "homologation", cnpj: "123", clientId: "x", clientSecret: "y" }).ok === false);
  check("sem credenciais → recusado", FiscalInboundConnectionService.create(ORG, { environment: "production", cnpj: "98765432000155", clientId: "", clientSecret: "" } as any).ok === false);

  // Fail-closed: produção sem ENCRYPTION_KEY dedicada recusa (ADR-200 §17.1)
  const savedKey = process.env.ENCRYPTION_KEY; delete process.env.ENCRYPTION_KEY;
  const noKey = FiscalInboundConnectionService.create(ORG, { environment: "production", cnpj: "98765432000155", clientId: "x", clientSecret: "y" });
  check("prod sem ENCRYPTION_KEY → recusado (fail-closed)", noKey.ok === false && (noKey as any).reason === "encryption_key_required");
  process.env.ENCRYPTION_KEY = savedKey;

  // Probe: só um probe real ativa
  FiscalInboundConnectionService.markProbe(ORG, conn.id, { connected: true, capabilities: { distribuicao: true } });
  const afterProbe = FiscalInboundConnectionService.get(ORG, conn.id);
  check("markProbe(connected) → connected + enabled", afterProbe.state === "connected" && afterProbe.enabled === true);
  FiscalInboundConnectionService.markProbe(ORG, conn.id, { connected: false, errorCode: "invalid_client" });
  check("markProbe(falha) → error + código sanitizado", FiscalInboundConnectionService.get(ORG, conn.id).state === "error");

  // Cursor com compare-and-set
  const cur0 = FiscalInboundConnectionService.getCursor(ORG, conn.id)!;
  check("cursor inicial ult_nsu=0 version=0", cur0.ultNsu === "0" && cur0.version === 0);
  check("advanceCursor versão certa → ok", FiscalInboundConnectionService.advanceCursor(ORG, conn.id, 0, { ultNsu: "150", maxNsu: "200" }) === true);
  check("advanceCursor versão velha → falha (corrida)", FiscalInboundConnectionService.advanceCursor(ORG, conn.id, 0, { ultNsu: "999" }) === false);
  const cur1 = FiscalInboundConnectionService.getCursor(ORG, conn.id)!;
  check("cursor avançou p/ 150, version=1", cur1.ultNsu === "150" && cur1.version === 1);

  // Disconnect preserva cursor
  check("disconnect → ok", FiscalInboundConnectionService.disconnect(ORG, conn.id).ok === true);
  const afterDisc = FiscalInboundConnectionService.get(ORG, conn.id);
  check("disconnect → disconnected + desligada", afterDisc.state === "disconnected" && afterDisc.enabled === false);
  check("disconnect PRESERVA cursor (150)", FiscalInboundConnectionService.getCursor(ORG, conn.id)!.ultNsu === "150");

  // Isolamento
  check("outra org não vê a conexão", FiscalInboundConnectionService.get("org-x", conn.id) === null);
  check("outra org não lê credenciais", FiscalInboundConnectionService.getCredentials("org-x", conn.id) === null);

  console.log("\n=== Conexão fiscal de entrada — Fase 3 PR 1 (ADR-200) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error("Erro fatal no teste:", e); fs.rmSync(tmpDir, { recursive: true, force: true }); process.exit(1); });
