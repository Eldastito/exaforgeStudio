/**
 * TEST — PRD 1 Fase 2.2 (CA6): "Fala Tu entrega arquivo gerado". O
 * FalaTuReportService compõe contexto-por-papel (P1) + render PDF + artefato
 * canônico + URL assinada, sem duplicar nenhuma peça.
 *
 * Prova (determinístico; RBAC de sistema real + snapshot sintético via mock de
 * ContextEngineService.build):
 *   - gera um artefato PDF (kind report, origin falatu, sha256/size), devolve
 *     LINK assinado (nunca binário/path); o PDF é válido (%PDF) via resolveSigned;
 *   - HERDA a projeção por papel: vendedor perde finance/procurement/... no
 *     relatório (droppedDomains); owner vê tudo;
 *   - correlation_id da interação fica no artefato;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:falatu-report
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-report-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-report-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuReportService: FR } = await import("../src/server/FalaTuReportService.js");
  const { ArtifactService: AS } = await import("../src/server/ArtifactService.js");
  const { ContextEngineService: CE } = await import("../src/server/ContextEngineService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const mkOrg = () => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja X', 'active')`).run(randomUUID(), id);
    PermissionService.seedSystemProfiles(id);
    return id;
  };
  const userFor = (org: string, key: string) => ({ userId: randomUUID(), role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id, role: key });

  // Mock do contexto canônico: narrativa + 6 domínios (buildForUser projeta por papel).
  (CE as any).build = (_o: string) => ({
    narrative: "Panorama do negócio: vendas em alta.",
    snapshot: { domains: { finance: { caixa: 9000 }, sales: { total: 120 }, inventory: { skus: 40 }, procurement: { req: 2 }, retail_ops: { fech: 1 }, tasks: { abertas: 3 } }, topPriorities: [], dataQuality: {} },
    snapshotEnabled: true, sources: [], generatedAt: "", schemaVersion: 1,
  });

  const orgA = mkOrg();
  const owner = userFor(orgA, "owner");
  const vendedor = userFor(orgA, "vendedor");

  // ===== 1. Owner: gera artefato PDF + link assinado =====
  const rOwner = await FR.executiveSummary(orgA, owner, "corr-report-1");
  check("1.1 devolve artefato report PDF com tamanho", rOwner.artifact.kind === "report" && rOwner.artifact.mimeType === "application/pdf" && rOwner.artifact.sizeBytes > 100);
  check("1.2 devolve URL assinada pública (não o binário/path)", typeof rOwner.url === "string" && rOwner.url!.startsWith(`/api/public/artifacts/${orgA}/${rOwner.artifact.id}`));
  const stored = AS.get(orgA, rOwner.artifact.id);
  check("1.3 artefato registrado com origin falatu + correlation_id", stored?.origin === "falatu" && stored?.correlationId === "corr-report-1" && !!stored?.sha256);
  check("1.4 owner: nada omitido (visão ampla)", rOwner.droppedDomains.length === 0);

  // ===== 2. O link entrega um PDF válido =====
  const q = new URLSearchParams(rOwner.url!.split("?")[1]);
  const file = AS.resolveSigned(orgA, rOwner.artifact.id, q.get("exp")!, q.get("sig")!);
  check("2.1 resolveSigned entrega o arquivo", !!file && file.mime === "application/pdf");
  check("2.2 conteúdo é um PDF válido (%PDF)", !!file && file.buffer.slice(0, 4).toString() === "%PDF");

  // ===== 3. Herda a projeção por papel (segurança P1) =====
  const rVend = await FR.executiveSummary(orgA, vendedor, "corr-report-2");
  check("3.1 vendedor: relatório omite finance (droppedDomains)", rVend.droppedDomains.includes("finance") && rVend.droppedDomains.includes("procurement"));
  check("3.2 vendedor: ainda gera um PDF válido", (() => { const qq = new URLSearchParams(rVend.url!.split("?")[1]); const f = AS.resolveSigned(orgA, rVend.artifact.id, qq.get("exp")!, qq.get("sig")!); return !!f && f.buffer.slice(0, 4).toString() === "%PDF"; })());

  // ===== 4. Isolamento multi-tenant =====
  const orgB = mkOrg();
  check("4.1 artefato de A não é visível em B", AS.get(orgB, rOwner.artifact.id) == null);
  const qb = new URLSearchParams(rOwner.url!.split("?")[1]);
  check("4.2 URL assinada de A não resolve sob o tenant B", AS.resolveSigned(orgB, rOwner.artifact.id, qb.get("exp")!, qb.get("sig")!) == null);

  console.log("\n=== TEST: Fala Tu entrega relatório como artefato (PRD 1 Fase 2.2, CA6) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Fala Tu entrega relatório como artefato (2.2) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
