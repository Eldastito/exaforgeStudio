/**
 * TEST — ResearchNeedService (PRD 9 / ADR-166 F11). DB-backed, determinístico.
 *
 * Prova (§29, RN-EI-2/4, RN-004):
 *   - detecta temas ativos (sinais abertos) sem inteligência de nicho fresca;
 *   - mapeia domínio → tópico → taxonomia (vertical,topic,region,timeframe);
 *   - tema COM intel fresca → covered; SEM → need (missing);
 *   - prioriza por severidade e depois nº de sinais;
 *   - sem vertical → honesto (no_vertical), não inventa nicho;
 *   - NÃO roda pesquisa; isolamento multi-tenant.
 *
 * Uso: npm run test:research-need
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rn-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-rn-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { BusinessSignalService: S } = await import("../src/server/BusinessSignalService.js");
  const { VerticalIntelligenceService: VI } = await import("../src/server/VerticalIntelligenceService.js");
  const { ResearchNeedService: RN } = await import("../src/server/ResearchNeedService.js");

  const mkOrg = (vertical: string | null) => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare("INSERT INTO organization_settings (id, organization_id, business_name, vertical, status) VALUES (?,?,?,?,'active')").run(randomUUID(), id, "X", vertical); return id; };
  const sig = (org: string, domain: string, sev: string, key: string) => S.publish(org, { domain, signalType: `${domain}_alert`, severity: sev, basis: "fact", confidence: 0.6, sourceService: "test", evidence: { k: 1 }, dedupeKey: key });

  // ═══════════════ 1. sem vertical → honesto ═══════════════
  const orgNoVert = mkOrg(null);
  sig(orgNoVert, "finance", "risk", "f1");
  const dNo = RN.detect(orgNoVert);
  check("1.1 sem vertical → no_vertical, needs vazio", dNo.reason === "no_vertical" && dNo.needs.length === 0);

  // ═══════════════ 2. taxonomia domínio→tópico ═══════════════
  check("2.1 finance → 'custos e capital de giro'", RN.topicFor("finance") === "custos e capital de giro");
  check("2.2 domínio desconhecido → fallback pro próprio", RN.topicFor("xpto") === "xpto");

  // ═══════════════ 3. detecção com cobertura parcial ═══════════════
  const ORG = mkOrg("padaria");
  sig(ORG, "finance", "critical", "fin1");
  sig(ORG, "finance", "attention", "fin2");
  sig(ORG, "procurement", "attention", "proc1");
  sig(ORG, "sales", "info", "sal1");
  // cobre SÓ 'custos e capital de giro' (finance) com intel fresca
  VI.publish({ userId: "admin", organizationId: null }, { vertical: "padaria", topic: "custos e capital de giro", content: { summary: "panorama", drivers: ["farinha"] }, sources: [], confidence: 0.7, provider: "stub" });

  const d = RN.detect(ORG);
  check("3.1 vertical detectada", d.vertical === "padaria");
  check("3.2 finance coberto (intel fresca)", d.covered.some((c: any) => c.domain === "finance" && c.status === "covered"));
  check("3.3 procurement e sales viram needs (sem intel)", d.needs.some((n: any) => n.domain === "procurement") && d.needs.some((n: any) => n.domain === "sales"));
  check("3.4 finance NÃO está em needs", !d.needs.some((n: any) => n.domain === "finance"));
  check("3.5 taxonomia canônica na need", (() => { const n = d.needs.find((x: any) => x.domain === "procurement"); return n && n.taxonomy.vertical === "padaria" && n.taxonomy.topic === "insumos e fornecedores"; })());

  // ═══════════════ 4. priorização (severidade, depois contagem) ═══════════════
  check("4.1 procurement (attention) antes de sales (info)", d.needs[0].domain === "procurement" && d.needs[0].severity === "attention");

  // ═══════════════ 5. region/timeframe entram na taxonomia ═══════════════
  const d2 = RN.detect(ORG, { region: "SP", timeframe: "2026-Q3" });
  const n2 = d2.needs.find((x: any) => x.domain === "procurement");
  check("5.1 region/timeframe propagados na taxonomia", n2.taxonomy.region === "SP" && n2.taxonomy.timeframe === "2026-Q3");

  // ═══════════════ 6. isolamento multi-tenant ═══════════════
  const OTHER = mkOrg("padaria");
  sig(OTHER, "marketing", "risk", "mk1");
  check("6.1 ORG não enxerga sinais da outra org", !RN.detect(ORG).needs.some((n: any) => n.domain === "marketing"));
  check("6.2 OTHER só vê o seu", RN.detect(OTHER).needs.length === 1 && RN.detect(OTHER).needs[0].domain === "marketing");

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} research-need: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
