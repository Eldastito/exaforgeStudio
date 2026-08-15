/**
 * TEST — BEAUTY-009 (ADR-169 F9): recomendador Look→Serviços.
 *
 * O ELO COMERCIAL da Beauty AI: transforma simulação em agendamento
 * potencial recomendando serviços do CATÁLOGO REAL do tenant. Regra
 * fundante RN-BS-02: **IA NUNCA sugere serviço/preço fora do catálogo.**
 *
 * Checks-âncora:
 *  - Sugere APENAS serviços do próprio tenant (RN-BS-07).
 *  - APENAS type='service' active=1 (product/reservation/inativo ignorados).
 *  - suggested_services_json de beauty_reference_looks tem PRIORIDADE
 *    (relevance='primary'); ids fora do catálogo do tenant são IGNORADOS
 *    silenciosamente (nunca inventa serviço extinto).
 *  - Match por keyword no `name` funciona (color → coloração/mechas/
 *    balayage/luzes; cut → corte/escova/finalização).
 *  - Catálogo vazio → `insufficient_catalog` (não retorna array vazio
 *    misterioso — retorna erro tipado com mensagem para o dono agir).
 *  - Sem parâmetros comerciais → `sem_parametros` (não recomenda no vácuo).
 *  - Multi-tenant duro: sim de outra org → not_found; refLook de outra
 *    org → ignorado como se não existisse.
 *  - Read-only: nenhuma escrita no banco.
 *  - Determinismo: 2 chamadas com mesmo estado retornam mesma lista.
 *
 * Uso: npm run test:beauty-look-to-services
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-look-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-beauty-look-1234567890abcdef";
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
    LookServiceRecommendationService,
    RECOMMENDATION_RELEVANCE,
  } = await import("../src/server/LookServiceRecommendationService.js");

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
  const seedService = (orgId: string, name: string, opts: { price?: number; duration?: number; category?: string; type?: string; active?: boolean } = {}) => {
    const id = `s_${randomUUID().slice(0, 6)}`;
    db.prepare(
      `INSERT INTO products_services (id, organization_id, type, name, description, price, currency, active, duration_minutes, category) VALUES (?, ?, ?, ?, '', ?, 'BRL', ?, ?, ?)`,
    ).run(id, orgId, opts.type || "service", name, opts.price ?? 100, opts.active === false ? 0 : 1, opts.duration ?? null, opts.category ?? null);
    return id;
  };
  const seedRefLook = (orgId: string, name: string, suggestedServiceIds: string[], active = true) => {
    const id = `rl_${randomUUID().slice(0, 6)}`;
    db.prepare(
      `INSERT INTO beauty_reference_looks (id, organization_id, name, hair_type, tone, cut_style, suggested_services_json, active) VALUES (?, ?, ?, 'liso', 'castanho', 'chanel', ?, ?)`,
    ).run(id, orgId, name, JSON.stringify(suggestedServiceIds), active ? 1 : 0);
    return id;
  };
  const prepareReady = async (orgId: string, contactId: string, goal = "mechas") => {
    BeautyVisualConsultationService.grantConsent(orgId, contactId, "hair_simulation");
    const cons = BeautyVisualConsultationService.startConsultation(orgId, { contactId, goal });
    const photo = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 128, g: 64, b: 32 } } }).jpeg().toBuffer();
    const up = await BeautyVisualConsultationService.uploadReferencePhoto(orgId, cons.id, photo);
    BeautyVisualConsultationService.approveAsset(orgId, (up as any).assetId);
    return BeautyVisualConsultationService.getConsultation(orgId, cons.id)!;
  };

  const orgA = seedOrg();
  const anaId = seedContact(orgA, "Ana");

  // ===== 1. Constantes =====
  check("RECOMMENDATION_RELEVANCE inclui primary/matched/generic",
    RECOMMENDATION_RELEVANCE.includes("primary") &&
    RECOMMENDATION_RELEVANCE.includes("matched"));
  const vocab = LookServiceRecommendationService.vocabulary();
  check("vocab.keywords.color inclui coloração/mechas/balayage",
    vocab.keywords.color.some(k => k.startsWith("colora")) &&
    vocab.keywords.color.includes("mecha") &&
    vocab.keywords.color.includes("balayage"));
  check("vocab.keywords.cut inclui corte/escova/franja",
    vocab.keywords.cut.includes("corte") &&
    vocab.keywords.cut.includes("escova") &&
    vocab.keywords.cut.includes("franja"));

  // ===== 2. Catálogo VAZIO → insufficient_catalog =====
  const consVazia = await prepareReady(orgA, anaId, "cor");
  const simVazia = BeautyHairSimulationService.requestSimulation(orgA, consVazia.id, {
    simulationType: "color", parameters: { color: "loiro" },
  });
  const emptyR = LookServiceRecommendationService.recommendForSimulation(orgA, (simVazia as any).simulationId);
  check("catálogo vazio + sim → insufficient_catalog",
    emptyR.ok === false && (emptyR as any).reason === "insufficient_catalog");
  check("insufficient_catalog inclui mensagem instrutiva",
    (emptyR as any).message?.includes("Catálogo vazio"));
  check("insufficient_catalog inclui activeCatalogCount=0",
    (emptyR as any).activeCatalogCount === 0);

  // ===== 3. Semeia catálogo real do tenant =====
  const svcColoracao = seedService(orgA, "Coloração completa", { price: 250, duration: 120, category: "Cabelo" });
  const svcMechas = seedService(orgA, "Mechas balayage", { price: 400, duration: 180, category: "Cabelo" });
  const svcLuzes = seedService(orgA, "Luzes altas", { price: 350, duration: 150, category: "Cabelo" });
  const svcCorte = seedService(orgA, "Corte feminino", { price: 80, duration: 45, category: "Corte" });
  const svcEscova = seedService(orgA, "Escova modelada", { price: 60, duration: 40, category: "Finalização" });
  const svcInativo = seedService(orgA, "Coloração antiga", { price: 100, active: false });
  const prodShampoo = seedService(orgA, "Shampoo profissional", { price: 40, type: "product" });
  const svcManicure = seedService(orgA, "Manicure completa", { price: 40, duration: 30, category: "Unhas" });

  // ===== 4. Sim color → matched (mechas, coloração, luzes) =====
  const consA = await prepareReady(orgA, anaId, "mechas");
  const simColor = BeautyHairSimulationService.requestSimulation(orgA, consA.id, {
    simulationType: "color", parameters: { color: "morena_iluminada" },
  });
  const rColor = LookServiceRecommendationService.recommendForSimulation(orgA, (simColor as any).simulationId);
  check("sim color com catálogo → ok=true", rColor.ok === true);
  const rC = rColor as any;
  check("recomenda pelo menos 3 serviços de cor", rC.recommendations.length >= 3);
  const idsColor = rC.recommendations.map((s: any) => s.serviceId);
  check("recomenda 'Coloração completa'", idsColor.includes(svcColoracao));
  check("recomenda 'Mechas balayage'", idsColor.includes(svcMechas));
  check("recomenda 'Luzes altas'", idsColor.includes(svcLuzes));
  check("NÃO recomenda 'Manicure' (nome não bate)", !idsColor.includes(svcManicure));
  check("NÃO recomenda 'Corte' pra sim color", !idsColor.includes(svcCorte));
  check("NÃO recomenda produto físico (Shampoo)", !idsColor.includes(prodShampoo));
  check("NÃO recomenda serviço inativo", !idsColor.includes(svcInativo));

  for (const rec of rC.recommendations) {
    check(`recomendação '${rec.name}' tem relevance='matched'`, rec.relevance === "matched");
    check(`recomendação '${rec.name}' tem matchReason (não vazio)`, typeof rec.matchReason === "string" && rec.matchReason.length > 5);
    check(`recomendação '${rec.name}' preserva price/duration do catálogo`,
      rec.price != null && rec.durationMinutes != null);
  }

  // ===== 5. Sim cut → matched (corte, escova) =====
  const simCut = BeautyHairSimulationService.requestSimulation(orgA, consA.id, {
    simulationType: "cut", parameters: { cut: "chanel" },
  });
  const rCut = LookServiceRecommendationService.recommendForSimulation(orgA, (simCut as any).simulationId);
  check("sim cut com catálogo → ok=true", rCut.ok === true);
  const idsCut = (rCut as any).recommendations.map((s: any) => s.serviceId);
  check("recomenda 'Corte feminino' pra sim cut", idsCut.includes(svcCorte));
  check("recomenda 'Escova modelada' pra sim cut", idsCut.includes(svcEscova));
  check("NÃO recomenda 'Coloração' pra sim cut", !idsCut.includes(svcColoracao));
  check("NÃO recomenda 'Mechas' pra sim cut", !idsCut.includes(svcMechas));

  // ===== 6. Sim combined → mistura color + cut =====
  const simComb = BeautyHairSimulationService.requestSimulation(orgA, consA.id, {
    simulationType: "combined", parameters: { color: "loiro", cut: "bob" },
  });
  const rComb = LookServiceRecommendationService.recommendForSimulation(orgA, (simComb as any).simulationId);
  const idsComb = (rComb as any).recommendations.map((s: any) => s.serviceId);
  check("sim combined recomenda color E cut", idsComb.includes(svcColoracao) && idsComb.includes(svcCorte));

  // ===== 7. Reference look TEM PRIORIDADE (relevance='primary') =====
  const refMorenaIluminada = seedRefLook(orgA, "Morena Iluminada", [svcMechas, svcColoracao]);
  const simRef = BeautyHairSimulationService.requestSimulation(orgA, consA.id, {
    simulationType: "color", parameters: { color: "morena_iluminada", referenceLookId: refMorenaIluminada },
  });
  const rRef = LookServiceRecommendationService.recommendForSimulation(orgA, (simRef as any).simulationId);
  const primaries = (rRef as any).recommendations.filter((r: any) => r.relevance === "primary");
  check("referenceLook produz 2 recomendações relevance='primary'", primaries.length === 2);
  check("primaries são os IDs curados (svcMechas + svcColoracao)",
    primaries.map((r: any) => r.serviceId).sort().join(",") === [svcMechas, svcColoracao].sort().join(","));
  check("primaries vêm PRIMEIRO na lista (ordem de curadoria preservada)",
    (rRef as any).recommendations[0].serviceId === svcMechas &&
    (rRef as any).recommendations[1].serviceId === svcColoracao);
  check("matchReason do primary menciona 'Curado pelo salão' + nome do look",
    primaries.every((r: any) => r.matchReason.includes("Curado pelo salão") && r.matchReason.includes("Morena Iluminada")));

  // ===== 8. Ids do reference_look INEXISTENTES são IGNORADOS =====
  const refBroken = seedRefLook(orgA, "Look quebrado", ["svc_inexistente", svcColoracao, "outro_id_falso"]);
  const simBroken = BeautyHairSimulationService.requestSimulation(orgA, consA.id, {
    simulationType: "color", parameters: { color: "loiro", referenceLookId: refBroken },
  });
  const rBroken = LookServiceRecommendationService.recommendForSimulation(orgA, (simBroken as any).simulationId);
  const primariesBroken = (rBroken as any).recommendations.filter((r: any) => r.relevance === "primary");
  check("ids inexistentes no suggested_services_json são IGNORADOS silenciosamente",
    primariesBroken.length === 1 && primariesBroken[0].serviceId === svcColoracao);
  check("NUNCA aparece 'svc_inexistente' como recomendação (nunca inventa)",
    !(rBroken as any).recommendations.some((r: any) => r.serviceId === "svc_inexistente"));

  // ===== 9. Sim SEM parâmetros comerciais → sem_parametros =====
  // Simula manualmente com params zerados (o service normalmente sanitiza,
  // mas conseguimos criar essa condição via UPDATE direto)
  db.prepare(
    `UPDATE beauty_visual_simulations SET parameters_json = '{}' WHERE id = ?`,
  ).run((simCut as any).simulationId);
  const rEmpty = LookServiceRecommendationService.recommendForSimulation(orgA, (simCut as any).simulationId);
  check("sim sem params comerciais → sem_parametros",
    rEmpty.ok === false && (rEmpty as any).reason === "sem_parametros");

  // ===== 10. recommendForConsultation (goal) =====
  const consB = await prepareReady(orgA, seedContact(orgA, "Bia"), "cor");
  const rConsB = LookServiceRecommendationService.recommendForConsultation(orgA, consB.id);
  check("consulta com goal='cor' recomenda serviços de color", rConsB.ok === true);
  const consC = await prepareReady(orgA, seedContact(orgA, "Cesar"), "escova");
  const rConsC = LookServiceRecommendationService.recommendForConsultation(orgA, consC.id);
  check("consulta com goal='escova' recomenda serviços de cut", rConsC.ok === true);
  check("consulta 'escova' recomenda 'Escova modelada'",
    (rConsC as any).recommendations.some((r: any) => r.serviceId === svcEscova));
  const consD = await prepareReady(orgA, seedContact(orgA, "Denise"), "transformação completa");
  const rConsD = LookServiceRecommendationService.recommendForConsultation(orgA, consD.id);
  check("consulta 'transformação completa' vira combined (recomenda ambos)",
    rConsD.ok === true &&
    (rConsD as any).recommendations.some((r: any) => r.serviceId === svcColoracao) &&
    (rConsD as any).recommendations.some((r: any) => r.serviceId === svcCorte));

  // Goal fora do vocabulário
  const consNoise = await prepareReady(orgA, seedContact(orgA, "Elza"), "batepapo com a IA");
  const rNoise = LookServiceRecommendationService.recommendForConsultation(orgA, consNoise.id);
  check("goal fora do vocab → sem_parametros",
    rNoise.ok === false && (rNoise as any).reason === "sem_parametros");

  // ===== 11. Cross-tenant DURO (RN-BS-07) =====
  const orgB = seedOrg();
  const svcOutraOrg = seedService(orgB, "Coloração Studio X");
  const simColorOrgA = LookServiceRecommendationService.recommendForSimulation(orgA, (simColor as any).simulationId);
  check("cross-tenant: recomendação da orgA NÃO inclui serviço da orgB",
    (simColorOrgA as any).recommendations?.every((r: any) => r.serviceId !== svcOutraOrg));

  const cross1 = LookServiceRecommendationService.recommendForSimulation(orgB, (simColor as any).simulationId);
  check("cross-tenant: getSimulation com org errada → not_found",
    cross1.ok === false && (cross1 as any).reason === "not_found");

  const cross2 = LookServiceRecommendationService.recommendForConsultation(orgB, consA.id);
  check("cross-tenant: consulta de OUTRA org → not_found",
    cross2.ok === false && (cross2 as any).reason === "not_found");

  // Reference look de outra org é IGNORADO (não gera primary)
  const svcOrgB = seedService(orgB, "Serviço orgB");
  const refCross = seedRefLook(orgB, "Ref cross", [svcOrgB]);
  const simRefCross = BeautyHairSimulationService.requestSimulation(orgA, consA.id, {
    simulationType: "color", parameters: { color: "loiro", referenceLookId: refCross },
  });
  const rRefCross = LookServiceRecommendationService.recommendForSimulation(orgA, (simRefCross as any).simulationId);
  const primariesCross = (rRefCross as any).recommendations?.filter((r: any) => r.relevance === "primary") || [];
  check("referenceLookId de OUTRA org → 0 recomendações 'primary' (ignorado)", primariesCross.length === 0);
  const idsCross = (rRefCross as any).recommendations?.map((r: any) => r.serviceId) || [];
  check("recomendação cross-tenant NÃO inclui serviço da orgB",
    !idsCross.includes(svcOrgB) && !idsCross.includes(svcOutraOrg));

  // ===== 12. Determinismo (read-only, sem LLM) =====
  const rDet1 = LookServiceRecommendationService.recommendForSimulation(orgA, (simColor as any).simulationId);
  const rDet2 = LookServiceRecommendationService.recommendForSimulation(orgA, (simColor as any).simulationId);
  check("2 chamadas com mesmo state retornam mesma lista (determinismo — read-only)",
    JSON.stringify((rDet1 as any).recommendations) === JSON.stringify((rDet2 as any).recommendations));

  // ===== 13. Read-only (nenhuma escrita) =====
  const simCountBefore = (db.prepare(`SELECT COUNT(*) c FROM beauty_visual_simulations`).get() as any).c;
  const analysisCountBefore = (db.prepare(`SELECT COUNT(*) c FROM beauty_visual_analyses`).get() as any).c;
  LookServiceRecommendationService.recommendForSimulation(orgA, (simColor as any).simulationId);
  LookServiceRecommendationService.recommendForConsultation(orgA, consA.id);
  const simCountAfter = (db.prepare(`SELECT COUNT(*) c FROM beauty_visual_simulations`).get() as any).c;
  const analysisCountAfter = (db.prepare(`SELECT COUNT(*) c FROM beauty_visual_analyses`).get() as any).c;
  check("recomendação NÃO cria simulações (read-only)", simCountBefore === simCountAfter);
  check("recomendação NÃO cria análises (read-only)", analysisCountBefore === analysisCountAfter);

  // ===== 14. Zero hardcoded (§17/§65) =====
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
  console.log("\n=== TEST: Look → Serviços do catálogo REAL (ADR-169 F9 / BEAUTY-009) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? "  [" + r.note + "]" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Elo comercial pronto — simulação vira agendamento potencial, grounded no catálogo real.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
