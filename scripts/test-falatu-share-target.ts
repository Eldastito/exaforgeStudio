/**
 * TEST — FalaTu F8.5 (ADR-154 Fase 8): Atalho Siri + Web Share Target.
 *
 * A fatia é quase toda "cola" declarativa entre 4 peças (manifest → share
 * sheet do sistema → SW → view). Bug aqui não estoura em unit test de
 * service — estoura como contrato quebrado entre arquivos. Então o teste
 * verifica exatamente os CONTRATOS:
 *
 * - manifestFileForHost: troca por host (falatu.* → falatu.webmanifest),
 *   com porta, case, header ausente/estranho.
 * - falatu.webmanifest: share_target completo (action/method/enctype/params)
 *   e coerente com o que o SW intercepta.
 * - site.webmanifest do painel: INTOCADO (sem share_target — instalar o
 *   painel da clínica não pode criar alvo de compartilhamento do FalaTu).
 * - falatu-share-sw.js ↔ FalaTuView: mesmo cache ('falatu-share'), mesmas
 *   chaves de stash (payload-file/payload-text), mesmo redirect (?share=1);
 *   SW não toca /api (decisão ADR-082).
 * - Wiring: importScripts no vite.config.ts; rota /site.webmanifest no
 *   server.ts ANTES do express.static (senão o static ganha e o swap nunca
 *   roda).
 *
 * Uso: npm run test:falatu-share-target
 */
import fs from "fs";
import path from "path";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf-8");

async function main() {
  const { manifestFileForHost } = await import("../src/server/hostManifest.js");

  // ===== 1. Troca de manifest por host =====
  check("host falatu.dominio → falatu.webmanifest", manifestFileForHost("falatu.tesseractauto.com.br") === "falatu.webmanifest");
  check("host com porta → falatu.webmanifest", manifestFileForHost("falatu.exemplo.com:443") === "falatu.webmanifest");
  check("host em caixa alta → falatu.webmanifest", manifestFileForHost("FALATU.Exemplo.com") === "falatu.webmanifest");
  check("painel → site.webmanifest", manifestFileForHost("zapflowia.tesseractauto.com.br") === "site.webmanifest");
  check("prefixo parcial NÃO engana (notfalatu.x)", manifestFileForHost("notfalatu.exemplo.com") === "site.webmanifest");
  check("header ausente → site.webmanifest", manifestFileForHost(undefined) === "site.webmanifest");
  check("header não-string (array) → site.webmanifest", manifestFileForHost(["falatu.a", "b"]) === "site.webmanifest");

  // ===== 2. falatu.webmanifest — share_target completo =====
  const falatuManifest = JSON.parse(read("public/falatu.webmanifest"));
  check("manifest FalaTu: name", falatuManifest.name === "FalaTu");
  check("manifest FalaTu: display standalone", falatuManifest.display === "standalone");
  check("manifest FalaTu: tem ícones", Array.isArray(falatuManifest.icons) && falatuManifest.icons.length >= 2);
  const st = falatuManifest.share_target;
  check("share_target: action /falatu-share", st?.action === "/falatu-share");
  check("share_target: método POST", st?.method === "POST");
  check("share_target: multipart (obrigatório pra arquivos)", st?.enctype === "multipart/form-data");
  check("share_target: campo de arquivo 'media'", st?.params?.files?.[0]?.name === "media");
  const accepts = st?.params?.files?.[0]?.accept || [];
  check("share_target: aceita áudio e imagem", accepts.includes("audio/*") && accepts.includes("image/*"));
  check("share_target: params de texto (title/text/url)", st?.params?.title === "title" && st?.params?.text === "text" && st?.params?.url === "url");

  // ===== 3. site.webmanifest do painel — intocado =====
  const panelManifest = JSON.parse(read("public/site.webmanifest"));
  check("painel: segue ZappFlow", panelManifest.name === "ZappFlow");
  check("painel: SEM share_target", panelManifest.share_target === undefined);

  // ===== 4. Contrato SW ↔ view =====
  const sw = read("public/falatu-share-sw.js");
  const view = read("src/features/FalaTuView.tsx");
  check("SW: escuta fetch", sw.includes("addEventListener('fetch'"));
  check("SW: só age em POST", sw.includes("method !== 'POST'"));
  check("SW: intercepta o action do manifest", sw.includes("'/falatu-share'"));
  check("SW: campo de arquivo igual ao manifest ('media')", sw.includes("form.get('media')"));
  check("SW: redireciona pro app com ?share=1", sw.includes("'/?share=1'"));
  check("SW: não toca /api (ADR-082)", !sw.includes("/api"));
  for (const key of ["'falatu-share'", "'/falatu-share/payload-file'", "'/falatu-share/payload-text'"]) {
    check(`SW e view usam a mesma chave ${key}`, sw.includes(key) && view.includes(key));
  }
  check("view: lê o parâmetro ?share=1", view.includes("params.get('share')"));

  // ===== 5. Wiring de build e server =====
  const vite = read("vite.config.ts");
  check("vite: SW importa o receptor de share", /importScripts:\s*\[[^\]]*'falatu-share-sw\.js'/.test(vite));
  check("vite: SW mantém o handler de push (F8.3)", /importScripts:\s*\[[^\]]*'falatu-push-sw\.js'/.test(vite));
  const server = read("server.ts");
  const routeAt = server.indexOf("app.get('/site.webmanifest'");
  const staticAt = server.indexOf("app.use(express.static(distPath))");
  check("server: rota do manifest existe", routeAt > -1);
  check("server: rota vem ANTES do express.static", routeAt > -1 && staticAt > -1 && routeAt < staticAt);
  check("server: rota usa o helper testado", server.includes("manifestFileForHost(req.headers['x-forwarded-host'] || req.headers.host)"));

  // ===== resultado =====
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
