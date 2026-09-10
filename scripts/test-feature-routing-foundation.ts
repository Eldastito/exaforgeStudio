/**
 * TEST — F6.1 (RF-03/RF-08): fundação da finalidade.
 *
 * Prova, offline (tmp db, sends stubados — sem rede), que:
 *  1. o `feature` FLUI pela fila de entrega até o sender (antes era descartado
 *     em MessageDeliveryService → gate de finalidade nunca se aplicava no
 *     caminho assíncrono); sem feature = comportamento herdado (0-regressão);
 *  2. FileDeliveryService declara finalidade "gestao" (não o "falatu" inválido);
 *  3. quando o gate BLOQUEIA a finalidade (feature desligada), a entrega de
 *     arquivo NÃO vira link — pausar é a decisão de política (§14), mandar o
 *     link burlaria o gate;
 *  4. falha de ANEXO (não-gate) ainda cai pro link declarado, também com a
 *     finalidade "gestao".
 *
 * (O gate no sink em si já é coberto por test:channel-binding-gate.)
 * Uso: npm run test:feature-routing-foundation
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-feat-route-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-feat-route-1";
process.env.APP_URL = "https://app.test";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MessageDeliveryService: MD } = await import("../src/server/MessageDeliveryService.js");
  const { MessageProviderService: MP } = await import("../src/server/MessageProviderService.js");
  const { FileDeliveryService: FD } = await import("../src/server/FileDeliveryService.js");
  const { ContextEngineService: CE } = await import("../src/server/ContextEngineService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja X', 'active')`).run(randomUUID(), orgId);
  PermissionService.seedSystemProfiles(orgId);

  // ── 1. o feature flui pela fila até o sender ──
  const captured: Array<{ feature: string | null | undefined }> = [];
  (MD as any).__setSenderForTests(async (_ch: string, _to: string, _content: string, feature?: string | null) => {
    captured.push({ feature }); return "wamid-1";
  });
  MD.enqueue(orgId, { messageId: randomUUID(), channelId: "ch1", recipient: "5511999", content: "oi", feature: "gestao" });
  await MD.dispatchDue();
  check("1.1 fila carrega o feature até o sender", captured.length === 1 && captured[0].feature === "gestao");
  captured.length = 0;
  MD.enqueue(orgId, { messageId: randomUUID(), channelId: "ch1", recipient: "5511999", content: "oi2" });
  await MD.dispatchDue();
  check("1.2 sem feature = herdado (0-regressão)", captured.length === 1 && !captured[0].feature);

  // Stubs de envio de documento/mensagem (FileDeliveryService chama o sink direto).
  let lastDoc: any = null; let lastMsg: any = null; let docBehavior: "ok" | "gate" | "fail" = "ok";
  (MP as any).sendDocument = async (_ch: string, _to: string, url: string, fileName: string, caption: string, opts: any) => {
    if (docBehavior === "gate") { const e: any = new Error("bloqueado"); e.code = "outbound_blocked:feature_disabled"; throw e; }
    if (docBehavior === "fail") throw new Error("provedor recusou anexo");
    lastDoc = { url, fileName, caption, opts }; return true;
  };
  (MP as any).sendMessage = async (_ch: string, _to: string, text: string, opts: any) => { lastMsg = { text, opts }; return "wamid"; };
  (CE as any).build = (_o: string) => ({ narrative: "n", snapshot: { domains: { sales: { total: 120 } }, topPriorities: [], dataQuality: {} }, snapshotEnabled: true, sources: [], generatedAt: "", schemaVersion: 1 });
  const owner = { userId: randomUUID(), role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'owner'`).get(orgId) as any)?.id, role: "owner" };

  // ── 2. FileDeliveryService declara "gestao" ──
  docBehavior = "ok"; lastDoc = null;
  const r2 = await FD.deliverNow(orgId, { channelId: "ch1", toIdentifier: "5511999", user: owner, format: "docx", catalogKey: "executive_summary" });
  check("2.1 entrega de arquivo declara finalidade 'gestao'", r2.sent === true && lastDoc?.opts?.feature === "gestao");

  // ── 3. gate bloqueou → NÃO vira link ──
  docBehavior = "gate"; lastDoc = null; lastMsg = null;
  const r3 = await FD.deliverNow(orgId, { channelId: "ch1", toIdentifier: "5511999", user: owner, format: "docx", catalogKey: "executive_summary" });
  check("3.1 feature desligada → não envia nem link (pausa, não burla)", r3.sent === false && (r3 as any).reason === "feature_disabled" && lastMsg === null);

  // ── 4. falha de anexo (não-gate) → link declarado, também 'gestao' ──
  docBehavior = "fail"; lastDoc = null; lastMsg = null;
  const r4 = await FD.deliverNow(orgId, { channelId: "ch1", toIdentifier: "5511999", user: owner, format: "docx", catalogKey: "executive_summary" });
  check("4.1 falha de anexo → link declarado (native false)", r4.sent === true && (r4 as any).native === false);
  check("4.2 o link também declara finalidade 'gestao'", lastMsg?.opts?.feature === "gestao" && lastMsg.text.toLowerCase().includes("link"));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} feature-routing-foundation: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
