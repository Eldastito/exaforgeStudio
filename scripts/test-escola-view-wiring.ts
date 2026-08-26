/**
 * TEST — Fiação da tela Escola (UI da vertical educacao, ADR-144). Determinístico.
 * A EscolaView é UI-only sobre o backend /api/escola/* já em produção. Este teste
 * garante que a fiação não quebre em silêncio:
 *   (A) todo endpoint que a EscolaView consome está MONTADO no router (sem 404);
 *   (B) a view está ligada no App/Sidebar/ViewMode e gated pelo módulo `escola`.
 *
 * Uso: npm run test:escola-view-wiring
 */
import os from "os"; import path from "path"; import fs from "fs"; import { fileURLToPath } from "url";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-escola-ui-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-escola-ui-123456";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
function routePaths(router: any): string[] {
  const out: string[] = [];
  try { for (const l of router?.stack || []) if (l?.route?.path) out.push(String(l.route.path)); } catch { /* noop */ }
  return out;
}
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

async function main() {
  // ═══════════ (A) endpoints consumidos pela EscolaView estão montados ═══════════
  const router = (await import("../src/server/routes/escola.js")).default as any;
  const rp = routePaths(router);
  // Coordenação
  check("A1 coordenação (panel + scan)", rp.includes("/coordenacao/panel") && rp.includes("/coordenacao/scan"));
  // Alunos + responsáveis + consentimento + agenda + falta + resumo
  check("A2 alunos (list/create/get)", rp.includes("/students") && rp.includes("/students/:studentId"));
  check("A3 responsáveis + consentimento", rp.includes("/students/:studentId/guardians") && rp.includes("/students/:studentId/guardians/:guardianContactId/consent"));
  check("A4 agenda do aluno + falta", rp.includes("/students/:studentId/agenda") && rp.includes("/students/:studentId/absence"));
  check("A5 resumo diário (send-test)", rp.includes("/students/:studentId/digest/send-test"));
  // Professores + grade + notify
  check("A6 professores (list/create/get)", rp.includes("/teachers") && rp.includes("/teachers/:teacherId"));
  check("A7 grade + remover item + notify", rp.includes("/teachers/:teacherId/schedule") && rp.includes("/schedule/:scheduleItemId") && rp.includes("/teachers/:teacherId/notify"));
  // Atividades + roster + matrícula + presença
  check("A8 atividades (list/create/roster)", rp.includes("/activities") && rp.includes("/activities/:activityId/roster"));
  check("A9 matrícula/cancelar/presença", rp.includes("/activities/:activityId/enroll") && rp.includes("/activities/:activityId/cancel") && rp.includes("/activities/:activityId/attendance"));

  // ═══════════ (B) view ligada no front + gate por módulo ═══════════
  check("B1 EscolaView existe", fs.existsSync(path.join(repoRoot, "src/features/EscolaView.tsx")));
  const app = read("src/App.tsx");
  check("B2 App importa e renderiza EscolaView", app.includes("import { EscolaView }") && app.includes("viewMode === 'escola' && <EscolaView"));
  check("B3 App tem título 'Escola'", app.includes("viewMode === 'escola' && 'Escola'"));
  check("B4 guard de redirect mapeia escola→módulo escola", app.includes("escola: 'escola'"));
  const sidebar = read("src/features/Sidebar.tsx");
  check("B5 Sidebar mostra item Escola gated por mod('escola')", sidebar.includes("mod('escola')") && sidebar.includes("setViewMode('escola')"));
  check("B6 ViewMode inclui 'escola'", read("src/store/useStore.ts").includes("'escola'"));

  // ═══════════ (C) módulo escola pertence ao preset da vertical educacao ═══════════
  const { getVertical } = await import("../src/server/verticals.js");
  const edu = getVertical("educacao");
  check("C1 preset educacao liga o módulo escola", !!edu && edu!.modules.includes("escola"));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} escola-view-wiring: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
