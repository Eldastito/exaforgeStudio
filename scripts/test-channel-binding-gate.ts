/**
 * TEST — F2.4 (CA-03): gate de saída por finalidade no SINK
 * (PRD WhatsApp Unificado — RF-03 / CA-03).
 *
 * Prova, offline (tmp db + fetch stubado):
 *  - assertOutboundAllowed: finalidade DESLIGADA (binding só inbound) lança;
 *    finalidade ligada passa; sem binding passa (0-regressão); sem feature passa.
 *  - sendMessage com opts.feature desligada BLOQUEIA (nem chega a chamar fetch);
 *    com feature ligada envia; sem opts.feature envia (herdado).
 *  - CA-03: desligar 'campanhas' bloqueia campanha SEM afetar 'atendimento'.
 *  - isolamento entre orgs.
 *
 * Uso: npm run test:channel-binding-gate
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cfb-gate-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-cfb-gate-1";
process.env.EVOLUTION_API_KEY = "k"; process.env.EVOLUTION_BASE_URL = "https://ev.test";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

let fetchCalls = 0;
function installFetch() {
  const orig = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => { fetchCalls++; return { ok: true, status: 200, text: async () => "{}", json: async () => ({ key: { id: "mid" } }), headers: { get: () => "application/json" } }; };
  return () => { (globalThis as any).fetch = orig; };
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ChannelBindingService, OutboundFeatureDisabledError } = await import("../src/server/ChannelBindingService.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const mkChannel = (org: string, name: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, token_encrypted) VALUES (?, ?, 'evolution_go', ?, ?, 'connected', 'tok')`).run(id, org, name, name);
    return id;
  };
  const bind = (org: string, ch: string, feature: string, inbound: number, outbound: number) =>
    db.prepare(`INSERT INTO channel_feature_bindings (id, organization_id, channel_id, feature_key, inbound, outbound) VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), org, ch, feature, inbound, outbound);

  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);
  const ch = mkChannel(A, "num1");

  // ── 1. assertOutboundAllowed ──
  bind(A, ch, "campanhas", 1, 0);   // campanhas: só entrada → saída DESLIGADA
  bind(A, ch, "atendimento", 1, 1); // atendimento ligado
  let threw = false;
  try { ChannelBindingService.assertOutboundAllowed(A, "campanhas"); } catch (e) { threw = e instanceof OutboundFeatureDisabledError; }
  check("1.1 finalidade desligada → lança OutboundFeatureDisabledError", threw === true);
  check("1.2 finalidade ligada → passa", (() => { try { ChannelBindingService.assertOutboundAllowed(A, "atendimento"); return true; } catch { return false; } })());
  check("1.3 sem binding (cobranca) → passa (herdado)", (() => { try { ChannelBindingService.assertOutboundAllowed(A, "cobranca"); return true; } catch { return false; } })());
  check("1.4 sem feature → passa", (() => { try { ChannelBindingService.assertOutboundAllowed(A, undefined); return true; } catch { return false; } })());

  // ── 2. sendMessage respeita o gate ──
  const restore = installFetch();
  // 2.1 campanhas desligada → bloqueia (sem tocar fetch)
  fetchCalls = 0; let blocked = false;
  try { await MessageProviderService.sendMessage(ch, "5521999", "promo", { feature: "campanhas" }); } catch (e) { blocked = e instanceof OutboundFeatureDisabledError; }
  check("2.1 sendMessage campanhas desligada → bloqueia", blocked === true);
  check("2.2 nem chegou a chamar o provedor (fetch=0)", fetchCalls === 0);
  // 2.3 atendimento ligado → envia
  fetchCalls = 0;
  await MessageProviderService.sendMessage(ch, "5521999", "oi", { feature: "atendimento" });
  check("2.3 atendimento ligado → envia (fetch>0)", fetchCalls > 0);
  // 2.4 sem feature → envia (herdado, 0-regressão)
  fetchCalls = 0;
  await MessageProviderService.sendMessage(ch, "5521999", "oi");
  check("2.4 sem feature → envia (herdado)", fetchCalls > 0);
  // 2.5 sem binding (cobranca) → envia
  fetchCalls = 0;
  await MessageProviderService.sendMessage(ch, "5521999", "oi", { feature: "cobranca" });
  check("2.5 finalidade sem binding → envia", fetchCalls > 0);
  restore();

  // ── 3. CA-03: desligar campanhas não afeta atendimento (já provado 2.1×2.3) ──
  check("3.1 CA-03: campanhas bloqueada E atendimento livre no MESMO canal", blocked === true);

  // ── 4. isolamento: org B sem binding não é afetada ──
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B);
  check("4.1 org B (sem binding) → assert passa", (() => { try { ChannelBindingService.assertOutboundAllowed(B, "campanhas"); return true; } catch { return false; } })());

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} channel-binding-gate: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
