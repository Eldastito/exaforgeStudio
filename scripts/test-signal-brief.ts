/**
 * TESTE — PRD Fase 1, critério de sucesso: "Entendi o que aconteceu… Quer que eu execute?" (S4c-1).
 * O briefing que o gestor vê ANTES de o botão criar a ação. Prova: traz o que houve (linguagem empresarial), a causa MAIS PROVÁVEL
 * como HIPÓTESE quando há correlação que a sustente — e "ainda não identifiquei" quando não há (nunca inventa); só dados da lista
 * branca da evidência (chave técnica não vaza); impacto fato/estimativa rotulado e role-gated; a ação recomendada é a MESMA do
 * /act; termina com "Quer que eu execute?"; é READ-ONLY (não cria ação); sinal resolvido/outra org = não encontrado; sem LLM.
 * Uso:  npm run test:signal-brief
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sigbrief-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-sigbrief-1234567890";

let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SignalBriefService: B } = await import("../src/server/SignalBriefService.js");
  const { BusinessSignalService: S } = await import("../src/server/BusinessSignalService.js");
  const { PermissionService: P } = await import("../src/server/PermissionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const A = mkOrg(), O = mkOrg();
  P.seedSystemProfiles(A);
  const owner = { id: "u1", role: "owner", userId: "u1" };
  const pub = (org: string, over: any) => S.publish(org, { domain: "retail_ops", signalType: "retail_store_stockout", severity: "risk", basis: "fact", confidence: 0.9, impactAmount: 4, impactUnit: "units", sourceService: "test", sourceEntityType: "retail_store", sourceEntityId: "s1", evidence: { store: "Bangu", alerts: 4, internal_debug_flag: "x", dead_letter: "y", nested: { a: 1 } }, dedupeKey: `t:${randomUUID()}`, ...over } as any);

  // ── sinal sem hipótese de causa ──
  const s1 = pub(A, {});
  const b = B.brief(A, s1.id, owner);
  const dump = JSON.stringify(b);
  check("traz o que aconteceu na linguagem do gestor (não o tipo técnico)", b.found && /^Entendi o que aconteceu: /.test(b.understood || "") && /divergência de estoque/i.test(b.understood || "") && !/retail_store_stockout|retail_ops/.test(dump), dump);
  check("sem correlação que sustente: diz que NÃO identificou a causa (nunca inventa)", b.cause?.known === false && /Ainda não identifiquei a causa/.test(b.cause.text) && b.cause.confidencePct === null, dump);
  check("dados que sustentam: só a lista branca, com rótulo humano (chave técnica/aninhada não vaza)", !!b.evidence?.find((e) => e.label === "Loja" && e.value === "Bangu") && !!b.evidence?.find((e) => e.label === "Itens com divergência" && e.value === "4") && !/internal_debug|dead_letter|nested|"a":/.test(dump), dump);
  check("a ação recomendada é a MESMA que o /act cria", b.recommendation?.label === "Investigar divergência" && b.recommendation?.willDo.length > 10);
  check("termina com 'Quer que eu execute?' e explica a regra de aprovação (nada executa sem passar por ela)", b.question === "Quer que eu execute?" && /regra de aprovação/.test(b.governance || ""));
  check("impacto rotulado como FATO", b.impact?.basis === "fato" && b.impact?.amount === 4 && b.impact?.restricted === false);

  // ── causa provável como hipótese (correlação sustenta) ──
  const corr = randomUUID();
  const top = S.publish(A, { domain: "inventory", signalType: "stockout_risk", severity: "risk", basis: "estimate", confidence: 0.7, sourceService: "test", sourceEntityType: "product", sourceEntityId: "p1", evidence: { product: "Camisa Polo" }, dedupeKey: `t:${randomUUID()}`, correlationId: corr } as any);
  S.publish(A, { domain: "procurement", signalType: "supplier_delay", severity: "attention", basis: "fact", confidence: 0.8, sourceService: "test", sourceEntityType: "product", sourceEntityId: "p1", evidence: {}, dedupeKey: `t:${randomUUID()}`, correlationId: corr } as any);
  const bc = B.brief(A, top.id, owner);
  check("com correlação que sustenta: 'Causa mais provável' — como HIPÓTESE, com confiança, nunca como fato", bc.cause?.known === true && /Causa mais provável: Fornecedor atrasado/.test(bc.cause.text) && /hipótese/.test(bc.cause.text) && bc.cause.basis === "hypothesis" && (bc.cause.confidencePct || 0) > 0, JSON.stringify(bc.cause));

  // ── read-only ──
  const before = (db.prepare(`SELECT COUNT(*) AS c FROM decision_actions WHERE organization_id = ?`).get(A) as any).c;
  B.brief(A, s1.id, owner); B.brief(A, top.id, owner);
  check("é read-only: ver o briefing NÃO cria ação (só o /act cria)", (db.prepare(`SELECT COUNT(*) AS c FROM decision_actions WHERE organization_id = ?`).get(A) as any).c === before);

  // ── dinheiro role-gated ──
  const money = pub(A, { signalType: "retail_floor_declared_vs_pdv_gap", domain: "retail_floor", impactAmount: 1250.5, impactUnit: "BRL", basis: "estimate", evidence: { store: "Carioca", unmatchedCount: 3, unmatchedDeclaredValue: 1250.5 } });
  const bm = B.brief(A, money.id, owner);
  check("dono vê o valor e o rótulo 'estimativa'", bm.impact?.amount === 1250.5 && bm.impact?.basis === "estimativa" && bm.impact?.restricted === false);
  const restricted = { id: "u2", userId: "u2", role: "agent" };
  const br = B.brief(A, money.id, restricted);
  check("papel sem visão completa: sabe que HÁ impacto, mas o valor fica reservado (§73)", br.impact?.restricted === true && br.impact?.amount === null && !/1250/.test(JSON.stringify(br)), JSON.stringify(br.impact));

  // ── não encontrado / isolamento ──
  S.resolveByDedupe(A, (db.prepare(`SELECT dedupe_key FROM business_signals WHERE id = ?`).get(s1.id) as any).dedupe_key);
  check("sinal já resolvido: não encontrado (nunca ofereço executar o que não vale mais)", B.brief(A, s1.id, owner).found === false);
  check("isolamento: sinal de outra org = não encontrado", B.brief(O, top.id, owner).found === false);

  console.log(failures ? `\n${failures} FALHA(S)` : "\nTodas as verificações OK");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
