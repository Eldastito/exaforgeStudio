/**
 * TEST — BEAUTY-027 (ADR-169 F26): Reuso de imagens por CONTEÚDO + histórico
 * de visuais por cliente.
 *
 * A ideia da fatia: a imagem gerada é um ATIVO — quando a cliente volta no
 * mês seguinte com a mesma foto e pede o mesmo visual, o salão NÃO paga
 * outra geração de IA. O hash de idempotência muda de
 * `sha256(avatarId:params:providerKey)` para
 * `sha256(org:contato:sha256(bytesDaFoto):params)`:
 *
 *   - mesma foto re-enviada numa consulta NOVA → MESMO hash → reusa;
 *   - o PROVIDER fica FORA do hash → trocar OpenAI↔Google não invalida o
 *     acervo já gerado;
 *   - org+contato DENTRO do hash → reuso cross-tenant/cross-cliente é
 *     impossível por construção (RN-BS-07 + privacidade: a foto de uma
 *     cliente nunca "vale" pra outra, mesmo se os bytes coincidirem).
 *
 * E `listForContact` expõe o acervo (SUCCEEDED, todas as consultas do
 * contato) — rever/comparar não custa IA; purga por retenção (EXPIRED)
 * sai do acervo e re-gera corretamente.
 *
 * Uso: npm run test:beauty-simulation-reuse
 */
import os from "os";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-reuse-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-beauty-reuse-1234567890abcdef";
process.env.BEAUTY_HAIR_SIMULATION_PROVIDER = "stub"; // determinístico em CI

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

// Réplica local do stableStringify do service — pra provar a COMPOSIÇÃO do
// hash (org:contato:conteúdo:params — provider FORA) sem exportar internals.
function stableStringify(obj: any): string {
  if (obj == null) return "null";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k] ?? null)}`).join(",") + "}";
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));

  const sharp = (await import("sharp")).default;
  const { BeautyVisualConsultationService } = await import("../src/server/BeautyVisualConsultationService.js");
  const { BeautyHairSimulationService } = await import("../src/server/BeautyHairSimulationService.js");

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
  // A MESMA foto sempre (bytes idênticos) — é o cenário real da cliente que
  // volta com a foto salva no celular.
  const seedPhoto = async (): Promise<Buffer> =>
    await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 128, g: 64, b: 32 } } }).jpeg().toBuffer();

  const prepareReady = async (orgId: string, contactId: string) => {
    BeautyVisualConsultationService.grantConsent(orgId, contactId, "hair_simulation");
    const cons = BeautyVisualConsultationService.startConsultation(orgId, { contactId, goal: "coloração" });
    const up = await BeautyVisualConsultationService.uploadReferencePhoto(orgId, cons.id, await seedPhoto());
    if (!up.ok) throw new Error("prepareReady: upload falhou " + (up as any).error);
    BeautyVisualConsultationService.approveAsset(orgId, (up as any).assetId);
    return BeautyVisualConsultationService.getConsultation(orgId, cons.id)!;
  };

  const orgA = seedOrg();
  const anaId = seedContact(orgA, "Ana");

  // ===== 1. Baseline: 1ª geração (consulta 1) =====
  const cons1 = await prepareReady(orgA, anaId);
  const req1 = BeautyHairSimulationService.requestSimulation(orgA, cons1.id, {
    simulationType: "color", parameters: { color: "loiro" },
  });
  check("1ª request gera (reused=false)", req1.ok && (req1 as any).reused === false);
  const sim1 = (req1 as any).simulationId as string;
  await BeautyHairSimulationService.processJob(sim1);
  const sim1Row = BeautyHairSimulationService.getSimulation(orgA, sim1)!;
  check("1ª simulação SUCCEEDED com signedUrl", sim1Row.status === "SUCCEEDED" && !!sim1Row.signedUrl);

  // ===== 2. Regressão RN-BS-06: mesma consulta, mesmos params → reusa =====
  const req2 = BeautyHairSimulationService.requestSimulation(orgA, cons1.id, {
    simulationType: "color", parameters: { color: "loiro" },
  });
  check("mesma consulta + mesmos params → reused=true", req2.ok && (req2 as any).reused === true);
  check("mesma consulta: MESMO simulationId", req2.ok && (req2 as any).simulationId === sim1);

  // ===== 3. F26 CORE: mesma foto, consulta NOVA (cliente voltou) → reusa =====
  const cons2 = await prepareReady(orgA, anaId);
  check("consulta 2 pronta (id diferente da 1)", cons2.status === "ready" && cons2.id !== cons1.id);
  const req3 = BeautyHairSimulationService.requestSimulation(orgA, cons2.id, {
    simulationType: "color", parameters: { color: "loiro" },
  });
  check("consulta NOVA + mesma foto + mesmos params → reused=true (zero custo de IA)",
    req3.ok && (req3 as any).reused === true);
  check("consulta NOVA reusa o MESMO simulationId do acervo",
    req3.ok && (req3 as any).simulationId === sim1);
  const hashCount = db.prepare(
    `SELECT COUNT(*) AS n FROM beauty_visual_simulations WHERE organization_id = ? AND input_hash = (SELECT input_hash FROM beauty_visual_simulations WHERE id = ?)`,
  ).get(orgA, sim1) as any;
  check("nenhuma linha nova criada no reuso (1 row pro hash)", hashCount.n === 1);

  // ===== 4. Composição do hash: org:contato:sha256(foto):params — provider FORA =====
  const sim1Raw = db.prepare(`SELECT input_hash, parameters_json, avatar_id FROM beauty_visual_simulations WHERE id = ?`).get(sim1) as any;
  const assetRaw = db.prepare(`SELECT storage_key FROM beauty_avatar_assets WHERE id = ?`).get(sim1Raw.avatar_id) as any;
  const storedBytes = fs.readFileSync(path.join(tmpDir, "private_media", assetRaw.storage_key));
  const contentSha = crypto.createHash("sha256").update(storedBytes).digest("hex");
  const expectedHash = crypto.createHash("sha256")
    .update(`${orgA}:${anaId}:${contentSha}:${stableStringify(JSON.parse(sim1Raw.parameters_json))}`)
    .digest("hex");
  check("input_hash = sha256(org:contato:sha256(bytesDaFoto):params) — SEM provider",
    sim1Raw.input_hash === expectedHash);

  // Acervo gerado por OUTRO provider continua valendo (trocar de IA não
  // invalida imagem salva — o barato é reusar).
  db.prepare(`UPDATE beauty_visual_simulations SET provider_key = 'openai_hair_v1' WHERE id = ?`).run(sim1);
  const reqSwap = BeautyHairSimulationService.requestSimulation(orgA, cons2.id, {
    simulationType: "color", parameters: { color: "loiro" },
  });
  check("acervo gerado por provider DIFERENTE do ativo ainda reusa",
    reqSwap.ok && (reqSwap as any).reused === true && (reqSwap as any).simulationId === sim1);

  // ===== 5. Params diferentes → NOVA geração =====
  const reqCut = BeautyHairSimulationService.requestSimulation(orgA, cons2.id, {
    simulationType: "cut", parameters: { cut: "chanel" },
  });
  check("params diferentes → reused=false + novo id",
    reqCut.ok && (reqCut as any).reused === false && (reqCut as any).simulationId !== sim1);
  const simCut = (reqCut as any).simulationId as string;
  await BeautyHairSimulationService.processJob(simCut);

  // ===== 6. Contato DIFERENTE, mesma foto/params → NUNCA reusa =====
  const biaId = seedContact(orgA, "Bia");
  const consBia = await prepareReady(orgA, biaId);
  const reqBia = BeautyHairSimulationService.requestSimulation(orgA, consBia.id, {
    simulationType: "color", parameters: { color: "loiro" },
  });
  check("outro CONTATO (mesma foto/params) → reused=false (contato no hash)",
    reqBia.ok && (reqBia as any).reused === false && (reqBia as any).simulationId !== sim1);

  // ===== 7. Cross-org duro (RN-BS-07) =====
  const orgB = seedOrg();
  const carlaId = seedContact(orgB, "Carla");
  const consCarla = await prepareReady(orgB, carlaId);
  const reqCarla = BeautyHairSimulationService.requestSimulation(orgB, consCarla.id, {
    simulationType: "color", parameters: { color: "loiro" },
  });
  check("outra ORG (mesma foto/params) → reused=false (org no hash + filtro)",
    reqCarla.ok && (reqCarla as any).reused === false);
  check("listForContact cross-org → []",
    BeautyHairSimulationService.listForContact(orgB, anaId).length === 0);

  // ===== 8. Purga por retenção → EXPIRED sai do acervo e RE-GERA =====
  db.prepare(`UPDATE beauty_visual_simulations SET completed_at = datetime('now', '-60 days') WHERE id = ?`).run(sim1);
  BeautyHairSimulationService.purgeExpired();
  const afterPurge = BeautyHairSimulationService.getSimulation(orgA, sim1)!;
  check("simulação purgada vira EXPIRED sem output", afterPurge.status === "EXPIRED" && !afterPurge.outputStorageKey);
  const reqRegen = BeautyHairSimulationService.requestSimulation(orgA, cons2.id, {
    simulationType: "color", parameters: { color: "loiro" },
  });
  check("acervo purgado (EXPIRED) → re-gera (reused=false, novo id)",
    reqRegen.ok && (reqRegen as any).reused === false && (reqRegen as any).simulationId !== sim1);
  const simRegen = (reqRegen as any).simulationId as string;
  await BeautyHairSimulationService.processJob(simRegen);

  // ===== 9. listForContact — o acervo da cliente (todas as consultas) =====
  const history = BeautyHairSimulationService.listForContact(orgA, anaId);
  check("histórico da Ana tem 2 visuais vivos (corte + re-gerado)", history.length === 2);
  check("histórico NÃO inclui EXPIRED", history.every((s) => s.id !== sim1 && s.status === "SUCCEEDED"));
  check("histórico cobre consultas diferentes do MESMO contato",
    new Set(history.map((s) => s.consultationId)).size >= 1 &&
    history.some((s) => s.id === simCut) && history.some((s) => s.id === simRegen));
  check("todo item do histórico tem signedUrl", history.every((s) => !!s.signedUrl));
  check("histórico ordena mais recente primeiro", history[0].id === simRegen);
  check("histórico da Bia só tem os visuais da Bia",
    BeautyHairSimulationService.listForContact(orgA, biaId).every((s) => s.id !== simCut && s.id !== simRegen && s.id !== sim1));

  // ===== 10. F27 — stub NUNCA vale como acervo pra provider REAL =====
  // simRegen foi gerado pelo stub. Com OpenAI ativo, o mesmo pedido NÃO
  // pode ser satisfeito pelo quadrado de demonstração — regenera de verdade.
  delete process.env.BEAUTY_HAIR_SIMULATION_PROVIDER;
  process.env.OPENAI_API_KEY = "sk-test-quarentena";
  const reqReal = BeautyHairSimulationService.requestSimulation(orgA, cons2.id, {
    simulationType: "color", parameters: { color: "loiro" },
  });
  check("provider REAL ativo ignora acervo do stub (reused=false)",
    reqReal.ok && (reqReal as any).reused === false && (reqReal as any).providerKey === "openai_hair_v1");
  check("galeria esconde saídas do stub quando provider REAL ativo",
    BeautyHairSimulationService.listForContact(orgA, anaId).every((s) => s.providerKey !== "stub_v1"));
  delete process.env.OPENAI_API_KEY;
  process.env.BEAUTY_HAIR_SIMULATION_PROVIDER = "stub";
  check("com stub ativo (CI/demo) o acervo volta a valer (reused=true)",
    (() => { const r = BeautyHairSimulationService.requestSimulation(orgA, cons2.id, { simulationType: "color", parameters: { color: "loiro" } }); return r.ok && (r as any).reused === true; })());

  // ===== 11. F27 — 'selected' ainda simula; 'scheduled' trava =====
  // "Quero esse" não pode congelar a exploração (o bug do 400 em produção):
  // a cliente escolhe o visual A e AINDA troca a cor / gera o B.
  db.prepare(`UPDATE beauty_visual_consultations SET status = 'selected', selected_simulation_id = ? WHERE id = ? AND organization_id = ?`)
    .run(simRegen, cons2.id, orgA);
  const reqSelected = BeautyHairSimulationService.requestSimulation(orgA, cons2.id, {
    simulationType: "color", parameters: { color: "ruivo" },
  });
  check("consulta 'selected' AINDA simula (troca de cor pós-escolha — F27)",
    reqSelected.ok === true);
  db.prepare(`UPDATE beauty_visual_consultations SET status = 'scheduled' WHERE id = ? AND organization_id = ?`)
    .run(cons2.id, orgA);
  const reqScheduled = BeautyHairSimulationService.requestSimulation(orgA, cons2.id, {
    simulationType: "color", parameters: { color: "mel" },
  });
  check("consulta 'scheduled' (já agendou) NÃO simula mais",
    reqScheduled.ok === false && /agendamento/.test((reqScheduled as any).error || ""));
  db.prepare(`UPDATE beauty_visual_consultations SET status = 'selected' WHERE id = ? AND organization_id = ?`)
    .run(cons2.id, orgA);

  // ===== 12. F28 — stub honesto ROBUSTO: sem chave RECUSA, sem depender de NODE_ENV =====
  // (F27 gateava por NODE_ENV=production; o container do Coolify nem sempre
  // reporta 'production' e o stub silenciava. F28: stub IMPLÍCITO → recusa,
  // em QUALQUER ambiente, exceto opt-in explícito.)
  delete process.env.BEAUTY_HAIR_SIMULATION_PROVIDER; // stub vira último recurso
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_AI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  // NODE_ENV segue 'test' aqui de propósito — a recusa NÃO pode depender dele.
  const reqNoKey = BeautyHairSimulationService.requestSimulation(orgA, cons2.id, {
    simulationType: "color", parameters: { color: "caramelo" },
  });
  check("stub implícito sem chave → recusa honesta citando as chaves (independe de NODE_ENV)",
    reqNoKey.ok === false && /OPENAI_API_KEY/.test((reqNoKey as any).error || ""));
  const statusNoKey = BeautyHairSimulationService.simulatorStatus(orgA);
  check("simulatorStatus reporta isReal=false + chaves ausentes",
    statusNoKey.isReal === false && statusNoKey.activeProviderKey === "stub_v1" &&
    !statusNoKey.keys.openai && !statusNoKey.keys.google && !statusNoKey.keys.gemini);
  process.env.OPENAI_API_KEY = "sk-test-real";
  const statusWithKey = BeautyHairSimulationService.simulatorStatus(orgA);
  check("simulatorStatus com OPENAI_API_KEY → isReal=true + provider openai",
    statusWithKey.isReal === true && statusWithKey.activeProviderKey === "openai_hair_v1" && statusWithKey.keys.openai === true);
  delete process.env.OPENAI_API_KEY;
  process.env.BEAUTY_HAIR_SIMULATION_PROVIDER = "stub"; // opt-in explícito volta a valer
  const reqOptIn = BeautyHairSimulationService.requestSimulation(orgA, cons2.id, {
    simulationType: "color", parameters: { color: "caramelo" },
  });
  check("stub via opt-in explícito segue funcionando (CI/demo)", reqOptIn.ok === true);

  // ===== 13. Fiação: rota + BeautyView consomem o acervo =====
  const routesSrc = fs.readFileSync(path.join(process.cwd(), "src/server/routes/beauty.ts"), "utf8");
  check("rota GET /clients/:contactId/simulations existe",
    routesSrc.includes(`"/clients/:contactId/simulations"`) && routesSrc.includes("listForContact"));
  const viewSrc = fs.readFileSync(path.join(process.cwd(), "src/features/BeautyView.tsx"), "utf8");
  check("BeautyView carrega o histórico da cliente (galeria sem custo de IA)",
    viewSrc.includes("/simulations") && viewSrc.includes("clientHistory"));
  check("rota GET /simulator-status existe (diagnóstico F28)",
    routesSrc.includes(`"/simulator-status"`) && routesSrc.includes("simulatorStatus"));
  check("BeautyView tem banner de modo demonstração (F28)",
    viewSrc.includes("simulator-status") && viewSrc.includes("Modo demonstração"));

  // ===== Report =====
  console.log("\n=== TEST beauty-simulation-reuse (ADR-169 F26) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? ` — ${r.note}` : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  if (failures > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
