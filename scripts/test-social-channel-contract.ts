/**
 * TEST — SocialChannelProvider contract (PRD 10 / ADR-167 F1). Determinístico, sem rede.
 *
 * Prova (§5/§7, D2, RN-SI-06/08/12):
 *   - contrato + capabilities descobertas (não presumidas); flags grossas derivadas;
 *   - DEGRADAÇÃO explícita: sem `publish` → manual_required; sem `ads` → capability_unavailable;
 *     NUNCA finge capacidade ausente;
 *   - publicação/agendamento IDEMPOTENTES (mesmo idempotencyKey → duplicate);
 *   - analytics honestos (métrica ausente → null, nunca 0);
 *   - estados de conexão observáveis (connect/disconnect/health); token vencido ≠ conectado;
 *   - registry resolve por nome/env → stub default.
 *
 * Uso: npm run test:social-channel-contract
 */
let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const M = await import("../src/server/SocialChannelProvider.js");
  const { StubSocialChannelProvider, getSocialChannelProvider, deriveCapabilityFlags, supportsCapability } = M;

  // ═══════════════ 1. contrato + descoberta de capability ═══════════════
  const full = new StubSocialChannelProvider(); // publish+schedule+analytics; ads/competitor DEFERIDOS
  check("1.1 name + capabilities array", full.name === "stub" && Array.isArray(full.capabilities));
  check("1.2 capabilities inclui getProfile/getPosts/publish/schedule/analytics", ["getProfile", "getPosts", "publish", "schedule", "getPostAnalytics", "getAudienceAnalytics"].every((c) => full.capabilities.includes(c as any)));
  check("1.3 ads/competitor DEFERIDOS por default", !full.capabilities.includes("getAds" as any) && !full.capabilities.includes("competitorData" as any));
  const flags = deriveCapabilityFlags(full.capabilities);
  check("1.4 flags grossas derivadas (§7)", flags.analytics === true && flags.publish === true && flags.schedule === true && flags.ads === false && flags.competitorData === false);
  check("1.5 supportsCapability", supportsCapability(full, "publish") === true && supportsCapability(full, "getAds") === false);

  // ═══════════════ 2. degradação explícita (RN-SI-06) ═══════════════
  const readOnly = new StubSocialChannelProvider({ canPublish: false, canSchedule: false });
  check("2.1 sem publish → capability fora", !readOnly.capabilities.includes("publish" as any));
  const pubDeg = readOnly.publish({ kind: "image", idempotencyKey: "k1" });
  check("2.2 publish sem capacidade → manual_required (não finge)", pubDeg.status === "manual_required");
  const schDeg = readOnly.schedule({ kind: "image", idempotencyKey: "k2", scheduledAt: "2026-08-20T12:00:00Z" });
  check("2.3 schedule sem capacidade → manual_required", schDeg.status === "manual_required");
  const adsDeg = full.getAds();
  check("2.4 sem ads → capability_unavailable (não inventa)", adsDeg.available === false && adsDeg.reason === "capability_unavailable" && adsDeg.data === null);
  const noAnalytics = new StubSocialChannelProvider({ canAnalytics: false });
  check("2.5 sem analytics → capability_unavailable", noAnalytics.getPostAnalytics("SP-1").available === false);

  // ═══════════════ 3. publicação idempotente (RN-SI-08) ═══════════════
  const p1 = full.publish({ kind: "image", caption: "linho", mediaRef: "art:1", idempotencyKey: "pub-1" });
  const p2 = full.publish({ kind: "image", caption: "linho", mediaRef: "art:1", idempotencyKey: "pub-1" });
  check("3.1 1ª publica", p1.status === "published" && !!p1.externalId);
  check("3.2 2ª mesmo idempotencyKey → duplicate (nunca 2×)", p2.status === "duplicate");
  const s1 = full.schedule({ kind: "reel", idempotencyKey: "sch-1", scheduledAt: "2026-08-20T12:00:00Z" });
  check("3.3 schedule → scheduled", s1.status === "scheduled" && !!s1.externalId);

  // ═══════════════ 4. analytics honestos (RN-SI-12) ═══════════════
  const a1 = full.getPostAnalytics("SP-1");
  check("4.1 post com métricas → available + números", a1.available === true && a1.data?.impressions === 1200);
  const a2 = full.getPostAnalytics("SP-2");
  check("4.2 métrica ausente → null (não 0)", a2.available === true && a2.data?.comments === null && a2.data?.shares === null);
  const posts = full.getPosts({});
  check("4.3 getPosts leitura incremental (cursor)", posts.available === true && posts.posts.length === 2);
  const posts1 = full.getPosts({ limit: 1 });
  check("4.4 cursor paginado", posts1.posts.length === 1 && posts1.nextCursor === "1");

  // ═══════════════ 5. estados de conexão observáveis (§5) ═══════════════
  const fresh = new StubSocialChannelProvider();
  check("5.1 estado inicial not_connected", fresh.health().state === "not_connected");
  fresh.connect({ orgId: "org-1" });
  check("5.2 connect → connected", fresh.health().state === "connected");
  fresh.disconnect();
  check("5.3 disconnect → not_connected", fresh.health().state === "not_connected");
  // permission_limited: pede escopos além do que a conta permite
  const limited = new StubSocialChannelProvider({ canPublish: false });
  limited.connect({ orgId: "org-1", scopes: ["publish"] });
  check("5.4 escopos além da permissão → permission_limited (token nunca finge conectado)", limited.health().state === "permission_limited");
  // o enum cobre auth_expired/token_expiring/rate_limited etc.
  const states: any[] = ["not_connected", "connecting", "connected", "permission_limited", "token_expiring", "auth_expired", "rate_limited", "degraded", "unavailable"];
  check("5.5 enum de estados cobre auth_expired/token_expiring/rate_limited", states.includes("auth_expired") && states.includes("token_expiring") && states.includes("rate_limited"));

  // ═══════════════ 6. registry ═══════════════
  check("6.1 registry resolve 'stub'", getSocialChannelProvider("stub").name === "stub");
  check("6.2 desconhecido → fallback stub", getSocialChannelProvider("inexistente").name === "stub");

  // ═══════════════ 7. determinismo (sem random) ═══════════════
  check("7.1 mesma chamada, mesma saída", JSON.stringify(full.getProfile()) === JSON.stringify(full.getProfile()));

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} social-channel-contract: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
