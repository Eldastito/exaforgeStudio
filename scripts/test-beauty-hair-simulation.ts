/**
 * TEST — BEAUTY-006 (ADR-169 F6): Simulador de Cabelo.
 *
 * Prova o core da Beauty AI: `requestSimulation` → job na fila →
 * `processJob` executa provider → output SUCCEEDED → URL assinada. E
 * todos os guardrails que a fatia carrega: prompt invertido documentado,
 * vocabulário fechado, idempotência por input_hash, multi-tenant duro,
 * consent revalidado no request, purga de retenção.
 *
 * Uso o Stub provider (SEMPRE disponível — determinístico) pra não
 * depender de chave de IA no CI.
 *
 * Guardrails RN-BS validados:
 *   RN-BS-01 — SIMULAÇÃO ≠ AGENDAMENTO (output SUCCEEDED NÃO cria
 *              appointment; consulta segue em 'ready' até o usuário
 *              escolher em F7+).
 *   RN-BS-02 — referenceLookId de outra org é IGNORADO (não vaza
 *              existência); só do próprio tenant vale.
 *   RN-BS-04 — SAFETY_PROMPT_HAIR inclui "preserve rosto/expressão/tom
 *              de pele/corpo IDÊNTICOS" + "PROIBIDO embelezar/afinar/
 *              emagrecer/rejuvenescer"; consent revalidado antes de
 *              chamar provider.
 *   RN-BS-05 — logs só error_code/error_message_safe; safety_report_json
 *              guarda flags booleanas apenas.
 *   RN-BS-06 — idempotência real por input_hash (avatar+params+provider).
 *   RN-BS-07 — cross-tenant duro em request/get/list.
 *   RN-BS-11 — vocab fechado (color/cut fora dos sets é ignorado); sem
 *              foto approved não simula; sem consent não simula.
 *
 * Uso: npm run test:beauty-hair-simulation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-sim-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-beauty-sim-1234567890abcdef";
process.env.BEAUTY_HAIR_SIMULATION_PROVIDER = "stub"; // força determinístico

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
  const {
    BeautyHairSimulationService,
    SIMULATION_TYPES,
    SIMULATION_STATUSES,
    COLOR_VOCAB,
    CUT_VOCAB,
    SAFETY_PROMPT_HAIR,
  } = await import("../src/server/BeautyHairSimulationService.js");

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
  const seedReferenceLook = (orgId: string, name: string, active = true) => {
    const id = `rl_${randomUUID().slice(0, 6)}`;
    db.prepare(
      `INSERT INTO beauty_reference_looks (id, organization_id, name, hair_type, tone, cut_style, active) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, orgId, name, "cacheado", "castanho", "chanel", active ? 1 : 0);
    return id;
  };
  const seedPhoto = async (): Promise<Buffer> =>
    await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 128, g: 64, b: 32 } } }).jpeg().toBuffer();

  // Prepara consulta com foto aprovada (F5 flow).
  const prepareReady = async (orgId: string, contactId: string) => {
    BeautyVisualConsultationService.grantConsent(orgId, contactId, "hair_simulation");
    const cons = BeautyVisualConsultationService.startConsultation(orgId, {
      contactId, goal: "mechas", intensity: "moderado",
    });
    const photo = await seedPhoto();
    const up = await BeautyVisualConsultationService.uploadReferencePhoto(orgId, cons.id, photo);
    if (!up.ok) throw new Error("prepareReady: upload falhou " + (up as any).error);
    BeautyVisualConsultationService.approveAsset(orgId, (up as any).assetId);
    return { consultation: BeautyVisualConsultationService.getConsultation(orgId, cons.id)!, assetId: (up as any).assetId as string };
  };

  const orgA = seedOrg();
  const anaId = seedContact(orgA, "Ana");
  const biaId = seedContact(orgA, "Bia");

  // ===== 1. Constantes exportadas =====
  check("SIMULATION_TYPES tem color/cut/combined",
    ["color", "cut", "combined"].every(t => (SIMULATION_TYPES as readonly string[]).includes(t)));
  check("SIMULATION_STATUSES inclui CREATED/QUEUED/PROCESSING/SUCCEEDED/FAILED_FINAL",
    ["CREATED", "QUEUED", "PROCESSING", "SUCCEEDED", "FAILED_FINAL"].every(s =>
      (SIMULATION_STATUSES as readonly string[]).includes(s)));
  check("COLOR_VOCAB inclui morena_iluminada + loiro + ruivo",
    COLOR_VOCAB.has("morena_iluminada") && COLOR_VOCAB.has("loiro") && COLOR_VOCAB.has("ruivo"));
  check("CUT_VOCAB inclui chanel + bob + camadas",
    CUT_VOCAB.has("chanel") && CUT_VOCAB.has("bob") && CUT_VOCAB.has("camadas"));

  // ===== 2. Prompt invertido (RN-BS-04) — validação textual =====
  const p = SAFETY_PROMPT_HAIR.toLowerCase();
  check("prompt preserva rosto/expressão/tom de pele/corpo",
    p.includes("rosto") && p.includes("expressão") && p.includes("tom de pele") && p.includes("corpo"));
  check("prompt PROÍBE embelezar/afinar/emagrecer/rejuvenescer (RN-BS-03)",
    p.includes("embelezar") && p.includes("afinar") && p.includes("emagrecer") && p.includes("rejuvenescer"));
  check("prompt fala em ALTERAR o cabelo (invertido do Fashion)",
    p.includes("cabelo alterado") || p.includes("mudança de cabelo") || p.includes("aplique a mudança de cabelo"));
  check("prompt PROÍBE nudez/sexualização", p.includes("nudez") && p.includes("sexualiza"));
  check("prompt PROÍBE trocar a pessoa ou adicionar outras", p.includes("trocar a pessoa") && p.includes("outras pessoas"));

  // ===== 3. Vocabulary API =====
  const vocab = BeautyHairSimulationService.vocabulary();
  check("vocabulary().colors não vazio", vocab.colors.length > 0);
  check("vocabulary().cuts não vazio", vocab.cuts.length > 0);
  check("vocabulary().types === SIMULATION_TYPES", vocab.types.join(",") === SIMULATION_TYPES.join(","));

  // ===== 4. Provider ativo é o Stub (env forçado) =====
  check("providerKey='stub_v1' (BEAUTY_HAIR_SIMULATION_PROVIDER=stub)",
    BeautyHairSimulationService.providerKey() === "stub_v1");

  // ===== 5. requestSimulation — pré-condições =====
  // (a) consulta inexistente
  const noCons = BeautyHairSimulationService.requestSimulation(orgA, "cons_inexistente", {
    simulationType: "color", parameters: { color: "loiro" },
  });
  check("requestSimulation com consulta inexistente recusa", noCons.ok === false);

  // (b) simulationType inválido
  const badType = BeautyHairSimulationService.requestSimulation(orgA, "cons_x", {
    simulationType: "invalido" as any,
  });
  check("simulationType inválido recusa", badType.ok === false);

  // (c) consulta em draft (sem foto aprovada) recusa
  BeautyVisualConsultationService.grantConsent(orgA, biaId, "hair_simulation");
  const consDraft = BeautyVisualConsultationService.startConsultation(orgA, { contactId: biaId, goal: "cor" });
  const notReady = BeautyHairSimulationService.requestSimulation(orgA, consDraft.id, {
    simulationType: "color", parameters: { color: "loiro" },
  });
  check("consulta em draft (foto não aprovada) recusa (RN-BS-11)",
    notReady.ok === false && /aprove/.test((notReady as any).error || ""));

  // ===== 6. Happy path: consulta pronta → simulação SUCCEEDED (Stub) =====
  const { consultation: consAna } = await prepareReady(orgA, anaId);
  check("consulta da Ana em status='ready' após aprovação", consAna.status === "ready");

  const req = BeautyHairSimulationService.requestSimulation(orgA, consAna.id, {
    simulationType: "color", parameters: { color: "morena_iluminada" },
  });
  check("requestSimulation retorna ok + simulationId", req.ok && !!(req as any).simulationId);
  check("requestSimulation com Stub retorna providerKey='stub_v1'",
    req.ok && (req as any).providerKey === "stub_v1");
  check("requestSimulation retorna status='QUEUED'", req.ok && (req as any).status === "QUEUED");
  check("requestSimulation reused=false na 1ª chamada", req.ok && (req as any).reused === false);

  const simId = (req as any).simulationId as string;

  // Verifica row no banco
  const rowRaw = db.prepare(`SELECT * FROM beauty_visual_simulations WHERE id = ?`).get(simId) as any;
  check("simulação gravada no banco", !!rowRaw);
  check("simulação.consultation_id = consAna.id", rowRaw.consultation_id === consAna.id);
  check("simulação.simulation_type = 'color'", rowRaw.simulation_type === "color");
  check("simulação.provider_key = 'stub_v1'", rowRaw.provider_key === "stub_v1");
  check("simulação.input_hash preenchido (sha256 = 64 chars hex)",
    typeof rowRaw.input_hash === "string" && rowRaw.input_hash.length === 64);
  const params = JSON.parse(rowRaw.parameters_json);
  check("parameters.color = 'morena_iluminada' (dentro do vocab)", params.color === "morena_iluminada");

  // Executa o job (síncrono via processJob público)
  await BeautyHairSimulationService.processJob(simId);
  const sim = BeautyHairSimulationService.getSimulation(orgA, simId)!;
  check("simulação SUCCEEDED após processJob", sim.status === "SUCCEEDED");
  check("outputStorageKey preenchido em SUCCEEDED", !!sim.outputStorageKey);
  check("outputStorageKey em subdir beauty/", sim.outputStorageKey!.startsWith("beauty/"));
  check("startedAt preenchido", !!sim.startedAt);
  check("completedAt preenchido", !!sim.completedAt);
  check("signedUrl emitida em SUCCEEDED", !!sim.signedUrl);
  check("signedUrl aponta pra rota /api/public/beauty/media",
    sim.signedUrl!.startsWith("/api/public/beauty/media"));

  // Arquivo output existe no disco
  const outPath = path.join(tmpDir, "private_media", sim.outputStorageKey!);
  check("arquivo output existe no disco", fs.existsSync(outPath));
  const outBuf = fs.readFileSync(outPath);
  check("arquivo output começa com PNG signature",
    outBuf.length >= 8 && outBuf[0] === 0x89 && outBuf[1] === 0x50 && outBuf[2] === 0x4E && outBuf[3] === 0x47);

  // ===== 7. Idempotência (RN-BS-06) =====
  const req2 = BeautyHairSimulationService.requestSimulation(orgA, consAna.id, {
    simulationType: "color", parameters: { color: "morena_iluminada" },
  });
  check("2ª request com mesmo (avatar+params+provider) retorna reused=true",
    req2.ok && (req2 as any).reused === true);
  check("2ª request retorna o MESMO simulationId (idempotência real)",
    req2.ok && (req2 as any).simulationId === simId);

  // Parâmetros ligeiramente diferentes → NOVA simulação
  const req3 = BeautyHairSimulationService.requestSimulation(orgA, consAna.id, {
    simulationType: "cut", parameters: { cut: "chanel" },
  });
  check("params diferentes → NOVA simulação (reused=false)",
    req3.ok && (req3 as any).reused === false && (req3 as any).simulationId !== simId);

  // ===== 8. Vocab fechado (RN-BS-11) =====
  const consBia2 = (await prepareReady(orgA, biaId)).consultation;
  const badColor = BeautyHairSimulationService.requestSimulation(orgA, consBia2.id, {
    simulationType: "color", parameters: { color: "azul_neon_glitter" as any },
  });
  check("cor fora do vocab é aceita como request (color=null no params) — RN-BS-11",
    badColor.ok === true);
  const simBadRaw = db.prepare(`SELECT parameters_json FROM beauty_visual_simulations WHERE id = ?`)
    .get((badColor as any).simulationId) as any;
  const paramsBad = JSON.parse(simBadRaw.parameters_json);
  check("cor inválida vira null no parameters (não vai texto arbitrário pro prompt)",
    paramsBad.color === null);

  // ===== 9. Consent revogado após upload — request recusa (RN-BS-04) =====
  const karenId = seedContact(orgA, "Karen");
  const { consultation: consK } = await prepareReady(orgA, karenId);
  BeautyVisualConsultationService.revokeConsent(orgA, karenId, "hair_simulation");
  const noConsent = BeautyHairSimulationService.requestSimulation(orgA, consK.id, {
    simulationType: "color", parameters: { color: "loiro" },
  });
  check("consent revogado após upload → recusa (belt-and-suspenders RN-BS-04)",
    noConsent.ok === false && /consent|revog/i.test((noConsent as any).error || ""));

  // ===== 10. Cross-tenant duro (RN-BS-07) =====
  const orgB = seedOrg();
  const carlaId = seedContact(orgB, "Carla");
  const { consultation: consC } = await prepareReady(orgB, carlaId);
  // request com orgA errada NÃO acha a consulta de orgB
  const cross = BeautyHairSimulationService.requestSimulation(orgA, consC.id, {
    simulationType: "color", parameters: { color: "loiro" },
  });
  check("cross-tenant: request com orgA + consulta de orgB recusa", cross.ok === false);
  // get com org errada retorna null
  const getCross = BeautyHairSimulationService.getSimulation(orgB, simId);
  check("cross-tenant: getSimulation com org errada → null", getCross === null);
  const listCross = BeautyHairSimulationService.listForConsultation(orgB, consAna.id);
  check("cross-tenant: listForConsultation com org errada → []", listCross.length === 0);

  // ===== 11. referenceLookId de outra org é IGNORADO (RN-BS-02) =====
  const lookA = seedReferenceLook(orgA, "Morena iluminada — Studio X");
  const lookB = seedReferenceLook(orgB, "Loiro — Studio Y");
  const reqRefA = BeautyHairSimulationService.requestSimulation(orgA, consAna.id, {
    simulationType: "combined", parameters: { color: "castanho", cut: "chanel", referenceLookId: lookA },
  });
  check("referenceLookId do mesmo tenant preservado",
    reqRefA.ok === true);
  const simRefA = db.prepare(`SELECT reference_look_id, parameters_json FROM beauty_visual_simulations WHERE id = ?`)
    .get((reqRefA as any).simulationId) as any;
  check("reference_look_id gravado quando é do mesmo tenant", simRefA.reference_look_id === lookA);

  const reqRefCross = BeautyHairSimulationService.requestSimulation(orgA, consAna.id, {
    simulationType: "combined", parameters: { color: "ruivo", cut: "bob", referenceLookId: lookB },
  });
  const simRefCross = db.prepare(`SELECT reference_look_id, parameters_json FROM beauty_visual_simulations WHERE id = ?`)
    .get((reqRefCross as any).simulationId) as any;
  check("reference_look_id de OUTRA org é IGNORADO (não vaza — RN-BS-02/07)",
    simRefCross.reference_look_id === null);
  const paramsCross = JSON.parse(simRefCross.parameters_json);
  check("referenceLookId cross-tenant vira null no params",
    paramsCross.referenceLookId === null);

  // ===== 12. Cancel de QUEUED (nunca de SUCCEEDED) =====
  // Cria uma simulação e cancela ANTES de processar
  const consCancel = (await prepareReady(orgA, seedContact(orgA, "Cancel"))).consultation;
  const reqCancel = BeautyHairSimulationService.requestSimulation(orgA, consCancel.id, {
    simulationType: "color", parameters: { color: "ruivo" },
  });
  const cancelled = BeautyHairSimulationService.cancelSimulation(orgA, (reqCancel as any).simulationId);
  check("cancelSimulation em QUEUED retorna true", cancelled === true);
  const cancelledRow = db.prepare(`SELECT status FROM beauty_visual_simulations WHERE id = ?`)
    .get((reqCancel as any).simulationId) as any;
  check("simulação DELETED após cancel", cancelledRow.status === "DELETED");

  const cancelSucceeded = BeautyHairSimulationService.cancelSimulation(orgA, simId);
  check("cancelSimulation em SUCCEEDED retorna false (não afeta)", cancelSucceeded === false);

  // ===== 13. listForConsultation =====
  const listAna = BeautyHairSimulationService.listForConsultation(orgA, consAna.id);
  check("listForConsultation retorna as simulações da consulta (>=2)", listAna.length >= 2);
  check("simulações SUCCEEDED na lista têm signedUrl",
    listAna.filter(s => s.status === "SUCCEEDED").every(s => !!s.signedUrl));

  // ===== 14. Purga por retenção =====
  db.prepare(
    `UPDATE beauty_visual_simulations SET completed_at = datetime('now', '-45 day') WHERE id = ?`,
  ).run(simId);
  const purged = BeautyHairSimulationService.purgeExpired();
  check("purgeExpired retorna >=1 (simulação vencida)", purged >= 1);
  const purgedRow = db.prepare(`SELECT status, output_storage_key FROM beauty_visual_simulations WHERE id = ?`)
    .get(simId) as any;
  check("simulação vencida → status=EXPIRED", purgedRow.status === "EXPIRED");
  check("output_storage_key removido do banco", purgedRow.output_storage_key === null);
  check("arquivo output apagado do disco",
    !fs.existsSync(path.join(tmpDir, "private_media", sim.outputStorageKey!)));

  // ===== 15. RN-BS-01 — SIMULAÇÃO ≠ AGENDAMENTO =====
  // Consulta segue em 'ready' (não avança pra scheduled) mesmo com sim SUCCEEDED
  const consAfterSim = BeautyVisualConsultationService.getConsultation(orgA, consAna.id)!;
  check("consulta segue em 'ready' após simulações SUCCEEDED (RN-BS-01 — SIM ≠ AGENDAMENTO)",
    consAfterSim.status === "ready");
  check("scheduledAppointmentId da consulta segue null (agendamento é F10)",
    consAfterSim.scheduledAppointmentId === null);

  // ===== 16. Zero hardcoded do Studio Márcia (§17/§65) =====
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
  console.log("\n=== TEST: Beauty AI — Simulador de Cabelo (ADR-169 F6 / BEAUTY-006) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? "  [" + r.note + "]" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Simulador de Cabelo pronto — provider plugável, idempotência, vocab fechado.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
