/**
 * TESTE — F4 do PRD Conexão WhatsApp (20/09/2026): idempotency key + lock de
 * operação (padrão AC-012).
 * -----------------------------------------------------------------------------
 * Falha alta nº 6 do PRD (confirmada na F0): duplo clique / 2 abas no
 * "Conectar" disparavam DUAS chamadas simultâneas ao provedor — o nome
 * determinístico reusa o canal, mas nada serializava a corrida (2 GetQr
 * concorrentes = 2 StartInstance = 2 pools vazados no evolution-go).
 *
 * Prova, offline (EvolutionService.provision monkey-patchado com promessa
 * controlada — a corrida é real, não simulada):
 *  - 2 provisions concorrentes: 1 vence, a 2ª recebe operation_in_progress
 *    com o operationId VIVO e NÃO toca o provedor; só 1 canal existe;
 *  - concluída a 1ª, provisionar de novo funciona (idempotente, mesmo canal);
 *  - operação 'running' ZUMBI (expires_at vencido) é substituída;
 *  - reset tem chave própria (não colide com provision);
 *  - exceção no meio marca a operação como failed (não vira zumbi eterno);
 *  - isolamento: org B provisiona em paralelo sem conflito.
 *
 * Uso: npm run test:whatsapp-operation-lock
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-oplock-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-oplock-1";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
delete process.env.EVOLUTION_BASE_URL; delete process.env.EVOLUTION_API_KEY;

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ChannelProvisioningService: Svc } = await import("../src/server/ChannelProvisioningService.js");
  const { EvolutionService } = await import("../src/server/EvolutionService.js");

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B);

  // Provedor controlado: cada chamada fica PENDENTE até o teste liberar.
  let providerCalls = 0;
  const pending: Array<(v: any) => void> = [];
  const realProvision = EvolutionService.provision;
  (EvolutionService as any).provision = (instanceName: string) => {
    providerCalls++;
    return new Promise((resolve) => pending.push(resolve));
  };

  // ── 1) A corrida real: 2 provisions concorrentes da MESMA org. ──
  const p1 = Svc.provision(A, "u1", { mode: "new" });
  await new Promise((r) => setTimeout(r, 20)); // garante que a 1ª reservou a operação
  const r2 = await Svc.provision(A, "u1", { mode: "new" });
  check("1.1 a 2ª chamada recebe operation_in_progress", r2.ok === false && r2.code === "operation_in_progress", JSON.stringify(r2));
  check("1.2 a 2ª devolve o operationId VIVO da 1ª", !!r2.operationId, String(r2.operationId));
  check("1.3 o provedor foi tocado UMA vez (a corrida não dobra StartInstance)", providerCalls === 1, String(providerCalls));
  // Libera a 1ª: provedor responde QR.
  pending.shift()!({ ok: true, qrBase64: "data:image/png;base64,QQ==", state: undefined, token: "tok1" });
  const r1 = await p1;
  check("1.4 a 1ª conclui normal (QR + operationId)", r1.ok === true && !!r1.qrBase64 && !!r1.operationId, JSON.stringify({ ok: r1.ok, op: r1.operationId }));
  const nCh = (db.prepare(`SELECT COUNT(*) n FROM channels WHERE organization_id = ?`).get(A) as any).n;
  check("1.5 SÓ 1 canal existe na org", Number(nCh) === 1, String(nCh));
  const opRow = db.prepare(`SELECT state FROM channel_connection_operations WHERE id = ?`).get(String(r1.operationId)) as any;
  check("1.6 operação marcada succeeded", opRow?.state === "succeeded", opRow?.state);

  // ── 2) Concluída, provisionar de novo FUNCIONA (idempotente, mesmo canal). ──
  const p3 = Svc.provision(A, "u1", { mode: "new" });
  await new Promise((r) => setTimeout(r, 10));
  pending.shift()!({ ok: true, qrBase64: "data:image/png;base64,QQ==", token: "tok1" });
  const r3 = await p3;
  const nCh3 = (db.prepare(`SELECT COUNT(*) n FROM channels WHERE organization_id = ?`).get(A) as any).n;
  check("2.1 re-provision após conclusão passa e não duplica canal", r3.ok === true && Number(nCh3) === 1, `ok=${r3.ok} canais=${nCh3}`);

  // ── 3) Operação zumbi (processo caiu): expires_at vencido → substituível. ──
  db.prepare(`UPDATE channel_connection_operations SET state = 'running', expires_at = ? WHERE id = ?`)
    .run(new Date(Date.now() - 1000).toISOString(), String(r3.operationId));
  const p4 = Svc.provision(A, "u1", { mode: "new" });
  await new Promise((r) => setTimeout(r, 10));
  check("3.1 zumbi vencido não bloqueia (nova operação reservada)", pending.length === 1, String(pending.length));
  pending.shift()!({ ok: false, error: "provedor caiu" });
  const r4 = await p4;
  check("3.2 falha do provedor marca a operação failed", r4.ok === false && (db.prepare(`SELECT state FROM channel_connection_operations WHERE id = ?`).get(String(r4.operationId)) as any)?.state === "failed", JSON.stringify(r4.code));

  // ── 4) Exceção no meio NÃO vira zumbi eterno. ──
  (EvolutionService as any).provision = async () => { providerCalls++; throw new Error("explodiu"); };
  let threw = "";
  try { await Svc.provision(A, "u1", { mode: "new" }); } catch (e: any) { threw = e.message; }
  check("4.1 exceção propaga pro caller", threw === "explodiu", threw);
  const zomb = db.prepare(`SELECT state FROM channel_connection_operations WHERE organization_id = ? AND idempotency_key LIKE 'provision:%'`).get(A) as any;
  check("4.2 operação marcada failed (não fica running)", zomb?.state === "failed", zomb?.state);

  // ── 5) Reset tem chave própria + isolamento entre orgs. ──
  (EvolutionService as any).provision = (n: string) => { providerCalls++; return new Promise((res) => pending.push(res)); };
  const pReset = Svc.reset(A, "u1"); // org A tem 1 canal → compat sem channelId
  await new Promise((r) => setTimeout(r, 10));
  const pB = Svc.provision(B, "u1", { mode: "new" }); // org B em paralelo — chave própria
  await new Promise((r) => setTimeout(r, 10));
  check("5.1 reset (A) e provision (B) rodam em paralelo sem conflito", pending.length === 2, String(pending.length));
  pending.shift()!({ ok: true, qrBase64: "data:image/png;base64,QQ==" });
  pending.shift()!({ ok: true, qrBase64: "data:image/png;base64,QQ==" });
  const [rReset, rB] = await Promise.all([pReset, pB]);
  check("5.2 ambos concluem ok", rReset.ok === true && rB.ok === true, JSON.stringify({ reset: rReset.ok, b: rB.ok }));

  (EvolutionService as any).provision = realProvision;

  console.log("\n=== TEST: F4 — idempotency key + lock de operação ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
