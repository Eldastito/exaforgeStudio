/**
 * TEST — FacebookChannelProvider (PRD 11 / ADR-168 F14). DB-backed, determinístico (CI-safe).
 * 2º provider REAL do SocialChannelProvider, espelhando InstagramChannelProvider:
 *   - SEM canal OAuth → capabilities vazias, not_connected, leituras degradam honesto (RN-SI-06);
 *   - COM canal (channels provider='facebook') → base descoberta (getProfile/getPosts/publish),
 *     getProfile lê a identidade do canal (sem rede/LLM), analytics NÃO presumida sem probe;
 *   - publish desconectado → manual_required; schedule → manual_required; ads → capability_unavailable;
 *   - Hub `providerFor` roteia facebook+provider='facebook' → FacebookChannelProvider (opt-in);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:social-provider-facebook
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fbprov-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-fbprov-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FacebookChannelProvider } = await import("../src/server/FacebookChannelProvider.js");
  const { deriveCapabilityFlags } = await import("../src/server/SocialChannelProvider.js");
  const { SocialConnectionService: SC } = await import("../src/server/SocialConnectionService.js");

  const A = `org_fb_${randomUUID().slice(0, 8)}`;
  const B = `org_fb_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(`os-${o}`, o);

  // ═══ 1. desconectado → capabilities vazias, estado honesto ═══
  const off = new FacebookChannelProvider(A);
  check("1.1 sem canal → capabilities vazias (RN-SI-06)", off.capabilities.length === 0);
  check("1.2 health = not_connected", (await off.health()).state === "not_connected");
  check("1.3 connect sem canal → not_connected (determinístico, sem rede)", (await off.connect({})).state === "not_connected");
  const offProfile = await off.getProfile();
  check("1.4 getProfile desconectado → not_connected", offProfile.available === false && offProfile.reason === "not_connected");
  const offPosts = await off.getPosts({});
  check("1.5 getPosts desconectado → available:false", offPosts.available === false && offPosts.posts.length === 0);
  const offPub = await off.publish({ kind: "image", mediaRef: "art:1", idempotencyKey: "k1" });
  check("1.6 publish desconectado → manual_required (não finge)", offPub.status === "manual_required");
  const offAud = await off.getAudienceAnalytics();
  check("1.7 audience desconectado → not_connected", offAud.available === false && offAud.reason === "not_connected");

  // ═══ 2. conectado (canal no DB) → base descoberta, identidade sem rede ═══
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, token_encrypted, status) VALUES (?, ?, 'facebook', 'Facebook Minha Página', '1234567890', 'FB-TOKEN-XYZ', 'active')`).run(randomUUID(), A);
  const on = new FacebookChannelProvider(A);
  check("2.1 conectado → base descoberta (getProfile/getPosts/publish)", ["getProfile", "getPosts", "publish"].every((c) => on.capabilities.includes(c as any)));
  check("2.2 analytics NÃO presumida sem probe (RN-SI-06)", !on.capabilities.includes("getAudienceAnalytics" as any));
  const flags = deriveCapabilityFlags(on.capabilities);
  check("2.3 flags grossas: publish true, ads false", flags.publish === true && flags.ads === false);
  const prof = await on.getProfile();
  check("2.4 getProfile lê identidade do canal (sem rede/LLM)", prof.available === true && prof.data?.handle === "Facebook Minha Página".replace(/^Facebook\s*/i, "") && prof.data?.url === "https://facebook.com/1234567890");
  check("2.5 seguidores null honesto (RN-SI-12)", prof.data?.followers === null);

  // ═══ 3. degradações explícitas ═══
  check("3.1 schedule → manual_required", (await on.schedule({ kind: "image", mediaRef: "a", idempotencyKey: "s", scheduledAt: "2026-09-01T10:00:00Z" })).status === "manual_required");
  check("3.2 getAds → capability_unavailable (Ads DEFERIDO §4)", (await on.getAds()).available === false && (await on.getAds()).reason === "capability_unavailable");
  check("3.3 duplicate por idempotencyKey (RN-SI-08)", (() => { (on as any).published.add("dup"); return true; })() && (await on.publish({ kind: "text", idempotencyKey: "dup" })).status === "duplicate");

  // ═══ 4. Hub providerFor roteia opt-in ═══
  SC.setConfig(A, "facebook", {}, { provider: "stub" });
  check("4.1 provider='stub' → NÃO é FacebookChannelProvider (opt-in)", SC.providerFor(A, "facebook").name === "stub");
  SC.setConfig(A, "facebook", {}, { provider: "facebook" });
  const routed = SC.providerFor(A, "facebook");
  check("4.2 provider='facebook' → FacebookChannelProvider", routed instanceof FacebookChannelProvider && routed.name === "facebook");
  const scRow = SC.status(A, "facebook");
  check("4.3 credencial NÃO duplicada no social_connections (§37)", !JSON.stringify(scRow || {}).includes("FB-TOKEN-XYZ"));

  // ═══ 5. isolamento ═══
  const bProv = new FacebookChannelProvider(B);
  check("5.1 org B sem canal → desconectada (isolamento)", bProv.capabilities.length === 0);
  check("5.2 org B não vê o canal de A", (await bProv.getProfile()).available === false);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} social-provider-facebook: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
