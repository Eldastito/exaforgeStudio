/**
 * TESTE — Desconectar o WhatsApp pelo ZapFlow (pedido do dono, 15/09/2026).
 * ------------------------------------------------------------------------------
 * O card mostrava "conectado" (status legado no banco) SEM ação de saída.
 * `ChannelProvisioningService.disconnect` prova, offline:
 *   - canais Evolution da org viram `disconnected` (UPDATE, nunca DELETE —
 *     histórico preservado, convenção nº 9);
 *   - `status()` passa a reportar connected:false → o card vira "Desconectado";
 *   - sem Evolution configurada → `providerLogout:false` HONESTO (não finge
 *     logout no celular), mas a desconexão local acontece;
 *   - canal `disabled` (pausa administrativa) não é tocado;
 *   - isolamento multi-tenant; idempotente; auditado.
 *
 * Uso:  npm run test:whatsapp-disconnect
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-wa-disc-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-wa-disconnect-1234567890";
delete process.env.EVOLUTION_BASE_URL;
delete process.env.EVOLUTION_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ChannelProvisioningService: Svc } = await import("../src/server/ChannelProvisioningService.js");
  const { EvolutionService } = await import("../src/server/EvolutionService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  const mkCh = (org: string, identifier: string, status: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'evolution', ?, ?, ?)`)
      .run(id, org, identifier, identifier, status);
    return id;
  };
  const chA = mkCh(A, "ExaForge", "connected");         // o "conectado fantasma" do print
  const chAPaused = mkCh(A, "pausada", "disabled");      // pausa administrativa — não tocar
  const chB = mkCh(B, "outraOrg", "connected");

  // 0) Sem Evolution configurada, o logout no provedor é honesto: false.
  check("0.1 logoutInstance sem config → false (não finge)", (await EvolutionService.logoutInstance("ExaForge")) === false);

  // 1) Desconecta a org A.
  const r = await Svc.disconnect(A, "owner1");
  check("1.1 ok + 1 canal desconectado (o disabled não conta)", r.ok === true && r.disconnected === 1, JSON.stringify(r));
  check("1.2 providerLogout:false honesto (sem Evolution no ambiente)", r.providerLogout === false);
  const rowA = db.prepare(`SELECT status FROM channels WHERE id = ?`).get(chA) as any;
  check("1.3 canal vira 'disconnected' (UPDATE, não DELETE)", rowA?.status === "disconnected");
  check("1.4 status() reporta connected:false → card 'Desconectado'", Svc.status(A).channels.every(c => !c.connected));

  // 2) Pausa administrativa preservada; org B intacta (isolamento).
  check("2.1 canal 'disabled' não foi tocado", (db.prepare(`SELECT status FROM channels WHERE id = ?`).get(chAPaused) as any)?.status === "disabled");
  check("2.2 org B segue conectada", (db.prepare(`SELECT status FROM channels WHERE id = ?`).get(chB) as any)?.status === "connected");

  // 3) Idempotente: desconectar de novo não quebra nem apaga nada.
  const r2 = await Svc.disconnect(A, "owner1");
  check("3.1 repetir é seguro (ok, canal segue disconnected)", r2.ok === true && (db.prepare(`SELECT status FROM channels WHERE id = ?`).get(chA) as any)?.status === "disconnected");
  check("3.2 linha nunca deletada", !!db.prepare(`SELECT 1 FROM channels WHERE id = ?`).get(chA));

  // 4) Auditoria registrada.
  const audits = db.prepare(`SELECT COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CHANNEL_WHATSAPP_DISCONNECTED'`).get(A) as any;
  check("4.1 desconexões auditadas", Number(audits?.c || 0) >= 1);

  console.log("\n=== TEST: Desconectar WhatsApp pelo ZapFlow ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
