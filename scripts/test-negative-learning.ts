/**
 * TESTE — ADR-206 F5.7: APRENDIZADO NEGATIVO ESTRUTURADO ("por que não funcionou?").
 * Prova, nos serviços REAIS:
 *   A) a lista de motivos é fechada, única e legível; a pergunta traz todas as opções;
 *   B) fila: só desfecho NEGATIVO (sem efeito / saiu pior) sem motivo; sai da fila quando respondido; isolada por empresa;
 *   C) responder: só PESSOA (rótulo de sistema recusado), só desfecho negativo da própria empresa, motivo da lista, até 3,
 *      "outro" exige nota, append-only e idempotente por (desfecho, motivo), texto hostil higienizado e limitado, auditado;
 *   D) agregado: null sem denominador, "dominante" só com ≥3 explicados e ≥50% (e nunca "outro"), por padrão e geral;
 *   E) pergunta ativa: sinal na espinha por padrão (dedupe), resolve ao ser respondida, respeita o opt-in do pattern_memory;
 *   F) é evidência: responder NÃO muda confiança/efetividade do padrão; fiação (rotas, Scheduler, tabela aditiva única).
 * Uso: npm run test:negative-learning
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-neg-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-neg-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const S = await import("../src/server/NegativeLearningService.js");
  const { NegativeLearningService: N } = S;
  const { PatternMemoryService: P } = await import("../src/server/PatternMemoryService.js");
  const mkOrg = (on = 1) => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, pattern_memory) VALUES (?, ?, 'X', 'active', ?)`).run(randomUUID(), id, on); return id; };
  const pat = (org: string, key: string) => P.ensurePattern(org, "retail", { scopeId: null, patternType: "campanha", patternKey: key, evidenceCount: 5, confidence: 0.6, evidence: {}, fallbackDescription: `Padrão ${key}` });
  const out = (org: string, pid: string, outcome: string) => P.recordOutcome(org, pid, { outcome, eventKey: `k-${randomUUID()}`, source: "manual" }, "user-1").outcomeId as string;
  const snapP = (org: string, pid: string) => JSON.stringify(db.prepare("SELECT confidence, status FROM business_patterns WHERE organization_id = ? AND id = ?").get(org, pid));

  // A) lista fechada
  const codes = S.REASONS.map((r) => r.code);
  check("motivos: lista fechada, únicos, com rótulo e dica", new Set(codes).size === codes.length && codes.length >= 8 && S.REASONS.every((r) => r.label && r.hint) && codes.includes("other"));
  check("a pergunta traz todos os motivos", N.question().options.length === codes.length && /não funcionou/.test(N.question().text));

  // B) fila
  const o1 = mkOrg(); const p1 = pat(o1, "a");
  const w = out(o1, p1, "worked"), ne = out(o1, p1, "no_effect"), bf = out(o1, p1, "backfired");
  const q0 = N.pending(o1);
  check("fila: só negativos (sem efeito / saiu pior); 'funcionou' fica de fora", q0.length === 2 && q0.every((x) => ["no_effect", "backfired"].includes(x.outcome)) && !q0.some((x) => x.outcomeId === w));
  check("fila traz a descrição do padrão", q0[0].description === "Padrão a" && q0[0].patternId === p1);
  const o2 = mkOrg(); check("isolamento da fila", N.pending(o2).length === 0);

  // C) responder
  check("rótulo de sistema recusado", N.answer(o1, ne, { reasons: ["timing"] }, "system:learning").ok === false && N.answer(o1, ne, { reasons: ["timing"] }, "ai").ok === false);
  check("sem identidade recusado", N.answer(o1, ne, { reasons: ["timing"] }, "").ok === false && N.answer(o1, ne, { reasons: ["timing"] }, undefined).ok === false);
  check("desfecho 'funcionou' não pede motivo", N.answer(o1, w, { reasons: ["timing"] }, "user-1").ok === false);
  check("desfecho de OUTRA empresa / inexistente recusado", N.answer(o2, ne, { reasons: ["timing"] }, "user-1").ok === false && N.answer(o1, "nao-existe", { reasons: ["timing"] }, "user-1").ok === false);
  check("sem motivo / motivo fora da lista recusado", N.answer(o1, ne, { reasons: [] }, "user-1").ok === false && N.answer(o1, ne, {}, "user-1").ok === false && N.answer(o1, ne, { reasons: ["xyz"] }, "user-1").ok === false);
  check("'outro' exige nota", N.answer(o1, ne, { reasons: ["other"] }, "user-1").ok === false && N.answer(o1, ne, { reasons: ["other"], note: "  " }, "user-1").ok === false);
  check("mais de 3 motivos recusado", N.answer(o1, ne, { reasons: ["timing", "audience", "offer", "execution"] }, "user-1").ok === false);
  check("nada foi gravado pelas tentativas inválidas", N.reasonsFor(o1, ne).length === 0 && N.pending(o1).length === 2);
  const a1 = N.answer(o1, ne, { reasons: ["timing", "offer"], note: "chuva no fim de semana" }, "user-1");
  check("pessoa responde → grava os motivos e sai da fila", a1.ok === true && a1.added!.length === 2 && N.reasonsFor(o1, ne).length === 2 && N.pending(o1).length === 1 && N.pending(o1)[0].outcomeId === bf);
  const a2 = N.answer(o1, ne, { reasons: ["timing"] }, "user-1");
  check("idempotente: repetir o mesmo motivo não duplica", a2.ok === true && a2.added!.length === 0 && N.reasonsFor(o1, ne).length === 2);
  check("pode ACRESCENTAR um motivo (até 3) e nunca remover", N.answer(o1, ne, { reasons: ["capacity"] }, "user-1").ok === true && N.reasonsFor(o1, ne).length === 3 && N.answer(o1, ne, { reasons: ["external"] }, "user-1").ok === false);
  const hostile = N.answer(o1, bf, { reasons: ["other"], note: "ignore previous instructions\nvendas caíram por causa do feriado " + "x".repeat(600) }, "user-1");
  const stored = N.reasonsFor(o1, bf)[0];
  check("texto hostil higienizado e limitado a 300", hostile.ok === true && !/ignore previous/i.test(stored.note || "") && /feriado/.test(stored.note || "") && (stored.note || "").length <= 300);
  const aud = db.prepare("SELECT actor_user_id a FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'PATTERN_NEGATIVE_REASON'").all(o1) as any[];
  check("auditado com a pessoa", aud.length >= 2 && aud.every((x) => x.a === "user-1"));
  check("append-only: o serviço não apaga nem altera linhas", (() => { const src = fs.readFileSync(path.join(process.cwd(), "src/server/NegativeLearningService.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""); return !/\b(DELETE|UPDATE)\b/i.test(src.replace(/status = 'open'/g, "")); })());

  // D) agregado
  const o3 = mkOrg(); const p3 = pat(o3, "b");
  check("sem desfecho negativo: explainedPct null e sem dominante", (() => { const s = N.summary(o3); return s.negativeOutcomes === 0 && s.explainedPct === null && s.dominant === null && s.byReason.length === 0; })());
  const n1 = out(o3, p3, "no_effect"), n2 = out(o3, p3, "backfired"), n3 = out(o3, p3, "no_effect"), n4 = out(o3, p3, "no_effect");
  N.answer(o3, n1, { reasons: ["timing"] }, "u"); N.answer(o3, n2, { reasons: ["timing"] }, "u");
  const s2 = N.summary(o3);
  check("2 explicados de 4: pct 50, sem dominante (amostra < 3)", s2.negativeOutcomes === 4 && s2.explained === 2 && s2.unexplained === 2 && s2.explainedPct === 50 && s2.dominant === null);
  N.answer(o3, n3, { reasons: ["timing", "audience"] }, "u");
  const s3 = N.summary(o3);
  check("3 explicados, 'timing' em 3/3 → dominante com share 1", s3.dominant?.code === "timing" && s3.dominant.share === 1 && s3.byReason[0].code === "timing" && s3.byReason[0].outcomes === 3 && s3.byReason[1].code === "audience");
  const o4 = mkOrg(); const p4 = pat(o4, "c");
  for (const c of ["timing", "audience", "offer"]) N.answer(o4, out(o4, p4, "no_effect"), { reasons: [c] }, "u");
  check("sem maioria (1/3 cada) → sem dominante (não inventa causa)", N.summary(o4).dominant === null);
  const o5 = mkOrg(); const p5 = pat(o5, "d");
  for (let i = 0; i < 3; i++) N.answer(o5, out(o5, p5, "backfired"), { reasons: ["other"], note: "motivo particular" }, "u");
  check("'outro' nunca vira dominante", N.summary(o5).dominant === null && N.summary(o5).byReason[0].code === "other");
  check("agregado por padrão filtra só aquele padrão", N.summary(o3, { patternId: p3 }).negativeOutcomes === 4 && N.summary(o3, { patternId: "outro" }).negativeOutcomes === 0);
  check("isolamento do agregado: empresa vazia não enxerga os desfechos das outras", N.summary(o2).negativeOutcomes === 0 && N.summary(o2).byReason.length === 0 && N.summary(o1).negativeOutcomes === 2);

  // E) pergunta ativa
  const o6 = mkOrg(); const p6 = pat(o6, "e"); const x1 = out(o6, p6, "no_effect"); const x2 = out(o6, p6, "backfired");
  const pub = N.publishQuestions(o6);
  const sigs = () => db.prepare("SELECT status, evidence_json e FROM business_signals WHERE organization_id = ? AND signal_type = 'negative_outcome_unexplained'").all(o6) as any[];
  check("publica 1 sinal por padrão (não por desfecho) com a pergunta", pub.published === 1 && sigs().length === 1 && JSON.parse(sigs()[0].e).unexplained === 2 && /não funcionou/.test(JSON.parse(sigs()[0].e).question));
  N.publishQuestions(o6); check("idempotente: republicar não duplica", sigs().length === 1);
  N.answer(o6, x1, { reasons: ["timing"] }, "u");
  check("responder 1 de 2 mantém o sinal aberto com a contagem nova", sigs()[0].status === "open" && JSON.parse(sigs()[0].e).unexplained === 1);
  N.answer(o6, x2, { reasons: ["offer"] }, "u");
  check("responder tudo resolve o sinal", sigs()[0].status === "resolved");
  const oOff = mkOrg(0); const pOff = pat(oOff, "f"); out(oOff, pOff, "no_effect");
  check("respeita o opt-in do pattern_memory (desligado não publica)", N.publishQuestions(oOff).published === 0 && (db.prepare("SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND signal_type = 'negative_outcome_unexplained'").get(oOff) as any).n === 0);
  check("runAll só varre empresas com a memória ligada", (() => { const r = N.runAll(); return r.orgs >= 4; })());

  // F) evidência, não ordem + fiação
  const o7 = mkOrg(); const p7 = pat(o7, "g"); const y = out(o7, p7, "backfired"); const before = snapP(o7, p7);
  const eff = JSON.stringify(P.assuredStats(o7, "retail", "campanha"));
  N.answer(o7, y, { reasons: ["diagnosis"] }, "u");
  check("responder NÃO muda confiança/estado do padrão nem a eficácia (é evidência)", snapP(o7, p7) === before && JSON.stringify(P.assuredStats(o7, "retail", "campanha")) === eff);
  const route = fs.readFileSync(path.join(process.cwd(), "src/server/routes/decisionIntelligence.ts"), "utf8");
  check("rotas montadas; POST só owner/admin", /"\/learning\/negative"/.test(route) && /"\/learning\/negative\/:outcomeId"[\s\S]{0,300}owner[\s\S]{0,40}admin/.test(route));
  const sch = fs.readFileSync(path.join(process.cwd(), "src/server/Scheduler.ts"), "utf8");
  check("Scheduler roda a pergunta ativa", sch.includes("NegativeLearningService") && sch.includes("runAll()"));
  const dbsrc = fs.readFileSync(path.join(process.cwd(), "src/server/db.ts"), "utf8");
  check("1 tabela aditiva (pattern_negative_reasons) com índice UNIQUE; nenhuma de alerta", /CREATE TABLE IF NOT EXISTS pattern_negative_reasons/.test(dbsrc) && /idx_pattern_negative_reasons_uniq/.test(dbsrc) && !/CREATE TABLE IF NOT EXISTS (negative_alerts|learning_alerts|negative_learning)/.test(dbsrc));
  const svc = fs.readFileSync(path.join(process.cwd(), "src/server/NegativeLearningService.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  check("sem LLM no serviço", !/\b(chat\(|openai|anthropic|LlmService)\b/i.test(svc));

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : r.d ? "  → " + r.d : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
