/**
 * TESTE — ADR-206 F5.3: PLAYBOOK REGISTRY versionado (catálogo de plataforma sobre process_definitions).
 * Prova, nos serviços REAIS:
 *   A) catálogo: higiene (sem duplicado, teto ≤ execute/Nível 3, pré-condições e métrica), nenhum 'certified', cópia defensiva;
 *   B) todo playbook do catálogo aponta pra um process_type que o runtime REALMENTE semeia (sem catálogo fantasma);
 *   C) canRun: teto respeitado; experimental não passa de suggest; nível desconhecido recusado;
 *   D) fits por vertical/arquétipo: vertical desconhecida não casa com lista restrita (não chuta); lista vazia = qualquer;
 *   E) forOrg: adoção, autonomia acima do teto sinalizada, isolamento entre empresas;
 *   F) eficácia por versão: derivada das instâncias, n + Wilson + vertical; sem n → null (nunca 0%); versões separadas;
 *   G) fiação: rota montada no router do runtime, sem tabela nova.
 * Uso: npm run test:playbook-registry
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pbr-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pbr-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const S = await import("../src/server/PlaybookRegistryService.js");
  const { PlaybookRegistryService: P } = S;
  const { ProcessRuntimeService } = await import("../src/server/ProcessRuntimeService.js");
  const { CollectionPlaybookService } = await import("../src/server/CollectionPlaybook.js");
  const { SalesRecoveryPlaybookService } = await import("../src/server/SalesRecoveryPlaybook.js");
  const { RetailClosingPlaybookService } = await import("../src/server/RetailClosingPlaybook.js");
  const mkOrg = (vertical: string | null, arch: string | null = null) => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, business_archetype) VALUES (?, ?, 'X', 'active', ?, ?)`).run(randomUUID(), id, vertical, arch); return id; };

  // A) catálogo
  check("registro tem versão e playbooks", S.PLAYBOOK_REGISTRY_VERSION.length > 0 && S.PLAYBOOKS.length >= 3);
  check("lint do catálogo sem problemas", P.lint().length === 0, P.lint().join("|"));
  check("nenhum playbook acima do Nível 3 (execute)", S.PLAYBOOKS.every((p) => S.AUTONOMY_ORDER.indexOf(p.maxAutonomy) <= S.AUTONOMY_ORDER.indexOf("execute")));
  check("nenhum playbook 'certified' (sem piloto, não inventa)", S.PLAYBOOKS.every((p) => p.stage !== "certified"));
  check("catalog() devolve cópia defensiva", (() => { const c = P.catalog(); c.playbooks[0].name = "x"; c.playbooks[0].preconditions.push("y"); const g = P.get(c.playbooks[0].id, c.playbooks[0].version)!; return g.name !== "x" && !g.preconditions.includes("y"); })());
  check("get/latest/byProcessType coerentes", P.get("collection", 1)?.processType === "receivable_collection_v1" && P.latest("collection")?.version === 1 && P.byProcessType("sales_recovery_v1")?.id === "sales_recovery" && P.get("collection", 9) === null && P.latest("nada") === null);
  check("lint pega duplicado e 'certified' (mutação do catálogo)", (() => {
    const bak = S.PLAYBOOKS.slice(); S.PLAYBOOKS.push({ ...S.PLAYBOOKS[0] }); S.PLAYBOOKS[0].stage = "certified";
    const probs = P.lint(); S.PLAYBOOKS.length = 0; S.PLAYBOOKS.push(...bak); S.PLAYBOOKS[0].stage = "validated";
    return probs.some((x) => x.startsWith("duplicado")) && probs.some((x) => x.includes("certified"));
  })());

  // B) catálogo ↔ runtime real
  const seedOrg = mkOrg("moda");
  CollectionPlaybookService.seed(seedOrg); SalesRecoveryPlaybookService.seed(seedOrg); RetailClosingPlaybookService.seed(seedOrg);
  const seeded = new Set((ProcessRuntimeService.listDefinitions(seedOrg) as any[]).map((d) => d.process_type));
  check("todo process_type do catálogo existe no runtime (sem fantasma)", S.PLAYBOOKS.every((p) => seeded.has(p.processType)), [...seeded].join(","));
  check("autonomia semeada de cada playbook ≤ teto do catálogo", S.PLAYBOOKS.every((p) => { const d = ProcessRuntimeService.latestActiveDefinition(seedOrg, p.processType); return S.AUTONOMY_ORDER.indexOf(d.autonomy_level_default) <= S.AUTONOMY_ORDER.indexOf(p.maxAutonomy); }));

  // C) canRun
  const coll = P.get("collection", 1)!;
  check("canRun: dentro do teto libera", P.canRun(coll, "suggest").ok && P.canRun(coll, "execute").ok);
  check("canRun: acima do teto recusa", !P.canRun({ ...coll, maxAutonomy: "suggest" }, "execute").ok);
  check("canRun: experimental não passa de suggest", P.canRun({ ...coll, stage: "experimental" }, "suggest").ok && !P.canRun({ ...coll, stage: "experimental" }, "prepare").ok && !P.canRun({ ...coll, stage: "experimental" }, "execute").ok);
  check("canRun: nível desconhecido recusado", !P.canRun(coll, "autonomous" as any).ok);

  // D) fits
  const clo = P.get("retail_daily_closing", 1)!;
  const moda = mkOrg("moda"), food = mkOrg("food"), semV = mkOrg(null);
  check("fits: vertical certa casa", P.fits(moda, clo).fits);
  check("fits: vertical errada não casa e diz por quê", !P.fits(food, clo).fits && P.fits(food, clo).reasons[0].includes("food"));
  check("fits: vertical desconhecida não casa com lista restrita (não chuta)", !P.fits(semV, clo).fits);
  check("fits: lista vazia = qualquer vertical", P.fits(food, coll).fits && P.fits(semV, coll).fits);
  check("fits: arquétipo restrito exige o arquétipo", !P.fits(moda, { ...clo, archetypes: ["moda_colecao"] }).fits && P.fits(mkOrg("moda", "moda_colecao"), { ...clo, archetypes: ["moda_colecao"] }).fits);

  // E) forOrg
  const vazio = mkOrg("moda");
  const fo0 = P.forOrg(vazio);
  check("forOrg: empresa sem seed → nada adotado, sem eficácia", fo0.length >= 3 && fo0.every((x) => !x.adopted && x.activeDefinition === null && x.efficacy.length === 0 && x.canRunAtOrgLevel === null));
  const fo1 = P.forOrg(seedOrg);
  check("forOrg: seed → adotado com definição ativa", fo1.every((x) => x.adopted && x.activeDefinition && !x.autonomyAboveCeiling));
  db.prepare("UPDATE process_definitions SET autonomy_level_default = 'execute' WHERE organization_id = ? AND process_type = 'receivable_collection_v1'").run(seedOrg);
  const lowCeil = S.PLAYBOOKS.find((p) => p.id === "collection")!; lowCeil.maxAutonomy = "suggest";
  const above = P.forOrg(seedOrg).find((x) => x.playbook.id === "collection")!;
  lowCeil.maxAutonomy = "execute";
  check("forOrg: autonomia da empresa acima do teto é sinalizada", above.autonomyAboveCeiling === true && above.canRunAtOrgLevel?.ok === false);
  check("forOrg: isolamento — outra empresa não vê a adoção", P.forOrg(vazio).every((x) => !x.adopted));

  // F) eficácia por versão
  const defV1 = ProcessRuntimeService.latestActiveDefinition(seedOrg, "receivable_collection_v1");
  const v2 = ProcessRuntimeService.defineProcess(seedOrg, { processType: "receivable_collection_v1", name: "Cobrança v2", steps: JSON.parse(defV1.steps_json) });
  const inst = (defId: string, status: string, org = seedOrg) => db.prepare(`INSERT INTO process_instances (id, organization_id, process_definition_id, process_type, status) VALUES (?, ?, ?, 'receivable_collection_v1', ?)`).run(randomUUID(), org, defId, status);
  for (let i = 0; i < 8; i++) inst(defV1.id, "completed"); inst(defV1.id, "measured"); inst(defV1.id, "failed"); inst(defV1.id, "cancelled"); inst(defV1.id, "executing");
  const ef = P.efficacy(seedOrg, "receivable_collection_v1");
  const e1 = ef.find((x) => x.definitionVersion === 1)!, e2 = ef.find((x) => x.definitionVersion === 2)!;
  check("eficácia v1: 9 concluídas (completed+measured), 1 falha, n=10, taxa 0.9", e1.completed === 9 && e1.failed === 1 && e1.n === 10 && Math.abs(e1.completionRate! - 0.9) < 1e-9);
  check("eficácia v1: canceladas e em andamento ficam de fora e são ditas", e1.cancelled === 1 && e1.inProgress === 1);
  check("eficácia v1: banda de Wilson e confiança presentes, vertical da empresa junto", !!e1.interval && e1.interval.lower < 0.9 && e1.interval.upper > 0.9 && e1.confidence !== "insufficient" && e1.vertical === "moda");
  check("eficácia v2 sem instância → null (nunca 0%) e 'insufficient'", e2.n === 0 && e2.completionRate === null && e2.interval === null && e2.confidence === "insufficient", JSON.stringify(e2));
  check("eficácia: versões separadas (v2 não herda v1)", e2.completed === 0 && v2.version === 2);
  check("eficácia: isolamento — outra empresa não vê instâncias", P.efficacy(vazio, "receivable_collection_v1").length === 0);
  inst(defV1.id, "completed", vazio);
  check("eficácia: instância de outra org com mesmo definition id não contamina", P.efficacy(seedOrg, "receivable_collection_v1").find((x) => x.definitionVersion === 1)!.completed === 9);
  const small = (() => { const o = mkOrg("moda"); CollectionPlaybookService.seed(o); const d = ProcessRuntimeService.latestActiveDefinition(o, "receivable_collection_v1"); db.prepare(`INSERT INTO process_instances (id, organization_id, process_definition_id, process_type, status) VALUES (?, ?, ?, 'receivable_collection_v1', 'completed')`).run(randomUUID(), o, d.id); return P.efficacy(o, "receivable_collection_v1")[0]; })();
  check("1/1 concluída: taxa 1 mas confiança NÃO é alta (banda larga)", small.completionRate === 1 && small.confidence !== "high" && small.interval!.lower < 0.5);

  // G) fiação
  const route = fs.readFileSync(path.join(process.cwd(), "src/server/routes/runtime.ts"), "utf8");
  check("rota /playbook-registry montada no router do runtime", /router\.get\("\/playbook-registry"/.test(route) && route.includes("PlaybookRegistryService"));
  const dbsrc = fs.readFileSync(path.join(process.cwd(), "src/server/db.ts"), "utf8");
  check("sem tabela nova de registry/playbook", !/CREATE TABLE IF NOT EXISTS (playbook_registry|playbook_versions|playbook_catalog)/.test(dbsrc));

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : r.d ? "  → " + r.d : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
