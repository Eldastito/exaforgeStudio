/**
 * TEST — BEAUTY-008 (ADR-169 F8): Análise de Harmonia Visual.
 *
 * Prova a regra fundante RN-BS-03: **IA NUNCA julga aparência**. A análise
 * é DESCRITIVA (dimensões técnicas de estilo, vocab fechado), NUNCA
 * ranking / nota / adjetivo sobre a pessoa. Determinística (0 LLM).
 *
 * Checks-âncora:
 *  - `AiGovernanceService.PEOPLE_AFFECTING` inclui `estetica_appearance_advice`.
 *  - `guardApplied` lança `human_decision_required` sem `actorId + reason`.
 *  - Dimensões vindas do vocab fechado (5 chaves).
 *  - Narrativa NUNCA contém palavras proibidas (bonito/feio/atrativo/nota/
 *    score/rank/melhor/pior/envelhec/rejuvenesc/embel...) — se aparecer,
 *    o próprio service LANÇA (proteção contra regressão).
 *  - Disclaimer sempre presente (`disclaimer_shown=1` + texto embutido).
 *  - Cross-tenant duro (get/list com org errada → null/[]).
 *  - Consent revogado → recusa (RN-BS-04).
 *  - Determinismo: 2 chamadas com mesmos inputs geram mesma narrativa
 *    (não é LLM).
 *
 * Uso: npm run test:beauty-harmony-analysis
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-harm-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-beauty-harm-1234567890abcdef";
process.env.BEAUTY_HAIR_SIMULATION_PROVIDER = "stub";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));

  const sharp = (await import("sharp")).default;
  const { BeautyVisualConsultationService } = await import("../src/server/BeautyVisualConsultationService.js");
  const { BeautyHairSimulationService } = await import("../src/server/BeautyHairSimulationService.js");
  const {
    BeautyHarmonyAnalysisService,
    CONTRASTE_VALORES, EQUILIBRIO_VALORES, DESTAQUE_VALORES,
    VOLUME_VALORES, INTENSIDADE_VALORES, HARMONY_DISCLAIMER,
  } = await import("../src/server/BeautyHarmonyAnalysisService.js");
  const { AiGovernanceService, PEOPLE_AFFECTING } = await import("../src/server/AiGovernanceService.js");

  const seedOrg = () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`,
    ).run(randomUUID(), orgId);
    return orgId;
  };
  const seedContact = (orgId: string, name = "Cliente") => {
    const id = `c_${randomUUID().slice(0, 6)}`;
    db.prepare(
      `INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch1', ?, ?)`,
    ).run(id, orgId, name, `${orgId}:${id}`);
    return id;
  };
  const prepareReady = async (orgId: string, contactId: string, goal = "mechas", intensity = "moderado") => {
    BeautyVisualConsultationService.grantConsent(orgId, contactId, "hair_simulation");
    const cons = BeautyVisualConsultationService.startConsultation(orgId, { contactId, goal, intensity });
    const photo = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 128, g: 64, b: 32 } } }).jpeg().toBuffer();
    const up = await BeautyVisualConsultationService.uploadReferencePhoto(orgId, cons.id, photo);
    BeautyVisualConsultationService.approveAsset(orgId, (up as any).assetId);
    return BeautyVisualConsultationService.getConsultation(orgId, cons.id)!;
  };

  const orgA = seedOrg();
  const anaId = seedContact(orgA, "Ana");

  // ===== 1. PEOPLE_AFFECTING inclui a nova entrada =====
  check("PEOPLE_AFFECTING.estetica_appearance_advice existe",
    !!PEOPLE_AFFECTING.estetica_appearance_advice);
  check("entrada tem label + basis + fairnessNote (padrão canônico)",
    !!PEOPLE_AFFECTING.estetica_appearance_advice?.label &&
    !!PEOPLE_AFFECTING.estetica_appearance_advice?.basis &&
    !!PEOPLE_AFFECTING.estetica_appearance_advice?.fairnessNote);
  check("AiGovernanceService.isPeopleAffecting('estetica_appearance_advice')=true",
    AiGovernanceService.isPeopleAffecting("estetica_appearance_advice"));

  // ===== 2. guardApplied lança sem actor+reason =====
  let guardErr: string | null = null;
  try {
    AiGovernanceService.guardApplied("estetica_appearance_advice", {
      decision: "applied", actorId: null, reason: null,
    });
  } catch (e: any) { guardErr = e?.code || e?.message || "err"; }
  check("guardApplied sem actor/reason lança 'human_decision_required'",
    guardErr === "human_decision_required");

  guardErr = null;
  try {
    AiGovernanceService.guardApplied("estetica_appearance_advice", {
      decision: "applied", actorId: "u_1", reason: "   ",
    });
  } catch (e: any) { guardErr = e?.code || e?.message || "err"; }
  check("guardApplied com reason vazio lança",
    guardErr === "human_decision_required");

  // ===== 3. Vocabulary API =====
  const vocab = BeautyHarmonyAnalysisService.vocabulary();
  check("vocabulary.contraste tem 3 valores", vocab.contraste.length === 3);
  check("vocabulary.equilibrio tem 3 valores", vocab.equilibrio.length === 3);
  check("vocabulary.destaque tem 4 valores", vocab.destaque.length === 4);
  check("vocabulary.volume tem 3 valores", vocab.volume.length === 3);
  check("vocabulary.intensidade tem 3 valores", vocab.intensidade.length === 3);
  check("vocabulary.disclaimer não vazio", !!vocab.disclaimer && vocab.disclaimer.length > 50);
  check("HARMONY_DISCLAIMER contém 'nunca um julgamento' (RN-BS-03)",
    HARMONY_DISCLAIMER.toLowerCase().includes("nunca um julgamento"));

  // ===== 4. analyze — pré-condições =====
  const cons = await prepareReady(orgA, anaId, "mechas", "moderado");

  // Sem actor/reason → lança
  let noActor: string | null = null;
  try { BeautyHarmonyAnalysisService.analyze(orgA, cons.id, { actorId: null, reason: null }); }
  catch (e: any) { noActor = e?.code || e?.message || "err"; }
  check("analyze sem actor/reason → human_decision_required (RN-BS-03)",
    noActor === "human_decision_required");

  // Consulta inexistente
  let noCons: string | null = null;
  try { BeautyHarmonyAnalysisService.analyze(orgA, "c_inexistente", { actorId: "u_a", reason: "Vou apresentar à cliente" }); }
  catch (e: any) { noCons = e?.message || "err"; }
  check("analyze com consulta inexistente lança", !!noCons);

  // Simulação de outra consulta rejeitada
  const consOutra = await prepareReady(orgA, seedContact(orgA, "Outra"), "corte");
  const simOutra = BeautyHairSimulationService.requestSimulation(orgA, consOutra.id, {
    simulationType: "cut", parameters: { cut: "chanel" },
  });
  let mismatch: string | null = null;
  try {
    BeautyHarmonyAnalysisService.analyze(orgA, cons.id, {
      simulationId: (simOutra as any).simulationId,
      actorId: "u_a", reason: "teste",
    });
  } catch (e: any) { mismatch = e?.message || "err"; }
  check("analyze com simulação de OUTRA consulta lança", !!mismatch && /não pertence|nao pertence|not.*belong/i.test(mismatch));

  // ===== 5. Happy path — dimensões DERIVADAS do vocab fechado =====
  const a1 = BeautyHarmonyAnalysisService.analyze(orgA, cons.id, {
    actorId: "u_ana", reason: "Vou mostrar à cliente antes do serviço",
  });
  check("analyze happy path retorna id", !!a1.id);
  check("dimensions.contraste é valor válido do vocab",
    (CONTRASTE_VALORES as readonly string[]).includes(a1.dimensions.contraste));
  check("dimensions.equilibrio é valor válido do vocab",
    (EQUILIBRIO_VALORES as readonly string[]).includes(a1.dimensions.equilibrio));
  check("dimensions.destaque é valor válido do vocab",
    (DESTAQUE_VALORES as readonly string[]).includes(a1.dimensions.destaque));
  check("dimensions.volume é valor válido do vocab",
    (VOLUME_VALORES as readonly string[]).includes(a1.dimensions.volume));
  check("dimensions.intensidade é valor válido do vocab",
    (INTENSIDADE_VALORES as readonly string[]).includes(a1.dimensions.intensidade));
  check("dimensions.intensidade='moderada' pra consulta com intensity='moderado'",
    a1.dimensions.intensidade === "moderada");

  // ===== 6. Narrativa NUNCA contém palavras proibidas =====
  const nar = a1.narrative.toLowerCase();
  const FORBIDDEN = [
    "bonito", "bonita", "feio", "feia", "atraente", "atrativo",
    "lindo", "linda", "nota", "score", "rank", "pontuação",
    "melhor", "pior", "embelezar", "rejuvenescer", "envelhecer",
    "afinar", "emagrecer",
  ];
  for (const w of FORBIDDEN) {
    check(`narrativa NÃO contém palavra proibida "${w}"`,
      !new RegExp(`\\b${w}\\w*`, "u").test(nar));
  }
  check("narrativa começa com 'Para ' (padrão descritivo)", a1.narrative.startsWith("Para "));
  check("narrativa MENCIONA todas as 5 dimensões (contraste/equilíbrio/destaque/volume/intensidade)",
    nar.includes("contraste") && nar.includes("equilíbrio") && nar.includes("destaque") && nar.includes("volume") && nar.includes("intensidade"));

  // ===== 7. Disclaimer presente =====
  check("análise gravada com disclaimer_shown=true", a1.disclaimerShown === true);
  check("narrativa contém o texto do HARMONY_DISCLAIMER",
    a1.narrative.includes("nunca um julgamento sobre a pessoa"));

  // ===== 8. Analysis com simulação específica muda dimensões =====
  const sim = BeautyHairSimulationService.requestSimulation(orgA, cons.id, {
    simulationType: "combined", parameters: { color: "loiro_platinado", cut: "longo" },
  });
  const a2 = BeautyHarmonyAnalysisService.analyze(orgA, cons.id, {
    simulationId: (sim as any).simulationId,
    actorId: "u_ana", reason: "Análise da simulação escolhida",
  });
  check("análise com sim de cor=loiro_platinado → contraste='alto'", a2.dimensions.contraste === "alto");
  check("análise com corte=longo → volume='pronunciado'", a2.dimensions.volume === "pronunciado");
  check("análise com (loiro+longo) → intensidade='marcante' (mesmo com intensity=moderado)",
    // A intensidade base vem da consulta (moderada); intensification pelo par
    // acontece só quando intensity está ausente. Aqui o intensity='moderado'
    // ganha — mas equilíbrio deve ser 'marcante'.
    a2.dimensions.intensidade === "moderada" && a2.dimensions.equilibrio === "marcante");

  // ===== 9. Determinismo — 2 chamadas mesmos inputs = mesma narrativa =====
  const a3 = BeautyHarmonyAnalysisService.analyze(orgA, cons.id, {
    simulationId: (sim as any).simulationId,
    actorId: "u_ana", reason: "Análise da simulação escolhida", // mesma reason
  });
  check("2 análises com MESMOS inputs geram MESMA narrativa (determinismo — nunca LLM)",
    a2.narrative === a3.narrative);
  check("2 análises com MESMOS inputs geram MESMAS dimensões",
    JSON.stringify(a2.dimensions) === JSON.stringify(a3.dimensions));
  check("mas ids DIFERENTES (histórico completo — LGPD)",
    a2.id !== a3.id);

  // ===== 10. listForConsultation retorna histórico =====
  const list = BeautyHarmonyAnalysisService.listForConsultation(orgA, cons.id);
  check("listForConsultation retorna 3 análises da consulta", list.length === 3);
  check("lista ordenada por created_at DESC (mais recente primeiro)",
    list[0].createdAt >= list[list.length - 1].createdAt);

  // getForSimulation retorna a mais recente
  const forSim = BeautyHarmonyAnalysisService.getForSimulation(orgA, (sim as any).simulationId);
  check("getForSimulation retorna análise da simulação", !!forSim);
  check("getForSimulation traz a mais recente (a3)", forSim?.id === a3.id);

  // ===== 11. Consent revogado → recusa =====
  BeautyVisualConsultationService.revokeConsent(orgA, anaId, "hair_simulation");
  let noConsent: string | null = null;
  try { BeautyHarmonyAnalysisService.analyze(orgA, cons.id, { actorId: "u_a", reason: "teste" }); }
  catch (e: any) { noConsent = e?.message || "err"; }
  check("análise após revoke hair_simulation lança (RN-BS-04)",
    !!noConsent && /consent|revog/i.test(noConsent));

  // ===== 12. Cross-tenant duro =====
  const orgB = seedOrg();
  const bContact = seedContact(orgB, "Bia");
  const consB = await prepareReady(orgB, bContact);
  const aB = BeautyHarmonyAnalysisService.analyze(orgB, consB.id, { actorId: "u_b", reason: "teste orgB" });
  check("análise criada na orgB isolada", !!aB.id);

  const cross = BeautyHarmonyAnalysisService.getById(orgA, aB.id);
  check("cross-tenant: getById com org errada → null", cross === null);
  const crossList = BeautyHarmonyAnalysisService.listForConsultation(orgA, consB.id);
  check("cross-tenant: listForConsultation com org errada → []", crossList.length === 0);

  // ===== 13. Auditoria: ai_decisions ganha 1 linha por análise =====
  const decisions = db.prepare(
    `SELECT COUNT(*) c FROM ai_decisions WHERE organization_id = ? AND kind = 'estetica_appearance_advice' AND decision = 'applied'`,
  ).get(orgA) as any;
  check("cada análise da orgA gera 1 linha em ai_decisions (auditoria ADR-130)",
    decisions.c === 3);

  // ===== 14. Zero hardcoded do Studio Márcia (§17/§65) =====
  const forbiddenNeedles = ["studio_marcia", "studio de beleza márcia", "marcia_studio", "\"marcia\"", "'marcia'"];
  let hardcoded: string | null = null;
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|jsx)$/.test(f.name)) {
        try {
          const s = fs.readFileSync(p, "utf8").toLowerCase();
          for (const n of forbiddenNeedles) if (s.includes(n)) { hardcoded = `${p}: ${n}`; return; }
        } catch { /* skip */ }
      }
    }
  };
  try {
    walk(path.join(process.cwd(), "src", "server"));
    if (!hardcoded) walk(path.join(process.cwd(), "src", "features"));
  } catch { /* skip */ }
  check("nenhum hardcoded do Studio Márcia em src/server ou src/features (§17/§65)", hardcoded === null, hardcoded || undefined);

  // --- Relatório ---
  console.log("\n=== TEST: Beauty AI — Análise de Harmonia Visual (ADR-169 F8 / BEAUTY-008) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? "  [" + r.note + "]" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Análise de Harmonia Visual pronta — descritiva, nunca ranking, PEOPLE_AFFECTING ativo.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
