/**
 * TEST — PRD 4 F1 (Core Contracts): contratos puros do SkillOS. SEM DB/LLM —
 * determinístico, roda em CI sem chave. Prova os tipos + as guardas/invariantes:
 *
 *   - taxonomia de falhas AI-FAIL-1..6 + política de retry por classe (§17/§27);
 *   - tool permission (§44): permitida só se declarada e não proibida;
 *   - model match (§22/§23): modelo atende se cobre needs + janela;
 *   - confidence gate (§21): a confiança altera comportamento;
 *   - validateCapability / validateSkillManifest: forma + invariantes (tool não pode
 *     ser allowed E forbidden; supportsFallback exige fallbackSkills);
 *   - vocabulários fechados + versão do contrato.
 *
 * Uso: npm run test:skillos-contracts
 */
import { strict as assert } from "assert";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const M = await import("../src/server/skillosModel.js");

  // ═══════════════ 0. vocabulário + versão ═══════════════
  check("0.1 versão do contrato", M.SKILLOS_CONTRACT_VERSION === 1);
  check("0.2 status de ciclo de vida", JSON.stringify(M.LIFECYCLE_STATUSES) === JSON.stringify(["draft", "active", "deprecated", "disabled"]));
  check("0.3 response types estende basis com recommendation (§20)", M.RESPONSE_TYPES.includes("fact") && M.RESPONSE_TYPES.includes("hypothesis") && M.RESPONSE_TYPES.includes("recommendation"));
  check("0.4 result status nunca 'silêncio' (§65)", JSON.stringify(M.SKILL_RESULT_STATUSES) === JSON.stringify(["success", "fallback", "blocked", "escalated", "failed"]));

  // ═══════════════ 1. taxonomia de falhas (§17) + retry (§27) ═══════════════
  check("1.1 6 classes de falha", M.FAILURE_CLASSES.length === 6);
  check("1.2 códigos AI-FAIL-N", M.failureCode("technical") === "AI-FAIL-1" && M.failureCode("outcome") === "AI-FAIL-6" && M.failureCode("grounding") === "AI-FAIL-3");
  check("1.3 retry: técnico→backoff", M.retryPolicyFor("technical") === "backoff");
  check("1.4 retry: formato→corretivo", M.retryPolicyFor("format") === "corrective");
  check("1.5 retry: policy→nunca repetir", M.retryPolicyFor("policy") === "no_retry");
  check("1.6 retry: grounding→fallback (não repete igual)", M.retryPolicyFor("grounding") === "fallback");
  check("1.7 retry: outcome→sem retry (decisão humana)", M.retryPolicyFor("outcome") === "no_retry");

  // ═══════════════ 2. tool permission (§44) ═══════════════
  const skillTools = { allowedTools: ["ocr", "accounting_read"], forbiddenTools: ["whatsapp_send", "create_payment"] };
  check("2.1 tool declarada é permitida", M.toolAllowedBySkill(skillTools, "ocr") === true);
  check("2.2 tool não declarada é bloqueada", M.toolAllowedBySkill(skillTools, "send_email") === false);
  check("2.3 tool proibida é bloqueada (mesmo se estivesse em allowed)", M.toolAllowedBySkill({ allowedTools: ["x"], forbiddenTools: ["x"] }, "x") === false);

  // ═══════════════ 3. model match (§22/§23) ═══════════════
  const profBig = { model: "big", provider: "p", capabilities: ["reasoning", "structured_output", "long_context"] as any[], contextTokens: 128000 };
  const profSmall = { model: "small", provider: "p", capabilities: ["fast", "cheap"] as any[], contextTokens: 8000 };
  check("3.1 modelo cobre needs → atende", M.modelMeets(profBig as any, { needs: ["reasoning", "structured_output"] }) === true);
  check("3.2 modelo sem a capacidade → não atende", M.modelMeets(profSmall as any, { needs: ["reasoning"] }) === false);
  check("3.3 janela de contexto insuficiente → não atende", M.modelMeets(profSmall as any, { needs: ["fast"], minContextTokens: 32000 }) === false);
  check("3.4 janela suficiente → atende", M.modelMeets(profBig as any, { needs: ["reasoning"], minContextTokens: 32000 }) === true);

  // ═══════════════ 4. confidence gate (§21) ═══════════════
  const t = { low: 0.4, high: 0.75 };
  check("4.1 alta confiança → segue", M.confidenceAction(0.9, t) === "continue");
  check("4.2 média → buscar mais contexto", M.confidenceAction(0.6, t) === "seek_context");
  check("4.3 baixa → fallback/humano", M.confidenceAction(0.2, t) === "fallback");
  check("4.4 exatamente no high → segue (limiar inclusivo)", M.confidenceAction(0.75, t) === "continue");

  // ═══════════════ 5. validateCapability (§7) ═══════════════
  const okCap = { capabilityId: "classify_intent", version: 1, name: "Classificar intenção", category: "nlp", riskLevel: "low", status: "active", defaultBudgetClass: "low", requiredContext: "minimal", supportedVerticals: ["retail"] };
  check("5.1 capability válida", M.validateCapability(okCap).valid);
  const badCap = M.validateCapability({ capabilityId: "", version: 0, name: "", category: "x", riskLevel: "bogus", status: "on" });
  check("5.2 capability inválida acumula erros", !badCap.valid && badCap.errors.length >= 4);
  check("5.3 não-objeto inválido", !M.validateCapability(null).valid);

  // ═══════════════ 6. validateSkillManifest (§9) + invariantes ═══════════════
  const okSkill = {
    skillId: "intent_llm_v2", version: 2, capabilityId: "classify_intent", riskLevel: "low", status: "active",
    allowedTools: ["nlp"], forbiddenTools: ["whatsapp_send"], supportsFallback: true, fallbackSkills: ["intent_regex_v1"],
    requiredContextProfile: "minimal", budgetClass: "low", maxAttempts: 2,
  };
  check("6.1 skill manifest válido", M.validateSkillManifest(okSkill).valid);
  // INVARIANTE §44: tool em allowed E forbidden.
  const clash = M.validateSkillManifest({ ...okSkill, allowedTools: ["nlp", "x"], forbiddenTools: ["x"] });
  check("6.2 tool allowed+forbidden é pega", !clash.valid && clash.errors.some((e: string) => e.includes("allowed E forbidden")));
  // INVARIANTE fallback: supportsFallback sem fallbackSkills.
  const noFb = M.validateSkillManifest({ ...okSkill, supportsFallback: true, fallbackSkills: [] });
  check("6.3 supportsFallback sem fallbackSkills é pego", !noFb.valid && noFb.errors.some((e: string) => e.includes("fallbackSkills")));
  // allowedTools ausente (nada implícito §9).
  const noTools = M.validateSkillManifest({ ...okSkill, allowedTools: undefined });
  check("6.4 allowedTools obrigatório (nada implícito)", !noTools.valid && noTools.errors.some((e: string) => e.includes("allowedTools")));
  // capabilityId ausente (skill sem capability não existe).
  const noCap = M.validateSkillManifest({ ...okSkill, capabilityId: "" });
  check("6.5 skill sem capabilityId é inválida", !noCap.valid);

  // sanity: os tipos exportados são usáveis como valores (compilação já garante).
  const res: any = { skillId: "s", capabilityId: "c", status: "success", responseType: "recommendation", confidence: 0.8, evidence: [], fallbackUsed: false };
  check("6.6 SkillResult aceita status terminal + responseType válido", M.SKILL_RESULT_STATUSES.includes(res.status) && M.RESPONSE_TYPES.includes(res.responseType));

  console.log("\n=== TEST: SkillOS Core Contracts (PRD 4 F1) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  assert.equal(failures, 0);
  console.log("\n✅ SkillOS Core Contracts (F1) OK.");
}

main().catch((e) => { console.error(e); process.exit(1); });
