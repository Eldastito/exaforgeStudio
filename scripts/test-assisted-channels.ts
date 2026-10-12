/**
 * TESTE — Canais sem API (TikTok/LinkedIn/YouTube/X): publicação ASSISTIDA (ADR-207 F13c). Determinístico, sem rede.
 * Prova: provider com ZERO capacidades que degrada pra manual_required e nunca finge (leituras indisponíveis, não zero);
 * Hub roteia opt-in (default segue como antes) e health honesto (not_connected); pacote por canal adaptado às normas
 * (limite de legenda/hashtags), passos + site, plano de vídeo só em formato de vídeo, marca respeitada (termo proibido
 * recusa), canal com API real / desconhecido em skipped, nada publicado; rota.
 * Uso: npm run test:assisted-channels
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-assist-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-assist-1234567890";
let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const studio = (await import("../src/server/routes/studio.js")).default;
  const { AssistedChannelProvider, ASSISTED_CHANNELS } = await import("../src/server/AssistedChannelProvider.js");
  const { PublishPackageService: P } = await import("../src/server/PublishPackageService.js");
  const { SocialConnectionService: SC } = await import("../src/server/SocialConnectionService.js");
  const { deriveCapabilityFlags } = await import("../src/server/SocialChannelProvider.js");
  const { BrandDnaService } = await import("../src/server/BrandDnaService.js");
  const A = `org_as_${randomUUID().slice(0, 8)}`, B = `org_as_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);
  const rej = async (fn: () => Promise<any>) => { try { await fn(); return ""; } catch (e: any) { return String(e.message); } };

  // 1. provider
  const x = new AssistedChannelProvider("x");
  check("1.1 quatro canais assistidos", ASSISTED_CHANNELS.join() === "tiktok,linkedin,youtube,x");
  check("1.2 zero capacidades (descoberta, não presumida)", x.capabilities.length === 0 && !Object.values(deriveCapabilityFlags(x.capabilities)).some(Boolean));
  check("1.3 publish e schedule degradam pra manual_required, nunca 'published'", x.publish({ kind: "text", idempotencyKey: "k" }).status === "manual_required" && x.schedule({ kind: "text", idempotencyKey: "k", scheduledAt: "2026-01-01T00:00:00Z" }).status === "manual_required");
  check("1.4 leituras indisponíveis (analytics ausente ≠ zero)", [x.getProfile(), x.getPostAnalytics("1"), x.getAudienceAnalytics(), x.getAds()].every((r: any) => r.available === false && r.data === null) && x.getPosts({}).available === false && x.getPosts({}).posts.length === 0);
  check("1.5 health honesto: not_connected, sem permissões", x.health().state === "not_connected" && (x.health().permissions || []).length === 0);

  // 2. Hub
  SC.setConfig(A, "tiktok", {}, { provider: "assisted", enabled: true });
  const pr = SC.providerFor(A, "tiktok");
  check("2.1 Hub roteia provider=assisted pro provider assistido", pr.name === "assisted:tiktok" && pr.capabilities.length === 0);
  check("2.2 sem opt-in (outra empresa) segue o comportamento anterior", SC.providerFor(B, "tiktok").name === "stub");
  check("2.3 'assisted' num canal com API real (instagram) NÃO é aceito", SC.providerFor((SC.setConfig(A, "instagram", {}, { provider: "assisted", enabled: true }), A), "instagram").name !== "assisted:instagram");
  const st = await SC.refreshHealth(A, "tiktok");
  check("2.4 passe de saúde persiste not_connected (nunca 'connected')", st.state === "not_connected");

  // 3. pacote
  const caption = "Camisa de linho nova na loja, perfeita para o verão. Confira as cores e tamanhos disponíveis e venha conhecer a coleção completa com a nossa equipe, que atende todos os dias da semana.".repeat(2);
  const pkg = await P.build(A, { caption, hashtags: ["#moda", "#linho", "#verao", "#look", "#estilo", "#nova", "#loja"], channels: ["x", "tiktok", "linkedin", "youtube"] });
  check("3.1 um pacote por canal, todos 'manual_required' e 'assisted'", pkg.packages.length === 4 && pkg.packages.every((p) => p.publishStatus === "manual_required" && p.mode === "assisted"));
  const px = pkg.packages.find((p) => p.channel === "x")!, pt = pkg.packages.find((p) => p.channel === "tiktok")!;
  check("3.2 legenda respeita o limite do canal (X 280, TikTok 150)", px.content.caption.length <= 280 && pt.content.caption.length <= 150 && px.changes.length > 0);
  check("3.3 hashtags dentro da faixa do canal (X ≤2, TikTok ≤5)", px.content.hashtags.length <= 2 && pt.content.hashtags.length <= 5);
  check("3.4 passos e site pra publicar, por canal", pkg.packages.every((p) => p.steps.length >= 3 && /^https:\/\//.test(p.openUrl)) && /x\.com/.test(px.openUrl));
  check("3.5 sem 'topic' não há plano de vídeo", pkg.packages.every((p) => p.videoPlan === undefined));
  const vid = await P.build(A, { caption: "Bastidores do ateliê", channels: ["tiktok", "linkedin"], topic: "bastidores do ateliê", format: "reels", objectiveId: "engajamento" });
  check("3.6 com topic e formato de vídeo: plano de edição anexado (TikTok); LinkedIn (post) não", !!(vid.packages.find((p) => p.channel === "tiktok")!.videoPlan as any)?.steps?.length && vid.packages.find((p) => p.channel === "linkedin")!.videoPlan === undefined);
  const mix = await P.build(A, { caption: "Oi", channels: ["instagram", "orkut", "x"] });
  check("3.7 canal com API real e canal desconhecido vão pra skipped", mix.packages.length === 1 && mix.skipped.length === 2 && mix.skipped.find((s) => s.channel === "instagram")!.reason.includes("governada"));
  check("3.8 não publica nem grava nada (sem decision_action/scheduled_post novos)", (db.prepare("SELECT COUNT(*) n FROM decision_actions WHERE organization_id = ?").get(A) as any).n === 0 && (db.prepare("SELECT COUNT(*) n FROM scheduled_posts WHERE organization_id = ?").get(A) as any).n === 0);
  check("3.9 nota deixa claro que não mede resultado", /não mede o resultado/.test(pkg.note));
  check("3.10 sem legenda / sem canal recusa", /legenda/.test(await rej(() => P.build(A, { caption: " ", channels: ["x"] }))) && /canal/.test(await rej(() => P.build(A, { caption: "Oi", channels: [] }))));

  // 4. marca
  await BrandDnaService.save(A, "u", { forbidden: ["barato"] });
  check("4.1 termo proibido pela marca recusa (não reescreve)", /não usa/.test(await rej(() => P.build(A, { caption: "Tudo barato e bom", channels: ["x"] }))) && /não usa/.test(await rej(() => P.build(A, { caption: "Oi", hashtags: ["#barato"], channels: ["x"] }))));
  check("4.2 isolamento: a marca de outra empresa não vaza", (await P.build(B, { caption: "Tudo barato e bom", channels: ["x"] })).packages.length === 1);

  // 5. rota
  const app = express(); app.use(express.json());
  app.use((req: any, _res: any, next: any) => { if (req.headers["x-org"]) req.organizationId = String(req.headers["x-org"]); next(); });
  app.use("/api/studio", studio);
  const server = http.createServer(app);
  const port: number = await new Promise((rs) => server.listen(0, () => rs((server.address() as any).port)));
  const call = async (org: string | null, body: any) => { const r = await fetch(`http://127.0.0.1:${port}/api/studio/publish-package`, { method: "POST", headers: { "Content-Type": "application/json", ...(org ? { "x-org": org } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const r1 = await call(B, { caption: "Olá mundo", channels: ["youtube"] });
  check("5.1 rota devolve o pacote", r1.status === 200 && r1.body.packages?.[0]?.channel === "youtube");
  check("5.2 rota: 400 sem legenda, 400 com termo proibido, 401 sem login", (await call(B, { channels: ["x"] })).status === 400 && (await call(A, { caption: "barato demais", channels: ["x"] })).status === 400 && (await call(null, { caption: "x", channels: ["x"] })).status === 401);
  server.close();

  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
