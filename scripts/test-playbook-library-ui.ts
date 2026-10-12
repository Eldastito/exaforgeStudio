/**
 * TESTE — Biblioteca de playbooks (ADR-206 F5.11): cartão em Empresa → Autonomia da IA + rótulos PUROS, contra o PlaybookRegistryService REAL.
 * Prova: nada é inventado (estágio "validado" diz que é por testes, sem piloto; eficácia sempre com n e banda; sem execução → "sem dado", nunca 0%)
 * · aviso quando a autonomia passa do teto · "cabem" primeiro sem esconder nenhum · fiação (sem menu novo, só owner/admin, só carrega ao abrir,
 * rota existente, 403 do runtime tratado, sem botão que ligue/desligue/inicie) · isolamento entre empresas.
 * Uso: npm run test:playbook-library-ui
 */
import os from "os"; import path from "path"; import fs from "fs"; import { fileURLToPath } from "url"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pblui-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pblui-1234567890";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

async function main() {
  const L = await import("../src/features/playbooklibrary/libraryLabels.js");
  const { default: db } = await import("../src/server/db.js");
  const { PlaybookRegistryService: REG } = await import("../src/server/PlaybookRegistryService.js");

  // ── rótulos ──
  check("estágio: validado diz 'por testes (sem piloto)'; certificado só quando é; desconhecido não vira bom", /testes/.test(L.stageLabel("validated")) && /sem piloto/.test(L.stageLabel("validated")) && L.stageLabel("certified") === "Certificado em piloto" && L.stageLabel("experimental") === "Experimental" && L.stageLabel("x") === "Estágio desconhecido");
  check("risco em português; desconhecido explícito", L.riskLabel("low") === "Risco baixo" && L.riskLabel("medium") === "Risco médio" && L.riskLabel("high") === "Risco alto" && L.riskLabel("?") === "Risco desconhecido");
  check("autonomia: 4 níveis + '—' para nada", L.autonomyLabel("observe") === "Só observa e relata" && /aprovação/.test(L.autonomyLabel("prepare")) && /limite que você autorizou/.test(L.autonomyLabel("execute")) && L.autonomyLabel(null) === "—");
  check("ramos: lista vazia = qualquer ramo", L.verticalsLabel([]) === "Qualquer ramo" && L.verticalsLabel(["moda", "varejo"]) === "moda, varejo");

  const effNone: any[] = [];
  check("eficácia sem execuções: diz que não dá para afirmar (nunca 0%)", /Sem execuções concluídas/.test(L.efficacyLine(effNone)) && !/0%/.test(L.efficacyLine(effNone)));
  check("eficácia com n=0 em todas as versões também é 'sem dado'", /Sem execuções concluídas/.test(L.efficacyLine([{ definitionVersion: 1, completed: 0, failed: 0, inProgress: 3, n: 0, completionRate: null, interval: null, confidence: "", vertical: null }])));
  const line = L.efficacyLine([{ definitionVersion: 2, completed: 8, failed: 2, inProgress: 0, n: 10, completionRate: 0.8, interval: { lower: 0.49, upper: 0.94 }, confidence: "baixa", vertical: "moda" }]);
  check("eficácia com dado: n, banda e confiança juntos (nunca percentual solto)", /8 de 10/.test(line) && /49% a 94%/.test(line) && /confiança baixa/.test(line) && /versão 2/.test(line));
  check("eficácia usa a versão mais recente com dado", /versão 2/.test(L.efficacyLine([
    { definitionVersion: 1, completed: 1, failed: 0, inProgress: 0, n: 1, completionRate: 1, interval: null, confidence: "", vertical: null },
    { definitionVersion: 2, completed: 2, failed: 1, inProgress: 0, n: 3, completionRate: 0.66, interval: null, confidence: "", vertical: null },
    { definitionVersion: 3, completed: 0, failed: 0, inProgress: 2, n: 0, completionRate: null, interval: null, confidence: "", vertical: null }])));

  // ── contra o registry REAL ──
  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'x', 'active', 'moda')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'y', 'active', 'clinica')`).run(randomUUID(), B);
  const forA = REG.forOrg(A) as any[]; const forB = REG.forOrg(B) as any[];
  check("o registry real devolve os 3 playbooks", forA.length === 3 && forB.length === 3);
  check("nenhum playbook real sai como 'Certificado' (não há piloto)", forA.every((i) => L.stageLabel(i.playbook.stage) !== "Certificado em piloto"));
  check("empresa sem nada ligado: 'Ainda não está ligado' e eficácia sem dado", forA.every((i) => /Ainda não está ligado/.test(L.adoptionLine(i)) && /Sem execuções/.test(L.efficacyLine(i.efficacy))));
  const closing = (list: any[]) => list.find((i) => i.playbook.id === "retail_daily_closing");
  check("fechamento de loja cabe na moda e NÃO na clínica, com a razão dita", L.fitLine(closing(forA)) === "Cabe no ramo da sua empresa." && /^Não cabe: .+\.$/.test(L.fitLine(closing(forB))));
  const ord = L.orderLibrary(forB);
  check("ordem: os que cabem primeiro, nenhum escondido", ord.length === 3 && ord[ord.length - 1].playbook.id === "retail_daily_closing" && ord.slice(0, 2).every((i) => i.fits));

  // empresa que liga um playbook com autonomia acima do teto → aviso; abaixo → sem aviso
  const defId = randomUUID();
  db.prepare(`INSERT INTO process_definitions (id, organization_id, process_type, version, name, steps_json, active, autonomy_level_default) VALUES (?, ?, 'receivable_collection_v1', 1, 'c', '{}', 1, 'execute')`).run(defId, A);
  const afterA = REG.forOrg(A) as any[];
  const col = afterA.find((i) => i.playbook.id === "collection");
  check("playbook ligado: a linha diz versão e nível", /Ligado na sua empresa \(versão 1/.test(L.adoptionLine(col)) && /executar/.test(L.adoptionLine(col)));
  check("dentro do teto e do estágio: sem aviso", L.ceilingWarning(col) === null);
  const fake = { ...col, autonomyAboveCeiling: true };
  check("passou do teto: aviso explícito", /passa do teto/.test(L.ceilingWarning(fake) || ""));
  check("estágio não permite o nível: usa a razão do servidor", L.ceilingWarning({ ...col, autonomyAboveCeiling: false, canRunAtOrgLevel: { ok: false, reason: "experimental não executa" } }) === "experimental não executa");
  check("isolamento: ligar na empresa A não aparece na B", (REG.forOrg(B) as any[]).every((i) => !i.adopted));

  // ── fiação ──
  const card = read("src/features/playbooklibrary/PlaybookLibraryCard.tsx");
  const settings = read("src/features/SettingsView.tsx");
  const nav = read("src/lib/navCatalog.ts");
  check("sem menu novo (nav não conhece a biblioteca)", !/playbook/i.test(nav));
  check("fica na aba Autonomia da IA, lazy e depois do contrato de autonomia", /lazy\(\(\) => import\('\.\/playbooklibrary\/PlaybookLibraryCard'\)/.test(settings) && /<AutonomyContractPanel \/>[\s\S]{0,200}<PlaybookLibraryCard \/>/.test(settings));
  check("só dono/administrador vê", /user\?\.role !== 'owner' && user\?\.role !== 'admin'\) return null/.test(card));
  check("só carrega ao abrir", /if \(next && !items && state !== 'loading'\) load\(\)/.test(card));
  check("usa a rota existente e trata o 403 do runtime com mensagem honesta", /\/api\/runtime\/playbook-registry/.test(card) && /status === 403[\s\S]{0,60}unavailable/.test(card) && /Execution Runtime está ligado/.test(card));
  check("só leitura: nenhuma chamada de escrita nem botão de ligar/desligar", !/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(card) && !/<button[^>]*onClick=\{\(\) => (activate|enable|start|run)/i.test(card) && (card.match(/<button/g) || []).length === 1 && /Só leitura/.test(card));
  check("sem cálculo de eficácia na tela (só rótulos)", !/wilson/i.test(card) && !/completionRate\s*[*/]/.test(card));
  check("a rota do registry segue existindo e só lê", /router\.get\("\/playbook-registry"/.test(read("src/server/routes/runtime.ts")));

  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - results.filter((r) => !r.ok).length}/${results.length} checks`);
  if (failures) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
