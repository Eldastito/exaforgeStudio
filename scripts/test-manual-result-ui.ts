/**
 * TESTE — Tela "Registrar resultado" (ADR-207 F13c, 2ª etapa): regras PURAS da tela (`manualResultLabels`) contra as respostas
 * REAIS do servidor (rotas Express reais: /api/studio/manual-result(s) e /api/social/experiments) + fiação do componente.
 * Não vejo a tela num navegador: o que se prova é a lógica (o que é enviado, em branco ≠ zero, como a resposta vira texto) e que
 * a tela só chama rotas que existem, não cria item de menu e carrega só ao abrir.
 * Uso: npm run test:manual-result-ui
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http"; import { fileURLToPath } from "url"; import { randomUUID } from "crypto";
import express from "express";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mrui-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mrui-1234567890";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

async function main() {
  const L = await import("../src/features/manualresult/manualResultLabels.js");
  const db = (await import("../src/server/db.js")).default;
  const studio = (await import("../src/server/routes/studio.js")).default;
  const social = (await import("../src/server/routes/social.js")).default;
  const { CreativeExperimentService: EXP } = await import("../src/server/CreativeExperimentService.js");
  const A = `org_mr_${randomUUID().slice(0, 8)}`, B = `org_mr_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);
  const form = (p: Partial<import("../src/features/manualresult/manualResultLabels.js").Form> = {}) => ({ ...L.emptyForm(), ...p });

  // ── 1. montar o corpo ──
  check("1.1 só os 4 canais assistidos, com nome pra pessoa", L.CHANNELS.map((c) => c.channel).join() === "tiktok,linkedin,youtube,x" && L.channelLabel("x") === "X" && L.channelLabel("tiktok") === "TikTok" && L.channelLabel("zzz") === "zzz");
  const e1 = L.buildBody(form()), e2 = L.buildBody(form({ channel: "x" })), e3 = L.buildBody(form({ channel: "x", link: "x.com/a/status/1" })), e4 = L.buildBody(form({ channel: "instagram", link: "https://instagram.com/p/1" }));
  check("1.2 sem rede / sem link / link sem https / rede de API real: avisa cedo, em português", !e1.ok && /rede/.test((e1 as any).error) && !e2.ok && /link/.test((e2 as any).error) && !e3.ok && /https/.test((e3 as any).error) && !e4.ok);
  const ok1: any = L.buildBody(form({ channel: "tiktok", link: " https://tiktok.com/@a/video/1 ", metrics: { impressions: "1.250", likes: "80", comments: "", reach: "  " } }));
  check("1.3 em branco é OMITIDO (não vira 0); link é aparado; números vão como o cliente digitou", ok1.ok && ok1.hasMetrics && ok1.body.link === "https://tiktok.com/@a/video/1" && JSON.stringify(ok1.body.metrics) === JSON.stringify({ impressions: "1.250", likes: "80" }) && !("comments" in ok1.body.metrics) && !("reach" in ok1.body.metrics));
  check("1.4 sem número nenhum: vale (post guardado sem análise) e diz que não tem métrica", (L.buildBody(form({ channel: "x", link: "https://x.com/a/status/1" })) as any).hasMetrics === false);
  check("1.5 número inválido (decimal, texto, negativo) é recusado citando o campo", ["1,5", "abc", "-3"].every((v) => { const r: any = L.buildBody(form({ channel: "x", link: "https://x.com/a/status/1", metrics: { likes: v } })); return !r.ok && /Curtidas/.test(r.error); }));
  const ok2: any = L.buildBody(form({ channel: "x", link: "https://x.com/a/status/1", publishedAt: "2026-10-10T15:30", variantKey: "v:A" }));
  check("1.6 data+hora vira ISO UTC; variante segue; data inválida recusada", ok2.ok && /^2026-10-10T\d\d:30:00\.000Z$/.test(ok2.body.publishedAt) && ok2.body.variantKey === "v:A" && !(L.buildBody(form({ channel: "x", link: "https://x.com/a/status/1", publishedAt: "lixo" })) as any).ok);
  check("1.7 sem data e sem variante: não manda esses campos", (() => { const r: any = L.buildBody(form({ channel: "x", link: "https://x.com/a/status/1" })); return !("publishedAt" in r.body) && !("variantKey" in r.body); })());

  // ── 2. textos ──
  check("2.1 erro: 403 explica o papel; 401 sessão; 400 usa a mensagem do servidor; resto genérico", /dono ou um administrador/.test(L.errorText(403, {})) && /sessão/.test(L.errorText(401, {})) && L.errorText(400, { error: "Esse link não é do TikTok." }) === "Esse link não é do TikTok." && /Tente de novo/.test(L.errorText(500, {})) && L.errorText(400, {}).length > 10);
  check("2.2 números em pt-BR; ausente/NaN vira '—' (nunca 0)", L.fmtNum(1250) === "1.250" && L.fmtNum(0) === "0" && L.fmtNum(null) === "—" && L.fmtNum(undefined) === "—" && L.fmtNum(NaN) === "—");
  check("2.3 linha de números: só o que existe; zero informado aparece; nada informado diz isso", L.metricsLine({ impressions: 1000, likes: 0, reach: null }) === "1.000 visualizações · 0 curtidas" && L.metricsLine({ impressions: null }) === "sem números ainda");
  check("2.4 link curto: host sem www + começo do caminho; lixo não quebra", L.shortLink("https://www.tiktok.com/@loja/video/12345678901234567890") === "tiktok.com/@loja/video/12345678901…" && L.shortLink("https://x.com/") === "x.com" && L.shortLink("zzz") === "zzz");
  check("2.5 variantes do experimento: usa label quando há; ignora lixo", JSON.stringify(L.variantOptions({ variants: [{ variantKey: "v:A", label: "Dor" }, { variantKey: "v:B" }, {}] })) === JSON.stringify([{ key: "v:A", label: "Dor (v:A)" }, { key: "v:B", label: "v:B" }]) && L.variantOptions(null).length === 0);

  // ── 3. contra o servidor REAL ──
  const app = express(); app.use(express.json());
  app.use((req: any, _res: any, next: any) => { if (req.headers["x-org"]) { req.organizationId = String(req.headers["x-org"]); req.user = { role: String(req.headers["x-role"] || "owner"), userId: "u1" }; } next(); });
  app.use("/api/studio", studio); app.use("/api/social", social);
  const server = http.createServer(app);
  const port: number = await new Promise((rs) => server.listen(0, () => rs((server.address() as any).port)));
  const call = async (org: string | null, method: string, p: string, body?: any, role = "owner") => {
    const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method, headers: { "Content-Type": "application/json", ...(org ? { "x-org": org, "x-role": role } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const exp = EXP.create(A, "u", { hypothesis: "Gancho de dor vence", variants: [{ variantKey: "v:A", label: "Dor" }, { variantKey: "v:B" }] });

  const sent = L.buildBody(form({ channel: "tiktok", link: "https://www.tiktok.com/@loja/video/1?x=1", metrics: { impressions: "1.250", likes: "80" }, variantKey: "v:A" })) as any;
  const r1 = await call(A, "POST", "/studio/manual-result", sent.body);
  check("3.1 o corpo que a tela monta é aceito pelo servidor real (número '1.250' vira 1250)", r1.status === 200 && r1.body.created === true && r1.body.analyticsAvailable === true && r1.body.variantKey === "v:A");
  const list = (await call(A, "GET", "/studio/manual-results?limit=10")).body.results;
  check("3.2 a lista traz o que a tela mostra (rede, link, números, variante) e metricsLine bate", list.length === 1 && list[0].channel === "tiktok" && list[0].impressions === 1250 && list[0].variantKey === "v:A" && L.metricsLine(list[0]) === "1.250 visualizações · 80 curtidas" && L.shortLink(list[0].link) === "tiktok.com/@loja/video/1");
  const lines = L.resultLines(r1.body);
  check("3.3 depois de salvar: diz que registrou, que em branco não vira zero, que entra no teste A/B e que é digitado (≠ medido)", lines.title === "Resultado registrado." && lines.notes.some((n) => /não viram zero/.test(n)) && lines.notes.some((n) => /teste A\/B/.test(n)) && lines.notes.some((n) => /não medidos/.test(n)));
  const again = await call(A, "POST", "/studio/manual-result", (L.buildBody(form({ channel: "tiktok", link: "https://tiktok.com/@loja/video/1", metrics: { reach: "700" } })) as any).body);
  check("3.4 'Completar' (mesmo link, só um número novo): atualiza, não duplica, preserva os anteriores", again.status === 200 && again.body.created === false && L.resultLines(again.body).title === "Resultado atualizado." && (await call(A, "GET", "/studio/manual-results")).body.results.length === 1 && (await call(A, "GET", "/studio/manual-results")).body.results[0].impressions === 1250);
  const noNum = await call(A, "POST", "/studio/manual-result", (L.buildBody(form({ channel: "linkedin", link: "https://linkedin.com/posts/abc" })) as any).body);
  check("3.5 sem números: servidor guarda sem análise e a tela avisa ('ainda sem números') + o aviso do servidor aparece", noNum.status === 200 && noNum.body.analyticsAvailable === false && L.resultLines(noNum.body).notes[0].includes("ainda sem números") && L.resultLines(noNum.body).warnings.length > 0);
  const wrongHost = await call(A, "POST", "/studio/manual-result", { channel: "tiktok", link: "https://youtube.com/watch?v=1" });
  check("3.6 link de outro site: 400 e a mensagem do servidor chega inteira à tela", wrongHost.status === 400 && L.errorText(wrongHost.status, wrongHost.body) === wrongHost.body.error && /não é do/.test(wrongHost.body.error));
  check("3.7 atendente: 403 com texto de papel; isolamento: outra empresa não vê nada", (await call(B, "POST", "/studio/manual-result", sent.body, "agent")).status === 403 && /dono ou um administrador/.test(L.errorText(403, {})) && (await call(B, "GET", "/studio/manual-results")).body.results.length === 0);

  // ── 4. teste A/B (campo opcional) ──
  const exps = await call(A, "GET", "/social/experiments?status=running");
  check("4.1 a lista de experimentos em andamento traz o que o seletor usa (id + hipótese)", exps.status === 200 && exps.body.experiments.some((x: any) => x.id === exp.id && x.hypothesis === "Gancho de dor vence"));
  const det = await call(A, "GET", `/social/experiments/${exp.id}`);
  check("4.2 o detalhe do experimento alimenta o seletor de versão", det.status === 200 && JSON.stringify(L.variantOptions(det.body)) === JSON.stringify([{ key: "v:A", label: "Dor (v:A)" }, { key: "v:B", label: "v:B" }]));
  check("4.3 atendente não vê experimentos → a tela esconde o campo (lista vazia), sem quebrar", (await call(A, "GET", "/social/experiments?status=running", undefined, "agent")).status === 403);
  check("4.4 empresa sem experimento: lista vazia → campo não aparece", (await call(B, "GET", "/social/experiments?status=running")).body.experiments.length === 0);
  server.close();

  // ── 5. fiação do componente ──
  const panel = read("src/features/ManualResultPanel.tsx"), studioView = read("src/features/StudioView.tsx"), sidebar = read("src/features/Sidebar.tsx");
  const routesUsed = [...panel.matchAll(/apiFetch\(\s*[`']([^`']+)/g)].map((m) => m[1].split("?")[0].replace(/\$\{[^}]+\}/g, ":id"));
  const studioSrc = read("src/server/routes/studio.ts"), socialSrc = read("src/server/routes/social.ts");
  check("5.1 a tela só chama rotas que existem no servidor", routesUsed.length >= 3 && routesUsed.every((r) => (r.startsWith("/api/studio/") && studioSrc.includes(`"${r.replace("/api/studio", "")}"`)) || (r.startsWith("/api/social/experiments") && socialSrc.includes(`router.get("${r.replace("/api/social", "").replace("/:id", "/:id")}"`))), routesUsed.join(" | "));
  check("5.2 carrega só ao abrir (lazy + Suspense) e fecha no X", /const ManualResultPanel = lazy\(/.test(studioView) && /\{manualOpen && \(\s*<Suspense/.test(studioView) && /onClose=\{\(\) => setManualOpen\(false\)\}/.test(studioView));
  check("5.3 SEM menu novo: o ponto de entrada é um link dentro do Estúdio; Sidebar não menciona o painel", /Registrar resultado<\/button>/.test(studioView) && !/ManualResult|manual-result|Registrar resultado/i.test(sidebar));
  check("5.4 não calcula nada na tela: sem soma/média de métricas no componente", !/\.reduce\(|Math\.(round|floor)|\* 100/.test(panel));
  check("5.5 a tela diz que o número é digitado (não medido) e que em branco não vira zero", /\bvocê<\/b> digita/.test(panel) && /em branco não vira zero/.test(panel));
  check("5.6 sem texto de terceiro injetado como HTML", !/dangerouslySetInnerHTML/.test(panel) && /rel="noreferrer noopener"/.test(panel));

  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
