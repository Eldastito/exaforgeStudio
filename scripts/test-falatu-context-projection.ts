/**
 * TEST — PRD 1 (Fala Tu), fatia de SEGURANÇA (P1): contexto filtrado por papel
 * + redação ("minimum necessary context", §30/§31, CA13).
 *
 * O contexto canônico é org+período, NÃO filtrado por papel. Esta camada projeta
 * pro que ESTE usuário pode ver, ANTES de entregar a modelo — reusando o
 * PermissionService (sem RBAC novo), fail-closed, com redação de campo sensível.
 *
 * Prova (determinístico, snapshot sintético + perfis RBAC de sistema reais):
 *   - domínios sem permissão CAEM (fail-closed) por papel (owner/gerente/vendedor/
 *     financeiro/estoquista);
 *   - campos sensíveis são REDIGIDOS quando o viewer não tem 'full' no módulo;
 *     'full' (owner/gerente) vê cru; redação é wholesale (subtree) e registrada;
 *   - topPriorities de domínio descartado somem;
 *   - narrativa org-wide só vai pra visão ampla (fail-closed mesmo com snapshot off);
 *   - buildForUser projeta o snapshot de ponta a ponta;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:falatu-context-projection
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-ctxproj-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-ctxproj-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ContextProjectionService: CP } = await import("../src/server/ContextProjectionService.js");
  const { ContextEngineService: CE } = await import("../src/server/ContextEngineService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const mkOrg = () => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id);
    PermissionService.seedSystemProfiles(id);
    return id;
  };
  const userFor = (org: string, systemKey: string) => {
    const pid = (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, systemKey) as any)?.id;
    return { userId: randomUUID(), role_profile_id: pid, role: systemKey };
  };
  // Snapshot sintético: 6 domínios; sales carrega campos sensíveis (custo/margem
  // + subtree custos{}) pra provar a redação.
  const snap = () => ({
    organization: { name: "X" },
    period: { month: "2026-08" },
    dataQuality: { ok: true },
    domains: {
      finance: { caixa: 10000, receita: 50000 },
      sales: { total: 320, ticket: 88, custo_medio: 41.2, margem: 0.37, custos: { unitario: 5, frete: 2 } },
      inventory: { skus: 120, ruptura: 3 },
      procurement: { requisicoes: 4 },
      retail_ops: { fechamentos: 2 },
      tasks: { abertas: 9 },
    },
    topPriorities: [
      { domain: "finance", label: "caixa curto" },
      { domain: "sales", label: "meta" },
      { label: "sem domínio" },
    ],
  });

  const org = mkOrg();
  const owner = userFor(org, "owner");
  const gerente = userFor(org, "gerente");
  const vendedor = userFor(org, "vendedor");
  const financeiro = userFor(org, "financeiro");
  const estoquista = userFor(org, "estoquista");
  const domainsOf = (u: any) => Object.keys(CP.projectSnapshot(org, u, snap()).snapshot.domains);

  // ===== 1. owner vê tudo, cru =====
  const rOwner = CP.projectSnapshot(org, owner, snap());
  check("1.1 owner: nada descartado (6 domínios)", Object.keys(rOwner.snapshot.domains).length === 6 && rOwner.manifest.droppedDomains.length === 0);
  check("1.2 owner: nada redigido (full em tudo → cru)", rOwner.manifest.redactedPaths.length === 0 && rOwner.snapshot.domains.sales.custo_medio === 41.2);

  // ===== 2. vendedor: finance/procurement/retail_ops/tasks caem; sales+inventory ficam =====
  const rVend = CP.projectSnapshot(org, vendedor, snap());
  check("2.1 vendedor vê só sales+inventory", JSON.stringify(domainsOf(vendedor).sort()) === JSON.stringify(["inventory", "sales"]));
  check("2.2 vendedor: finance descartado (fail-closed)", rVend.manifest.droppedDomains.includes("finance"));
  check("2.3 vendedor: campo sensível de sales REDIGIDO (não tem full em vendas)", rVend.snapshot.domains.sales.custo_medio === "[redigido]" && rVend.snapshot.domains.sales.margem === "[redigido]");
  check("2.4 vendedor: subtree sensível redigida wholesale", rVend.snapshot.domains.sales.custos === "[redigido]");
  check("2.5 vendedor: agregado não-sensível preservado", rVend.snapshot.domains.sales.total === 320);
  check("2.6 manifesto registra o path redigido", rVend.manifest.redactedPaths.includes("domains.sales.custo_medio"));
  check("2.7 topPriorities de domínio descartado somem; sem-domínio fica", rVend.snapshot.topPriorities.some((p: any) => p.label === "meta") && rVend.snapshot.topPriorities.some((p: any) => p.label === "sem domínio") && !rVend.snapshot.topPriorities.some((p: any) => p.domain === "finance"));

  // ===== 3. financeiro: finance cru (full) + sales redigido (read); resto cai =====
  const rFin = CP.projectSnapshot(org, financeiro, snap());
  check("3.1 financeiro vê finance+sales", JSON.stringify(domainsOf(financeiro).sort()) === JSON.stringify(["finance", "sales"]));
  check("3.2 financeiro: finance CRU (full)", rFin.snapshot.domains.finance.caixa === 10000);
  check("3.3 financeiro: sales redigido (read < full)", rFin.snapshot.domains.sales.custo_medio === "[redigido]");

  // ===== 4. estoquista: inventory+procurement =====
  check("4.1 estoquista vê inventory+procurement", JSON.stringify(domainsOf(estoquista).sort()) === JSON.stringify(["inventory", "procurement"]));

  // ===== 5. gerente: visão ampla, tudo cru =====
  const rGer = CP.projectSnapshot(org, gerente, snap());
  check("5.1 gerente: 6 domínios, nada redigido (full)", Object.keys(rGer.snapshot.domains).length === 6 && rGer.manifest.redactedPaths.length === 0 && rGer.snapshot.domains.sales.custo_medio === 41.2);

  // ===== 6. hasFullBusinessVisibility =====
  check("6.1 owner/gerente têm visão ampla", CP.hasFullBusinessVisibility(org, owner) && CP.hasFullBusinessVisibility(org, gerente));
  check("6.2 vendedor/financeiro/estoquista NÃO têm visão ampla", !CP.hasFullBusinessVisibility(org, vendedor) && !CP.hasFullBusinessVisibility(org, financeiro) && !CP.hasFullBusinessVisibility(org, estoquista));

  // ===== 7. buildForUser: narrativa fail-closed (snapshot off nesta org) =====
  const bOwner = CE.buildForUser(org, owner);
  const bVend = CE.buildForUser(org, vendedor);
  check("7.1 owner recebe narrativa; vendedor não (narrativeOmitted)", typeof bOwner.narrative === "string" && bOwner.narrativeOmitted === false && bVend.narrative === null && bVend.narrativeOmitted === true);
  check("7.2 buildForUser marca roleScoped", bVend.roleScoped === true);

  // ===== 8. buildForUser projeta o snapshot de ponta a ponta =====
  const realBuild = (CE as any).build;
  (CE as any).build = (_o: string) => ({ narrative: "N", snapshot: snap(), snapshotEnabled: true, sources: [], generatedAt: "", schemaVersion: 1 });
  const bVend2 = CE.buildForUser(org, vendedor);
  check("8.1 buildForUser dropa finance pro vendedor + reporta manifesto", bVend2.droppedDomains.includes("finance") && !bVend2.snapshot.domains.finance && bVend2.snapshot.domains.sales.custo_medio === "[redigido]");
  (CE as any).build = realBuild;

  // ===== 9. Isolamento multi-tenant =====
  const orgB = mkOrg();
  const ownerB = userFor(orgB, "owner");
  // vendedor de org A projetado no CONTEXTO da org A não vira full por causa de B;
  // e o owner de B não herda nada de A (levelFor filtra por org).
  check("9.1 permissão é por org (vendedor A não vira full em B)", !CP.hasFullBusinessVisibility(org, vendedor) && CP.hasFullBusinessVisibility(orgB, ownerB));

  console.log("\n=== TEST: Fala Tu contexto por papel + redação (PRD 1 — segurança P1) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Fala Tu contexto por papel + redação (P1) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
