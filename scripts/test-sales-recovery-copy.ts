/**
 * TEST — ADR-155 F3.1: tune-up da copy de Recuperação Comercial.
 *
 * `SalesRecoveryCopy` centraliza control vs calibrated (prompt do LLM + fallback
 * determinístico), escolhido por-org. Cobre:
 *  - variantFor: default 'control', opt-in 'calibrated', sem org → control, isolamento;
 *  - control BYTE-IDÊNTICO à copy legada (zero mudança em prod / test:piloto verde);
 *  - calibrated DIFERE do control e carrega o framework da rubrica (prova de
 *    compromisso / reciprocidade);
 *  - GUARDRAILS nas DUAS variantes: nada de urgência falsa / cobrança / ameaça,
 *    em todos os stages e tentativas;
 *  - o gerador (fallback sem OPENAI_API_KEY) usa a variante da org.
 *
 * Uso: npm run test:sales-recovery-copy
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sales-recovery-copy-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-sales-recovery-copy-123456";
delete process.env.OPENAI_API_KEY; // força o caminho de fallback (template determinístico)

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// Substrings PROIBIDAS em qualquer copy (urgência falsa / cobrança / ameaça).
const FORBIDDEN = ["última chance", "ultima chance", "expira", "dívida", "divida", "pendência", "pendencia", "urgente", "você sumiu", "voce sumiu"];
const clean = (t: string) => FORBIDDEN.every((w) => !t.toLowerCase().includes(w));

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SalesRecoveryCopy } = await import("../src/server/SalesRecoveryCopy.js");
  const { generate } = await import("../src/server/SalesRecoveryMessageGenerator.js");

  function seedOrg(orgId: string, variant?: string) {
    db.prepare(`
      INSERT INTO organization_settings (id, organization_id, business_name, vertical, status, onboarding_status, plan_id, billing_status, default_landing_view, sales_recovery_copy_variant)
      VALUES (?, ?, ?, 'servicos', 'active', 'completed', 'growth', 'active', 'dashboard', ?)
    `).run(randomUUID(), orgId, "Org " + orgId, variant ?? "control");
  }
  seedOrg("org_ctrl");
  seedOrg("org_cal", "calibrated");

  // ===== 1. variantFor =====
  check("sem org → control", SalesRecoveryCopy.variantFor(undefined) === "control");
  check("org default → control", SalesRecoveryCopy.variantFor("org_ctrl") === "control");
  check("org opt-in → calibrated", SalesRecoveryCopy.variantFor("org_cal") === "calibrated");
  check("org desconhecida → control", SalesRecoveryCopy.variantFor("nope") === "control");

  // ===== 2. control BYTE-IDÊNTICO à copy legada =====
  const A = { contactName: "Ana", stage: "proposta" } as const;
  check("control proposta = legado", SalesRecoveryCopy.template("control", A) === "Oi, Ana! 🙂 Faz uns dias que a gente não conversa por aqui — a proposta que enviei ainda faz sentido pra você? Se precisar ajustar algo, é só me falar.");
  check("control negociacao = legado", SalesRecoveryCopy.template("control", { contactName: "Ana", stage: "negociacao" }) === "Oi, Ana! 🙂 Quer retomar de onde a gente parou? Se ficou alguma dúvida ou tiver algo pra ajustar, me chama aqui.");
  check("control attempt2 = legado", SalesRecoveryCopy.template("control", { contactName: "Ana", stage: "proposta", attemptNumber: 2 }) === "Oi, Ana! 🙂 Sei que a rotina corre — só passando pra ver se ainda faz sentido a gente conversar. Sem pressão nenhuma.");
  check("control attempt3 = legado", SalesRecoveryCopy.template("control", { contactName: "Ana", stage: "proposta", attemptNumber: 3 }) === "Oi, Ana! 🙂 Vou deixar essa conversa em stand-by por aqui — se um dia quiser retomar, é só me chamar. Obrigado! 🙏");
  check("control default (qualificado) = legado", SalesRecoveryCopy.template("control", { contactName: "Ana", stage: "qualificado" }) === "Oi, Ana! 🙂 Só passando pra saber se posso te ajudar em algo por aqui. Se preferir conversar depois, é só me avisar.");
  check("control sem nome → 'Oi!'", SalesRecoveryCopy.template("control", { stage: "qualificado" }).startsWith("Oi! 🙂"));

  // ===== 3. calibrated DIFERE e carrega o framework =====
  check("calibrated proposta ≠ control", SalesRecoveryCopy.template("calibrated", A) !== SalesRecoveryCopy.template("control", A));
  check("calibrated proposta cita revisar/ajustar (reciprocidade)", /revis|ajustar/i.test(SalesRecoveryCopy.template("calibrated", A)));
  check("calibrated attempt3 mantém porta aberta", /stand-by/i.test(SalesRecoveryCopy.template("calibrated", { stage: "proposta", attemptNumber: 3 })));

  // ===== 4. GUARDRAILS nas duas variantes, todos stages × tentativas =====
  const stages = ["qualificado", "proposta", "orcamento", "negociacao"];
  const attempts = [1, 2, 3] as const;
  let allClean = true;
  for (const v of ["control", "calibrated"] as const)
    for (const s of stages)
      for (const a of attempts) {
        const t = SalesRecoveryCopy.template(v, { contactName: "Ana", stage: s, attemptNumber: a });
        if (!clean(t) || t.length === 0) allClean = false;
        if (t.length > 220) allClean = false; // margem sobre o cap de 200 (emoji conta multibyte)
      }
  check("nenhuma copy tem urgência/cobrança/ameaça (control+calibrated)", allClean);

  // ===== 5. systemPrompt: control legado, calibrated framework, ambos sem urgência =====
  const spCtrl = SalesRecoveryCopy.systemPrompt("control", 1);
  const spCal = SalesRecoveryCopy.systemPrompt("calibrated", 1);
  check("systemPrompt control = base legada", spCtrl.includes("RETOMAR uma conversa comercial parada"));
  check("systemPrompt calibrated cita o framework da rubrica", spCal.includes("rubrica sales-recovery") && /prova de compromisso/i.test(spCal));
  check("systemPrompt resolve o {ATTEMPT_HINT}", !spCtrl.includes("{ATTEMPT_HINT}") && !spCal.includes("{ATTEMPT_HINT}"));
  check("systemPrompt (ambos) proíbem urgência falsa", /urgência falsa/i.test(spCtrl) && /urgência falsa/i.test(spCal));
  check("systemPrompt attempt3 fala em stand-by", /stand-by/i.test(SalesRecoveryCopy.systemPrompt("calibrated", 3)));

  // ===== 6. gerador (fallback) usa a variante da org =====
  const gCal = await generate({ orgId: "org_cal", contactName: "Ana", stage: "proposta", daysStalled: 5 });
  check("gerador sem LLM → source template", gCal.source === "template");
  check("gerador da org calibrated usa a copy calibrada", gCal.text === SalesRecoveryCopy.template("calibrated", A));
  const gCtrl = await generate({ orgId: "org_ctrl", contactName: "Ana", stage: "proposta", daysStalled: 5 });
  check("gerador da org control usa a copy legada", gCtrl.text === SalesRecoveryCopy.template("control", A));
  const gNone = await generate({ contactName: "Ana", stage: "proposta", daysStalled: 5 });
  check("gerador sem orgId → control (retrocompat)", gNone.text === SalesRecoveryCopy.template("control", A));

  console.log("");
  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"} — ${x.name}`);
  console.log(failures === 0 ? "\nOK — 100% PASS" : `\nFALHOU — ${failures} checagem(ns)`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
});
