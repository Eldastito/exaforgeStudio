/**
 * TESTE — ADR-204 D4c: link público de consentimento do cliente do PDV.
 * Prova: só o HASH do token é guardado · 1 link ativo por cliente (novo revoga o anterior) · cliente inexistente/inativo/sem celular não gera link ·
 * a página pública mostra o MÍNIMO (1º nome + final do celular, sem CPF/e-mail/celular completo) · decisão grava no MESMO livro (origem `link`) ·
 * revogar vence e dá pra mudar de ideia · expirado→410/revogado→404 sem gravar · bad_request não grava · isolamento · rotas públicas + operador (owner/admin, escopo) · UI.
 * Uso: npm run test:pdv-consent-link
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http";
import { randomUUID, createHash } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pcl-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pcl-1234567890"; process.env.APP_URL = "https://app.example.com";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PdvConsentLinkService: L } = await import("../src/server/PdvConsentLinkService.js");
  const { PdvConsentService: P } = await import("../src/server/PdvConsentService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");
  const mkOrg = (name: string) => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), id, name); PM.seedSystemProfiles(id); return id; };
  const O = mkOrg("Loja Toulon"), Q = mkOrg("Outra");
  const cust = (org: string, code: string, nome: string, celular: string | null, inativo = 0) => db.prepare("INSERT INTO retail_pdv_customers (id, organization_id, codigo_n, nome, celular, email, cpf, filial, inativo) VALUES (?,?,?,?,?,?,?,?,?)").run(randomUUID(), org, code, nome, celular, "ana@x.com", "12345678900", "01", inativo);
  cust(O, "100", "Ana Maria Souza", "(21) 99876-5432"); cust(O, "102", "Sem Fone", null); cust(O, "103", "Inativo", "(21) 90000-0003", 1);
  const bad = (f: () => any) => { try { f(); return false; } catch { return true; } };

  check("não gera link pra cliente inexistente / sem celular / inativo", bad(() => L.create(O, "999", "u")) && bad(() => L.create(O, "102", "u")) && bad(() => L.create(O, "103", "u")));
  check("outra org não gera link pro código alheio", bad(() => L.create(Q, "100", "u")));

  const t1 = L.create(O, "100", "u1");
  const row = db.prepare("SELECT token_hash FROM retail_pdv_consent_links WHERE organization_id = ?").get(O) as any;
  check("token 64 hex; no banco só o HASH (nunca o token cru)", /^[0-9a-f]{64}$/.test(t1.token) && row.token_hash === createHash("sha256").update(t1.token).digest("hex") && row.token_hash !== t1.token);
  check("path /consentimento/<token> e activeFor", t1.path === `/consentimento/${t1.token}` && L.activeFor(O, "100").active);

  const v = L.view(t1.token) as any;
  check("a página mostra só o mínimo: empresa, 1º nome, final do celular", v.ok && v.businessName === "Loja Toulon" && v.firstName === "Ana" && v.phoneTail === "5432" && v.state === "unknown");
  const js = JSON.stringify(v);
  check("sem CPF, e-mail, sobrenome nem celular completo", !/12345678900|ana@x|Souza|99876/.test(js));

  check("decisão não-booleana → bad_request e NÃO grava", (L.decide(t1.token, "sim") as any).reason === "bad_request" && P.status(O, "100").state === "unknown");
  check("token inventado → invalid", (L.decide("a".repeat(64), true) as any).reason === "invalid" && (L.view("zzz") as any).reason === "invalid");
  const d1 = L.decide(t1.token, true) as any;
  check("Autorizo → granted no MESMO livro, origem `link`", d1.ok && P.status(O, "100").state === "granted" && P.status(O, "100").source === "link" && P.assertContactable(O, "100").allowed);
  const d2 = L.decide(t1.token, false) as any;
  check("pode mudar de ideia: Não autorizo → revoked (revogar vence)", d2.ok && P.status(O, "100").state === "revoked" && P.history(O, "100").length === 2);
  check("a página reabre refletindo a escolha atual", (L.view(t1.token) as any).state === "revoked");

  const t2 = L.create(O, "100", "u1");
  check("novo link revoga o anterior (1 ativo)", (L.view(t1.token) as any).reason === "invalid" && (L.view(t2.token) as any).ok === true && (db.prepare("SELECT COUNT(*) c FROM retail_pdv_consent_links WHERE organization_id = ? AND revoked_at IS NULL").get(O) as any).c === 1);
  const before = P.history(O, "100").length;
  check("link revogado não grava", (L.decide(t1.token, true) as any).ok === false && P.history(O, "100").length === before);

  const exp = L.create(O, "100", "u1", { ttlDays: 1, now: Date.now() - 3 * 86400000 });
  check("expirado → 'expired', não grava", (L.view(exp.token) as any).reason === "expired" && (L.decide(exp.token, true) as any).reason === "expired" && P.history(O, "100").length === before);
  check("revoke do operador invalida o link", (() => { const t = L.create(O, "100", "u1"); const r = L.revoke(O, "100", "u1"); return r.revoked === 1 && (L.view(t.token) as any).reason === "invalid"; })());
  check("TTL é limitado (1..60 dias)", (() => { const t = L.create(O, "100", "u1", { ttlDays: 9999 }); return Date.parse(t.expiresAt) - Date.now() <= 61 * 86400000; })());

  // rotas
  const { default: pub, resetConsentPublicLimiter, CONSENT_PUBLIC_MAX } = await import("../src/server/routes/consentPublic.js");
  const { default: router } = await import("../src/server/routes/retailops.js");
  const express = (await import("express")).default;
  const mkU = (org: string, role: string, key: string) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'U', ?, ?, 'active')`).run(id, org, `${id}@t.local`, role); const pid = (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id; return { userId: id, id, role, role_profile_id: pid }; };
  const who: any = { dono: mkU(O, "owner", "owner"), vend: mkU(O, "agent", "vendedor") };
  const app = express(); app.use(express.json());
  app.use("/api/public/consent", pub);
  app.use((req: any, _res, next) => { req.organizationId = O; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/retailops", router);
  const server = http.createServer(app); await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const call = async (m: string, u: string, user?: string, body?: any) => { const r = await fetch(`http://127.0.0.1:${port}${u}`, { method: m, headers: { "Content-Type": "application/json", ...(user ? { "x-user": user } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, headers: r.headers, body: await r.json().catch(() => ({})) as any }; };

  const gen = await call("POST", "/api/retailops/pdv-consent/100/link", "dono");
  check("operador (dono) gera link: 201 + url absoluta + QR + expira", gen.status === 201 && gen.body.url?.startsWith("https://app.example.com/consentimento/") && /^data:image\/png/.test(gen.body.qrDataUrl || "") && !!gen.body.expiresAt);
  check("vendedor não gera link (403)", (await call("POST", "/api/retailops/pdv-consent/100/link", "vend")).status === 403);
  check("cliente sem celular → 400", (await call("POST", "/api/retailops/pdv-consent/102/link", "dono")).status === 400);
  const tok = gen.body.path.split("/").pop();
  const g = await call("GET", `/api/public/consent/${tok}`);
  check("GET público: 200, no-store, só o mínimo", g.status === 200 && g.headers.get("cache-control") === "no-store" && g.body.firstName === "Ana" && !JSON.stringify(g.body).includes("12345678900"));
  const pd = await call("POST", `/api/public/consent/${tok}/decision`, undefined, { granted: true });
  check("POST público decide (sem login): 200 granted", pd.status === 200 && pd.body.state === "granted" && P.status(O, "100").source === "link");
  check("POST sem booleano → 400", (await call("POST", `/api/public/consent/${tok}/decision`, undefined, { granted: "sim" })).status === 400);
  check("link desconhecido → 404; vencido → 410", (await call("GET", `/api/public/consent/${"b".repeat(64)}`)).status === 404 && (await call("GET", `/api/public/consent/${exp.token}`)).status === 404);
  const exp2 = L.create(O, "100", "u", { ttlDays: 1, now: Date.now() - 3 * 86400000 });
  check("vencido de verdade → 410", (await call("GET", `/api/public/consent/${exp2.token}`)).status === 410);
  const del = await call("DELETE", "/api/retailops/pdv-consent/100/link", "dono");
  check("operador revoga o link → público 404", del.status === 200 && (await call("GET", `/api/public/consent/${tok}`)).status === 404);
  resetConsentPublicLimiter();
  let last = 200; for (let i = 0; i < CONSENT_PUBLIC_MAX + 2; i++) last = (await call("GET", `/api/public/consent/${"c".repeat(64)}`)).status;
  check("rate limit por IP → 429", last === 429);
  server.close();

  // UI / fiação
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
  const page = read("src/clinic-public/ConsentPage.tsx"), main = read("src/main.tsx"), ro = read("src/features/RetailOpsView.tsx"), srv = read("server.ts");
  check("página: dois botões iguais, sem pré-seleção, revogação explicada", /Autorizo/.test(page) && /Não autorizo/.test(page) && /revogar quando quiser/.test(page) && !/defaultChecked|checked=\{true\}/.test(page));
  check("main.tsx monta /consentimento/ e o fetch público não injeta token de staff", /isConsentPage/.test(main) && /\/consentimento\//.test(main) && /!input\.startsWith\('\/api\/public\/'\)/.test(main));
  check("server.ts monta a rota pública", /\/api\/public\/consent/.test(srv));
  check("operador: botão Link + aviso de que o sistema NÃO envia", /pdv-consent-link-btn/.test(ro) && /NÃO envia este link/.test(ro));
  check("origem `link` entre as origens válidas", (P as any) && bad(() => P.record(O, "100", { granted: true, source: "link" } as any)) === false);

  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  → " + x.d}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
