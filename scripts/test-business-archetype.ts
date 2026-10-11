/**
 * TESTE — ADR-206 F5.2: ARQUÉTIPO OPERACIONAL + resolvedor em camadas (organização > arquétipo > vertical > plataforma).
 * ----------------------------------------------------------------------------
 * Prova, nos serviços REAIS:
 *   A) catálogo: só arquétipos com política real por trás; cada política declarada existe e tem valor válido;
 *   B) precedência: sem nada → plataforma (continuous, 0-regressão); com arquétipo → arquétipo; com escolha da própria empresa
 *      → ORGANIZAÇÃO vence o arquétipo; limpar o arquétipo volta ao fundo; cada resposta diz DE ONDE veio (layers);
 *   C) escolha do arquétipo: só PESSOA, só se cabe na vertical, desconhecido recusado, NÃO sobrescreve o que a empresa já
 *      configurou, auditado, isolado por empresa; vertical desconhecida/sem arquétipo não recebe pergunta;
 *   D) a pergunta guiada some depois da escolha; opções em linguagem de dono;
 *   E) consumidores reais: RetailReplenishmentStrategyService.strategy/classify/suggestsRepurchase seguem o resolvedor
 *      (coleção: zerar = fim de ciclo normal; contínua: ruptura) e 0-regressão sem arquétipo;
 *   F) fiação: coluna aditiva, rotas montadas, sem tabela nova.
 * Uso: npm run test:business-archetype
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-arch-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-arch-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const S = await import("../src/server/BusinessArchetypeService.js");
  const { BusinessArchetypeService: B } = S;
  const { RetailReplenishmentStrategyService: R } = await import("../src/server/RetailReplenishmentStrategyService.js");
  const mkOrg = (vertical: string | null) => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'X', 'active', ?)`).run(randomUUID(), id, vertical); return id; };
  const moda = mkOrg("moda"), moda2 = mkOrg("moda"), food = mkOrg("food"), semVert = mkOrg(null);
  const colRow = (org: string) => db.prepare("SELECT business_archetype, retail_replenishment_strategy FROM organization_settings WHERE organization_id = ?").get(org) as any;

  // ── A) catálogo ──
  check("catálogo versionado e não vazio", S.ARCHETYPE_CATALOG_VERSION.length > 0 && S.ARCHETYPES.length >= 2);
  check("toda política de um arquétipo existe no registro de políticas, com valor válido", S.ARCHETYPES.every((a) => Object.entries(a.policies).every(([k, v]) => S.POLICIES.some((p) => p.key === k && p.values.includes(v)))));
  check("chaves de arquétipo únicas e cada um declara vertical", new Set(S.ARCHETYPES.map((a) => a.key)).size === S.ARCHETYPES.length && S.ARCHETYPES.every((a) => a.verticals.length > 0));
  check("catalog() devolve cópia (não vaza o objeto interno)", (() => { const c = B.catalog(); c.archetypes[0].label = "x"; return B.get("moda_colecao")!.label === "Moda — coleção"; })());

  // ── B) precedência ──
  const r0 = B.resolve(moda, "retail_replenishment_strategy")!;
  check("sem nada: plataforma (continuous) — 0-regressão", r0.value === "continuous_replenishment" && r0.source === "platform" && r0.archetype === null);
  check("camadas sempre listadas na ordem org > arquétipo > vertical > plataforma", r0.layers.map((l) => l.source).join(">") === "organization>archetype>vertical>platform");
  check("política desconhecida → null (não inventa)", B.resolve(moda, "nao_existe") === null);
  check("escolhe moda_colecao (pessoa, vertical certa)", B.select(moda, "moda_colecao", "user-1").ok === true && colRow(moda).business_archetype === "moda_colecao");
  const r1 = B.resolve(moda, "retail_replenishment_strategy")!;
  check("com arquétipo: o valor vem do ARQUÉTIPO e diz qual", r1.value === "collection_sellout" && r1.source === "archetype" && r1.archetype === "moda_colecao");
  R.setStrategy(moda, "continuous_replenishment", "user-1");
  const r2 = B.resolve(moda, "retail_replenishment_strategy")!;
  check("a escolha da PRÓPRIA empresa vence o arquétipo", r2.value === "continuous_replenishment" && r2.source === "organization" && r2.layers[1].value === "collection_sellout");
  B.select(moda, null, "user-1");
  check("limpar o arquétipo mantém a escolha da empresa", B.resolve(moda, "retail_replenishment_strategy")!.source === "organization");
  db.prepare("UPDATE organization_settings SET retail_replenishment_strategy = NULL WHERE organization_id = ?").run(moda);
  check("sem escolha própria e sem arquétipo: volta ao fundo (plataforma)", B.resolve(moda, "retail_replenishment_strategy")!.source === "platform");
  db.prepare("UPDATE organization_settings SET retail_replenishment_strategy = 'valor_lixo' WHERE organization_id = ?").run(moda);
  check("valor inválido na camada da empresa é ignorado (cai pra próxima), não quebra", B.resolve(moda, "retail_replenishment_strategy")!.value === "continuous_replenishment");
  db.prepare("UPDATE organization_settings SET retail_replenishment_strategy = NULL WHERE organization_id = ?").run(moda);
  db.prepare("UPDATE organization_settings SET business_archetype = 'arquetipo_que_sumiu' WHERE organization_id = ?").run(moda);
  check("arquétipo gravado que saiu do catálogo vale como 'sem arquétipo'", B.current(moda) === null && B.resolve(moda, "retail_replenishment_strategy")!.source === "platform");
  db.prepare("UPDATE organization_settings SET business_archetype = NULL WHERE organization_id = ?").run(moda);

  // ── C) escolha ──
  for (const bad of [undefined, null, "", "   ", "ai", "system", "runtime", "agent:x", "bot-1"]) check(`select recusa autor "${String(bad)}"`, B.select(moda2, "moda_colecao", bad as any).ok === false);
  check("arquétipo desconhecido recusado", B.select(moda2, "xpto", "user-1").ok === false);
  check("arquétipo de outra vertical recusado (food não recebe moda)", B.select(food, "moda_colecao", "user-1").ok === false && colRow(food).business_archetype === null);
  check("vertical desconhecida: nenhum arquétipo se aplica", B.applicable(semVert).length === 0 && B.select(semVert, "moda_colecao", "user-1").ok === false);
  check("empresa inexistente recusada", B.select("org-fantasma", "moda_colecao", "user-1").ok === false);
  check("nada mudou depois das recusas", colRow(moda2).business_archetype === null);
  R.setStrategy(moda2, "continuous_replenishment", "u");
  B.select(moda2, "moda_colecao", "user-1");
  check("escolher NÃO sobrescreve o que a empresa já configurou", colRow(moda2).retail_replenishment_strategy === "continuous_replenishment" && R.strategy(moda2) === "continuous_replenishment");
  const audit = db.prepare("SELECT 1 FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'BUSINESS_ARCHETYPE_SET' AND actor_user_id = 'user-1'").get(moda2);
  check("escolha é auditada", !!audit);
  check("isolamento: escolher em uma empresa não muda a outra", colRow(moda).business_archetype === null && B.current(moda) === null);

  // ── D) pergunta guiada ──
  const q = B.question(moda);
  check("moda sem arquétipo recebe a pergunta, com opções em linguagem de dono", !!q && /coleção/.test(q.text) && q.options.length === 2 && q.options.every((o) => o.label && o.description));
  check("food (sem arquétipo aplicável) NÃO recebe pergunta", B.question(food) === null && B.question(semVert) === null);
  B.select(moda, "moda_reposicao_continua", "user-1");
  check("a pergunta some depois da escolha", B.question(moda) === null);
  const ex = B.explain(moda);
  check("explain: arquétipo atual, precedência explícita e política com origem", ex.archetype!.key === "moda_reposicao_continua" && ex.precedence.join(">") === "organization>archetype>vertical>platform" && ex.policies[0].source === "archetype");

  // ── E) consumidores reais ──
  const c1 = mkOrg("moda");
  check("0-regressão: sem arquétipo, zerar = ruptura (problema)", R.strategy(c1) === "continuous_replenishment" && R.classify(c1, 0).problem === true);
  B.select(c1, "moda_colecao", "user-1");
  check("coleção via arquétipo: zerar = fim de ciclo NORMAL (sem alerta)", R.strategy(c1) === "collection_sellout" && R.classify(c1, 0).problem === false && /Fim de ciclo/.test(R.classify(c1, 0).label));
  check("coleção: negativo continua anomalia (qualquer estratégia)", R.classify(c1, -3).problem === true);
  check("coleção: não sugere recompra sem política da peça", R.suggestsRepurchase(c1, "prod-sem-politica") === false);
  R.setStrategy(c1, "continuous_replenishment", "user-1");
  check("a empresa decide o contrário: a escolha dela vence o arquétipo nos consumidores", R.strategy(c1) === "continuous_replenishment" && R.classify(c1, 0).problem === true);

  // ── F) fiação ──
  const dbs = fs.readFileSync(path.resolve(process.cwd(), "src/server/db.ts"), "utf8");
  const routes = fs.readFileSync(path.resolve(process.cwd(), "src/server/routes/retailops.ts"), "utf8");
  check("fiação: coluna aditiva business_archetype, sem tabela nova", /ADD COLUMN business_archetype TEXT/.test(dbs) && !/CREATE TABLE IF NOT EXISTS (business_archetypes|archetypes|archetype_policies)\b/i.test(dbs));
  check("fiação: rotas GET/PUT /archetype montadas; PUT exige escopo de rede", /router\.get\("\/archetype"/.test(routes) && /router\.put\("\/archetype", requireNetworkScope/.test(routes));

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.d}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
