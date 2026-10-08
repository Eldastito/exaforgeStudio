/**
 * TESTE — ADR-205 F4.9: contexto EXTERNO ao lado de uma decisão (ExternalDecisionContextService).
 * Prova: consumo do pool compartilhado SEM pesquisar · opt-in/nicho/frescor honestos · FONTE e DATA em cada item · síntese do modelo ≠ fonte viva (mesmo que se declare "live" sem fonte datada) ·
 * texto externo = dado não confiável (limpo, truncado, marcado) · NÃO altera nenhum número (cenário idêntico antes/depois) · premissas editáveis reaproveitadas do ScenarioEngine ·
 * perguntas, nunca conclusão · confiança nunca alta · sem benchmark entre empresas · isolamento · rotas gestor-only · composição.
 * Uso: npm run test:external-decision-context
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http";
import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-extctx-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-extctx-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ExternalDecisionContextService: X, DECISION_KINDS } = await import("../src/server/ExternalDecisionContextService.js");
  const { VerticalIntelligenceService: V, researchFingerprint } = await import("../src/server/VerticalIntelligenceService.js");
  const { ScenarioEngine } = await import("../src/server/ScenarioEngine.js");
  const { FinancialLedgerService: F } = await import("../src/server/FinancialLedgerService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");
  const mkOrg = (vertical: string | null, optIn: boolean) => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, external_intelligence_enabled) VALUES (?, ?, 'Loja Teste', 'active', ?, ?)`).run(randomUUID(), id, vertical, optIn ? 1 : 0); PM.seedSystemProfiles(id); return id; };
  const thrown = (f: () => any) => { try { f(); return null; } catch (e: any) { return e?.code || "error"; } };
  const A = mkOrg("moda", true), NOVERT = mkOrg(null, true), OPTOUT = mkOrg("moda", false), OTHER = mkOrg("restaurante", true);
  F.recordEvent(A, { direction: "in", amount: 50000 });
  const master = { userId: "master-1", organizationId: null };
  const pub = (topic: string, content: any, sources: string[] = [], confidence = 0.7, vertical = "moda") => V.publish(master, { vertical, topic, content, sources, confidence, provider: "manual", ttlDays: 30 });
  pub("demanda e sazonalidade", { summary: "Demanda de moda sobe antes do Dia das Mães e no fim do ano.", drivers: ["Datas comemorativas", "Clima"], evidenceMode: "live", retrievedAt: "2026-10-01", sourceEvidence: [{ title: "Pesquisa de varejo", url: "https://exemplo.com/relatorio", publisher: "Entidade X", tier: "A", retrievedAt: "2026-10-01" }] }, ["https://exemplo.com/relatorio"], 0.8);
  pub("preço e prazo de fornecedores", { summary: "Fornecedores sinalizam reajuste moderado no atacado.", drivers: ["Custo de matéria-prima"], evidenceMode: "model_knowledge" }, ["relatório citado pelo modelo"], 0.5);
  pub("tendências de coleção", { summary: "Tons terrosos em alta.", evidenceMode: "live", sourceEvidence: [] }, [], 0.6);     // declara live, MAS sem fonte datada
  pub("calendário comercial", { summary: "Datas fortes do varejo no fim do ano.", evidenceMode: "live", retrievedAt: "2026-09-01", sourceEvidence: [{ title: "Blog sem data", url: "https://exemplo.com/blog", publisher: null, tier: "C", retrievedAt: null }] }, [], 0.6);   // declara live + data, mas só fonte tier C sem data
  const longText = "x".repeat(2000);
  pub("concorrência e promoções", { summary: "Linha1\nLinha2\u0007 " + longText, drivers: ["a".repeat(400), "b", "c", "d", "e", "f", "g"], evidenceMode: "model_knowledge" }, [], 0.4);

  // validação
  check("o tipo de decisão é validado (6 tipos) e os tópicos livres são saneados e limitados", DECISION_KINDS.length === 6 && thrown(() => X.forDecision(A, { kind: "nova_loja" })) === "invalid_kind" && thrown(() => X.forDecision(A, { kind: "" })) === "invalid_kind"
    && thrown(() => X.forDecision(A, { kind: "purchase", topics: ["<script>alert(1)</script>"] })) === "invalid_topic" && thrown(() => X.forDecision(A, { kind: "purchase", topics: ["ab"] })) === "invalid_topic"
    && thrown(() => X.forDecision(A, { kind: "purchase", topics: ["um", "dois tópicos", "três tópicos", "quatro tópicos", "cinco tópicos", "seis tópicos"] })) === "too_many_topics");

  // sem nicho / sem opt-in
  const nv = X.forDecision(NOVERT, { kind: "purchase" });
  check("sem nicho cadastrado → vazio e honesto, com o motivo (não inventa)", nv.vertical === null && nv.items.length === 0 && nv.confidence.level === "baixa" && nv.caveats.some((c: string) => /nicho/.test(c)) && nv.questions.length === 0);
  const oo = X.forDecision(OPTOUT, { kind: "purchase" });
  check("sem opt-in da empresa → nada é carregado: todos os itens 'opt_out' e o aviso explica", oo.brokerEnabled === false && oo.items.length === 3 && oo.items.every((i: any) => i.available === false && i.reason === "opt_out") && oo.caveats.some((c: string) => /desligada/.test(c)));

  // contexto
  const before = ScenarioEngine.run(A, "purchase", { amount: 9000, payInWeeks: 2 });
  const cnt = () => ["decision_actions", "business_signals", "tasks", "strategic_decisions", "strategic_plans"].map((t) => (db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE organization_id = ?`).get(A) as any).c).join(",");
  const c0 = cnt();
  const r = X.forDecision(A, { kind: "purchase" });
  const item = (t: string) => r.items.find((i: any) => i.topic === t) as any;
  check("é leitura de contexto, não previsão nem ação, e declara que NÃO mexe em cálculo", r.type === "external_context" && r.isForecast === false && r.executes === false && r.affectsCalculations === false && r.brokerEnabled === true && r.vertical === "moda");
  check("usa os tópicos do tipo de decisão (compra: demanda/sazonalidade, preço e prazo de fornecedores, tendências de coleção)", r.items.map((i: any) => i.topic).join("|") === "demanda e sazonalidade|preço e prazo de fornecedores|tendências de coleção" && X.topicsFor("purchase").length === 3);
  const live = item("demanda e sazonalidade");
  check("FONTE VIVA datada (tier A + data de coleta) → 'fonte_viva' com fonte, tier, data de coleta e validade", live.available && live.label === "fonte_viva" && live.evidenceMode === "live" && live.sources[0].tier === "A" && live.sources[0].publisher === "Entidade X" && /^https:\/\/exemplo\.com/.test(live.sources[0].url) && live.collectedAt === "2026-10-01" && !!live.validUntil && !!live.generatedAt);
  const syn = item("preço e prazo de fornecedores");
  check("síntese do modelo NÃO é fonte viva: rótulo 'sintese_do_modelo', sem data de coleta, fonte citada vira tier C", syn.label === "sintese_do_modelo" && syn.evidenceMode === "model_knowledge" && syn.collectedAt === null && syn.sources[0].tier === "C" && syn.sources[0].retrievedAt === null);
  const fake = item("tendências de coleção");
  check("entrada que se DECLARA live mas não tem fonte A/B datada é rebaixada a síntese do modelo (grounding)", fake.available && fake.label === "sintese_do_modelo" && fake.evidenceMode === "model_knowledge" && fake.collectedAt === null && fake.sources.length === 0);
  check("data de coleta só acompanha FONTE VIVA datada: entrada que se declara live com data, mas só fonte tier C sem data, NÃO exibe collectedAt e vira síntese", (() => { const p = (X.forDecision(A, { kind: "plan" }).items.find((i: any) => i.topic === "calendário comercial") as any); return p.available && p.label === "sintese_do_modelo" && p.collectedAt === null && p.sources[0].tier === "C"; })());
  check("a procedência e a confiança do pool aparecem no item (0–1) e a tendência vem do broker", live.confidence === 0.8 && syn.confidence === 0.5 && "trend" in live);
  check("confiança geral nunca 'alta': com uma fonte viva datada → média; sem nenhuma → baixa", r.confidence.level === "media" && X.forDecision(A, { kind: "supplier" }).confidence.level === "baixa" && ["purchase", "sales_change", "hire", "capital", "plan", "supplier"].every((k) => (X.forDecision(A, { kind: k }).confidence.level as string) !== "alta"));
  check("avisos obrigatórios: contexto é pergunta, não conclusão · não altera número · texto externo não confiável · sem benchmark entre empresas", r.caveats.some((c: string) => /PERGUNTAR/.test(c)) && r.caveats.some((c: string) => /Nada aqui altera/.test(c)) && r.caveats.some((c: string) => /não confiável/.test(c)) && r.caveats.some((c: string) => /outras empresas/.test(c)));
  check("avisa quando há contexto que é só síntese do modelo (sem fonte viva)", X.forDecision(A, { kind: "supplier" }).caveats.some((c: string) => /síntese do modelo/.test(c)) && !r.caveats.some((c: string) => /Tudo aqui é síntese/.test(c)));

  // texto não confiável
  const c2 = X.forDecision(A, { kind: "sales_change" }).items.find((i: any) => i.topic === "concorrência e promoções") as any;
  check("texto externo é DADO NÃO CONFIÁVEL: marcado, sem caracteres de controle, resumo ≤600, no máximo 5 fatores de ≤160", c2.untrusted === true && !/[\n\u0007]/.test(c2.summary) && c2.summary.length <= 600 && c2.drivers.length === 5 && c2.drivers.every((d: string) => d.length <= 160) && r.items.filter((i: any) => i.available).every((i: any) => i.untrusted === true));

  // NÃO altera número
  const after = ScenarioEngine.run(A, "purchase", { amount: 9000, payInWeeks: 2 });
  check("NÃO altera cálculo: o mesmo cenário antes e depois do contexto tem as mesmas premissas (versão) e as mesmas métricas", before.assumptionsVersion === after.assumptionsVersion && JSON.stringify(before.metrics) === JSON.stringify(after.metrics) && JSON.stringify(before.assumptions) === JSON.stringify(after.assumptions));
  check("não cria ação, sinal, tarefa, decisão nem plano", cnt() === c0);

  // premissas e perguntas
  check("premissas a revisitar vêm do ScenarioEngine (compra: valor, caixa mínimo, semana do pagamento) — reaproveitadas, não duplicadas", r.assumptionsToRevisit.map((a: any) => a.key).join() === (ScenarioEngine.kinds() as any[]).find((k) => k.kind === "purchase")!.inputs.map((i: any) => i.key).join() && r.assumptionsToRevisit.length === 3);
  check("tipos sem cenário (investimento, plano, fornecedor) não inventam premissa: lista vazia", X.forDecision(A, { kind: "capital" }).assumptionsToRevisit.length === 0 && X.forDecision(A, { kind: "plan" }).assumptionsToRevisit.length === 0);
  check("só PERGUNTAS, nunca conclusão ou recomendação; e nenhuma se não há contexto disponível", r.questions.length >= 1 && r.questions.every((q: string) => q.endsWith("?") && !/^(compre|venda|contrate|invista|aumente|reduza|troque)\b/i.test(q) && !/recomend|você deve/i.test(q)) && oo.questions.length === 0 && oo.assumptionsToRevisit.length === 0);

  // frescor
  db.prepare(`UPDATE vertical_intelligence SET generated_at = datetime('now', '-90 days') WHERE fingerprint = ?`).run(researchFingerprint("moda", "demanda e sazonalidade"));
  const stale = X.forDecision(A, { kind: "purchase" });
  check("contexto com mais de 60 dias é marcado como defasado (ageDays + aviso)", (stale.items[0] as any).stale === true && (stale.items[0] as any).ageDays >= 89 && stale.caveats.some((c: string) => /60 dias/.test(c)));
  db.prepare(`UPDATE vertical_intelligence SET valid_until = datetime('now', '-1 day') WHERE fingerprint = ?`).run(researchFingerprint("moda", "preço e prazo de fornecedores"));
  const expired = X.forDecision(A, { kind: "purchase" }).items.find((i: any) => i.topic === "preço e prazo de fornecedores") as any;
  check("entrada vencida NÃO é mostrada como atual: fica indisponível com o motivo (o sistema não pesquisa sozinho)", expired.available === false && /no_fresh|opt_out|unavailable/.test(expired.reason));
  check("tópico livre sem pesquisa publicada → indisponível com motivo; não inventa", (() => { const t = X.forDecision(A, { kind: "hire", topics: ["tema nunca pesquisado"] }); return t.items.length === 1 && (t.items[0] as any).available === false && (t.items[0] as any).reason === "no_fresh_vertical_intelligence" && t.caveats.some((c: string) => /admin master/.test(c)); })());

  // isolamento
  check("o nicho é o da empresa: empresa de outro nicho não recebe a pesquisa de moda", (() => { const o = X.forDecision(OTHER, { kind: "purchase" }); return o.vertical === "restaurante" && o.items.every((i: any) => i.available === false); })());
  check("pool compartilhado sem dado por-org: nenhum item carrega id/nome de empresa (a contextualização por-org fica só no cache L2 da própria empresa)", !/org_|Loja Teste/.test(JSON.stringify(r)) && (db.prepare(`SELECT COUNT(*) c FROM organization_contextualization WHERE organization_id = ?`).get(OTHER) as any).c === 0);

  // rotas
  const { default: router } = await import("../src/server/routes/health.js");
  const express = (await import("express")).default;
  const mkU = (org: string, role: string, key: string) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'U', ?, ?, 'active')`).run(id, org, `${id}@t.local`, role); const pid = (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id; return { userId: id, id, role, role_profile_id: pid }; };
  const who: any = { dono: mkU(A, "owner", "owner"), vend: mkU(A, "agent", "vendedor") };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = req.headers["x-anon"] ? undefined : A; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/health-center", router);
  const server = http.createServer(app); await new Promise<void>((x) => server.listen(0, x));
  const port = (server.address() as any).port;
  const get = async (u: string, user: string, anon = false) => { const x = await fetch(`http://127.0.0.1:${port}/api/health-center${u}`, { headers: { "x-user": user, ...(anon ? { "x-anon": "1" } : {}) } }); return { status: x.status, body: await x.json().catch(() => ({})) as any }; };
  const g1 = await get("/external-context?kind=capital", "dono");
  check("rota: gestor lê o contexto (200); tópicos livres por vírgula funcionam", g1.status === 200 && g1.body.type === "external_context" && g1.body.kind === "capital" && (await get("/external-context?kind=hire&topics=tema%20a,tema%20b", "dono")).body.items.length === 2);
  check("rota: vendedor não vê (403); sem empresa → 401; tipo inválido → 400 com código; tópico inválido → 400", (await get("/external-context?kind=purchase", "vend")).status === 403 && (await get("/external-context?kind=purchase", "dono", true)).status === 401 && (await get("/external-context?kind=xyz", "dono")).body.code === "invalid_kind" && (await get("/external-context?kind=purchase&topics=%3Cb%3E", "dono")).body.code === "invalid_topic");
  server.close();

  // composição
  const src = fs.readFileSync(path.join(process.cwd(), "src/server/ExternalDecisionContextService.ts"), "utf8").replace(/\/\*\*[\s\S]*?\*\//g, "");
  check("NUNCA pesquisa: não chama provedor, não roda pesquisa (só broker + leitura do pool compartilhado)", /ResearchBrokerService\.resolve/.test(src) && !/runResearch|\.research\(|getResearchProvider|runManual|VerticalIntelligenceService\.(publish|run)|fetch\(/.test(src));
  check("NÃO calcula nada: só lê as premissas do ScenarioEngine (kinds), nunca roda cenário/plano/comparação", /ScenarioEngine\.kinds\(\)/.test(src) && !/ScenarioEngine\.run|CashForecast|PurchaseScenario|StrategicPlan|CapitalAllocation/.test(src));
  check("não grava nem cria ação/sinal/mensagem (sem INSERT/UPDATE/DELETE)", !/\b(INSERT|UPDATE|DELETE)\b|BusinessSignalService|DecisionActionService|CommandExecutor|MessageProvider/.test(src));

  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  → " + x.d}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
