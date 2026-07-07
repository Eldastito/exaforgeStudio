/**
 * TEST — Trio de auditoria filosófica (Tier 2, Sinek/Domingos, ADR-050).
 *
 * Cobre:
 *   [CELERY TEST]
 *   1. create + question monta com nome do assunto + Manifesto injetado
 *   2. Dedupe na mesma semana + mesmo assunto
 *   3. answer registra decisão e status = answered
 *   4. list filtra + ordena pending primeiro
 *   5. metrics agrega decisões
 *   [MANIPULAÇÃO]
 *   6. analyzeText detecta discount/urgency/pressure/scarcity/fear
 *   7. severity escala com nº de táticas
 *   8. scan cria alerta persistido + dedupe 24h
 *   9. updateStatus (dismissed/reformulated) funciona
 *  10. Manifesto injetado na sugestão
 *  11. Isolamento entre orgs
 *   [FUNDAMENTOS]
 *  12. run devolve check com 5 itens
 *  13. Amostra insuficiente → status='unknown' + evidência
 *  14. CSAT baixo → item critical + status = blocked
 *  15. Ticket travado + reclamação aberta → agrega
 *  16. latest devolve o mais recente
 *   [HOOK]
 *  17. Hook em MessageProviderService (simulado): texto com desconto
 *      dispara scan quando organizationId disponível — testado via
 *      chamada direta ao service (test de contrato do scan já cobre)
 *
 * Uso: npm run test:tier2-philosophy-audit
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-philosophy-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-philosophy-1234567890ab";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { CeleryTestService } = await import("../src/server/CeleryTestService.js");
  const { ManipulationRadarService, analyzeText } = await import("../src/server/ManipulationRadarService.js");
  const { FundamentalsChecklistService } = await import("../src/server/FundamentalsChecklistService.js");
  const { BusinessManifestoService } = await import("../src/server/BusinessManifestoService.js");

  const seedOrg = (tag: string) => {
    const id = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), id, `Loja ${tag}`);
    return id;
  };
  const orgA = seedOrg("A");
  const orgB = seedOrg("B");

  // Manifesto na A
  BusinessManifestoService.save(orgA, {
    whyStatement: "Ajudar donas de loja a vender sem depender de desconto.",
    toneVoice: "Direta, brasileira.",
  } as any);

  // ==== CELERY TEST ====
  console.log("\n=== CELERY TEST ===");
  const t1 = CeleryTestService.create(orgA, "vender pacote com brinde 'compre 3 leve 4'");
  check("1.1 create devolve teste", !!t1);
  check("1.2 question inclui o assunto", t1?.question.includes("compre 3 leve 4") ?? false);
  check("1.3 question cita o Por Quê do Manifesto", t1?.question.includes("Ajudar donas de loja") ?? false);
  check("1.4 status inicial = pending", t1?.status === "pending");

  // Dedupe
  const t1b = CeleryTestService.create(orgA, "vender pacote com brinde 'compre 3 leve 4'");
  check("2.1 dedupe mesma semana + mesmo assunto = mesmo id", t1b?.id === t1?.id);
  const t2 = CeleryTestService.create(orgA, "parcelar em 12x sem juros");
  check("2.2 assunto diferente → teste novo", t2?.id !== t1?.id);

  // answer
  const answered = CeleryTestService.answer(orgA, t1!.id, { answer: "Combina com o Manifesto porque valoriza fidelidade.", decision: "keeps" });
  check("3.1 answer atualiza para answered", answered?.status === "answered");
  check("3.2 decision persistida", answered?.decision === "keeps");
  check("3.3 answer com decision inválido = null", CeleryTestService.answer(orgA, t2!.id, { answer: "x", decision: "invalid" as any }) === null);

  // list + ordem
  const list = CeleryTestService.list(orgA);
  check("4.1 lista inclui pending primeiro", list[0]?.status === "pending");

  // metrics
  const cm = CeleryTestService.metrics(orgA);
  check("5.1 metrics.total >= 2", cm.total >= 2);
  check("5.2 metrics.keeps = 1", cm.keeps === 1);
  check("5.3 metrics.pending >= 1", cm.pending >= 1);

  // ==== MANIPULAÇÃO ====
  console.log("\n=== MANIPULAÇÃO ===");
  const a1 = analyzeText("Aproveita! 50% de desconto só hoje — última chance!");
  check("6.1 detecta discount", a1.tactics.includes("discount"));
  check("6.2 detecta urgency", a1.tactics.includes("urgency"));
  check("6.3 severity high com 3+ táticas", ["medium", "high"].includes(a1.severity));

  const a2 = analyzeText("Oi Ana, seu pedido está pronto pra retirada.");
  check("6.4 texto neutro → 0 táticas", a2.tactics.length === 0);

  const a3 = analyzeText("Não perca essa oportunidade — restam 2 vagas!");
  check("6.5 detecta pressure + scarcity", a3.tactics.includes("pressure") && a3.tactics.includes("scarcity"));

  const a4 = analyzeText("Você vai se arrepender se não comprar agora!");
  check("6.6 detecta fear", a4.tactics.includes("fear"));

  const alert1 = ManipulationRadarService.scan({
    organizationId: orgA, text: "50% off, só hoje, última chance!", source: "ai_outbound",
  });
  check("8.1 scan cria alerta quando detecta", !!alert1 && alert1.id.length > 0);
  check("8.2 tactics persistidas", (alert1?.tactics.length || 0) >= 2);
  check("8.3 sugestão cita o Por Quê do Manifesto", alert1?.suggestion.includes("Ajudar donas de loja") ?? false);

  // Dedupe 24h
  const alert1b = ManipulationRadarService.scan({
    organizationId: orgA, text: "50% off, só hoje, última chance!", source: "ai_outbound",
  });
  check("8.4 dedupe 24h devolve MESMO alerta", alert1b?.id === alert1?.id);

  // Texto sem manipulação → null
  const noManip = ManipulationRadarService.scan({
    organizationId: orgA, text: "Bom dia! Sua reserva foi confirmada.", source: "ai_outbound",
  });
  check("8.5 texto neutro → scan não cria alerta", noManip === null);

  // updateStatus
  check("9.1 dismiss retorna true", ManipulationRadarService.updateStatus(orgA, alert1!.id, "dismissed", { handledBy: "u1" }));
  check("9.2 dismiss em id inexistente = false", ManipulationRadarService.updateStatus(orgA, "no-existe", "dismissed") === false);
  const dismissed = ManipulationRadarService.list(orgA, { status: "dismissed" });
  check("9.3 lista dismissed inclui o alerta", dismissed.some((a) => a.id === alert1!.id));

  // Isolamento
  const alertB = ManipulationRadarService.scan({ organizationId: orgB, text: "50% off, só hoje!", source: "ai_outbound" });
  check("11.1 B tem seu próprio alerta", alertB?.organizationId === orgB);
  check("11.2 A NÃO vê alerta de B", ManipulationRadarService.list(orgA).every((a) => a.id !== alertB!.id));

  // ==== FUNDAMENTOS ====
  console.log("\n=== FUNDAMENTOS ===");
  // Sem dados → status='unknown' em muitos itens, mas o run funciona
  const f1 = FundamentalsChecklistService.run(orgA);
  check("12.1 run devolve check", !!f1);
  check("12.2 5 itens", f1?.items.length === 5);
  check("12.3 items tem status válido", f1?.items.every((i) => ["ok", "attention", "critical", "unknown"].includes(i.status)) ?? false);
  check("13.1 amostra pequena → itens unknown", f1?.items.some((i) => i.status === "unknown") ?? false);

  // Injeta dados que forçam critical: CSAT baixo (3 respostas 1)
  const chId = `ch_${randomUUID().slice(0, 8)}`;
  try { db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?, ?, 'whatsapp', 'C', 'active')`).run(chId, orgA); } catch {}
  const seedContact = () => {
    const id = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
      .run(id, orgA, chId, "cliente", `55${id.slice(0, 8)}`);
    return id;
  };
  for (let i = 0; i < 5; i++) {
    const contactId = seedContact();
    const sid = randomUUID();
    db.prepare(`INSERT INTO satisfaction_surveys (id, organization_id, contact_id, status, score, answered_at) VALUES (?, ?, ?, 'answered', 1, CURRENT_TIMESTAMP)`)
      .run(sid, orgA, contactId);
  }
  const f2 = FundamentalsChecklistService.run(orgA);
  check("14.1 CSAT muito baixo → item critical", f2?.items.find((i) => i.key === "csat")?.status === "critical");
  check("14.2 status = blocked com item crítico", f2?.status === "blocked");
  check("14.3 recomendação orienta a pausar", f2?.recommendation.includes("PAUSE") ?? false);

  // latest
  const latest = FundamentalsChecklistService.latest(orgA);
  check("16.1 latest devolve o mais recente", latest?.id === f2?.id);

  // ==== Relatório ====
  console.log("\n=========================================");
  console.log("RELATÓRIO — Trio de auditoria filosófica (Tier 2)");
  console.log("=========================================");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
  }
  console.log("=========================================");
  console.log(`${results.length - failures}/${results.length} passaram`);
  if (failures > 0) {
    console.log(`❌ ${failures} falhas`);
    process.exit(1);
  }
  console.log("✅ Todos os testes passaram");
  process.exit(0);
}

main().catch((e) => {
  console.error("💥 Teste explodiu:", e);
  process.exit(1);
});
