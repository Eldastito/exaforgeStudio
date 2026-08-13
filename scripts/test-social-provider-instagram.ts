/**
 * TEST — InstagramChannelProvider (PRD 10 / ADR-167 F3). DB-backed, determinístico.
 * Exercita SÓ os caminhos sem rede (a Graph API real é provada em produção, como o
 * ReclameAquiProvider): descoberta de capability por estado de conexão, degradação
 * honesta desconectado, e o roteamento do Connection Hub (F2) pro provider REAL.
 *
 * Prova (§5/§7, RN-SI-06/08/12):
 *   - SEM canal OAuth → capabilities vazias, not_connected, leituras degradam honesto;
 *   - COM canal (channels provider='instagram') → capabilities base descobertas
 *     (getProfile/getPosts/publish) + getProfile lê a identidade do canal (sem rede/LLM);
 *   - publish sem conexão/sem mídia → manual_required (nunca finge); schedule idem;
 *     ads/getPostAnalytics → capability_unavailable (DEFERIDOS);
 *   - Hub `providerFor` roteia instagram+provider='instagram' → InstagramChannelProvider;
 *     credencial NÃO é duplicada no social_connections (fica no channels).
 *
 * Uso: npm run test:social-provider-instagram
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ig-prov-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ig-prov-12345";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { InstagramChannelProvider } = await import("../src/server/InstagramChannelProvider.js");
  const { SocialConnectionService: SC } = await import("../src/server/SocialConnectionService.js");
  const { deriveCapabilityFlags } = await import("../src/server/SocialChannelProvider.js");

  const A = "org_ig_A", B = "org_ig_B";

  // ═══════════════ 1. desconectado → capabilities vazias, estado honesto ═══════════════
  const off = new InstagramChannelProvider(A);
  check("1.1 sem canal → capabilities vazias (não presume, RN-SI-06)", off.capabilities.length === 0);
  const offHealth = await off.health();
  check("1.2 health = not_connected", offHealth.state === "not_connected");
  const offConn = await off.connect({ orgId: A });
  check("1.3 connect sem canal → not_connected (determinístico, sem rede)", offConn.state === "not_connected");
  const offProfile = await off.getProfile();
  check("1.4 getProfile desconectado → available:false not_connected", offProfile.available === false && offProfile.reason === "not_connected");
  const offPosts = await off.getPosts({});
  check("1.5 getPosts desconectado → available:false", offPosts.available === false && offPosts.posts.length === 0);
  const offPub = await off.publish({ kind: "image", mediaRef: "art:1", idempotencyKey: "k1" });
  check("1.6 publish desconectado → manual_required (não finge)", offPub.status === "manual_required");
  const offAud = await off.getAudienceAnalytics();
  check("1.7 audience desconectado → not_connected", offAud.available === false && offAud.reason === "not_connected");

  // ═══════════════ 2. conectado (canal OAuth no channels) → descoberta base ═══════════════
  db.prepare(
    `INSERT INTO channels (id, organization_id, provider, name, identifier, token_encrypted, status)
     VALUES (?, ?, 'instagram', 'Instagram @minha.marca', '17841400000000000', 'IG-TOKEN-XYZ', 'active')`,
  ).run("ch-ig-A", A);
  const on = new InstagramChannelProvider(A);
  check("2.1 conectado → base descoberta (getProfile/getPosts/publish)", ["getProfile", "getPosts", "publish"].every((c) => on.capabilities.includes(c as any)));
  check("2.2 analytics NÃO presumida sem probe (RN-SI-06)", !on.capabilities.includes("getAudienceAnalytics" as any));
  const flags = deriveCapabilityFlags(on.capabilities);
  check("2.3 flags grossas: publish true, ads false", flags.publish === true && flags.ads === false);
  const prof = await on.getProfile();
  check("2.4 getProfile lê a identidade do canal (sem rede/LLM)", prof.available === true && prof.data?.handle === "@minha.marca" && prof.data?.url === "https://instagram.com/minha.marca");
  check("2.5 seguidores null honesto (escopo business/insights) (RN-SI-12)", prof.data?.followers === null);

  // ═══════════════ 3. degradações explícitas (sem rede) ═══════════════
  const sch = await on.schedule({ kind: "image", mediaRef: "art:1", idempotencyKey: "s1", scheduledAt: "2026-09-01T12:00:00Z" });
  check("3.1 schedule → manual_required (Scheduler do app cuida do horário)", sch.status === "manual_required");
  const pubNoMedia = await on.publish({ kind: "image", idempotencyKey: "k2" });
  check("3.2 publish sem mídia → manual_required", pubNoMedia.status === "manual_required");
  const pa = await on.getPostAnalytics("IG-1");
  check("3.3 getPostAnalytics → capability_unavailable (DEFERIDO p/ F4)", pa.available === false && pa.reason === "capability_unavailable");
  const ads = await on.getAds();
  check("3.4 getAds → capability_unavailable (Ads DEFERIDO §4)", ads.available === false && ads.reason === "capability_unavailable");

  // ═══════════════ 4. Hub roteia pro provider REAL (F2→F3) ═══════════════
  // provider default 'stub' → NÃO é o real (0-regressão, opt-in).
  SC.setConfig(A, "instagram", {}, { provider: "stub" });
  check("4.1 provider='stub' → NÃO é InstagramChannelProvider (opt-in)", SC.providerFor(A, "instagram").name === "stub");
  // provider='instagram' → o real; credencial fica no channels, não no social_connections.
  SC.setConfig(A, "instagram", {}, { provider: "instagram" });
  const routed = SC.providerFor(A, "instagram");
  check("4.2 provider='instagram' → InstagramChannelProvider", routed instanceof InstagramChannelProvider && routed.name === "instagram");
  const scRow = db.prepare(`SELECT config_enc FROM social_connections WHERE organization_id = ? AND channel = 'instagram'`).get(A) as any;
  check("4.3 credencial NÃO duplicada no social_connections (§42)", !JSON.stringify(scRow || {}).includes("IG-TOKEN-XYZ"));

  // ═══════════════ 5. isolamento multi-tenant ═══════════════
  const bProv = new InstagramChannelProvider(B);
  check("5.1 org B sem canal → desconectada (isolamento, convenção #1)", bProv.capabilities.length === 0);
  const bProf = await bProv.getProfile();
  check("5.2 org B não vê o canal de A", bProf.available === false);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} social-provider-instagram: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
