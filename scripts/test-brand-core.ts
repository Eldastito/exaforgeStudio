/**
 * TEST — Brand Core institucional (BrandCoreService, PRD 01 "Evolução de Marca").
 * Marca da PLATAFORMA ZapFlow: GLOBAL, versionada, master-only. Prova o ciclo
 * draft→publish→restore + concorrência otimista + fallback honesto + auditoria + escopo global.
 *
 * Uso: npm run test:brand-core
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-brand-core-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-brand-core-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { BrandCoreService, brandCoreDefaults } = await import("../src/server/BrandCoreService.js");

  // ── 1. Estado vazio: fallback honesto (nunca inventa) ──
  check("1.1 getPublished vazio → not_configured", (BrandCoreService.getPublished() as any).status === "not_configured");
  check("1.2 getBrandCoreContext vazio → configured:false, brand null", (() => { const c = BrandCoreService.getBrandCoreContext(); return c.configured === false && c.brand === null; })());
  check("1.3 getDraft vazio → null", BrandCoreService.getDraft() === null);

  // ── 2. Seed no primeiro draft (defaults estratégicos, §43) ──
  const d1 = BrandCoreService.createDraft("master@zapflow");
  check("2.1 createDraft cria V1 draft", d1.version === 1 && d1.status === "draft" && d1.revision === 1);
  check("2.2 draft vem pré-preenchido (essence/promise)", !!d1.snapshot.essence && /não está olhando/.test(d1.snapshot.promise));
  check("2.3 restrictedClaims semeados; approvedClaims vazio (§23/§24)", d1.snapshot.restrictedClaims.length > 0 && d1.snapshot.approvedClaims.length === 0);
  // single-draft: segundo createDraft devolve o mesmo, não duplica
  const d1b = BrandCoreService.createDraft("master@zapflow");
  check("2.4 single-draft: 2º createDraft NÃO duplica", d1b.version === 1 && BrandCoreService.listVersions().length === 1);

  // ── 3. Concorrência otimista (§28) ──
  const upd1 = BrandCoreService.updateDraft({ promise: "Nova promessa v2" }, 1, "master@zapflow");
  check("3.1 update com revisão certa → aplica + bump revision", upd1.revision === 2 && upd1.snapshot.promise === "Nova promessa v2");
  let conflicted = false;
  try { BrandCoreService.updateDraft({ promise: "stale" }, 1, "master@zapflow"); } catch (e: any) { conflicted = e?.code === "CONFLICT"; }
  check("3.2 update com revisão velha → CONFLICT (não sobrescreve)", conflicted);
  check("3.3 promise preservada após conflito", BrandCoreService.getDraft().snapshot.promise === "Nova promessa v2");

  // ── 4. Publicação: validação de obrigatórios (§36) ──
  // Zera um obrigatório → publish bloqueado (INCOMPLETE).
  const cur = BrandCoreService.getDraft();
  BrandCoreService.updateDraft({ essence: "" }, cur.revision, "master@zapflow");
  let incomplete = false, missingHasEssence = false;
  try { BrandCoreService.publish("master@zapflow", BrandCoreService.getDraft().revision); }
  catch (e: any) { incomplete = e?.code === "INCOMPLETE"; missingHasEssence = (e?.missing || []).includes("essence"); }
  check("4.1 publish incompleto → INCOMPLETE", incomplete && missingHasEssence);
  // Restaura essence e publica.
  BrandCoreService.updateDraft({ essence: "Fazer empresas funcionarem melhor." }, BrandCoreService.getDraft().revision, "master@zapflow");
  const pub1 = BrandCoreService.publish("master@zapflow", BrandCoreService.getDraft().revision);
  check("4.2 publish válido → published V1", pub1.version === 1 && pub1.status === "published");
  check("4.3 getPublished agora configurado", (BrandCoreService.getPublished() as any).status === "published");
  check("4.4 getBrandCoreContext agora configured:true", BrandCoreService.getBrandCoreContext().configured === true);
  check("4.5 sem draft aberto após publicar", BrandCoreService.getDraft() === null);

  // ── 5. Imutabilidade + segunda publicação (única published ativa) ──
  const d2 = BrandCoreService.createDraft("master@zapflow");
  check("5.1 novo draft clona a publicada (V2, sourceVersion=1)", d2.version === 2 && d2.sourceVersion === 1 && /não está olhando/.test(d2.snapshot.promise) === false && d2.snapshot.essence === "Fazer empresas funcionarem melhor.");
  BrandCoreService.updateDraft({ category: "Categoria v2" }, d2.revision, "master@zapflow");
  BrandCoreService.publish("master@zapflow", BrandCoreService.getDraft().revision);
  const publishedRows = BrandCoreService.listVersions().filter((v: any) => v.status === "published");
  check("5.2 só UMA versão publicada ativa", publishedRows.length === 1 && publishedRows[0].version === 2);
  check("5.3 V1 foi ARQUIVADA (histórico preservado)", BrandCoreService.getVersion(1).status === "archived");
  check("5.4 published atual = V2", (BrandCoreService.getPublished() as any).version === 2);

  // ── 6. Restore-to-draft (§27): nova versão a partir de antiga, sem apagar histórico ──
  const restored = BrandCoreService.restoreToDraft(1, "master@zapflow");
  check("6.1 restore V1 → cria V3 draft (sourceVersion=1)", restored.version === 3 && restored.status === "draft" && restored.sourceVersion === 1);
  // V1 foi publicada com promise="Nova promessa v2" (alterada no passo 3.1) — o restore traz ESSE valor.
  check("6.2 restore trouxe o snapshot exato da V1", restored.snapshot.promise === "Nova promessa v2");
  // restore bloqueado com draft aberto (single-draft)
  let restoreBlocked = false;
  try { BrandCoreService.restoreToDraft(2, "master@zapflow"); } catch { restoreBlocked = true; }
  check("6.3 restore bloqueado com draft aberto", restoreBlocked);
  check("6.4 histórico preservado (V1,V2 intactas + V3 draft)", BrandCoreService.listVersions().length === 3 && BrandCoreService.getVersion(2).status === "published");

  // ── 7. Descartar draft não afeta publicada nem histórico ──
  check("7.1 discardDraft remove só o draft", BrandCoreService.discardDraft("master@zapflow").discarded === true && BrandCoreService.getDraft() === null);
  check("7.2 publicada intacta após descarte", (BrandCoreService.getPublished() as any).version === 2 && BrandCoreService.listVersions().length === 2);

  // ── 8. Auditoria + escopo GLOBAL (isolamento por design) ──
  const events = db.prepare("SELECT DISTINCT event_type FROM auth_audit_logs WHERE event_type LIKE 'brand_core.%'").all() as any[];
  const types = events.map((e) => e.event_type);
  check("8.1 auditou created/updated/published/restored/deleted", ["brand_core.draft_created", "brand_core.draft_updated", "brand_core.version_published", "brand_core.version_restored_to_draft", "brand_core.draft_deleted"].every((t) => types.includes(t)));
  const cols = db.prepare("PRAGMA table_info(brand_core_versions)").all() as any[];
  check("8.2 tabela é GLOBAL (sem organization_id — marca única da plataforma)", !cols.some((c) => c.name === "organization_id"));

  // ── 9. PRD 02 — Message House (estende o mesmo snapshot; sem store novo) ──
  const defs = brandCoreDefaults();
  check("9.1 defaults semeiam a message house", !!defs.messaging.tagline && defs.messaging.functionalMessages.length > 0);
  // Resolver getBrandMessaging: V2 publicada → configured + prohibitedClaims reusa restrictedClaims (não duplica).
  const bm = BrandCoreService.getBrandMessaging();
  const pubClaims = (BrandCoreService.getPublished() as any).restrictedClaims || [];
  check("9.2 getBrandMessaging configured (V2)", bm.configured === true && bm.version === 2 && !!bm.messaging);
  check("9.3 prohibitedClaims reusa restrictedClaims (sem duplicar)", JSON.stringify(bm.messaging!.prohibitedClaims) === JSON.stringify(pubClaims) && pubClaims.length > 0);
  // Merge parcial da messaging no draft (não zera os outros campos).
  const dm = BrandCoreService.createDraft("master@zapflow");
  const updated = BrandCoreService.updateDraft({ messaging: { tagline: "TAG-X" } }, dm.revision, "master@zapflow");
  check("9.4 messaging.tagline atualizada", updated.snapshot.messaging.tagline === "TAG-X");
  check("9.5 merge parcial preserva masterMessage", !!updated.snapshot.messaging.masterMessage);
  BrandCoreService.discardDraft("master@zapflow");
  // Normalização de versão LEGADA (pré-PRD 02, snapshot sem messaging) → messaging vazio, não quebra.
  db.prepare(`INSERT INTO brand_core_versions (id, version, status, snapshot_json, revision) VALUES ('legacy-99', 99, 'archived', ?, 1)`).run(JSON.stringify({ essence: "legado" }));
  const legacy = BrandCoreService.getVersion(99);
  check("9.6 versão legada sem messaging → normalizada (não quebra)", !!legacy.snapshot.messaging && Array.isArray(legacy.snapshot.messaging.functionalMessages) && legacy.snapshot.messaging.tagline === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} brand-core: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
