/**
 * TEST — Vídeos de treinamento na ajuda (ADR-179 F5, mídia curada).
 * DB-backed, determinístico, isolado. Prova:
 *   - os artigos de Operação da Rede saem com o vídeo do seed (tour + sugestões);
 *   - o seed preenche a mídia de artigo JÁ existente sem mídia (base antiga);
 *   - o seed NÃO atropela a mídia que o curador escolheu;
 *   - todo vídeo citado no seed existe em public/ajuda/;
 *   - isVideoUrl separa vídeo de imagem (ignora ?query/#hash).
 *
 * Uso: npm run test:help-video
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-help-video-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-help-video-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const RETAIL_VIDEOS: Record<string, string> = {
  help_seed_retail_implantacao: "/ajuda/rede_1_ligar_e_cadastrar_loja.mp4",
  help_seed_retail_loja_codigo: "/ajuda/rede_1_ligar_e_cadastrar_loja.mp4",
  help_seed_retail_matricula: "/ajuda/rede_2_vendedores_matricula.mp4",
  help_seed_retail_escala_cotas: "/ajuda/rede_3_escala_e_cotas.mp4",
  help_seed_retail_malote: "/ajuda/rede_4_malote_depositos.mp4",
};

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const mod = await import("../src/server/HelpKnowledgeService.js");
  const KB = mod.HelpKnowledgeService;
  const { isVideoUrl } = await import("../src/lib/helpMedia.js");

  // Base "antiga": artigo já semeado SEM mídia, e outro com mídia escolhida pelo curador.
  db.prepare(`INSERT INTO help_articles (id, vertical, module_key, title, steps_json, common_errors_json, keywords, reviewed_by, status)
              VALUES ('help_seed_retail_matricula', NULL, 'retail', 'Vendedores (antigo)', '["passo"]', '[]', 'matricula', 'x', 'published')`).run();
  db.prepare(`INSERT INTO help_articles (id, vertical, module_key, title, steps_json, common_errors_json, keywords, reviewed_by, status, media_url)
              VALUES ('help_seed_retail_malote', NULL, 'retail', 'Malote (antigo)', '["passo"]', '[]', 'malote', 'x', 'published', 'https://cdn.exemplo/curador.gif')`).run();

  KB.ensureSeeded();
  const media = (id: string) => (db.prepare(`SELECT media_url FROM help_articles WHERE id=?`).get(id) as any)?.media_url ?? null;

  // 1. seed liga cada artigo da rede ao seu vídeo
  check("1.1 implantação → vídeo 1", media("help_seed_retail_implantacao") === RETAIL_VIDEOS.help_seed_retail_implantacao);
  check("1.2 código da filial → vídeo 1", media("help_seed_retail_loja_codigo") === RETAIL_VIDEOS.help_seed_retail_loja_codigo);
  check("1.3 escala & cotas → vídeo 3", media("help_seed_retail_escala_cotas") === RETAIL_VIDEOS.help_seed_retail_escala_cotas);

  // 2. base antiga
  check("2.1 artigo existente SEM mídia ganha o vídeo", media("help_seed_retail_matricula") === RETAIL_VIDEOS.help_seed_retail_matricula);
  check("2.2 mídia do curador NÃO é atropelada", media("help_seed_retail_malote") === "https://cdn.exemplo/curador.gif");
  check("2.3 seed não sobrescreve o texto do artigo existente", (db.prepare(`SELECT title FROM help_articles WHERE id='help_seed_retail_matricula'`).get() as any).title === "Vendedores (antigo)");
  check("2.4 artigo sem vídeo no seed segue sem mídia", media("help_seed_vendas") === null);

  // 3. o vídeo chega ao usuário pelo tour/sugestões
  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status) VALUES (?, ?, 'A', 'active', 'varejo', 'autonomo', 'active')`).run(randomUUID(), A);
  const sug = KB.suggestions(A, "retail", { limit: 10 });
  check("3.1 sugestões da tela da rede trazem vídeo", sug.some((s) => isVideoUrl(s.mediaUrl)));
  const tour = KB.tour(A, "retail");
  check("3.2 tour da rede existe e carrega mídia", !!tour && !!tour!.mediaUrl);

  // 4. arquivos existem
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  for (const url of new Set(Object.values(RETAIL_VIDEOS))) {
    const f = path.join(root, "public", url);
    check(`4 arquivo existe: ${url}`, fs.existsSync(f) && fs.statSync(f).size > 100_000);
  }

  // 5. isVideoUrl
  check("5.1 mp4 é vídeo", isVideoUrl("/ajuda/x.mp4"));
  check("5.2 mp4 com query é vídeo", isVideoUrl("https://cdn/x.MP4?v=2#t=3"));
  check("5.3 gif não é vídeo", !isVideoUrl("https://cdn/x.gif"));
  check("5.4 vazio/nulo não é vídeo", !isVideoUrl(null) && !isVideoUrl(""));
  check("5.5 'mp4' no meio do caminho não engana", !isVideoUrl("/mp4/foto.png"));

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} help-video: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
