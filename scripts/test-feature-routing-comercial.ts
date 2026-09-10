/**
 * TEST — F6.3c (RF-08 §F6.3 / CA-03): guardas de finalidade CAMPANHAS/PROSPECÇÃO.
 *
 * Prova, offline (tmp db, fetch/sender stubados — sem rede), que:
 *  A. o produtor real de campanha (CampaignService) envia declarando a finalidade
 *     "campanhas" — antes o gate não passava por ele;
 *  B. no sink, desligar "campanhas" bloqueia campanha SEM afetar "prospeccao"/
 *     "atendimento" e vice-versa (CA-03 nos dois sentidos); sem binding passa
 *     (0-regressão) — "interno" não vira finalidade privilegiada.
 *
 * Mapa desta fatia: campanhas = CampaignService · prospeccao =
 * ProspectExecutionService. (SupplierQuote/QuoteService — compras/vendas sem
 * KNOWN_FEATURE direto — ficam pra F6.3d com decisão de vocabulário.)
 *
 * Uso: npm run test:feature-routing-comercial
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-feat-com-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-feat-com-1";
process.env.EVOLUTION_API_KEY = "k"; process.env.EVOLUTION_BASE_URL = "https://ev.test";
process.env.CAMPAIGN_MIN_DELAY_MS = "0"; process.env.CAMPAIGN_MAX_DELAY_MS = "0"; process.env.CAMPAIGN_DAILY_LIMIT = "300";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ChannelBindingService, OutboundFeatureDisabledError } = await import("../src/server/ChannelBindingService.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const mkChannel = (org: string) => { const id = randomUUID(); db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, token_encrypted) VALUES (?, ?, 'evolution_go', 'n', 'n', 'connected', 'tok')`).run(id, org); return id; };
  const bind = (org: string, ch: string, feature: string, inbound: number, outbound: number) =>
    db.prepare(`INSERT INTO channel_feature_bindings (id, organization_id, channel_id, feature_key, inbound, outbound) VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), org, ch, feature, inbound, outbound);

  // ══ PARTE B (sink REAL): isolamento campanhas × prospeccao ══
  let fetchCalls = 0;
  const origFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => { fetchCalls++; return { ok: true, status: 200, text: async () => "{}", json: async () => ({ key: { id: "mid" } }), headers: { get: () => "application/json" } }; };
  const sendTry = async (ch: string, feature: string) => { fetchCalls = 0; let blocked = false; try { await MessageProviderService.sendMessage(ch, "5521999", "x", { feature }); } catch (e) { blocked = e instanceof OutboundFeatureDisabledError; } return { blocked, sent: fetchCalls > 0 }; };

  const O1 = `org1_${randomUUID().slice(0, 6)}`; mkOrg(O1); const c1 = mkChannel(O1);
  bind(O1, c1, "campanhas", 1, 0); bind(O1, c1, "prospeccao", 1, 1); bind(O1, c1, "atendimento", 1, 1);
  check("B.1 campanhas desligada → campanha bloqueada", (await sendTry(c1, "campanhas")).blocked === true);
  check("B.2 CA-03: prospeccao livre no mesmo canal", (await sendTry(c1, "prospeccao")).sent === true);
  check("B.3 CA-03: atendimento livre no mesmo canal", (await sendTry(c1, "atendimento")).sent === true);
  check("B.4 finalidade sem binding (gestao) → passa (0-regressão)", (await sendTry(c1, "gestao")).sent === true);

  const O2 = `org2_${randomUUID().slice(0, 6)}`; mkOrg(O2); const c2 = mkChannel(O2);
  bind(O2, c2, "prospeccao", 1, 0); bind(O2, c2, "campanhas", 1, 1);
  check("B.5 prospeccao desligada → prospecção bloqueada", (await sendTry(c2, "prospeccao")).blocked === true);
  check("B.6 CA-03: campanhas livre (prospeccao desligada não afeta)", (await sendTry(c2, "campanhas")).sent === true);
  (globalThis as any).fetch = origFetch;

  // ══ PARTE A: produtor real de campanha declara 'campanhas' ══
  const { CampaignService } = await import("../src/server/CampaignService.js");
  const captured: Array<{ feature: string | undefined }> = [];
  (MessageProviderService as any).sendMessage = async (_ch: string, _to: string, _text: string, opts?: any) => { captured.push({ feature: opts?.feature }); return `wamid.${randomUUID().slice(0, 8)}`; };

  const orgA = `org_camp_${randomUUID().slice(0, 6)}`; mkOrg(orgA); const chA = mkChannel(orgA);
  const contactA = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, 'Cliente', '5511988887777')`).run(contactA, orgA, chA);
  const camp = CampaignService.createCampaignForContacts(orgA, { name: "Promo", message: "Oi {nome}!", contactIds: [contactA] });
  await CampaignService.startCampaign(orgA, camp.id!);
  // runLoop roda em background (não-awaited) — espera o envio concluir.
  for (let i = 0; i < 40 && captured.length === 0; i++) await wait(10);
  check("A.1 campanha enviou ao destinatário", captured.length === 1);
  check("A.2 o envio declara finalidade 'campanhas'", captured[0]?.feature === "campanhas");

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} feature-routing-comercial: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
