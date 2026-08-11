/**
 * TEST — PRD 3 F6 (§36/§37): Context Candidate (Fala Tu Context Capture).
 * DB-backed, isolado por tmpDir. Prova, determinístico:
 *
 *   - detect() captura um candidato (DETECTED/PENDING) e NÃO altera o contexto
 *     (§36): nenhuma restrição/sinal criado até confirmar;
 *   - confirm() é o ÚNICO ponto que muda o contexto — PROMOVE via os serviços da
 *     1ª classe: kind=constraint → business_constraints (F4); kind=fact →
 *     business_signals (ADR-136); registra promoted_kind/promoted_ref_id;
 *   - reject()/expireStale() NUNCA promovem;
 *   - invariante de estado (§37): confirmar/rejeitar candidato já resolvido falha;
 *     transições respeitam DETECTED→PENDING→CONFIRMED/REJECTED/EXPIRED;
 *   - o promovido é EXATAMENTE o proposed (não inventa, §25);
 *   - validação de forma (kind/proposed mínimo);
 *   - ISOLAMENTO multi-tenant.
 *
 * Uso: npm run test:context-candidate
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ctx-candidate-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-ctx-candidate-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const uid = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ContextCandidateService: CC } = await import("../src/server/ContextCandidateService.js");
  const { BusinessConstraintService: CONS } = await import("../src/server/BusinessConstraintService.js");
  const { BusinessSignalService: SIG } = await import("../src/server/BusinessSignalService.js");
  const { canTransitionCandidate } = await import("../src/server/contextModel.js");

  const mkOrg = (name: string) => {
    const id = uid("org");
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), id, name);
    return id;
  };
  const orgA = mkOrg("Empresa A");
  const orgB = mkOrg("Empresa B");

  // ═══════════════ 0. Transições puras (§37) ═══════════════
  check("0.1 DETECTED→PENDING válido", canTransitionCandidate("DETECTED", "PENDING"));
  check("0.2 DETECTED→CONFIRMED válido (triou e confirmou)", canTransitionCandidate("DETECTED", "CONFIRMED"));
  check("0.3 CONFIRMED é terminal", !canTransitionCandidate("CONFIRMED", "REJECTED"));
  check("0.4 REJECTED é terminal", !canTransitionCandidate("REJECTED", "CONFIRMED"));

  // ═══════════════ 1. detect NÃO altera o contexto (§36) ═══════════════
  const cand = CC.detect(orgA, {
    kind: "constraint", title: "Teto de desconto 20%", source: "falatu", sourceRef: "inbox-1",
    proposed: { kind: "discount_ceiling", name: "Desconto máximo", operator: "lte", valueNum: 20, valueUnit: "%" },
  });
  check("1.1 detect cria candidato DETECTED", cand.status === "DETECTED" && cand.kind === "constraint");
  check("1.2 proposed preservado", (cand.proposed as any).valueNum === 20 && (cand.proposed as any).kind === "discount_ceiling");
  check("1.3 proveniência (source/sourceRef)", cand.source === "falatu" && cand.sourceRef === "inbox-1");
  check("1.4 §36: NENHUMA restrição criada ainda", CONS.list(orgA, {}).length === 0);

  // ═══════════════ 2. confirm PROMOVE (constraint) ═══════════════
  const conf = CC.confirm(orgA, cand.id, "u-boss");
  check("2.1 confirm → CONFIRMED", conf.candidate.status === "CONFIRMED");
  check("2.2 promovido pra constraint (promoted_kind/ref)", conf.promoted.kind === "constraint" && !!conf.promoted.refId && conf.candidate.promotedKind === "constraint");
  const created = CONS.list(orgA, {});
  check("2.3 a restrição existe agora (proposed → business_constraints)", created.length === 1 && created[0].kind === "discount_ceiling" && Number(created[0].value_num) === 20);
  check("2.4 resolvedBy registrado", conf.candidate.resolvedBy === "u-boss" && !!conf.candidate.resolvedAt);

  // ═══════════════ 3. invariante de estado (§37) ═══════════════
  let reConfirm = false; try { CC.confirm(orgA, cand.id, "u-boss"); } catch { reConfirm = true; }
  check("3.1 confirmar candidato já confirmado falha", reConfirm);
  let reReject = false; try { CC.reject(orgA, cand.id, "u-boss"); } catch { reReject = true; }
  check("3.2 rejeitar candidato já confirmado falha", reReject);

  // ═══════════════ 4. reject NÃO promove ═══════════════
  const cand2 = CC.detect(orgA, {
    kind: "constraint", title: "Piso de margem 30%",
    proposed: { kind: "margin_floor", name: "Margem mínima", operator: "gte", valueNum: 30, valueUnit: "%" },
  });
  const rej = CC.reject(orgA, cand2.id, "u-boss", { reason: "não faz sentido" });
  check("4.1 reject → REJECTED", rej.status === "REJECTED" && rej.resolutionReason === "não faz sentido");
  check("4.2 §36: reject NÃO criou restrição (segue 1)", CONS.list(orgA, {}).length === 1);

  // ═══════════════ 5. confirm PROMOVE (fact → signal) ═══════════════
  const factCand = CC.detect(orgA, {
    kind: "fact", title: "Cliente mudou de faixa", pending: true,
    proposed: { domain: "sales", signalType: "customer_tier_changed", severity: "attention", basis: "fact", subjectType: "customer", subjectId: "cust-9", evidence: { tier: "gold" }, dedupeKey: "fact:tier:cust-9" },
  });
  check("5.1 detect com pending → PENDING", factCand.status === "PENDING");
  check("5.2 §36: nenhum sinal criado ainda", SIG.list(orgA, {}).length === 0);
  const confFact = CC.confirm(orgA, factCand.id, "u-boss");
  check("5.3 confirm fact → promovido pra signal", confFact.promoted.kind === "signal" && !!confFact.promoted.refId);
  const sigs = SIG.list(orgA, {});
  check("5.4 o sinal existe (proposed → business_signals)", sigs.length === 1 && sigs[0].signal_type === "customer_tier_changed" && sigs[0].subject_id === "cust-9");

  // ═══════════════ 6. expireStale NÃO promove ═══════════════
  const past = "2020-01-01T00:00:00.000Z";
  const stale = CC.detect(orgA, {
    kind: "constraint", title: "Regra vencida", expiresAt: past,
    proposed: { kind: "policy", name: "Política X", operator: "eq", valueText: "algo" },
  });
  const sweep = CC.expireStale(orgA);
  check("6.1 expireStale marca vencido", sweep.expired >= 1 && CC.get(orgA, stale.id)!.status === "EXPIRED");
  check("6.2 §36: expire NÃO promoveu (segue 1 restrição)", CONS.list(orgA, {}).length === 1);
  let confExpired = false; try { CC.confirm(orgA, stale.id, "u-boss"); } catch { confExpired = true; }
  check("6.3 confirmar candidato expirado falha", confExpired);

  // ═══════════════ 7. validação de forma ═══════════════
  let badKind = false; try { CC.detect(orgA, { kind: "acao" as any, title: "x", proposed: { a: 1 } }); } catch { badKind = true; }
  check("7.1 kind inválido rejeitado", badKind);
  let badProposed = false; try { CC.detect(orgA, { kind: "constraint", title: "x", proposed: { name: "sem kind nem valor" } }); } catch { badProposed = true; }
  check("7.2 proposed insuficiente rejeitado (constraint)", badProposed);
  let badFact = false; try { CC.detect(orgA, { kind: "fact", title: "x", proposed: { domain: "sales" } }); } catch { badFact = true; }
  check("7.3 proposed insuficiente rejeitado (fact sem signalType)", badFact);

  // ═══════════════ 8. ISOLAMENTO multi-tenant ═══════════════
  const candB = CC.detect(orgB, { kind: "constraint", title: "B", proposed: { kind: "budget_limit", name: "Orç", operator: "lte", valueNum: 5 } });
  check("8.1 get de outro tenant → null", CC.get(orgA, candB.id) === null);
  let confCross = false; try { CC.confirm(orgA, candB.id, "u-boss"); } catch { confCross = true; }
  check("8.2 confirmar candidato de outro tenant falha", confCross);
  check("8.3 list isolado por org", CC.list(orgB, {}).length === 1 && CC.list(orgB, {})[0].id === candB.id);
  check("8.4 a restrição de A não vaza pra B", CONS.list(orgB, {}).length === 0);

  console.log("\n=== TEST: Context Candidate (PRD 3 F6) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Context Candidate (F6) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
