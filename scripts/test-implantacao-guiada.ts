/**
 * TESTE — 19/09/2026: implantação guiada (3 correções do Guia de Implantação Moda).
 * ----------------------------------------------------------------------------------
 * Achados do mapeamento do guia (TOULON):
 *  1. Vertical `moda` sem pack Quick-Start → alias moda→varejo (o card do
 *     Dashboard volta a aparecer e o apply funciona);
 *  2. Artigos do Tutor de Ajuda destilados do guia (implantação/loja-código/
 *     matrícula/escala-cotas/malote/alterdata) — grounded, curados, com o
 *     retrieval determinístico achando cada um;
 *  3. Trava de loja ADR-173 imposta nas rotas /seller-scoreboard e
 *     /seller-goal-signals (antes qualquer storeId da org passava).
 *
 * Uso:  npm run test:implantacao-guiada
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-implant-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-implant-1";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { OnboardingTemplateService } = await import("../src/server/OnboardingTemplateService.js");
  const { HelpKnowledgeService: KB } = await import("../src/server/HelpKnowledgeService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status) VALUES (?, ?, 'Moda A', 'active', 'moda', 'autonomo', 'active')`).run(randomUUID(), A);

  // ── 1) Alias do pack Quick-Start: moda → varejo. ──
  check("1.1 resolvePackVertical('moda') → 'varejo'", OnboardingTemplateService.resolvePackVertical("moda") === "varejo");
  check("1.2 vertical com pack próprio passa direto", OnboardingTemplateService.resolvePackVertical("saude") === "saude");
  // O lookup do /status (mesma lógica da rota): moda agora ACHA um pack.
  const wanted = OnboardingTemplateService.resolvePackVertical("moda");
  const packForModa = OnboardingTemplateService.availablePacks().find((p: any) => p.vertical === wanted) || null;
  check("1.3 org de moda encontra o pack (card do Dashboard volta)", !!packForModa && (packForModa as any).vertical === "varejo");
  // applyPack('moda') não lança mais e semeia as áreas base do varejo.
  const report = await OnboardingTemplateService.applyPack(A, "moda", { skipFaq: true });
  check("1.4 applyPack('moda') aplica o pack de varejo", report.areas.created > 0, JSON.stringify(report.areas));
  // Idempotente: 2ª aplicação não duplica.
  const report2 = await OnboardingTemplateService.applyPack(A, "moda", { skipFaq: true });
  check("1.5 reaplicar não duplica áreas", report2.areas.created === 0 && report2.areas.skipped > 0);
  // Vertical realmente desconhecida segue com erro honesto.
  let threw = false;
  try { await OnboardingTemplateService.applyPack(A, "xyz_inexistente"); } catch { threw = true; }
  check("1.6 vertical desconhecida segue rejeitada (não inventa pack)", threw);

  // ── 2) Artigos de implantação no Tutor de Ajuda (grounded, curados). ──
  KB.ensureSeeded();
  const ids = ["help_seed_retail_implantacao", "help_seed_retail_loja_codigo", "help_seed_retail_matricula", "help_seed_retail_escala_cotas", "help_seed_retail_malote", "help_seed_alterdata_validacao"];
  const found = (db.prepare(`SELECT COUNT(*) c FROM help_articles WHERE status='published' AND id IN (${ids.map(() => "?").join(",")})`).get(...ids) as any).c;
  check("2.1 os 6 artigos de implantação publicados", Number(found) === 6, String(found));
  const reviewed = (db.prepare(`SELECT COUNT(*) c FROM help_articles WHERE id IN (${ids.map(() => "?").join(",")}) AND (reviewed_by IS NULL OR reviewed_by='')`).get(...ids) as any).c;
  check("2.2 todos com reviewed_by (RN-HELP-3)", Number(reviewed) === 0);
  const rCodigo = KB.retrieve(A, "por que as metas do vendedor estão zeradas nessa loja?");
  check("2.3 'metas zeradas na loja' → artigo do código da filial", !!rCodigo && rCodigo!.id === "help_seed_retail_loja_codigo", rCodigo?.id);
  const rMalote = KB.retrieve(A, "o valor em caixa do malote parece errado, como registro o deposito?");
  check("2.4 'em caixa/depósito' → artigo do malote", !!rMalote && rMalote!.id === "help_seed_retail_malote", rMalote?.id);
  const rAlterdata = KB.retrieve(A, "como sincronizar o alterdata e conferir filiais orfas");
  check("2.5 'alterdata/filiais órfãs' → artigo de validação", !!rAlterdata && rAlterdata!.id === "help_seed_alterdata_validacao", rAlterdata?.id);
  const rImplant = KB.retrieve(A, "por onde eu começo a configurar a rede de lojas?");
  check("2.6 'por onde começar' → artigo de implantação", !!rImplant && rImplant!.id === "help_seed_retail_implantacao", rImplant?.id);
  // 0-regressão: os artigos antigos continuam ganhando as suas perguntas.
  const rDiretor = KB.retrieve(A, "o que é o diretor executivo ia?");
  check("2.7 0-regressão: pergunta do Diretor segue no artigo do Diretor", !!rDiretor && rDiretor!.id === "help_seed_diretor", rDiretor?.id);

  // ── 3) Trava de loja nas rotas do placar (gate de fonte + semântica). ──
  const routesSrc = fs.readFileSync(path.join(process.cwd(), "src/server/routes/retailops.ts"), "utf8");
  const scoreboardBlock = routesSrc.split('router.get("/seller-scoreboard"')[1]?.split("router.get(")[0] || "";
  const signalsBlock = routesSrc.split('router.get("/seller-goal-signals"')[1]?.split("router.get(")[0] || "";
  check("3.1 /seller-scoreboard impõe canAccessStore (ADR-173)", /canAccessStore/.test(scoreboardBlock) && /403/.test(scoreboardBlock));
  check("3.2 /seller-goal-signals impõe canAccessStore (ADR-173)", /canAccessStore/.test(signalsBlock) && /403/.test(signalsBlock));
  // Semântica do gate (o serviço já é testado em test-retail-store-scope; aqui
  // só o contorno usado pelas rotas): restrito nega loja alheia; sem user → libera.
  const { RetailStoreScopeService } = await import("../src/server/RetailStoreScopeService.js");
  const s1 = randomUUID(), s2 = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active) VALUES (?, ?, 'L1', 1)`).run(s1, A);
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active) VALUES (?, ?, 'L2', 1)`).run(s2, A);
  RetailStoreScopeService.setForUser(A, "u_restrito", [s1], "owner1");
  check("3.3 usuário restrito NÃO acessa a outra loja", RetailStoreScopeService.canAccessStore(A, "u_restrito", "admin", s2) === false);
  check("3.4 usuário restrito acessa a loja dele", RetailStoreScopeService.canAccessStore(A, "u_restrito", "admin", s1) === true);
  check("3.5 sem atribuição → irrestrito (retrocompatível)", RetailStoreScopeService.canAccessStore(A, "u_livre", "admin", s2) === true);

  console.log("\n=== TEST: Implantação guiada (pack moda + ajuda + trava do placar) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
