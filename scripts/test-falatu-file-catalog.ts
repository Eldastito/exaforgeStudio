/**
 * TEST — F5.1 (RF-07 §13.1/§13.2/§13.3): catálogo + autorização + referência "isso".
 *
 * Prova, offline (tmp db), a etapa de INTERPRETAÇÃO/AUTORIZAÇÃO do pedido de arquivo
 * (a geração é F5.2, a entrega F5.3), determinística (RBAC real + snapshot sintético
 * via mock de ContextEngineService.build):
 *   - catálogo VISÍVEL recorta por papel (vendedor não vê "contas a pagar/receber");
 *   - resolve(ready) forma resultado ESTRUTURADO (fonte + instante + domínios
 *     projetados) e NÃO gera arquivo; grava o "último resultado" (durável);
 *   - referência "isso" (ref:'last') reusa o MESMO snapshot em outro formato, sem
 *     reconsultar (mesmo com a consulta mudando depois);
 *   - REVOGAÇÃO entre consulta e reexport: acesso perdido reduz o snapshot servido;
 *   - pedido fora do catálogo devolve as opções (NUNCA inventa);
 *   - entrada com consulta de domínio ainda não plugada é honesta (pending, sem dado);
 *   - entrada gated sem permissão → recusa genérica (sem vazar), sem conteúdo;
 *   - formatGeneratorReady honesto (pdf/xlsx sim, docx não até F5.2);
 *   - localizar artefato existente (RBAC por classificação);
 *   - isolamento multi-tenant da referência.
 *
 * Uso: npm run test:falatu-file-catalog
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-file-catalog-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-file-catalog-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FileRequestCatalogService: CAT } = await import("../src/server/FileRequestCatalogService.js");
  const { ContextEngineService: CE } = await import("../src/server/ContextEngineService.js");
  const { ArtifactService: AS } = await import("../src/server/ArtifactService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const mkOrg = () => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja X', 'active')`).run(randomUUID(), id);
    PermissionService.seedSystemProfiles(id);
    return id;
  };
  const profileId = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id;
  const userFor = (org: string, key: string, userId = randomUUID()) => ({ userId, role_profile_id: profileId(org, key), role: key });

  // Snapshot canônico sintético (buildForUser projeta por papel).
  const FULL = { narrative: "Panorama.", snapshot: { domains: { finance: { caixa: 9000 }, sales: { total: 120 }, inventory: { skus: 40 }, procurement: { req: 2 }, retail_ops: { fech: 1 }, tasks: { abertas: 3 } }, topPriorities: [], dataQuality: {} }, snapshotEnabled: true, sources: [], generatedAt: "", schemaVersion: 1 };
  (CE as any).build = (_o: string) => FULL;

  const orgA = mkOrg();
  const owner = userFor(orgA, "owner");
  const vendedor = userFor(orgA, "vendedor");
  const CONV = "conv-1";

  // ── 1. Catálogo recorta por papel ──
  const catOwner = CAT.list(orgA, owner).map((e) => e.key);
  const catVend = CAT.list(orgA, vendedor).map((e) => e.key);
  check("1.1 owner vê as 5 entradas do catálogo", catOwner.length === 5 && catOwner.includes("accounts_finance"));
  check("1.2 vendedor NÃO vê contas a pagar/receber (finance gated)", !catVend.includes("accounts_finance"));
  check("1.3 vendedor ainda vê resumo executivo + arquivo existente", catVend.includes("executive_summary") && catVend.includes("existing_artifact"));

  // ── 2. resolve(ready) forma resultado estruturado + grava "último" ──
  const r1 = CAT.resolve(orgA, owner, { kind: "executive_summary", format: "pdf", conversationId: CONV, correlationId: "c1" });
  check("2.1 ok + autorizado + ready", r1.ok && r1.authorized && r1.queryStatus === "ready");
  check("2.2 resultado estruturado tem domínios projetados + fonte + instante", !!r1.structuredResult?.domains?.finance && r1.source === "context_engine" && !!r1.queriedAt);
  check("2.3 NÃO gera arquivo (sem url/binário no retorno)", !(r1 as any).url && !(r1 as any).buffer);
  const last = CAT.getLast(orgA, owner, CONV);
  check("2.4 gravou o último resultado (durável)", !!last && last.catalog_key === "executive_summary");

  // ── 3. referência "isso" reusa o MESMO snapshot em outro formato ──
  // Muda a consulta DEPOIS de gravar — o "isso" não pode refletir a mudança.
  (CE as any).build = (_o: string) => ({ ...FULL, snapshot: { ...FULL.snapshot, domains: { sales: { total: 999 } } } });
  const r2 = CAT.resolve(orgA, owner, { ref: "last", format: "xlsx", conversationId: CONV });
  check("3.1 fromReference + formato trocado (isso em Excel)", r2.fromReference === true && r2.format === "xlsx");
  check("3.2 mesmo snapshot congelado (sales=120 original, não o 999 reconsultado)", r2.structuredResult?.domains?.finance?.caixa === 9000 && r2.structuredResult?.domains?.sales?.total === 120);
  (CE as any).build = (_o: string) => FULL; // restaura

  // ── 4. REVOGAÇÃO entre consulta e reexport: acesso perdido reduz o servido ──
  const ux = randomUUID();
  CAT.resolve(orgA, userFor(orgA, "owner", ux), { kind: "executive_summary", format: "pdf", conversationId: "conv-rev" });
  const demoted = { userId: ux, role_profile_id: profileId(orgA, "vendedor"), role: "vendedor" };
  const r3 = CAT.resolve(orgA, demoted, { ref: "last", conversationId: "conv-rev" });
  check("4.1 reexport após revogação: finance sai do snapshot servido", r3.fromReference === true && !r3.structuredResult?.domains?.finance && r3.structuredResult?.droppedDomains?.includes("finance"));

  // ── 5. fora do catálogo devolve opções (não inventa) ──
  const r4 = CAT.resolve(orgA, owner, { kind: "contrato_juridico", format: "pdf", conversationId: CONV });
  check("5.1 kind desconhecido → unsupported com opções", r4.ok === false && r4.unsupported?.reason === "unknown_kind" && (r4.unsupported?.supportedKinds || []).includes("executive_summary"));

  // ── 6. consulta de domínio pendente é honesta (sem inventar dado) ──
  const r5 = CAT.resolve(orgA, owner, { kind: "sales_by_period", format: "pdf", conversationId: CONV });
  check("6.1 autorizado porém pending_domain_query, sem dado inventado", r5.ok && r5.authorized && r5.queryStatus === "pending_domain_query" && r5.structuredResult === null);

  // ── 7. gated sem permissão → recusa genérica, sem conteúdo ──
  const r6 = CAT.resolve(orgA, vendedor, { kind: "accounts_finance", format: "pdf", conversationId: "conv-v" });
  check("7.1 recusa genérica sem vazar + sem estruturado", r6.ok === false && r6.authorized === false && r6.denialReason === "not_authorized" && r6.structuredResult === null);

  // ── 8. formatGeneratorReady honesto ──
  const rDoc = CAT.resolve(orgA, owner, { kind: "executive_summary", format: "docx", conversationId: "conv-doc" });
  check("8.1 docx: gerador pronto (F5.2 — DocxService real)", rDoc.ok && rDoc.format === "docx" && rDoc.formatGeneratorReady === true);
  check("8.2 pdf/xlsx: gerador pronto", r1.formatGeneratorReady === true && r2.formatGeneratorReady === true);

  // ── 9. localizar artefato existente (RBAC por classificação) ──
  const art = AS.create(orgA, { kind: "report", title: "Vendas Maio", mimeType: "application/pdf", content: Buffer.from("%PDF-1.4 x"), origin: "falatu", createdBy: owner.userId });
  const r7 = CAT.resolve(orgA, owner, { kind: "existing_artifact", format: "pdf", conversationId: "conv-loc" });
  check("9.1 localiza o artefato autorizado", r7.ok && r7.structuredResult?.artifacts?.some((a: any) => a.id === art.id));

  // ── 10. isolamento multi-tenant da referência ──
  const orgB = mkOrg();
  const ownerB = userFor(orgB, "owner", owner.userId); // mesmo userId, outra org
  check("10.1 getLast não vaza entre orgs", CAT.getLast(orgB, ownerB, CONV) === null);
  const r8 = CAT.resolve(orgB, ownerB, { ref: "last", conversationId: CONV });
  check("10.2 ref:'last' em org sem histórico → sem resultado anterior", r8.ok === false && r8.unsupported?.reason === "no_prior_result");

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-file-catalog: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
