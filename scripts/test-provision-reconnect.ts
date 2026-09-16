/**
 * TESTE — Correção do "QR não sai" (relato do dono, 16/09/2026).
 * ------------------------------------------------------------------------------
 * Causa: o botão "Conectar WhatsApp" (mode 'new') cunhava SEMPRE uma instância
 * nova `zapflow_<orgId>` — mesmo quando a org já tinha a dela (ex.: ExaForge
 * desconectada após o Desconectar) — e orgId real é UUID com HÍFENS, que forks
 * do Evolution rejeitam no nome. Resultado: create falhava/QR não vinha e a
 * instância REAL da empresa nunca era reconectada.
 * Prova, offline (fetch stubado, tmp db):
 *   - org COM instância própria → 'new' RECONECTA ela (QR da existente, sem
 *     cunhar zapflow_*);
 *   - preferência: disconnected (já pareou) vence zumbi 'provisioning';
 *   - 'disabled' (pausa administrativa) nunca é reusada;
 *   - org SEM instância → nome novo SANITIZADO (UUID com hífens não vaza pro
 *     provedor);
 *   - isolamento: instância de outra org nunca é reusada;
 *   - idempotência do fluxo novo preservada.
 *
 * Uso:  npm run test:provision-reconnect
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-prov-rec-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-prov-rec-1";
process.env.EVOLUTION_BASE_URL = "https://ev.test"; process.env.EVOLUTION_API_KEY = "admin-key"; process.env.APP_URL = "https://app.test";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

// Provedor stubado: registra os nomes de instância que chegam no create.
const createdNames: string[] = [];
function jsonResp(body: any) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => "application/json" } };
}
function installFetch() {
  const orig = (globalThis as any).fetch;
  (globalThis as any).fetch = async (url: string, _opts?: any) => {
    const u = String(url);
    if (u.includes("/instance/all")) return jsonResp({ data: [] });
    if (u.includes("/instance/create")) {
      createdNames.push(decodeURIComponent(u.split("/instance/create").pop() || "") || "(body)");
      return jsonResp({ data: { token: "tok", id: "iid" } });
    }
    if (u.includes("/instance/qr")) return jsonResp({ data: { qrcode: "data:image/png;base64,QR" } });
    return jsonResp({});
  };
  return () => { (globalThis as any).fetch = orig; };
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ChannelProvisioningService: Svc } = await import("../src/server/ChannelProvisioningService.js");
  const restore = installFetch();

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const mkCh = (org: string, idf: string, status: string, updatedAt = "2026-01-01 10:00:00") => {
    const id = randomUUID();
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, updated_at) VALUES (?, ?, 'evolution', ?, ?, ?, ?)`)
      .run(id, org, idf, idf, status, updatedAt);
    return id;
  };
  const chCount = (org: string) => Number((db.prepare(`SELECT COUNT(*) n FROM channels WHERE organization_id = ?`).get(org) as any).n);

  // ── 1) O cenário EXATO do relato: ExaForge desconectada + Conectar ('new'). ──
  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);
  mkCh(A, "ExaForge", "disconnected");
  const r1 = await Svc.provision(A, "u1", { mode: "new" });
  check("1.1 'new' RECONECTA a instância existente (ExaForge)", r1.ok === true && r1.instanceName === "ExaForge", r1.instanceName);
  check("1.2 QR devolvido", !!r1.qrBase64);
  check("1.3 NÃO cunhou canal zapflow_* (sem instância paralela)", chCount(A) === 1);

  // ── 2) Preferência: disconnected (já pareou) vence zumbi 'provisioning'. ──
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B);
  mkCh(B, "MinhaInstancia", "disconnected", "2026-01-01 10:00:00");
  mkCh(B, "zapflow_zumbi", "provisioning", "2026-02-01 10:00:00"); // mais recente, mas zumbi
  const r2 = await Svc.provision(B, "u1", { mode: "new" });
  check("2.1 prefere a que já pareou (disconnected) ao zumbi provisioning", r2.instanceName === "MinhaInstancia", r2.instanceName);

  // ── 3) 'disabled' (pausa administrativa) nunca é reusada. ──
  const C = `org-C-${randomUUID().slice(0, 6)}`; mkOrg(C); // com HÍFENS de propósito
  mkCh(C, "Pausada", "disabled");
  const r3 = await Svc.provision(C, "u1", { mode: "new" });
  check("3.1 org só com canal disabled → cria instância nova (não reusa pausada)", r3.instanceName !== "Pausada" && (r3.instanceName || "").startsWith("zapflow_"));
  check("3.2 nome novo SANITIZADO — sem hífens do orgId", !/[^a-zA-Z0-9_]/.test(r3.instanceName || ""), r3.instanceName);

  // ── 4) Nome sanitizado nunca chega ao provedor com caractere inválido. ──
  check("4.1 nenhum create no provedor levou hífen/char inválido", createdNames.every(n => !/-/.test(n)), createdNames.join(","));

  // ── 5) Isolamento: a instância de A nunca é reusada por outra org. ──
  const D = `org_D_${randomUUID().slice(0, 6)}`; mkOrg(D);
  const r5 = await Svc.provision(D, "u1", { mode: "new" });
  check("5.1 org sem canal não herda instância alheia", r5.instanceName === `zapflow_${D}`, r5.instanceName);

  // ── 6) Idempotência do fluxo preservada: repetir 'new' reusa o MESMO canal. ──
  const r6 = await Svc.provision(A, "u1", { mode: "new" });
  check("6.1 repetir 'new' segue na MESMA instância (ExaForge), sem duplicar", r6.instanceName === "ExaForge" && chCount(A) === 1);

  restore();
  console.log("\n=== TEST: Reconexão no 'Conectar WhatsApp' (correção do QR) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
