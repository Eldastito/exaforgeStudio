/**
 * TESTE — ADR-206 F5.8: STRATEGIC POLICY com pesos (o dono diz o que importa mais; a priorização se inclina em até 25%).
 * Prova, nos serviços REAIS:
 *   A) objetivos: lista fechada, domínios sem sobreposição, domínios protegidos fora de qualquer objetivo; fator limitado a ±25%, 50 = neutro;
 *   B) validação dos pesos (objetivo desconhecido, não-inteiro, fora de 0–100, vazio);
 *   C) sem política = priorização IDÊNTICA (fator 1); com política o ranking se inclina na direção certa, pelo objetivo certo;
 *   D) só PESSOA define; versionada e append-only; histórico; reset volta ao neutro sem apagar;
 *   E) NÃO esconde nada, NÃO muda nível de impacto/aprovação, NÃO rebaixa segurança/compliance/jurídico/governança nem o override crítico;
 *   F) prioridade temporal: validade futura ok, passada recusada, vencida volta ao neutro sozinha;
 *   G) prévia mostra antes/depois sem gravar; scoreOne coerente com o feed; isolamento por empresa; fiação.
 * Uso: npm run test:strategic-policy
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-spol-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-spol-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const S = await import("../src/server/StrategicPolicyService.js");
  const { StrategicPolicyService: P } = S;
  const { ImpactPrioritizationService: I } = await import("../src/server/ImpactPrioritizationService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const sig = (org: string, domain: string, type: string, amount: number, severity = "attention") =>
    BusinessSignalService.publish(org, { domain, signalType: type, severity, basis: "fact", confidence: 0.8, impactAmount: amount, impactUnit: "BRL", sourceService: "t", dedupeKey: `${domain}:${type}:${randomUUID()}`, evidence: {} }).id;
  const order = (org: string, opts: any = {}) => I.prioritize(org, { globalLimit: 50, perDomain: 50, skipGoals: true, ...opts }).global.map((x: any) => x.domain);

  // A) objetivos e fator
  const allDomains = S.OBJECTIVES.flatMap((o) => o.domains);
  check("5 objetivos fechados com rótulo e dica", S.OBJECTIVES.length === 5 && S.OBJECTIVES.every((o) => o.label && o.hint && o.domains.length));
  check("nenhum domínio pertence a dois objetivos", new Set(allDomains).size === allDomains.length);
  check("domínios protegidos não estão em nenhum objetivo", S.PROTECTED_DOMAINS.every((d) => !allDomains.includes(d)) && ["security", "compliance", "legal", "governance", "platform"].every((d) => S.PROTECTED_DOMAINS.includes(d)));
  check("fator: 50→1, 100→1,25, 0→0,75, monotônico, limitado", S.factorOf(50) === 1 && S.factorOf(100) === 1.25 && S.factorOf(0) === 0.75 && S.factorOf(70) > S.factorOf(60) && S.factorOf(1000) === 1.25 && S.factorOf(-5) === 0.75);

  // B) validação
  const bad = (w: any) => P.validate(w).ok === false;
  check("validação recusa objetivo desconhecido, não-inteiro, fora de faixa, texto, nulo, vazio, lista", bad({ x: 50 }) && bad({ cash: 50.5 }) && bad({ cash: 101 }) && bad({ cash: -1 }) && bad({ cash: "alto" }) && bad({ cash: null }) && bad({ cash: "" }) && bad({}) && bad([]) && bad(null) && bad("cash"));
  check("validação aceita parcial e extremos", P.validate({ cash: 0 }).ok && P.validate({ cash: 100, sales: 50 }).ok && P.validate({}, { allowEmpty: true }).ok);

  // C) sem política = idêntico; com política, inclina
  const o1 = mkOrg();
  sig(o1, "finance", "receivable_overdue", 1000); sig(o1, "sales", "retail_seller_below_quota", 900); sig(o1, "inventory", "consumo_cobertura_baixa", 800);
  const base = I.prioritize(o1, { globalLimit: 50, perDomain: 50, skipGoals: true }).global;
  check("sem política: fator 1 em todos, policyObjective null, explain.inEffect false", base.every((x: any) => x.components.policyFactor === 1 && x.components.policyObjective === null) && P.explain(o1).inEffect === false && P.active(o1) === null);
  const baseOrder = order(o1);
  check("base: ordenado por impacto (finance, sales, inventory)", baseOrder.join() === "finance,sales,inventory", baseOrder.join());
  const r1 = P.set(o1, { weights: { cash: 0, sales: 100 }, note: "trimestre de crescimento" }, "owner-1");
  check("pessoa define → versão 1 vigente", r1.ok === true && r1.version === 1 && P.active(o1)!.version === 1 && P.explain(o1).inEffect === true);
  const polOrder = order(o1);
  check("com sales=100 e cash=0 a ordem se inclina: vendas passam à frente de caixa", polOrder.indexOf("sales") < polOrder.indexOf("finance"), polOrder.join());
  const withPol = I.prioritize(o1, { globalLimit: 50, perDomain: 50, skipGoals: true }).global;
  const fin = withPol.find((x: any) => x.domain === "finance"), sal = withPol.find((x: any) => x.domain === "sales"), inv = withPol.find((x: any) => x.domain === "inventory");
  check("fatores certos e explicáveis: caixa 0,75 · vendas 1,25 · estoque (não informado) 1", fin.components.policyFactor === 0.75 && fin.components.policyObjective === "cash" && sal.components.policyFactor === 1.25 && sal.components.policyObjective === "sales" && inv.components.policyFactor === 1 && inv.components.policyObjective === null);
  check("score = score base × fator (inclinação de no máximo 25%)", Math.abs(fin.score - base.find((x: any) => x.domain === "finance").score * 0.75) < 0.0002 && Math.abs(sal.score - base.find((x: any) => x.domain === "sales").score * 1.25) < 0.0002);
  P.set(o1, { weights: { cash: 50, sales: 50 } }, "owner-1");
  check("peso 50 não marca objetivo no sinal (neutro de verdade)", I.prioritize(o1, { globalLimit: 50, perDomain: 50, skipGoals: true }).global.every((x: any) => x.components.policyObjective === null && x.components.policyFactor === 1));
  check("peso 50 em tudo é neutro (ordem original)", order(o1).join() === baseOrder.join());

  // E) não esconde, não muda nível, protegidos
  const o2 = mkOrg();
  sig(o2, "finance", "receivable_overdue", 1000, "risk"); sig(o2, "sales", "retail_seller_below_quota", 900, "risk");
  const secId = sig(o2, "security", "anomalous_behavior", 10, "critical"); sig(o2, "legal", "x_legal", 5000, "risk"); sig(o2, "governance", "autonomy_regressed", 4000, "risk"); sig(o2, "falatu", "x_falatu", 3000, "risk");
  const beforeAll = I.prioritize(o2, { globalLimit: 50, perDomain: 50, skipGoals: true }).global;
  P.set(o2, { weights: { cash: 0, sales: 0, stock: 0, service: 0, operations: 0 } }, "owner-1");
  const afterAll = I.prioritize(o2, { globalLimit: 50, perDomain: 50, skipGoals: true }).global;
  check("NÃO esconde nenhum sinal (mesma quantidade antes e depois)", beforeAll.length === afterAll.length && beforeAll.length === 6);
  check("NÃO muda nível de impacto nem aprovação", beforeAll.every((b: any) => { const a = afterAll.find((x: any) => x.signalId === b.signalId); return a.impactLevel === b.impactLevel && JSON.stringify(a.approvalNeeded) === JSON.stringify(b.approvalNeeded) && a.analysis.humanApprovalRequired === b.analysis.humanApprovalRequired; }));
  const pick = (arr: any[], d: string) => arr.find((x: any) => x.domain === d);
  check("segurança, jurídico, governança e domínio sem objetivo: score IDÊNTICO com todos os pesos em 0", ["security", "legal", "governance", "falatu"].every((d) => pick(beforeAll, d).score === pick(afterAll, d).score && pick(afterAll, d).components.policyFactor === 1));
  check("override crítico de segurança continua em 1º lugar", afterAll[0].signalId === secId && afterAll[0].override === true);
  check("domínios mapeados são rebaixados com todos em 0 (efeito real)", pick(afterAll, "finance").score < pick(beforeAll, "finance").score && pick(afterAll, "sales").score < pick(beforeAll, "sales").score);

  // defesa em profundidade: mesmo que alguém coloque um domínio protegido dentro de um objetivo, o fator o ignora
  S.OBJECTIVES[0].domains.push("security");
  check("domínio protegido injetado num objetivo continua sem fator (defesa em profundidade)", P.factors(o2, { cash: 0 }).has("security") === false && P.factors(o2, { cash: 0 }).has("finance") === true);
  S.OBJECTIVES[0].domains.pop();

  // D) append-only, histórico, reset, só pessoa
  check("rótulo de sistema / sem identidade recusados", P.set(o1, { weights: { cash: 10 } }, "system:policy").ok === false && P.set(o1, { weights: { cash: 10 } }, "ai").ok === false && P.set(o1, { weights: { cash: 10 } }, "").ok === false && P.reset(o1, "bot-1").ok === false && P.reset(o1, undefined).ok === false);
  const nVers = (db.prepare("SELECT COUNT(*) n FROM strategic_policy_versions WHERE organization_id = ?").get(o1) as any).n;
  check("tentativas inválidas não gravam versão", nVers === 2 && P.set(o1, { weights: { cash: 500 } }, "owner-1").ok === false && (db.prepare("SELECT COUNT(*) n FROM strategic_policy_versions WHERE organization_id = ?").get(o1) as any).n === 2);
  const rs = P.reset(o1, "owner-1", "voltando ao normal");
  check("reset = nova versão neutra (3), histórico preservado, ordem volta ao base", rs.ok === true && rs.version === 3 && P.history(o1).length === 3 && P.history(o1)[0].version === 3 && Object.keys(P.history(o1)[0].weights).length === 0 && P.history(o1)[2].weights.sales === 100 && order(o1).join() === baseOrder.join() && P.explain(o1).inEffect === false);
  const aud = db.prepare("SELECT event_type e FROM auth_audit_logs WHERE organization_id = ? AND event_type LIKE 'STRATEGIC_POLICY_%'").all(o1) as any[];
  check("auditado (SET e RESET) com a pessoa", aud.filter((a) => a.e === "STRATEGIC_POLICY_SET").length === 2 && aud.some((a) => a.e === "STRATEGIC_POLICY_RESET"));
  const src = fs.readFileSync(path.join(process.cwd(), "src/server/StrategicPolicyService.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  check("append-only no código: nenhum UPDATE/DELETE", !/\b(UPDATE|DELETE)\b/i.test(src));
  check("nota higienizada e limitada", (() => { const o = mkOrg(); P.set(o, { weights: { cash: 60 }, note: "x".repeat(900) }, "u"); return (P.active(o)!.note || "").length <= 300; })());

  // F) temporal
  const o3 = mkOrg();
  sig(o3, "finance", "receivable_overdue", 1000); sig(o3, "sales", "retail_seller_below_quota", 900);
  check("validade no passado / data inválida recusadas", P.set(o3, { weights: { sales: 100, cash: 0 }, validUntil: "2000-01-01" }, "u").ok === false && P.set(o3, { weights: { sales: 100 }, validUntil: "amanhã" }, "u").ok === false && P.set(o3, { weights: { sales: 100 }, validUntil: "2099-02-31x" }, "u").ok === false);
  const fut = P.set(o3, { weights: { sales: 100, cash: 0 }, validUntil: "2099-12-31" }, "u");
  check("validade futura aceita e em vigor", fut.ok === true && P.active(o3)!.validUntil === "2099-12-31" && P.active(o3)!.expired === false && order(o3)[0] === "sales");
  db.prepare("UPDATE strategic_policy_versions SET valid_until = '2020-01-01' WHERE organization_id = ?").run(o3); // simula o tempo passando
  check("vencida volta ao neutro SOZINHA (sem job), marcada como expirada", P.active(o3)!.expired === true && P.explain(o3).inEffect === false && order(o3)[0] === "finance" && I.prioritize(o3, { globalLimit: 5, skipGoals: true }).global.every((x: any) => x.components.policyFactor === 1));

  // G) prévia, scoreOne, isolamento, fiação
  const o4 = mkOrg(); const idF = sig(o4, "finance", "receivable_overdue", 1000); const idS = sig(o4, "sales", "retail_seller_below_quota", 900);
  const vBefore = (db.prepare("SELECT COUNT(*) n FROM strategic_policy_versions WHERE organization_id = ?").get(o4) as any).n;
  const pv: any = await P.preview(o4, { sales: 100, cash: 0 });
  check("prévia: mostra antes/depois, changed:true e NÃO grava", pv.ok && pv.changed === true && pv.before[0].domain === "finance" && pv.after[0].domain === "sales" && pv.saved === false && (db.prepare("SELECT COUNT(*) n FROM strategic_policy_versions WHERE organization_id = ?").get(o4) as any).n === vBefore && P.active(o4) === null);
  check("prévia de pesos inválidos devolve erro", (await P.preview(o4, { cash: 999 }) as any).ok === false);
  P.set(o4, { weights: { sales: 100, cash: 0 } }, "u");
  const one = I.scoreOne(o4, idS)!, feed = I.prioritize(o4, { globalLimit: 50, skipGoals: true }).global.find((x: any) => x.signalId === idS);
  check("scoreOne coerente com o feed (mesma política)", one.score === feed.score && one.components.policyFactor === 1.25 && I.scoreOne(o4, idF)!.components.policyFactor === 0.75);
  const o5 = mkOrg(); sig(o5, "finance", "receivable_overdue", 1000);
  check("isolamento: política de uma empresa não afeta outra", I.prioritize(o5, { skipGoals: true }).global[0].components.policyFactor === 1 && P.active(o5) === null);
  const route = fs.readFileSync(path.join(process.cwd(), "src/server/routes/decisionIntelligence.ts"), "utf8");
  check("rotas montadas; PUT/reset só owner/admin", /"\/strategic-policy"/.test(route) && /"\/strategic-policy\/preview"/.test(route) && /router\.put\("\/strategic-policy"[\s\S]{0,260}owner[\s\S]{0,40}admin/.test(route) && /"\/strategic-policy\/reset"[\s\S]{0,260}owner[\s\S]{0,40}admin/.test(route));
  const dbsrc = fs.readFileSync(path.join(process.cwd(), "src/server/db.ts"), "utf8");
  check("1 tabela aditiva com UNIQUE(org,versão); nenhuma tabela de alerta", /CREATE TABLE IF NOT EXISTS strategic_policy_versions/.test(dbsrc) && /idx_strategic_policy_versions_uniq/.test(dbsrc));
  check("sem LLM no serviço", !/\b(chat\(|openai|anthropic|LlmService)\b/i.test(src));

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : r.d ? "  → " + r.d : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
