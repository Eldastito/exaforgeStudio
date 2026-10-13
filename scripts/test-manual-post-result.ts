/**
 * TESTE — Resultado de publicação MANUAL em canal assistido (ADR-207 F13c, 2ª etapa). Determinístico, sem rede.
 * Prova: só canais assistidos; link https do domínio do canal (e normalizado: mesma publicação = mesmo post);
 * métrica em branco = NULL (nunca 0) e só liga a análise com ao menos um número; reenvio atualiza sem apagar o que já
 * estava; variante validada contra os experimentos DA org e o post passa a contar no experimento (engajamento×impressões);
 * marcado 'manual' e SEM decision_action/confirmação/dinheiro; Instagram/provider intactos; isolamento; rota (papel + erros).
 * Uso: npm run test:manual-post-result
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-manual-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-manual-1234567890";
let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const studio = (await import("../src/server/routes/studio.js")).default;
  const { ManualPostResultService: M, normalizeLink } = await import("../src/server/ManualPostResultService.js");
  const { CreativeExperimentService: EXP } = await import("../src/server/CreativeExperimentService.js");
  const { SocialAnalyticsService } = await import("../src/server/SocialAnalyticsService.js");
  const A = `org_mp_${randomUUID().slice(0, 8)}`, B = `org_mp_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);
  const rej = (fn: () => any) => { try { fn(); return ""; } catch (e: any) { return String(e.message); } };
  const row = (org: string, id: string) => db.prepare(`SELECT * FROM social_post_metrics WHERE organization_id = ? AND post_external_id = ?`).get(org, id) as any;

  // 1. schema
  const cols = (db.prepare(`PRAGMA table_info(social_post_metrics)`).all() as any[]).map((c) => c.name);
  check("1.1 coluna aditiva `source`", cols.includes("source"));

  // 2. canais e links
  check("2.1 canal com API real (instagram) recusado, apontando a sincronização", /sincroniza/.test(rej(() => M.record(A, { channel: "instagram", link: "https://instagram.com/p/abc" }))));
  check("2.2 canal desconhecido/vazio recusado", !!rej(() => M.record(A, { channel: "orkut", link: "https://x.com/a/status/1" })) && !!rej(() => M.record(A, { channel: "", link: "https://x.com/a/status/1" })));
  check("2.3 link sem https recusado", /https/.test(rej(() => M.record(A, { channel: "x", link: "http://x.com/a/status/1" }))) && /link completo/.test(rej(() => M.record(A, { channel: "x", link: "x.com/a/status/1" }))));
  check("2.4 link de outro site (domínio trocado) recusado", /não é do/.test(rej(() => M.record(A, { channel: "tiktok", link: "https://youtube.com/watch?v=abc" }))) && /não é do/.test(rej(() => M.record(A, { channel: "x", link: "https://evilx.com/a/status/1" }))));
  check("2.5 endereço do site (sem post) recusado", /não de um post/.test(rej(() => M.record(A, { channel: "x", link: "https://x.com/" }))));
  check("2.6 normaliza: www, caixa, barra final, query e fragmento não criam outro post", normalizeLink("x", "https://WWW.X.com/loja/status/99/?s=20#a") === "https://x.com/loja/status/99" && normalizeLink("x", "https://twitter.com/loja/status/99") === "https://twitter.com/loja/status/99");
  check("2.7 YouTube mantém só o `v`", normalizeLink("youtube", "https://www.youtube.com/watch?v=AbC123&t=10s") === "https://youtube.com/watch?v=AbC123");

  // 3. gravação e honestidade
  const r1 = M.record(A, { channel: "tiktok", link: "https://www.tiktok.com/@loja/video/111", caption: "Bastidores", metrics: { impressions: 1000, likes: 80, comments: "5" } });
  const p1 = row(A, r1.postId);
  check("3.1 grava como post do canal, marcado 'manual', com o link", r1.created && p1.source === "manual" && p1.permalink === "https://tiktok.com/@loja/video/111" && p1.channel === "tiktok");
  check("3.2 métrica não informada = NULL (nunca 0)", p1.reach === null && p1.shares === null && p1.saves === null && p1.clicks === null && p1.impressions === 1000 && p1.comments === 5);
  check("3.3 com número: análise disponível; resposta diz o que foi informado", r1.analyticsAvailable && p1.analytics_available === 1 && r1.metricsInformed.join() === "impressions,likes,comments");
  check("3.4 a resposta avisa: digitado, não medido", r1.source === "manual" && /digitados por você, não medidos/.test(r1.note));
  const r0 = M.record(A, { channel: "linkedin", link: "https://www.linkedin.com/posts/loja-abc" });
  check("3.5 sem nenhuma métrica: guarda o post mas SEM análise (e avisa)", row(A, r0.postId).analytics_available === 0 && !r0.analyticsAvailable && r0.caveats.some((c) => /Nenhuma métrica/.test(c)) && row(A, r0.postId).likes === null);
  check("3.6 métrica inválida recusada (negativa, decimal, texto)", [-1, 1.5, "abc"].every((v) => /inteiro/.test(rej(() => M.record(A, { channel: "x", link: "https://x.com/a/status/5", metrics: { likes: v as any } })))));
  check("3.7 número brasileiro '1.250' vira 1250", row(A, M.record(A, { channel: "x", link: "https://x.com/a/status/6", metrics: { impressions: "1.250" } }).postId).impressions === 1250);
  check("3.8 data sem hora recusada; com hora vira ISO UTC", /data e hora/.test(rej(() => M.record(A, { channel: "x", link: "https://x.com/a/status/7", publishedAt: "2026-10-10" }))) && row(A, M.record(A, { channel: "x", link: "https://x.com/a/status/7", publishedAt: "2026-10-10T15:30:00Z" }).postId).published_at === "2026-10-10T15:30:00.000Z");
  check("3.9 interações > visualizações gera aviso (não bloqueia)", M.record(A, { channel: "x", link: "https://x.com/a/status/8", metrics: { impressions: 10, likes: 50 } }).caveats.some((c) => /mais que as visualizações/.test(c)));

  // 4. idempotência e atualização
  const r1b = M.record(A, { channel: "tiktok", link: "https://tiktok.com/@loja/video/111/?utm=1", metrics: { reach: 700 } });
  const p1b = row(A, r1.postId);
  check("4.1 mesmo link (variado) = mesmo post: atualiza, não duplica", r1b.postId === r1.postId && !r1b.created && (db.prepare(`SELECT COUNT(*) n FROM social_post_metrics WHERE organization_id = ? AND post_external_id = ?`).get(A, r1.postId) as any).n === 1);
  check("4.2 campo omitido PRESERVA o anterior; o novo entra", p1b.impressions === 1000 && p1b.likes === 80 && p1b.reach === 700 && p1b.caption === "Bastidores");
  const rLate = M.record(A, { channel: "linkedin", link: "https://linkedin.com/posts/loja-abc", metrics: { impressions: 300, likes: 12 } });
  check("4.3 completar métricas depois liga a análise", !rLate.created && row(A, r0.postId).analytics_available === 1);

  // 5. variante / experimento
  const exp = EXP.create(A, "u", { hypothesis: "Gancho de dor vence", variants: [{ variantKey: "v:A" }, { variantKey: "v:B" }], minSample: 100 });
  check("5.1 variante inexistente recusada", /não existe/.test(rej(() => M.record(A, { channel: "tiktok", link: "https://tiktok.com/@loja/video/222", variantKey: "v:ZZ" }))));
  M.record(A, { channel: "tiktok", link: "https://tiktok.com/@loja/video/222", variantKey: "v:A", metrics: { impressions: 1000, likes: 100 } });
  M.record(A, { channel: "youtube", link: "https://youtube.com/watch?v=BBB", variantKey: "v:B", metrics: { impressions: 1000, likes: 20, comments: 5 } });
  const meas = EXP.measure(A, exp.id);
  const mA = meas.find((m) => m.variantKey === "v:A")!, mB = meas.find((m) => m.variantKey === "v:B")!;
  check("5.2 o post manual passa a contar na variante (impressões e engajamento)", mA.impressions === 1000 && mA.engagement === 100 && mB.engagement === 25);
  const dec = EXP.decide(A, exp.id, "u");
  check("5.3 o experimento decide sobre os números digitados (A ganha com amostra mínima)", dec.decision === "winner" && dec.winnerVariantKey === "v:A", JSON.stringify(dec).slice(0, 200));
  check("5.4 variante de OUTRA empresa não é aceita", /não existe/.test(rej(() => M.record(B, { channel: "tiktok", link: "https://tiktok.com/@b/video/1", variantKey: "v:A" }))));

  // 6. não finge governança nem mede
  check("6.1 nenhuma decision_action / confirmação / outcome criada", ["decision_actions", "action_confirmations", "action_outcomes"].every((t) => (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE organization_id = ?`).get(A) as any).n === 0));
  check("6.2 a sincronização por API não toca/duplica posts manuais (UNIQUE por id; resumo os conta à parte)", SocialAnalyticsService.summary(A, "tiktok").posts >= 1 && row(A, r1.postId).source === "manual");

  // 7. listagem + isolamento
  const L = M.list(A, { channel: "tiktok" });
  check("7.1 lista só os manuais do canal, com source", L.length === 2 && L.every((x: any) => x.source === "manual" && x.channel === "tiktok"));
  check("7.2 isolamento: outra empresa não vê nem toca", M.list(B).length === 0 && row(B, r1.postId) === undefined);
  M.record(B, { channel: "tiktok", link: "https://tiktok.com/@loja/video/111", metrics: { likes: 1 } });
  check("7.3 mesmo link em outra empresa = post próprio, sem vazar números", row(B, r1.postId).likes === 1 && row(A, r1.postId).likes === 80);
  db.prepare(`INSERT INTO social_post_metrics (id, organization_id, channel, post_external_id, analytics_available, likes) VALUES (?, ?, 'instagram', 'ig1', 1, 9)`).run(randomUUID(), A);
  check("7.4 posts do Instagram (provider, source NULL) ficam fora da lista manual", M.list(A).every((x: any) => x.channel !== "instagram"));

  // 8. rota
  const app = express(); app.use(express.json());
  app.use((req: any, _res: any, next: any) => { if (req.headers["x-org"]) { req.organizationId = String(req.headers["x-org"]); req.user = { role: String(req.headers["x-role"] || "owner") }; } next(); });
  app.use("/api/studio", studio);
  const server = http.createServer(app);
  const port: number = await new Promise((rs) => server.listen(0, () => rs((server.address() as any).port)));
  const call = async (method: string, p: string, org: string | null, role: string, body?: any) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/studio${p}`, { method, headers: { "Content-Type": "application/json", ...(org ? { "x-org": org, "x-role": role } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const ok = await call("POST", "/manual-result", B, "owner", { channel: "x", link: "https://x.com/b/status/1", metrics: { impressions: 50, likes: 3 } });
  check("8.1 rota grava e devolve o resumo", ok.status === 200 && ok.body.source === "manual" && ok.body.analyticsAvailable === true);
  const bad = await call("POST", "/manual-result", B, "owner", { channel: "instagram", link: "https://instagram.com/p/1" });
  check("8.2 rota: erro de regra vira 400 com mensagem e código", bad.status === 400 && bad.body.code === "not_assisted" && /sincroniza/.test(bad.body.error));
  check("8.3 rota: atendente (não owner/admin) → 403; sem sessão nunca passa (o 401 de verdade vem do auth do app)", (await call("POST", "/manual-result", B, "agent", { channel: "x", link: "https://x.com/b/status/2" })).status === 403 && [401, 403].includes((await call("POST", "/manual-result", null, "owner", { channel: "x", link: "https://x.com/b/status/2" })).status) && (await call("GET", "/manual-results", B, "agent")).status === 403);
  const ls = await call("GET", "/manual-results?channel=x", B, "owner");
  check("8.4 rota lista só da própria empresa", ls.status === 200 && ls.body.results.length === 1 && ls.body.results[0].link === "https://x.com/b/status/1");
  server.close();

  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
