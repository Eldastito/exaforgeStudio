/**
 * TESTE — PRD Fase 1 §18 (S5): "Analisar desempenho" do vendedor.
 * Prova: compara janela atual × anterior (vendas, nº de vendas, ticket, P.A.) com FATO separado de HIPÓTESE; null≠0 (sem escala não
 * diz dias trabalhados; sem nº de vendas não há ticket); dado insuficiente → não diagnostica; hipótese só quando o número sustenta;
 * entra no briefing do sinal de vendedor (só com visão completa) e no Diretor IA ("analisar desempenho de X": acha a pessoa,
 * pergunta se ambíguo/ausente, nunca chuta); read-only; isolamento por org; sem LLM.
 * Uso:  npm run test:seller-diagnosis
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { mock } from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sellerdiag-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-sellerdiag-1234567890";
// Os dados são de 08–09/2026 e o briefing/ferramenta leem a data REAL de hoje (30 dias): sem congelar o relógio, o teste quebra quando a janela
// anda (apareceu em 10/10/2026, vermelho também na main). Só `Date` é congelado — timers e IO seguem normais.
mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-30T15:00:00Z") });

let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SellerDiagnosisService: D } = await import("../src/server/SellerDiagnosisService.js");
  const { SignalBriefService: B } = await import("../src/server/SignalBriefService.js");
  const { BusinessSignalService: S } = await import("../src/server/BusinessSignalService.js");
  const { ExecutiveQueryRouterService: R } = await import("../src/server/ExecutiveQueryRouterService.js");
  const { ExecutiveQueryToolsService: T } = await import("../src/server/ExecutiveQueryToolsService.js");
  const { PermissionService: P } = await import("../src/server/PermissionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const A = mkOrg(), O = mkOrg();
  P.seedSystemProfiles(A);
  const seller = (org: string, mat: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, ?, ?)`).run(id, org, mat, name); return id; };
  const sale = (org: string, mat: string, name: string, date: string, valor: number, pecas: number) =>
    db.prepare(`INSERT INTO retail_seller_sales (id, organization_id, sale_date, seller_name, matricula, valor, pecas, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')`).run(randomUUID(), org, date, name, mat, valor, pecas);
  const REF = "2026-09-30";

  const maria = seller(A, "101", "Maria Souza");
  const mariana = seller(A, "102", "Mariana Lima");
  const joana = seller(A, "103", "Joana Prado");
  const semDados = seller(A, "104", "Paula Nunes");
  // atual (01–30/09): 5 vendas de R$100 · anterior (02–31/08): 10 vendas de R$100 → só o nº de vendas caiu (ticket e P.A. iguais)
  for (let i = 1; i <= 5; i++) sale(A, "101", "Maria Souza", `2026-09-${String(i * 2).padStart(2, "0")}`, 100, 1);
  for (let i = 1; i <= 10; i++) sale(A, "101", "Maria Souza", `2026-08-${String(i * 2 + 1).padStart(2, "0")}`, 100, 1);
  sale(A, "102", "Mariana Lima", "2026-09-10", 100, 1);
  sale(O, "101", "Maria Souza", "2026-09-10", 99999, 9);        // outra org: não pode vazar

  const d = D.diagnose(A, maria, REF);
  const dump = JSON.stringify(d);
  check("acha a pessoa e compara janela atual × anterior (mesmo tamanho)", d.found && d.enough && d.current?.sales === 500 && d.previous?.sales === 1000 && d.current?.start === "2026-09-01" && d.previous?.end === "2026-08-31");
  check("fatos: nº de vendas, ticket médio e P.A. calculados do que existe", d.current?.orders === 5 && d.current?.ticket === 100 && d.current?.pa === 1 && d.previous?.orders === 10);
  check("fato rotulado 'fact' com a variação (Vendas −50%)", d.findings.some((f) => f.kind === "fact" && /Vendas: R\$ 500,00 contra R\$ 1\.000,00.*-50%/.test(f.text)));
  check("hipótese só quando o número sustenta (menos vendas fechadas, ticket estável) — rotulada 'hypothesis'", d.findings.some((f) => f.kind === "hypothesis" && /menos vendas fechadas/.test(f.text)) && d.findings.filter((f) => f.kind === "hypothesis").length === 1);
  check("sem escala cadastrada: null (não diz 'trabalhou 0 dias') e avisa", d.current?.scheduledDays === null && d.findings.some((f) => /Não há escala cadastrada/.test(f.text)) && !/Dias escalados:/.test(dump));
  check("isolamento: venda de outra org não entra", d.current?.sales === 500);

  const dm = D.diagnose(A, mariana, REF);
  check("sem período anterior: não inventa comparação ('não há vendas no período anterior')", dm.enough && dm.findings.some((f) => /Não há vendas no período anterior/.test(f.text)) && !dm.findings.some((f) => f.kind === "hypothesis"));
  const dn = D.diagnose(A, semDados, REF);
  check("dado insuficiente: enough:false com o motivo, sem findings (não diagnostica no vazio)", dn.found && !dn.enough && /não dá para diagnosticar/.test(dn.reason || "") && dn.findings.length === 0);
  check("vendedor inexistente / de outra org: não encontrado", !D.diagnose(A, "nao-existe", REF).found && !D.diagnose(O, maria, REF).found);

  // escala → dias escalados + hipótese de menos dias
  const store = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name) VALUES (?, ?, 'Bangu')`).run(store, A);
  const wk = (date: string) => db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status) VALUES (?, ?, ?, ?, 'mat:101', 'Maria Souza', 'work')`).run(randomUUID(), A, store, date);
  for (const x of ["03", "05", "07"]) wk(`2026-09-${x}`);
  for (let i = 1; i <= 12; i++) wk(`2026-08-${String(i + 2).padStart(2, "0")}`);
  const ds = D.diagnose(A, maria, REF);
  check("com escala: dias escalados (3 × 12) e vendas por dia derivados", ds.current?.scheduledDays === 3 && ds.previous?.scheduledDays === 12 && ds.current?.salesPerDay === 166.67 && ds.findings.some((f) => /Dias escalados: 3 contra 12/.test(f.text)));

  // ── briefing do sinal de vendedor ──
  const owner = { id: "u1", role: "owner", userId: "u1" };
  const sg = S.publish(A, { domain: "retail_ops", signalType: "seller_goal_streak", severity: "risk", basis: "fact", confidence: 0.9, sourceService: "test", sourceEntityType: "seller", sourceEntityId: maria, evidence: { seller: "Maria Souza", streak: 3 }, dedupeKey: `seller_goal_streak|${maria}` });
  const b = B.brief(A, sg.id, owner);
  check("briefing do sinal de vendedor traz o diagnóstico (fato × hipótese)", !!b.diagnosis?.enough && b.diagnosis.findings.some((f) => f.kind === "hypothesis"));
  const other = { id: "u2", role: "vendedor", userId: "u2" };
  const bo = B.brief(A, sg.id, other);
  check("sem visão completa (traz R$): o diagnóstico não aparece", !bo.diagnosis);
  const nb = S.publish(A, { domain: "retail_ops", signalType: "retail_store_stockout", severity: "risk", basis: "fact", confidence: 0.9, sourceService: "test", evidence: {}, dedupeKey: "x" });
  check("sinal que não é de vendedor não ganha diagnóstico", !B.brief(A, nb.id, owner).diagnosis);

  // ── Diretor IA ──
  const dec = (q: string) => R.detect(A, q);
  check("'analisar desempenho de Maria Souza' → ferramenta de diagnóstico (antes da saída analítica)", dec("analisar desempenho de Maria Souza")?.tool === "diagnostico_vendedor");
  check("pergunta de desempenho sem vendedor/nome conhecido NÃO é capturada ('desempenho da loja')", dec("como está o desempenho da loja Bangu")?.tool !== "diagnostico_vendedor");
  const run = async (q: string) => T.run(A, "diagnostico_vendedor", { text: q }, { canSeeMoney: true });
  const r1: any = await run("analisar desempenho de Maria Souza");
  check("tool: acha pela nome completo e responde com fato/hipótese e o aviso de que hipótese não é causa", r1.ok && /Desempenho de Maria Souza/.test(r1.summary) && /Hipótese:/.test(r1.summary) && /não é causa comprovada/.test(r1.summary), JSON.stringify(r1.summary));
  const r2: any = await run("analisar desempenho da vendedora Mari");
  check("nome ambíguo/ausente: pergunta (nunca chuta)", !!r2.clarify, JSON.stringify(r2).slice(0, 200));
  const r3: any = await run("analisar desempenho da Joana");
  check("primeiro nome único resolve", r3.ok && /Joana Prado/.test(r3.summary || ""), JSON.stringify(r3).slice(0, 200));
  const r4: any = await run("analisar desempenho do vendedor");
  check("sem nome: pergunta de qual vendedor", /De qual vendedor/.test(r4.clarify || ""));

  // ── read-only ──
  const before = [(db.prepare(`SELECT COUNT(*) c FROM decision_actions WHERE organization_id = ?`).get(A) as any).c, (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id = ?`).get(A) as any).c];
  D.diagnose(A, maria, REF);
  const after = [(db.prepare(`SELECT COUNT(*) c FROM decision_actions WHERE organization_id = ?`).get(A) as any).c, (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id = ?`).get(A) as any).c];
  check("read-only: não cria ação nem sinal", before.join() === after.join());

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures) { console.log(`\n${failures} FALHA(S)`); process.exit(1); }
  console.log("\nTODOS OS CHECKS PASSARAM");
}
main().catch((e) => { console.error(e); process.exit(1); });
