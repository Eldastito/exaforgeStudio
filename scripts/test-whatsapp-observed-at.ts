/**
 * TESTE — F3 do PRD Conexão WhatsApp (20/09/2026): observed_at + reconciliação
 * LEAK-AWARE.
 * -----------------------------------------------------------------------------
 * Falha alta nº 3 do PRD (confirmada na F0): a tela lia o status do banco sem
 * prova de frescor — logout no celular + webhook perdido deixava "conectado"
 * mentindo pra sempre. E qualquer reconciliador ingênuo agrava o incidente
 * real de produção (16-19/09): o evolution-go vaza um pool de Postgres por
 * StartInstance — reconciliar TEM que ser só leitura de estado.
 *
 * Prova, offline (fetch global stubado):
 *  - sync carimba provider_observed_at em TODA linha reconciliada (inclusive
 *    "instância não existe lá"); legado NULL fica honesto até a 1ª observação;
 *  - evento de conexão do webhook carimba junto do status;
 *  - status() expõe providerObservedAt;
 *  - reconcilePass corrige o "conectado fantasma", respeita o throttle
 *    per-org e o teto por tick, e NUNCA chama GetQr/StartInstance (leak-aware
 *    provado pela lista de URLs);
 *  - sem provedor configurado → no-op sem gastar rede;
 *  - isolamento multi-tenant.
 *
 * Uso: npm run test:whatsapp-observed-at
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-observed-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-observed-1";
process.env.APP_URL = "https://app.test";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
delete process.env.EVOLUTION_BASE_URL; delete process.env.EVOLUTION_API_KEY;

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

let providerInstances: Array<{ name: string; token?: string; id?: string; connected?: boolean }> = [];
const urls: string[] = [];
function jsonResp(body: any) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => "application/json" } };
}
const origFetch = (globalThis as any).fetch;
(globalThis as any).fetch = async (url: string) => {
  urls.push(String(url));
  const u = String(url);
  if (u.includes("/instance/all")) return jsonResp({ data: providerInstances });
  return jsonResp({});
};

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ChannelProvisioningService: Svc } = await import("../src/server/ChannelProvisioningService.js");
  const { markEvolutionChannelStatusByIdentifier } = await import("../src/server/evolutionChannelStatus.js");
  const { EncryptionService } = await import("../src/server/EncryptionService.js");

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const mkCh = (org: string, idf: string, status: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, token_encrypted) VALUES (?, ?, 'evolution', ?, ?, ?, ?)`)
      .run(id, org, `WhatsApp (${idf})`, idf, status, EncryptionService.encrypt("tok"));
    return id;
  };
  const rowOf = (id: string) => db.prepare(`SELECT status, provider_observed_at FROM channels WHERE id = ?`).get(id) as any;

  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B);
  const chA = mkCh(A, "instA", "connected");     // o "conectado fantasma"
  const chGone = mkCh(A, "instSumida", "connected"); // não existe mais no provedor
  const chB = mkCh(B, "instB", "awaiting_qr");

  // ── 0) Sem provedor configurado: reconcilePass é no-op SEM rede. ──
  const r0 = await Svc.reconcilePass();
  check("0.1 sem config → no-op honesto", r0.reconciled === 0 && r0.skipped === 0, JSON.stringify(r0));
  check("0.2 nenhuma chamada de rede", urls.length === 0, String(urls.length));
  check("0.3 legado sem observação: observed_at NULL (honesto)", rowOf(chA).provider_observed_at == null, String(rowOf(chA).provider_observed_at));

  // ── 1) Sync carimba a observação em TODA linha reconciliada. ──
  process.env.EVOLUTION_BASE_URL = "https://ev.test"; process.env.EVOLUTION_API_KEY = "admin-key";
  providerInstances = [{ name: "instA", id: "i1", connected: false }]; // sessão CAIU; instSumida nem existe
  const s1 = await Svc.syncFromProvider(A, "u1");
  check("1.1 sync ok", s1.ok === true, JSON.stringify(s1));
  const a1 = rowOf(chA);
  check("1.2 'conectado fantasma' rebaixado com evidência", a1.status === "disconnected", a1.status);
  check("1.3 observação carimbada no canal rebaixado", !!a1.provider_observed_at, String(a1.provider_observed_at));
  const g1 = rowOf(chGone);
  check("1.4 'instância não existe lá' TAMBÉM é observação (carimbo + disconnected)", g1.status === "disconnected" && !!g1.provider_observed_at, JSON.stringify(g1));
  check("1.5 org B não observada pelo sync da A (isolamento)", rowOf(chB).provider_observed_at == null, String(rowOf(chB).provider_observed_at));

  // ── 2) Evento de conexão do webhook carimba junto do status. ──
  check("2.1 webhook marca status e carimba observação", markEvolutionChannelStatusByIdentifier("instB", "connected") === true);
  const b2 = rowOf(chB);
  check("2.2 status + observed_at gravados", b2.status === "connected" && !!b2.provider_observed_at, JSON.stringify(b2));

  // ── 3) status() expõe a observação pro operador. ──
  const st = Svc.status(A);
  check("3.1 status() expõe providerObservedAt", st.channels.every((c: any) => "providerObservedAt" in c) && !!st.channels.find((c: any) => c.channelId === chA)?.providerObservedAt, JSON.stringify(st.channels[0]));

  // ── 4) reconcilePass: corrige fantasma, throttle, teto e LEAK-AWARE. ──
  db.prepare(`UPDATE channels SET status = 'connected', provider_observed_at = NULL WHERE id = ?`).run(chA); // fantasma de novo
  urls.length = 0;
  const r4 = await Svc.reconcilePass();
  check("4.1 passe reconcilia as orgs com canal ativo", r4.reconciled >= 1, JSON.stringify(r4));
  const a4 = rowOf(chA);
  check("4.2 fantasma corrigido pelo passe (disconnected + carimbo)", a4.status === "disconnected" && !!a4.provider_observed_at, JSON.stringify(a4));
  // LEAK-AWARE: só /instance/all (+ webhook/set quando aberto) — NUNCA GetQr.
  const leaky = urls.filter((u) => u.includes("/instance/qr") || u.includes("/instance/connect") || u.includes("/instance/create"));
  check("4.3 LEAK-AWARE: nenhuma chamada que inicia sessão (GetQr/connect/create)", leaky.length === 0, JSON.stringify(leaky));
  // Throttle per-org: chamar de novo AGORA pula tudo.
  const r5 = await Svc.reconcilePass();
  check("4.4 throttle per-org: passe imediato pula (skipped)", r5.reconciled === 0 && r5.skipped >= 1, JSON.stringify(r5));
  // Teto por tick: zera o throttle e limita a 1 org por passada.
  (Svc as any).lastReconcileAt = new Map();
  const r6 = await Svc.reconcilePass({ maxOrgsPerTick: 1 });
  check("4.5 teto por tick respeitado (1 reconciliada, resto pulado)", r6.reconciled === 1 && r6.skipped >= 1, JSON.stringify(r6));

  (globalThis as any).fetch = origFetch;

  console.log("\n=== TEST: F3 — observed_at + reconciliação leak-aware ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
