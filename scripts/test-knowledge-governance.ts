/**
 * TESTE — ADR-206 F5.1: KNOWLEDGE GOVERNANCE (validade · expiração · conflito · proveniência) sobre o PatternMemoryService.
 * ----------------------------------------------------------------------------
 * Prova, nos serviços REAIS:
 *   A) validade: só PESSOA, só regra CONFIRMADA; data inválida/invertida recusada; sem prazo = vale sempre (0-regressão);
 *      prazo vencido → "expirado" (derivado, não gravado) e SAI das regras vigentes; revogar limpa o prazo; histórico append-only;
 *   B) vigência: `inForce` respeita início futuro e fim vencido; só confirmada pode estar em vigor;
 *   C) conflito: duas regras vigentes sobre o mesmo assunto com chaves diferentes → PERGUNTA (nunca escolhe); não conflita
 *      se uma venceu, se são de outro escopo/tipo/domínio, ou se é só hipótese; resolver = dar prazo/revogar; sinal no ledger
 *      (`business_signals`), resolvido sozinho quando o conflito some; isolado por empresa;
 *   D) proveniência: origem, quem decidiu, prazo, evidência e histórico — só o que foi gravado; isolado;
 *   E) read-model `/memory` mostra "expirado" à parte (regra vencida nunca aparece como vigente); rotas e permissões.
 * Uso: npm run test:knowledge-governance
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-kgov-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-kgov-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400e3).toISOString().slice(0, 10);

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PatternMemoryService: P } = await import("../src/server/PatternMemoryService.js");
  const { BusinessMemoryService: M } = await import("../src/server/BusinessMemoryService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const A = mkOrg(), B = mkOrg();
  const profile = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id;
  const mkUser = (org: string, role: string, key: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, ?, ?, ?, 'active')`).run(id, org, name, `${id}@t.local`, role); return { userId: id, id, role, role_profile_id: profile(org, key), name }; };
  const maria = mkUser(A, "owner", "owner", "Maria"); const joao = mkUser(A, "agent", "vendedor", "João");
  const mk = (org: string, type: string, key: string, scope: string | null = null, domain = "retail") =>
    P.ensurePattern(org, domain, { scopeId: scope, patternType: type, patternKey: key, evidenceCount: 5, confidence: 0.8, evidence: { k: key }, fallbackDescription: `Regra ${type}/${key}.` } as any);
  const row = (id: string) => db.prepare("SELECT * FROM business_patterns WHERE id = ?").get(id) as any;
  const confirm = (org: string, id: string) => P.decide(org, id, "confirmed", maria.userId);

  // ── A) validade ──
  const a1 = mk(A, "pa_meta", "2.5");
  check("hipótese/sem decisão NÃO tem validade", P.setValidity(A, a1, maria.userId, { validUntil: iso(30) }).ok === false);
  check("confirma → regra (sem prazo vale sempre)", confirm(A, a1).stage === "rule" && P.inForce(row(a1)) === true);
  for (const bad of [undefined, "", "ai", "system", "runtime", "agent:x"]) check(`validade recusa autor "${String(bad)}"`, P.setValidity(A, a1, bad as any, { validUntil: iso(30) }).ok === false);
  check("data inválida recusada", P.setValidity(A, a1, maria.userId, { validUntil: "31/12/2026" }).ok === false && P.setValidity(A, a1, maria.userId, { validUntil: "2026-13-45" }).ok === false);
  check("início depois do fim recusado", P.setValidity(A, a1, maria.userId, { validFrom: iso(10), validUntil: iso(5) }).ok === false);
  check("outra empresa não define validade de padrão alheio", P.setValidity(B, a1, maria.userId, { validUntil: iso(30) }).ok === false);
  check("nada mudou depois das recusas", row(a1).valid_until === null && row(a1).valid_from === null);
  const ok1 = P.setValidity(A, a1, maria.userId, { validFrom: iso(-10), validUntil: iso(30) }, "política 2026");
  check("pessoa define prazo → segue regra e em vigor", ok1.ok && ok1.stage === "rule" && row(a1).valid_until === iso(30) && P.inForce(row(a1)));
  check("histórico append-only registra a validade", P.decisions(A, a1).some((d: any) => d.decision === "validity" && /política 2026/.test(d.note)));
  P.setValidity(A, a1, maria.userId, { validUntil: iso(-1) });
  check("prazo vencido → EXPIRADO (derivado) e fora de vigor", P.stageOf(row(a1)) === "expired" && !P.inForce(row(a1)));
  check("o status gravado não foi tocado (expirado é derivado)", row(a1).manager_decision === "confirmed");
  check("stageOf aceita 'hoje' injetado (testável no tempo)", P.stageOf({ manager_decision: "confirmed", valid_until: "2026-06-01" }, "2026-05-31") === "rule" && P.stageOf({ manager_decision: "confirmed", valid_until: "2026-06-01" }, "2026-06-02") === "expired");
  check("hipótese nunca vira 'expirado' (só regra tem prazo)", P.stageOf({ status: "validated", valid_until: "2000-01-01" } as any) === "hypothesis");
  P.setValidity(A, a1, maria.userId, { validUntil: "" });
  check("limpar o prazo (vazio) → volta a valer sempre", row(a1).valid_until === null && P.stageOf(row(a1)) === "rule");
  P.setValidity(A, a1, maria.userId, { validUntil: iso(20) });
  P.decide(A, a1, "revoked", maria.userId);
  check("revogar a decisão LIMPA o prazo (não herda validade velha)", row(a1).valid_until === null && row(a1).valid_from === null);

  // ── B) vigência ──
  check("início no futuro → ainda não vigora", P.inForce({ manager_decision: "confirmed", valid_from: iso(5) }) === false);
  check("só confirmada pode estar em vigor", P.inForce({ manager_decision: null }) === false && P.inForce({ manager_decision: "rejected" }) === false);

  // ── C) conflito ──
  const x = mk(A, "pa_politica", "2.5"), y = mk(A, "pa_politica", "3.0");
  check("sem decisão, hipóteses iguais NÃO conflitam", P.conflicts(A).length === 0);
  confirm(A, x);
  check("uma só confirmada não conflita", P.conflicts(A).length === 0);
  confirm(A, y);
  const c = P.conflicts(A);
  check("duas vigentes, mesmo assunto, chaves diferentes → conflito com PERGUNTA", c.length === 1 && /Qual está vigente\?/.test(c[0].question) && [c[0].a.id, c[0].b.id].sort().join() === [x, y].sort().join());
  check("o sistema NÃO escolhe: as duas continuam regra", P.stageOf(row(x)) === "rule" && P.stageOf(row(y)) === "rule");
  const pub = P.publishConflicts(A);
  const sig = () => db.prepare(`SELECT * FROM business_signals WHERE organization_id = ? AND domain = 'memory' AND signal_type = 'rule_conflict' AND status NOT IN ('resolved','dismissed')`).all(A) as any[];
  check("conflito vira sinal no ledger (domínio memory), 1 só, idempotente", pub.published === 1 && sig().length === 1 && (P.publishConflicts(A), sig().length === 1));
  check("o sinal pergunta e não afirma (hipótese, sem dinheiro)", sig()[0].basis === "hypothesis" && /Qual está vigente\?/.test(String(sig()[0].evidence_json)) && sig()[0].impact_amount == null);
  const other = mk(A, "pa_politica", "3.0", "loja-2"); confirm(A, other);
  const otherType = mk(A, "pa_outro", "9", null); confirm(A, otherType);
  const otherDomain = mk(A, "pa_politica", "4.0", null, "finance"); confirm(A, otherDomain);
  check("outro escopo / tipo / domínio NÃO conflitam", P.conflicts(A).length === 1);
  P.setValidity(A, x, maria.userId, { validUntil: iso(-1) });
  check("uma venceu → conflito some", P.conflicts(A).length === 0);
  P.publishConflicts(A);
  check("sinal do conflito é resolvido quando o conflito some", sig().length === 0);
  P.setValidity(A, x, maria.userId, { validUntil: iso(10) });
  check("dar prazo futuro às duas mantém o conflito (ainda se sobrepõem hoje)", P.conflicts(A).length === 1);
  P.decide(A, y, "revoked", maria.userId);
  check("resolver = revogar uma → conflito some", P.conflicts(A).length === 0);
  const bx = mk(B, "pa_politica", "2.5"); const by2 = mk(B, "pa_politica", "3.0"); confirm(B, bx); P.decide(B, by2, "confirmed", maria.userId);
  check("isolado: conflitos de A não aparecem em B (e B só vê os seus)", P.conflicts(A).every((k) => ![k.a.id, k.b.id].some((i) => [bx, by2].includes(i))));

  // ── D) proveniência ──
  const pv = P.provenance(A, x)!;
  check("proveniência: quem decidiu, quando, prazo e histórico", pv.decidedBy === maria.userId && !!pv.decidedAt && pv.validUntil === iso(10) && pv.history.length >= 2 && pv.inForce === true);
  check("proveniência: origem derivada do que foi gravado (regra do sistema, não 'pessoa')", pv.origin === "system_rule" && pv.stage === "rule");
  check("proveniência: evidência é a gravada", pv.evidence && pv.evidence.k === "2.5");
  check("proveniência: padrão inexistente/outra empresa → null", P.provenance(A, "nao-existe") === null && P.provenance(B, x) === null);

  // ── E) read-model + rotas ──
  const ov = M.overview(A, { canSeeMoney: true });
  check("overview: regra vencida vai pra 'expired', não pra 'rules'", ov.expired.every((e: any) => !ov.rules.some((r: any) => r.id === e.id)));
  P.setValidity(A, other, maria.userId, { validUntil: iso(-2) });
  const ov2 = M.overview(A, { canSeeMoney: true });
  check("overview: expirado listado com aviso e contado", ov2.expired.some((e: any) => e.id === other && /Prazo vencido/.test(e.note)) && ov2.counts.expired === ov2.expired.length && !ov2.rules.some((r: any) => r.id === other));
  check("overview: regras mostram o prazo", ov2.rules.some((r: any) => r.id === x && r.validUntil === iso(10)));

  const express = (await import("express")).default;
  const router = (await import("../src/server/routes/insights.js")).default;
  const who: Record<string, any> = { maria, joao };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = req.headers["x-org"] || undefined; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/insights", router);
  const server = http.createServer(app); await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const call = async (method: string, url: string, user: string | null, org: string | null, body?: any) => {
    const h: any = { "Content-Type": "application/json" }; if (user) h["x-user"] = user; if (org) h["x-org"] = org;
    const r = await fetch(`http://127.0.0.1:${port}/api/insights${url}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const r1 = await call("POST", `/patterns/${x}/validity`, "maria", A, { validUntil: iso(40) });
  check("rota: dono define validade", r1.status === 200 && r1.body.ok && row(x).valid_until === iso(40));
  const r2 = await call("POST", `/patterns/${x}/validity`, "joao", A, { validUntil: iso(50) });
  check("rota: quem não é dono/admin toma 403 e nada muda", r2.status === 403 && row(x).valid_until === iso(40));
  const r3 = await call("POST", `/patterns/${x}/validity`, "maria", A, { validUntil: "amanhã" });
  check("rota: data inválida → 400 com motivo", r3.status === 400 && /AAAA-MM-DD/.test(r3.body.error));
  const r4 = await call("POST", `/patterns/${x}/validity`, "maria", B, { validUntil: iso(50) });
  check("rota: outra empresa → 400 e nada muda", r4.status === 400 && row(x).valid_until === iso(40));
  const r5 = await call("GET", `/memory/conflicts`, "maria", A);
  check("rota: conflitos", r5.status === 200 && Array.isArray(r5.body.conflicts));
  const r6 = await call("GET", `/patterns/${x}/provenance`, "joao", A);
  check("rota: proveniência", r6.status === 200 && r6.body.id === x && r6.body.decidedBy === maria.userId);
  check("rota: proveniência de outra empresa → 404", (await call("GET", `/patterns/${x}/provenance`, "maria", B)).status === 404);
  check("rota: sem empresa → 401", (await call("GET", `/memory/conflicts`, null, null)).status === 401);
  server.close();

  // ── fiação ──
  const src = fs.readFileSync(path.resolve(process.cwd(), "src/server/PatternMemoryService.ts"), "utf8");
  const dbs = fs.readFileSync(path.resolve(process.cwd(), "src/server/db.ts"), "utf8");
  check("fiação: learn publica conflitos (sem scheduler novo)", /this\.publishConflicts\(orgId\)/.test(src));
  check("fiação: colunas aditivas valid_from/valid_until em db.ts", /ADD COLUMN valid_from DATE/.test(dbs) && /ADD COLUMN valid_until DATE/.test(dbs));
  check("fiação: sem tabela nova de conhecimento/alerta", !/CREATE TABLE IF NOT EXISTS (rule_conflicts|knowledge_conflicts|knowledge_governance|knowledge_rules)\b/i.test(dbs));

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.d}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
