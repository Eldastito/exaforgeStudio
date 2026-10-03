/**
 * TESTE — Fase 2 / F2.9 (ADR-203): medição do piloto (consentimento + relatório de uso + nomes de tela coerentes com a retirada de legado).
 * Prova: (1) CONSENTIMENTO — `ux_telemetry_enabled` nasce DESLIGADO, só liga/desliga por owner/admin (rota), isolado por org; desligada = NO-OP (nada
 * entra no banco); (2) relatório HONESTO — desligada = `disabled` e NENHUM número; ligada sem evento = `no_data`; poucos eventos = `low_sample`
 * (mostra mas avisa); só `ok` com ≥30 aberturas e ≥2 pessoas; sempre diz que mede abertura/clique, não valor; (3) agregados corretos: telas mais
 * abertas, % pelo Explorar, % do Hoje que virou clique, perguntas ao FalaTu, buscas sem resultado; (4) só gestor (vendedor = restricted); isolamento;
 * (5) CORREÇÃO da F2.2: a abertura de tela usa o NOME DA TELA (o mesmo que o LegacyReductionService compara) — com uso real do legado o aviso de
 * retirada NÃO vira "pronto para retirar" (antes, o legado aberto pelo Explorar era invisível); (6) a abertura é registrada UMA vez, no App; as telas
 * só registram cliques; nada de texto digitado vai para a telemetria; (7) fiação (rotas, toggle, painel). Determinístico, sem LLM.
 * Uso:  npm run test:ux-pilot
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-f29-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-ux-pilot-1234567890";

let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const T = (await import("../src/server/UxTelemetryService.js")).UxTelemetryService;
  const { UxPilotReportService: P, MIN_VIEWS, MIN_USERS } = await import("../src/server/UxPilotReportService.js");
  const { LegacyReductionService: L } = await import("../src/server/LegacyReductionService.js");
  const { PermissionService: Perm } = await import("../src/server/PermissionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?,?,?,?)`).run(randomUUID(), id, id, "active"); Perm.seedSystemProfiles(id); return id; };
  const A = mkOrg(), B = mkOrg();
  const userFor = (org: string, key: string, id = randomUUID()) => ({ userId: id, id, role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id, role: key });
  const owner = userFor(A, "owner"), vendedor = userFor(A, "vendedor");
  const countEvents = (org: string) => Number((db.prepare(`SELECT COUNT(*) n FROM ux_telemetry_events WHERE organization_id = ?`).get(org) as any).n);

  // ── (1) consentimento ──
  check("nasce DESLIGADO (consentimento LGPD)", T.enabled(A) === false);
  const rec = (org: string, u: any, type: string, surface: string, key: string, sid = "s1") => T.record(org, u, { eventType: type, surface, moduleKey: key, sessionId: sid });
  check("desligada = NO-OP: nada entra no banco", rec(A, owner, "view_opened", "hoje", "hoje").recorded === false && countEvents(A) === 0);
  const off = P.build(A, owner);
  check("relatório com a coleta desligada: state=disabled, NENHUM número (não finge zero) e diz como ligar", off.state === "disabled" && off.telemetryEnabled === false && off.sample.views === 0 && off.topScreens.length === 0 && off.entry.explorarSharePct === null && /desligada/.test(off.notes.join(" ")));
  check("setEnabled liga; isolado por org", T.setEnabled(A, true).enabled === true && T.enabled(A) === true && T.enabled(B) === false);
  check("'search_no_result' é evento permitido; evento fora do whitelist é recusado", rec(A, owner, "search_no_result", "explorar", "busca").recorded === true && rec(A, owner, "texto_livre", "x", "y").recorded === false);
  check("desligar para de coletar, sem apagar o já coletado", (() => { const n = countEvents(A); T.setEnabled(A, false); const r1 = rec(A, owner, "view_opened", "hoje", "hoje"); const kept = countEvents(A) === n; T.setEnabled(A, true); return r1.recorded === false && kept; })());

  // ── (2) estados honestos ──
  db.prepare(`DELETE FROM ux_telemetry_events WHERE organization_id = ?`).run(A);
  check("ligada sem evento: no_data", P.build(A, owner).state === "no_data");
  rec(A, owner, "view_opened", "hoje", "hoje"); rec(A, owner, "view_opened", "hoje", "hoje");
  const low = P.build(A, owner);
  check("poucos eventos: low_sample (mostra, mas avisa que não prova nada)", low.state === "low_sample" && /Amostra pequena/.test(low.notes.join(" ")) && low.sample.views === 2);
  check("sempre avisa que mede abertura/clique, NÃO valor", /não mede se ajudou/.test(low.notes.join(" ")));

  // ── (3) agregados ──
  db.prepare(`DELETE FROM ux_telemetry_events WHERE organization_id = ?`).run(A);
  const u2 = userFor(A, "gerente"), u3 = userFor(A, "admin");
  const users = [owner, u2, u3];
  let i = 0;
  const view = (screen: string, n: number) => { for (let k = 0; k < n; k++) rec(A, users[i++ % 3], "view_opened", screen, screen, `s${k % 4}`); };
  view("hoje", 20); view("resultados", 10); view("dashboard", 5); view("insights", 3);
  for (let k = 0; k < 6; k++) rec(A, users[k % 3], "action_clicked", "nav_primario", "hoje", `s${k}`);
  for (let k = 0; k < 2; k++) rec(A, users[k % 3], "action_clicked", "nav_explorar", "dashboard", `s${k}`);
  for (let k = 0; k < 5; k++) rec(A, users[k % 3], "action_clicked", "hoje_acao", "falatu", `s${k}`);
  rec(A, owner, "action_clicked", "falatu_pergunta", "geral"); rec(A, owner, "action_clicked", "falatu_pergunta", "com_loja"); rec(A, owner, "action_clicked", "falatu_pergunta", "continuacao");
  rec(A, owner, "search_no_result", "explorar", "busca"); rec(A, owner, "search_no_result", "explorar", "busca");
  const ok = P.build(A, owner);
  check(`≥${MIN_VIEWS} aberturas e ≥${MIN_USERS} pessoas: state=ok`, ok.state === "ok" && ok.sample.views === 38 && ok.sample.users === 3, JSON.stringify(ok.sample));
  check("telas mais abertas em ordem (Hoje 20 › Resultados 10 › Atendimento Digital 5 › Insights 3), com rótulo humano", ok.topScreens.map(t => t.label).join(">") === "Hoje>Resultados>Atendimento Digital>Insights", ok.topScreens.map(t => t.label).join(">"));
  check("entrada: 2 de 8 acessos pelo Explorar = 25%", ok.entry.primary === 6 && ok.entry.explorar === 2 && ok.entry.explorarSharePct === 25);
  check("Hoje: 5 cliques em prioridade / 20 aberturas = 25%", ok.hoje.opens === 20 && ok.hoje.actionClicks === 5 && ok.hoje.actionRatePct === 25);
  check("FalaTu: 3 perguntas (1 com loja, 1 continuação) — só contagem, nunca o texto", ok.falatuQuestions.total === 3 && ok.falatuQuestions.withStore === 1 && ok.falatuQuestions.followUps === 1);
  check("buscas sem resultado contadas (2) e o relatório avisa", ok.searchMisses === 2 && /sem resultado/.test(ok.notes.join(" ")));
  check("menu simplificado desligado: o relatório avisa que os números são do menu completo", ok.simplifiedNavEnabled === false && /desligado/.test(ok.notes.join(" ")));

  // ── (4) papel + isolamento ──
  const sv = P.build(A, vendedor);
  check("vendedor: restricted, sem números", sv.restricted === true && sv.sample.views === 0 && sv.topScreens.length === 0);
  const ob = P.build(B, userFor(B, "owner"));
  check("isolamento: outra org não vê o uso da org A (e está desligada)", ob.state === "disabled" && ob.sample.views === 0);

  // ── (5) CORREÇÃO: nome de tela × LegacyReductionService ──
  const C = mkOrg(); T.setEnabled(C, true);
  const cu = [userFor(C, "owner"), userFor(C, "gerente"), userFor(C, "admin")];
  for (let k = 0; k < 12; k++) T.record(C, cu[k % 3], { eventType: "view_opened", surface: "hoje", moduleKey: "hoje" });
  for (let k = 0; k < 30; k++) T.record(C, cu[k % 3], { eventType: "view_opened", surface: "insights", moduleKey: "insights" });   // legado em uso real
  const co = L.candidates(C, cu[0]) as any;
  const pair = co.candidates.find((c: any) => c.legacy === "insights" && c.replacement === "hoje");
  check("com o legado (Insights) em uso real, a retirada NÃO é recomendada (status 'keep', share do legado alto)", pair?.status === "keep" && pair.evidence.legacyViews === 30 && pair.evidence.newViews === 12, JSON.stringify(pair?.evidence));
  const D = mkOrg(); T.setEnabled(D, true);
  const du = [userFor(D, "owner"), userFor(D, "gerente"), userFor(D, "admin")];
  for (let k = 0; k < 12; k++) T.record(D, du[k % 3], { eventType: "view_opened", surface: "hoje", moduleKey: "hoje" });
  const dd = L.candidates(D, du[0]) as any;
  check("e com o legado sem uso e a substituta adotada, aí sim 'ready_to_retire' (advisório)", dd.candidates.find((c: any) => c.legacy === "insights")?.status === "ready_to_retire");

  // ── (6) onde cada evento nasce ──
  const read = (f: string) => fs.readFileSync(f, "utf8");
  const tel = read("src/lib/uxTelemetry.ts"), app = read("src/App.tsx");
  check("o App registra a abertura de tela UMA vez por troca de viewMode (nome da tela)", /trackView\(viewMode\)/.test(app) && /\[viewMode, authed, modulesReady\]/.test(app) && /send\('view_opened', viewMode, viewMode\)/.test(tel));
  const feats = ["Today", "Executing", "Results", "Company", "FalaTu", "RetailOps"].map(n => read(`src/features/${n}View.tsx`)).concat(read("src/features/SimplifiedNav.tsx"));
  check("as telas NÃO registram abertura (só o App); dentro delas só cliques (trackAction)", feats.every(f => !/trackView\(/.test(f)));
  check("nenhum texto digitado vai para a telemetria (pergunta ao FalaTu = só 'geral/com_loja/continuacao'; busca = 'busca')", /trackAction\('falatu_pergunta', typeof override === 'string' \? 'continuacao' : ctxStoreId \? 'com_loja' : 'geral'\)/.test(read("src/features/FalaTuView.tsx")) && /send\('search_no_result', 'explorar', 'busca'\)/.test(tel) && !/trackAction\([^)]*\bq\b/.test(read("src/features/FalaTuView.tsx")));
  check("id de sessão é aleatório e por aba (sessionStorage), sem relação com a pessoa", /sessionStorage/.test(tel) && /Math\.random/.test(tel) && !/userId|email/.test(tel));

  // ── (7) fiação ──
  const ux = read("src/server/routes/ux.ts");
  check("rotas: enablement (owner/admin) e pilot-report", /router\.put\("\/telemetry\/enablement", requireRole\("owner", "admin"\)/.test(ux) && /router\.get\("\/pilot-report"/.test(ux));
  check("Configurações → Módulos tem o toggle de medição (default desligado) e a Empresa mostra o painel", /function UxTelemetrySection/.test(read("src/features/SettingsView.tsx")) && /<UxTelemetrySection \/>/.test(read("src/features/SettingsView.tsx")) && /data-testid="pilot-report"/.test(read("src/features/CompanyView.tsx")));

  console.log(failures === 0 ? "\nTODOS OS CHECKS PASSARAM" : `\n${failures} FALHA(S)`);
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
