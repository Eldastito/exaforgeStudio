/**
 * TESTE — Atualização de segurança de out/2026: (1) IP do cliente não é mais spoofável por X-Forwarded-For (rate-limit/login
 * público), (2) aviso de Node desatualizado + Dockerfile fixado na versão corrigida, (3) piso das dependências com falha
 * divulgada (multer, sharp, xmldom, express/proxy-addr/body-parser/qs, engine.io, vite…) e dependência morta com 10 avisos
 * removida. Determinístico, sem rede (lê node_modules/Dockerfile locais; Express real só pra provar o limitador).
 * Uso: npm run test:security-update-oct2026
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http"; import { fileURLToPath } from "url";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-secupd-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-secupd-1234567890";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
const cmp = (a: string, b: string) => { const x = a.split(".").map((n) => parseInt(n, 10) || 0), y = b.split(".").map((n) => parseInt(n, 10) || 0); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const walk = (dir: string, out: string[] = []): string[] => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (p.endsWith(".ts")) out.push(p); } return out; };

async function main() {
  const { clientIp, trustedProxyHops, normalizeIp } = await import("../src/server/clientIp.js");
  const { NodeRuntimeSecurityService: N, NODE_MIN_PATCHED } = await import("../src/server/NodeRuntimeSecurityService.js");
  const req = (xff: string | string[] | undefined, sock = "10.0.0.9") => ({ headers: xff === undefined ? {} : { "x-forwarded-for": xff }, socket: { remoteAddress: sock } });

  // ── 1. quantos proxies de confiança ──
  const h = (v?: string) => trustedProxyHops(v === undefined ? {} as any : { TRUSTED_PROXY_HOPS: v } as any);
  check("1.1 padrão = 1 proxy (Coolify/Traefik); '0' liga o modo exposto; número vira o que é", h() === 1 && h("") === 1 && h("0") === 0 && h("2") === 2);
  check("1.2 lixo/negativo/decimal caem no padrão seguro; teto de 5", h("abc") === 1 && h("-1") === 1 && h("1.5") === 1 && h("9") === 5);

  // ── 2. escolha do IP ──
  check("2.1 1 proxy: vale o ÚLTIMO valor (o que o NOSSO proxy anotou), não o primeiro que o cliente mandou", clientIp(req("6.6.6.6, 203.0.113.7"), 1) === "203.0.113.7" && clientIp(req("1.1.1.1, 2.2.2.2, 203.0.113.7"), 1) === "203.0.113.7");
  check("2.2 2 proxies (CDN + proxy): o cliente é o penúltimo", clientIp(req("6.6.6.6, 198.51.100.4, 172.16.0.2"), 2) === "198.51.100.4" && clientIp(req("198.51.100.4, 172.16.0.2"), 2) === "198.51.100.4");
  check("2.3 sem cabeçalho ou lista mais curta que os proxies: usa o endereço da conexão (nunca confia no de fora)", clientIp(req(undefined), 1) === "10.0.0.9" && clientIp(req("203.0.113.7"), 2) === "10.0.0.9" && clientIp(req(""), 1) === "10.0.0.9");
  check("2.4 modo exposto (0): ignora o cabeçalho por completo", clientIp(req("6.6.6.6"), 0) === "10.0.0.9" && clientIp(req("6.6.6.6, 7.7.7.7"), 0) === "10.0.0.9");
  check("2.5 valor que não é IP (texto, XSS, vazio) cai na conexão — não vira chave de balde", ["evil", "<script>", "6.6.6.6, not-an-ip", "6.6.6.6, 999.1.1.1"].every((x) => clientIp(req(x), 1) === "10.0.0.9"));
  check("2.6 IPv4 mapeado em IPv6 vira o IPv4 (mesma pessoa, um balde só); IPv6 puro passa", normalizeIp("::ffff:203.0.113.7") === "203.0.113.7" && clientIp(req("2001:db8::1"), 1) === "2001:db8::1" && clientIp(req(undefined, "::ffff:10.0.0.9"), 1) === "10.0.0.9");
  check("2.7 cabeçalho repetido (array) e cabeçalho gigante não quebram nem passam", clientIp(req(["6.6.6.6", "203.0.113.7"]), 1) === "203.0.113.7" && clientIp(req("1.1.1.1,".repeat(500) + "203.0.113.7"), 1) === "10.0.0.9");
  check("2.8 sem socket nem cabeçalho: 'unknown', sem lançar", clientIp({ headers: {} } as any, 1) === "unknown");

  // ── 3. contra o limitador REAL (rota pública de consentimento) ──
  const express = (await import("express")).default;
  const consent = (await import("../src/server/routes/consentPublic.js"));
  const app = express(); app.use("/api/public/consent", consent.default);
  const server = http.createServer(app);
  const port: number = await new Promise((rs) => server.listen(0, () => rs((server.address() as any).port)));
  const hit = async (xff?: string) => (await fetch(`http://127.0.0.1:${port}/api/public/consent/tok-inexistente`, { headers: xff ? { "x-forwarded-for": xff } : {} })).status;
  process.env.TRUSTED_PROXY_HOPS = "1";
  consent.resetConsentPublicLimiter();
  const codes: number[] = [];
  for (let i = 0; i < consent.CONSENT_PUBLIC_MAX + 5; i++) codes.push(await hit(`9.9.9.${i % 250}, 198.51.100.9`));   // atacante troca o 1º valor a cada pedido; o proxy anota sempre o mesmo IP
  check("3.1 atacante que muda o X-Forwarded-For a cada pedido É limitado (antes: nunca)", codes.slice(0, consent.CONSENT_PUBLIC_MAX).every((c) => c === 404) && codes.slice(consent.CONSENT_PUBLIC_MAX).every((c) => c === 429), codes.join(",").slice(-40));
  check("3.2 outro cliente (IP diferente anotado pelo proxy) NÃO é bloqueado junto", (await hit("9.9.9.1, 198.51.100.77")) === 404);
  process.env.TRUSTED_PROXY_HOPS = "0"; consent.resetConsentPublicLimiter();
  const codes0: number[] = [];
  for (let i = 0; i < consent.CONSENT_PUBLIC_MAX + 3; i++) codes0.push(await hit(`8.8.8.${i % 250}`));
  check("3.3 app exposto direto (0): cabeçalho forjado não escapa do limite", codes0.slice(consent.CONSENT_PUBLIC_MAX).every((c) => c === 429));
  server.close(); delete process.env.TRUSTED_PROXY_HOPS;

  // ── 4. nenhum ponto do app volta a ler o cabeçalho cru ──
  const offenders = [path.join(repoRoot, "server.ts"), ...walk(path.join(repoRoot, "src/server"))]
    .filter((f) => !/clientIp\.ts$|MetaWebhookLogService\.ts$/.test(f))   // o log de webhook só REDIGE esse cabeçalho
    .filter((f) => /headers\[["']x-forwarded-for["']\]|req\.ip\b/i.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(repoRoot, f));
  check("4.1 ninguém lê X-Forwarded-For cru nem req.ip fora do clientIp", offenders.length === 0, offenders.join(", "));
  const srv = read("server.ts");
  check("4.2 limitador global, limitador de webhook e auditoria usam clientIp", (srv.match(/clientIp\(req\)/g) || []).length >= 4);

  // ── 5. Node ──
  check("5.1 tabela de mínimos = release de 21/10/2026 (22.23.4 · 24.22.1 · 26.12.1)", NODE_MIN_PATCHED[22] === "22.23.4" && NODE_MIN_PATCHED[24] === "24.22.1" && NODE_MIN_PATCHED[26] === "26.12.1");
  check("5.2 versão antiga = 'outdated' com instrução; igual/maior = 'patched'", N.check("22.22.2").status === "outdated" && /pull --no-cache|NODE_IMAGE/.test(N.check("22.22.2").message) && N.check("22.23.4").status === "patched" && N.check("22.24.0").status === "patched" && N.check("v24.22.0").status === "outdated" && N.check("24.22.1").status === "patched" && N.check("26.12.1").status === "patched");
  check("5.3 linha fora da tabela = 'unsupported'; lixo = 'unknown' (nunca lança)", N.check("20.19.0").status === "unsupported" && N.check("18.0.0").status === "unsupported" && N.check("lixo").status === "unknown" && N.check("").status === "unknown");
  const df = read("Dockerfile");
  const pinned = /^ARG NODE_IMAGE=node:(\d+\.\d+\.\d+)-bookworm-slim$/m.exec(df)?.[1] || "";
  check("5.4 Dockerfile fixa o Node numa versão que a própria tabela considera corrigida (os dois não divergem)", !!pinned && N.check(pinned).status === "patched", pinned);
  check("5.5 os DOIS estágios usam o ARG (nenhum voltou pra tag flutuante)", (df.match(/^FROM \$\{NODE_IMAGE\}/gm) || []).length === 2 && !/^FROM node:22-bookworm-slim/m.test(df));
  check("5.6 aviso roda no boot do servidor (e não derruba nada: try/catch no log)", /NodeRuntimeSecurityService\.logAtBoot\(\)/.test(srv) && /log nunca derruba o boot/.test(read("src/server/NodeRuntimeSecurityService.ts")));

  // ── 6. piso das dependências ──
  // Versões lidas do LOCKFILE (o que `npm ci` instala), não de node_modules: no CI o job roda com NODE_ENV=production e as
  // dependências só de build (ex.: fast-uri) nem ficam instaladas — ler node_modules dava falso "0.0.0".
  const lockPk = JSON.parse(read("package-lock.json")).packages as Record<string, { version?: string }>;
  const lockVer = (key: string) => lockPk[key]?.version || "0.0.0";
  const floors: [string, string, string][] = [
    ["multer", "node_modules/multer", "2.5.0"], ["sharp", "node_modules/sharp", "0.35.5"],
    ["@xmldom/xmldom", "node_modules/@xmldom/xmldom", "0.9.12"], ["xml-crypto→@xmldom/xmldom (0.8.x)", "node_modules/xml-crypto/node_modules/@xmldom/xmldom", "0.8.15"],
    ["express", "node_modules/express", "4.22.3"], ["proxy-addr", "node_modules/proxy-addr", "2.0.8"],
    ["body-parser", "node_modules/body-parser", "1.20.9"], ["qs", "node_modules/qs", "6.16.0"],
    ["engine.io", "node_modules/engine.io", "6.6.10"], ["vite", "node_modules/vite", "6.4.5"], ["fast-uri", "node_modules/fast-uri", "3.1.9"],
  ];
  for (const [name, key, min] of floors) { const v = lockVer(key); check(`6.${name}: lockfile ${v} ≥ ${min}`, cmp(v, min) >= 0); }
  const pkg = JSON.parse(read("package.json"));
  const declared = (n: string) => String((pkg.dependencies?.[n] ?? pkg.devDependencies?.[n]) || "").replace(/^[\^~]/, "");
  check("6.12 package.json declara o piso (um `npm install` limpo não volta pra versão vulnerável)", cmp(declared("multer"), "2.5.0") >= 0 && cmp(declared("sharp"), "0.35.5") >= 0 && cmp(declared("@xmldom/xmldom"), "0.9.12") >= 0 && cmp(declared("express"), "4.22.3") >= 0 && cmp(declared("vite"), "6.4.5") >= 0);
  check("6.13 vite segue nos DOIS lugares como antes (a imagem de produção não mudou de composição)", !!pkg.dependencies?.vite && !!pkg.devDependencies?.vite);
  check("6.14 whatsapp-web.js (sem nenhum uso no código, trazia puppeteer + 10 avisos) saiu; nada a importa", !pkg.dependencies?.["whatsapp-web.js"] && ![path.join(repoRoot, "server.ts"), ...walk(path.join(repoRoot, "src"))].some((f) => /whatsapp-web\.js|puppeteer/.test(fs.readFileSync(f, "utf8"))));
  const lock = read("package-lock.json");
  check("6.15 nenhum pacote dos worms noticiados (keyv/cacheable/@subql/common/tensorlake) no lockfile — retrato de 25/10/2026", !/"node_modules\/(keyv|cacheable|@subql\/common|tensorlake)"/.test(lock));
  check("6.16 npm ci determinístico: o lockfile resolve o multer dentro da faixa declarada (≥ piso) e a raiz do lock concorda com package.json", cmp(lockVer("node_modules/multer"), declared("multer")) >= 0 && JSON.stringify((JSON.parse(lock) as any).packages[""].dependencies?.multer) === JSON.stringify(pkg.dependencies.multer));

  // ── 7. CI: ações de terceiros fixadas por SHA (tag/branch são móveis; um deles recebe a CLAUDE_API_KEY) ──
  const wfDir = path.join(repoRoot, ".github/workflows");
  const uses: { file: string; ref: string }[] = [];
  for (const f of fs.readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) for (const m of fs.readFileSync(path.join(wfDir, f), "utf8").matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)) uses.push({ file: f, ref: m[1] });
  const floating = uses.filter((u) => !/@[0-9a-f]{40}$/.test(u.ref)).map((u) => `${u.file}:${u.ref}`);
  check("7.1 TODA ação do CI está fixada em SHA de commit de 40 hex (nenhuma @main/@vN/@tag)", uses.length >= 6 && floating.length === 0, floating.join(", "));
  const sr = fs.readFileSync(path.join(wfDir, "security-review.yml"), "utf8");
  check("7.2 o passo que recebe CLAUDE_API_KEY só roda em PR do próprio repositório e não usa pull_request_target", /head\.repo\.full_name == github\.repository/.test(sr) && !/pull_request_target/.test(sr));

  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
