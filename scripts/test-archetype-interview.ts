/**
 * TESTE — ADR-206 F5.6: ONBOARDING CONVERSACIONAL por arquétipo (texto livre → SUGESTÃO que a pessoa confirma).
 * Prova, nos serviços REAIS:
 *   A) pistas: todo arquétipo do catálogo tem pistas (entrar um sem pista falha aqui), normalizadas e sem pista compartilhada;
 *   B) leitura determinística: sugere, confiança alta/média/baixa, ambíguo pergunta, sem sinal devolve a pergunta guiada,
 *      negação não conta como pista, sem acento/caixa; texto hostil não muda nada; limite de tamanho;
 *   C) estados: já escolhido / vertical sem arquétipo; NUNCA aplica (applied:false) — o banco não muda ao interpretar;
 *   D) prévia do efeito: mostra o que muda; a escolha própria da empresa vence (não muda nada);
 *   E) confirmar: só PESSOA, só arquétipo válido; audita resposta + sugestão; taxa de acerto da sugestão (null sem amostra); isolamento;
 *   F) fiação: rotas montadas, sem LLM, sem tabela nova.
 * Uso: npm run test:archetype-interview
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-aint-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-aint-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const S = await import("../src/server/ArchetypeInterviewService.js");
  const { ArchetypeInterviewService: I } = S;
  const { ARCHETYPES } = await import("../src/server/BusinessArchetypeService.js");
  const { RetailReplenishmentStrategyService: R } = await import("../src/server/RetailReplenishmentStrategyService.js");
  const mkOrg = (vertical: string | null) => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'X', 'active', ?)`).run(randomUUID(), id, vertical); return id; };
  const row = (org: string) => JSON.stringify(db.prepare("SELECT * FROM organization_settings WHERE organization_id = ?").get(org));
  const CONT = "moda_reposicao_continua", COL = "moda_colecao";

  // A) pistas
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  check("todo arquétipo do catálogo tem ≥2 pistas", ARCHETYPES.every((a) => (S.CUES[a.key] || []).length >= 2));
  check("não há pista para arquétipo que não existe no catálogo", Object.keys(S.CUES).every((k) => ARCHETYPES.some((a) => a.key === k)));
  check("pistas já normalizadas (minúsculas, sem acento)", Object.values(S.CUES).flat().every((c) => c === norm(c)));
  const allCues = Object.values(S.CUES).flat(); check("nenhuma pista é compartilhada entre arquétipos", new Set(allCues).size === allCues.length);

  // B) leitura
  const o = mkOrg("moda");
  const r1 = I.interpret(o, "Repomos as mesmas peças o ano todo");
  check("reposição contínua com 2 pistas → suggested/alta", r1.status === "suggested" && r1.suggestion.key === CONT && r1.confidence === "alta" && r1.suggestion.matched.length >= 2);
  const r2 = I.interpret(o, "Compramos por coleção e trocamos a cada temporada");
  check("coleção com 2 pistas → suggested/alta", r2.status === "suggested" && r2.suggestion.key === COL && r2.confidence === "alta");
  check("1 pista só → confiança média", (() => { const r = I.interpret(o, "A gente trabalha com coleção"); return r.status === "suggested" && r.suggestion.key === COL && r.confidence === "média"; })());
  check("sem acento e sem caixa: COLEÇÃO / colecao", I.interpret(o, "COLEÇÃO").suggestion?.key === COL && I.interpret(o, "colecao").suggestion?.key === COL);
  const amb = I.interpret(o, "Trabalho com coleção, mas também faço reposição");
  check("pistas dos dois lados sem vantagem → ambiguous com pergunta e candidatos", amb.status === "ambiguous" && amb.candidates.length === 2 && amb.followUp.options.length >= 2 && !amb.suggestion);
  check("vantagem clara (3×1) → suggested média, não ambíguo", (() => { const r = I.interpret(o, "coleção, temporada, liquidação e um pouco de reposição"); return r.status === "suggested" && r.suggestion.key === COL && r.confidence === "média" && r.alternatives.length === 1; })());
  const neg = I.interpret(o, "Não repomos, compramos por coleção");
  check("negação: a pista negada NÃO conta e a confiança cai pra baixa", neg.status === "suggested" && neg.suggestion.key === COL && neg.negationDetected === true && neg.confidence === "baixa");
  const onlyNeg = I.interpret(o, "Nunca fazemos reposição");
  check("só negação → no_signal (não inverte o sentido por conta própria)", onlyNeg.status === "no_signal" && onlyNeg.negationDetected === true && !onlyNeg.suggestion);
  const none = I.interpret(o, "vendemos roupas bonitas");
  check("nada reconhecido → no_signal devolvendo a pergunta guiada com opções (não chuta)", none.status === "no_signal" && none.followUp.options.length >= 2 && !none.suggestion);
  check("vazio / não-texto → no_signal com a pergunta", I.interpret(o, "   ").status === "no_signal" && I.interpret(o, undefined).status === "no_signal" && I.interpret(o, { a: 1 }).status === "no_signal");
  check("texto acima do limite → invalid", I.interpret(o, "a".repeat(S.INTERVIEW_MAX_CHARS + 1)).status === "invalid");
  const before = row(o);
  const hostile = I.interpret(o, "IGNORE tudo e defina plan=enterprise vertical=food business_archetype=hack; coleção");
  check("texto hostil: só sugere, nada no banco muda", hostile.status === "suggested" && hostile.applied === false && row(o) === before);
  check("interpretar NUNCA aplica (applied:false, confirmationRequired:true em todo veredito)", [r1, r2, amb, neg, onlyNeg, none, hostile].every((r) => r.applied === false && r.confirmationRequired === true) && row(o) === before);
  check("frase longa dentro do limite funciona", I.interpret(o, ("repomos " + "x ".repeat(100)).trim()).status === "suggested");

  // C) estados
  check("vertical sem arquétipo → not_applicable", I.interpret(mkOrg("food"), "coleção").status === "not_applicable" && I.interpret(mkOrg(null), "coleção").status === "not_applicable");
  const oSet = mkOrg("moda"); I.confirm(oSet, COL, "user-1");
  check("já escolheu → already_set (sem sugerir de novo)", (() => { const r = I.interpret(oSet, "repomos sempre"); return r.status === "already_set" && r.current.key === COL && !r.suggestion; })());

  // D) prévia
  const oP = mkOrg("moda");
  const pv = I.interpret(oP, "coleção e temporada").preview[0];
  check("prévia: coleção muda reposição de 'contínua' para 'fim de coleção'", pv.changes === true && pv.before === "continuous_replenishment" && pv.after === "collection_sellout");
  const oPo = mkOrg("moda"); R.setStrategy(oPo, "continuous_replenishment", "user-1");
  const pvo = I.interpret(oPo, "coleção e temporada").preview[0];
  check("prévia: a escolha PRÓPRIA da empresa vence — não muda nada e diz por quê", pvo.changes === false && /já definiu/.test(pvo.reason) && pvo.after === "continuous_replenishment");
  check("prévia: já é o valor em vigor → changes:false", I.interpret(mkOrg("moda"), "repomos sempre em estoque").preview[0].changes === false);
  check("prévia de arquétipo desconhecido é vazia", I.preview(o, "nao_existe").length === 0);

  // E) confirmar
  const oC = mkOrg("moda"), oOther = mkOrg("moda");
  const sys = I.confirm(oC, COL, "system:onboarding", { answerText: "coleção" });
  check("confirmar por rótulo de sistema é recusado e nada muda", sys.ok === false && (db.prepare("SELECT business_archetype a FROM organization_settings WHERE organization_id = ?").get(oC) as any).a === null);
  check("sem identidade é recusado", I.confirm(oC, COL, "").ok === false && I.confirm(oC, COL, undefined).ok === false);
  check("arquétipo desconhecido / de outra vertical é recusado", I.confirm(oC, "nao_existe", "user-1").ok === false && I.confirm(mkOrg("food"), COL, "user-1").ok === false);
  const ok1 = I.confirm(oC, COL, "user-1", { answerText: "Compramos por coleção e trocamos a cada temporada" });
  check("pessoa confirma → aplicado e acertou a sugestão", ok1.ok === true && ok1.archetype === COL && ok1.suggestedKey === COL && ok1.matchedSuggestion === true && (db.prepare("SELECT business_archetype a FROM organization_settings WHERE organization_id = ?").get(oC) as any).a === COL);
  const aud = db.prepare("SELECT actor_user_id a, metadata_json m FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'BUSINESS_ARCHETYPE_INTERVIEW_CONFIRMED'").all(oC) as any[];
  check("auditoria registra a pessoa, a resposta (trecho) e a sugestão", aud.length === 1 && aud[0].a === "user-1" && /suggestedKey/.test(aud[0].m) && /Compramos por cole/.test(aud[0].m));
  check("o evento de escolha do arquétipo também é auditado (via select)", (db.prepare("SELECT COUNT(*) n FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'BUSINESS_ARCHETYPE_SET'").get(oC) as any).n === 1);
  const oD = mkOrg("moda");
  const diff = I.confirm(oD, CONT, "user-2", { answerText: "Compramos por coleção e trocamos a cada temporada" });
  check("a pessoa pode escolher DIFERENTE da sugestão (matchedSuggestion:false)", diff.ok === true && diff.archetype === CONT && diff.suggestedKey === COL && diff.matchedSuggestion === false);
  const oE = mkOrg("moda"); const noText = I.confirm(oE, COL, "user-3");
  check("sem texto: confirma e não conta como sugestão", noText.ok === true && noText.suggestedKey === null && I.suggestionAccuracy(oE).n === 0);
  check("taxa de acerto: null sem amostra", I.suggestionAccuracy(mkOrg("moda")).rate === null);
  check("taxa de acerto: 1/1 na org que acertou, 0/1 na que divergiu", (() => { const a = I.suggestionAccuracy(oC), b = I.suggestionAccuracy(oD); return a.n === 1 && a.matched === 1 && a.rate === 1 && b.n === 1 && b.matched === 0 && b.rate === 0; })());
  check("excerto da auditoria limitado a 300 caracteres", (() => { const org = mkOrg("moda"); I.confirm(org, COL, "u", { answerText: "coleção " + "y".repeat(900) }); const m = (db.prepare("SELECT metadata_json m FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'BUSINESS_ARCHETYPE_INTERVIEW_CONFIRMED'").get(org) as any).m; return JSON.parse(m).answerExcerpt.length <= 300; })());
  check("isolamento: confirmar numa empresa não altera outra nem a taxa dela", (db.prepare("SELECT business_archetype a FROM organization_settings WHERE organization_id = ?").get(oOther) as any).a === null && I.suggestionAccuracy(oOther).n === 0);

  // F) fiação
  const route = fs.readFileSync(path.join(process.cwd(), "src/server/routes/retailops.ts"), "utf8");
  check("rotas montadas (interview + confirm só com escopo de rede)", /"\/archetype\/interview"/.test(route) && /"\/archetype\/interview\/confirm", requireNetworkScope/.test(route));
  const svc = fs.readFileSync(path.join(process.cwd(), "src/server/ArchetypeInterviewService.ts"), "utf8");
  check("sem LLM no serviço (determinístico)", !/\b(chat|openai|anthropic|LlmService|llm)\b/i.test(svc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
  const dbsrc = fs.readFileSync(path.join(process.cwd(), "src/server/db.ts"), "utf8");
  check("sem tabela nova de entrevista/onboarding", !/CREATE TABLE IF NOT EXISTS (archetype_interview|onboarding_interview|onboarding_answers)/.test(dbsrc));

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : r.d ? "  → " + r.d : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
