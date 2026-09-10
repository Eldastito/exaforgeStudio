/**
 * TEST — F6.3d (RF-08 §F6.3 / CA-03): vocabulário compras/vendas + guardas das
 * finalidades restantes (escola/vendas/compras/recompra).
 *
 * Prova, offline (tmp db, fetch stubado — sem rede), que:
 *  A. o vocabulário cresce de forma aditiva: `compras`/`vendas` são finalidades
 *     VÁLIDAS (isKnownFeature) e um binding pode ser gravado pra elas;
 *  B. no sink, desligar CADA finalidade migrada nesta fatia (escola/compras/
 *     vendas/recompra) bloqueia SÓ aquela SEM afetar `atendimento`; finalidade
 *     sem binding passa (0-regressão) — "interno" não vira finalidade privilegiada.
 *
 * Mapa desta fatia: escola=routes/escola · compras=SupplierQuote · vendas=Quote ·
 * recompra=SalesRecoveryPlaybook · gestao=Radar/TaskReminder · cobranca=Subscription.
 *
 * Uso: npm run test:feature-routing-vocab
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-feat-vocab-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-feat-vocab-1";
process.env.EVOLUTION_API_KEY = "k"; process.env.EVOLUTION_BASE_URL = "https://ev.test";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ChannelBindingService, OutboundFeatureDisabledError, isKnownFeature } = await import("../src/server/ChannelBindingService.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");

  // ── A. vocabulário aditivo ──
  check("A.1 'compras' é finalidade válida", isKnownFeature("compras") === true);
  check("A.2 'vendas' é finalidade válida", isKnownFeature("vendas") === true);
  check("A.3 chave fora do vocabulário segue inválida", isKnownFeature("qualquer_coisa") === false);

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const mkChannel = (org: string) => { const id = randomUUID(); db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, token_encrypted) VALUES (?, ?, 'evolution_go', 'n', 'n', 'connected', 'tok')`).run(id, org); return id; };
  const bind = (org: string, ch: string, feature: string, inbound: number, outbound: number) =>
    db.prepare(`INSERT INTO channel_feature_bindings (id, organization_id, channel_id, feature_key, inbound, outbound) VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), org, ch, feature, inbound, outbound);

  // upsert (caminho de escrita real) aceita as novas finalidades
  const OU = `orgU_${randomUUID().slice(0, 6)}`; mkOrg(OU); const cU = mkChannel(OU);
  let upsertOk = true;
  try { ChannelBindingService.upsert(OU, `user_${OU}`, { channelId: cU, featureKey: "compras", inbound: true, outbound: true }); } catch { upsertOk = false; }
  check("A.4 upsert grava binding de 'compras' (write path aceita)", upsertOk && (ChannelBindingService.list(OU, "compras") as any[]).length >= 1);

  // ── B. isolamento por finalidade no sink ──
  let fetchCalls = 0;
  const origFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => { fetchCalls++; return { ok: true, status: 200, text: async () => "{}", json: async () => ({ key: { id: "mid" } }), headers: { get: () => "application/json" } }; };
  const sendTry = async (ch: string, feature: string) => { fetchCalls = 0; let blocked = false; try { await MessageProviderService.sendMessage(ch, "5521999", "x", { feature }); } catch (e) { blocked = e instanceof OutboundFeatureDisabledError; } return { blocked, sent: fetchCalls > 0 }; };

  for (const feature of ["escola", "compras", "vendas", "recompra"]) {
    const org = `org_${feature}_${randomUUID().slice(0, 5)}`; mkOrg(org); const ch = mkChannel(org);
    bind(org, ch, feature, 1, 0);        // esta finalidade: saída DESLIGADA
    bind(org, ch, "atendimento", 1, 1);  // atendimento livre
    check(`B.${feature} desligada → bloqueia`, (await sendTry(ch, feature)).blocked === true);
    check(`B.${feature} CA-03: atendimento livre no mesmo canal`, (await sendTry(ch, "atendimento")).sent === true);
    check(`B.${feature} finalidade sem binding → passa (0-regressão)`, (await sendTry(ch, "satisfacao")).sent === true);
  }
  (globalThis as any).fetch = origFetch;

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} feature-routing-vocab: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
