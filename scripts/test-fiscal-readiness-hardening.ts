/**
 * TEST — Prontidão fiscal hardening (ADR-187 F4). Doc-of-record EXECUTÁVEL de dupla função:
 * (A) codifica RN-FR-1..7 como REGRESSÃO sobre os serviços REAIS F1–F3 (FiscalReadinessService +
 *     a UI + a rota), com a base tributária VAZIA (o estado real de hoje — nunca inventa alíquota);
 * (B) verifica a FIAÇÃO de produção (pass no Scheduler, rota montada, card na UI, testes wired,
 *     runbook/ADR presentes).
 *
 * Uso: npm run test:fiscal-readiness-hardening
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-frhard-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-frhard-123456";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FiscalReadinessService: FR } = await import("../src/server/FiscalReadinessService.js");
  const { FiscalProfileService } = await import("../src/server/FiscalProfileService.js");

  // Org FORMALIZADA (com CNPJ) mas identidade incompleta (sem regime/ibge/uf).
  const mkFormalized = (cnpj: string, uf?: string) => {
    const o = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, comigo_cnpj, address_state) VALUES (?, ?, 'O', 'active', ?, ?)`).run(randomUUID(), o, cnpj, uf || null);
    return o;
  };
  const sig = (org: string) => db.prepare(`SELECT status FROM business_signals WHERE organization_id=? AND dedupe_key='fiscal_readiness:incomplete'`).get(org) as any;

  const A = mkFormalized("11111111000199", "SP");
  const rA = FR.assess(A);

  // ── RN-FR-1: nunca inventa alíquota. Base VAZIA → tributos awaiting_curation; 2027 cheia depende
  //    do Senado (defined:false + dependsOn:'senate'), rotulada "não definido", nunca estimada. ──
  const allAwaiting = Object.values(rA.dimensions.referenceBase.tributes).every((s) => s === "awaiting_curation");
  check("RN-1 base vazia → tributos awaiting_curation (nunca inventa)", allAwaiting && rA.externalPending.platform.length > 0);
  const senateEntry = rA.timeline.find((t) => t.dependsOn === "senate");
  check("RN-1 2027 cheia: defined:false + dependsOn senate + 'não definido' (nunca estima)",
    !!senateEntry && senateEntry.defined === false && /não definido/i.test(senateEntry.label));
  check("RN-1 externalPending.senate presente e cita o Senado", rA.externalPending.senate.length > 0 && /senado/i.test(rA.externalPending.senate[0]));

  // ── RN-FR-2: nunca presume regime. Sem regime declarado → lacuna EXPLÍCITA do tenant. ──
  check("RN-2 regime não declarado → blocker do tenant + declared:false", rA.dimensions.regime.declared === false && rA.tenantBlockers.some((b) => /Regime/i.test(b)));

  // ── RN-FR-3: prontidão DERIVADA (RN-004) — reflete `completeness`, não é flag mutável. ──
  const before = rA.readyPct;
  FiscalProfileService.save(A, { regime: "presumido", municipalityIbge: "3550308" });
  const rA2 = FR.assess(A);
  check("RN-3 readyPct DERIVADO (sobe ao completar o perfil)", rA2.readyPct > before && rA2.readyPct === 100);
  // determinístico: reavaliar dá o mesmo
  check("RN-3 determinístico (2 chamadas iguais)", JSON.stringify(FR.assess(A)) === JSON.stringify(FR.assess(A)));

  // ── RN-FR-4: três origens separadas — só o TENANT conta pro readyPct. Identidade completa →
  //    readyPct 100 AINDA QUE plataforma/Senado sigam pendentes (não descontam do score). ──
  check("RN-4 identidade completa → 100% mesmo com plataforma/Senado pendentes",
    rA2.readyPct === 100 && (rA2.externalPending.platform.length > 0 || rA2.externalPending.senate.length > 0));

  // ── RN-FR-5: ADVISORY — o sinal nunca cria decision_action nem decide regime. ──
  const B = mkFormalized("22222222000199", "RJ"); // incompleta → publica
  FR.publishReadinessSignal(B);
  const daB = (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=?`).get(B) as any).n;
  check("RN-5 sinal advisory: publica mas zero decision_action", !!sig(B) && daB === 0);
  // assess é read-only: não grava regime na org
  const regimeBefore = (db.prepare(`SELECT fiscal_regime FROM organization_settings WHERE organization_id=?`).get(B) as any)?.fiscal_regime ?? null;
  FR.assess(B); FR.assess(B);
  const regimeAfter = (db.prepare(`SELECT fiscal_regime FROM organization_settings WHERE organization_id=?`).get(B) as any)?.fiscal_regime ?? null;
  check("RN-5 read-only: assess não decide/grava regime", regimeBefore === regimeAfter && regimeAfter === null);

  // ── RN-FR-6: isolado/honesto. Sinal de B não vaza pra A (completa) nem pra C. ──
  const C = mkFormalized("33333333000199", "MG");
  check("RN-6 isolado: A completa sem sinal, B com sinal, C sem sinal ainda", !sig(A) && !!sig(B) && !sig(C));

  // ── RN-FR-7: reusa os motores ADR-181 — SEM 2º motor fiscal, SEM alíquota hard-coded no service. ──
  const src = fs.readFileSync(path.join(ROOT, "src/server/FiscalReadinessService.ts"), "utf8");
  check("RN-7 reusa TaxReferenceService.rateFor + FiscalProfileService.completeness", src.includes("TaxReferenceService.rateFor") && src.includes("FiscalProfileService.completeness"));
  // não hard-coda uma alíquota CHEIA de CBS (ex.: 26.5 / 27.97) — a base curada é a fonte (RN-FISCAL-1)
  check("RN-7 sem alíquota cheia hard-coded no service", !/\b(26[.,]5|27[.,]97|28[.,]6)\b/.test(src));

  // ── (B) FIAÇÃO DE PRODUÇÃO ──
  const scheduler = fs.readFileSync(path.join(ROOT, "src/server/Scheduler.ts"), "utf8");
  check("wiring: FiscalReadinessService.pass no Scheduler", scheduler.includes("FiscalReadinessService.pass"));
  const route = fs.readFileSync(path.join(ROOT, "src/server/routes/fiscal.ts"), "utf8");
  check("wiring: rota GET /readiness montada", route.includes('"/readiness"') && route.includes("FiscalReadinessService.assess"));
  const panel = fs.readFileSync(path.join(ROOT, "src/features/settings/FiscalProfilePanel.tsx"), "utf8");
  check("wiring: card de prontidão na UI (consome /api/fiscal/readiness)", panel.includes("/api/fiscal/readiness") && /Prontid/i.test(panel));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const needed = ["test:fiscal-readiness", "test:fiscal-readiness-signal", "test:fiscal-readiness-hardening"];
  check("wiring: 3 testes de prontidão wired", needed.every((t) => pkg.scripts[t]));
  check("wiring: runbook presente", fs.existsSync(path.join(ROOT, "docs/runbook/prontidao-fiscal-operacao.md")));
  check("wiring: ADR-187 presente", fs.existsSync(path.join(ROOT, "docs/adr/ADR-187-prontidao-fiscal-reforma.md")));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} fiscal-readiness-hardening: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
