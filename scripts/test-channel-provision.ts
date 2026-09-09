/**
 * TEST — F2.1a: conexão autenticada e org-scoped de WhatsApp
 * (PRD WhatsApp Unificado — RF-01 / CA-01, modos 'new' e 'existing'/import §8).
 *
 * Prova, offline (fetch stubado, tmp db):
 *  - new: cria canal na org da sessão, provisiona, devolve QR; idempotente.
 *  - existing atribuída a OUTRA org → NEGA (attributed_to_other_org), sem criar canal.
 *  - existing que EXISTE no provedor e está livre → IMPORTA (claim + canal + imported).
 *  - existing que NÃO existe no provedor e sem canal → instance_not_found, sem inventar.
 *  - existing já desta org → reusa.
 *  - isolamento entre orgs; status() lista sem segredos.
 *
 * Uso: npm run test:channel-provision
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-chprov-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-chprov-1";
process.env.EVOLUTION_BASE_URL = "https://ev.test"; process.env.EVOLUTION_API_KEY = "admin-key"; process.env.APP_URL = "https://app.test";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// Instâncias que "existem" no provedor (controlável por teste).
let providerInstances: Array<{ name: string; token?: string; id?: string }> = [];
function jsonResp(body: any) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => "application/json" } };
}
function installFetch() {
  const orig = (globalThis as any).fetch;
  (globalThis as any).fetch = async (url: string, _opts?: any) => {
    const u = String(url);
    if (u.includes("/instance/all")) return jsonResp({ data: providerInstances });
    if (u.includes("/instance/create")) return jsonResp({ data: { token: "newtok", id: "newid" } });
    if (u.includes("/instance/qr")) return jsonResp({ data: { qrcode: "data:image/png;base64,QR" } });
    return jsonResp({}); // connect, webhook/set, legacy
  };
  return () => { (globalThis as any).fetch = orig; };
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ChannelProvisioningService } = await import("../src/server/ChannelProvisioningService.js");

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const chOf = (org: string, idf: string) => db.prepare(`SELECT id, status FROM channels WHERE organization_id = ? AND identifier = ?`).get(org, idf) as any;
  const chCount = (org: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM channels WHERE organization_id = ?`).get(org) as any).n);

  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B);
  const restore = installFetch();

  // ── 1. new: cria canal, provisiona, QR ──
  const r1 = await ChannelProvisioningService.provision(A, "u1", { mode: "new" });
  check("1.1 new ok + QR", r1.ok === true && !!r1.qrBase64 && r1.qrBase64.includes("QR"));
  check("1.2 nome de sistema zapflow_<org>", r1.instanceName === `zapflow_${A}`);
  check("1.3 canal criado na org A (awaiting_qr)", !!chOf(A, `zapflow_${A}`));
  const firstChannelId = r1.channelId;

  // ── 2. new idempotente: reusa o mesmo canal ──
  const r2 = await ChannelProvisioningService.provision(A, "u1", { mode: "new" });
  check("2.1 idempotente: mesmo channelId", r2.ok === true && r2.channelId === firstChannelId);
  check("2.2 não duplicou canal (segue 1)", chCount(A) === 1);

  // ── 3. import de instância atribuída a OUTRA org → NEGA (§8) ──
  // B já tem a "ExaForge" cadastrada; A tenta importar.
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'evolution', 'Ev', 'ExaForge', 'connected')`).run(randomUUID(), B);
  const r3 = await ChannelProvisioningService.provision(A, "u1", { mode: "existing", instanceName: "ExaForge" });
  check("3.1 negada com code attributed_to_other_org", r3.ok === false && r3.code === "attributed_to_other_org");
  check("3.2 NÃO criou canal ExaForge em A", !chOf(A, "ExaForge"));

  // ── 4. import de instância que EXISTE no provedor e está livre → importa ──
  providerInstances = [{ name: "MinhaLoja", token: "tok-ml", id: "id-ml" }];
  const r4 = await ChannelProvisioningService.provision(A, "u1", { mode: "existing", instanceName: "MinhaLoja" });
  check("4.1 import ok + imported=true", r4.ok === true && r4.imported === true);
  check("4.2 canal MinhaLoja criado em A", !!chOf(A, "MinhaLoja"));

  // ── 5. import de instância inexistente no provedor e sem canal → not_found ──
  providerInstances = [];
  const r5 = await ChannelProvisioningService.provision(A, "u1", { mode: "existing", instanceName: "NaoExiste" });
  check("5.1 code instance_not_found", r5.ok === false && r5.code === "instance_not_found");
  check("5.2 NÃO inventou canal", !chOf(A, "NaoExiste"));

  // ── 6. existing já desta org → reusa (sem import) ──
  const r6 = await ChannelProvisioningService.provision(A, "u1", { mode: "existing", instanceName: "MinhaLoja" });
  check("6.1 reusa canal existente da org (imported=false)", r6.ok === true && r6.imported === false && !!r6.channelId);

  // ── 7. isolamento + status sem segredos ──
  const st = ChannelProvisioningService.status(A);
  check("7.1 status lista os canais de A (zapflow + MinhaLoja)", st.channels.length === 2 && st.channels.every((c) => typeof c.instanceName === "string"));
  check("7.2 status não expõe token/segredo", JSON.stringify(st).toLowerCase().indexOf("token") === -1 && JSON.stringify(st).indexOf("newtok") === -1);
  check("7.3 org B intacta (só a ExaForge que ela tinha)", chCount(B) === 1);

  restore();
  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} channel-provision: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
