/**
 * TEST — BEAUTY-005 (ADR-169 F5): fundação da Beauty AI.
 *
 * Prova a fundação da vertical de simulação:
 *   consent tipado → consulta em draft → upload com quarentena+EXIF strip
 *   → aprovação manual (F5) → URL assinada TTL 15min → retenção/purga →
 *   revoke consent apaga assets (LGPD Art.18).
 *
 * Guardrails RN-BS validados:
 *   RN-BS-04 — consent tipado antes do processamento; escopos SEPARADOS
 *              (hair_simulation ≠ use_in_marketing); quarentena obrigatória;
 *              EXIF removido; URL assinada 15min; retenção configurável +
 *              purga.
 *   RN-BS-05 — safety_report_json só flags booleanas; nunca foto no log.
 *   RN-BS-07 — isolamento cross-tenant duro em toda operação.
 *   RN-BS-11 — sem consent → sem upload; sem foto → status permanece draft;
 *              quarentena aguarda validação (nunca aprova sozinha).
 *
 * Uso: npm run test:beauty-visual-consultation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-vc-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-beauty-vc-1234567890abcdef";

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
  const {
    BeautyVisualConsultationService,
    BEAUTY_CONSENT_SCOPES,
    BEAUTY_CONSULTATION_STATUSES,
  } = await import("../src/server/BeautyVisualConsultationService.js");

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

  // Uma imagem JPEG mínima válida com EXIF/GPS falsos — sharp deve
  // preservar visualmente mas STRIP EXIF na regravação.
  const seedPhoto = async (withExif = true): Promise<Buffer> => {
    const base = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 128, g: 64, b: 32 } },
    }).jpeg({ quality: 90 }).toBuffer();
    if (!withExif) return base;
    // Adiciona bloco EXIF fake com dados sensíveis (marca/modelo do
    // aparelho + software) pra provar que o service tira. Sharp aceita
    // `.withMetadata({exif})` com strings ASCII.
    return await sharp(base).withMetadata({
      exif: {
        IFD0: {
          Make: "TestCamera",
          Model: "Sensitive-1",
          Software: "PII-Leaker-1.0",
        },
      } as any,
    }).jpeg().toBuffer();
  };

  const hasExif = async (buf: Buffer): Promise<boolean> => {
    const meta = await sharp(buf).metadata();
    return !!(meta.exif && meta.exif.length > 0);
  };

  const orgA = seedOrg();
  const anaId = seedContact(orgA, "Ana");
  const biaId = seedContact(orgA, "Bia");

  // ===== 1. Constantes exportadas =====
  check("BEAUTY_CONSENT_SCOPES inclui hair_simulation (dado sensível)",
    (BEAUTY_CONSENT_SCOPES as readonly string[]).includes("hair_simulation"));
  check("BEAUTY_CONSENT_SCOPES inclui use_in_marketing (SEPARADO, RN-BS-04)",
    (BEAUTY_CONSENT_SCOPES as readonly string[]).includes("use_in_marketing"));
  check("BEAUTY_CONSENT_SCOPES tem 4 escopos", BEAUTY_CONSENT_SCOPES.length === 4);
  check("BEAUTY_CONSULTATION_STATUSES inclui draft/ready/selected/scheduled/abandoned",
    ["draft", "ready", "selected", "scheduled", "abandoned"].every(s =>
      (BEAUTY_CONSULTATION_STATUSES as readonly string[]).includes(s)));

  // ===== 2. grantConsent — idempotente + escopo inválido lança =====
  const cid1 = BeautyVisualConsultationService.grantConsent(orgA, anaId, "hair_simulation");
  check("grantConsent retorna id", !!cid1 && typeof cid1 === "string");
  const cid1Again = BeautyVisualConsultationService.grantConsent(orgA, anaId, "hair_simulation");
  check("2ª chamada de grantConsent é IDEMPOTENTE (reusa id)", cid1Again === cid1);
  check("hasConsent(hair_simulation)=true", BeautyVisualConsultationService.hasConsent(orgA, anaId, "hair_simulation"));

  let scopeErr: string | null = null;
  try { BeautyVisualConsultationService.grantConsent(orgA, anaId, "escopo_invalido" as any); } catch (e: any) { scopeErr = e?.message || "err"; }
  check("escopo inválido → lança", !!scopeErr);

  // Escopo SEPARADO: use_in_marketing NÃO ativa hair_simulation
  BeautyVisualConsultationService.grantConsent(orgA, biaId, "use_in_marketing");
  check("Bia tem use_in_marketing", BeautyVisualConsultationService.hasConsent(orgA, biaId, "use_in_marketing"));
  check("Bia NÃO tem hair_simulation (escopos SEPARADOS — RN-BS-04)",
    !BeautyVisualConsultationService.hasConsent(orgA, biaId, "hair_simulation"));

  // ===== 3. startConsultation =====
  const cons = BeautyVisualConsultationService.startConsultation(orgA, {
    contactId: anaId, goal: "mechas", intensity: "moderado",
  });
  check("startConsultation cria em status='draft'", cons.status === "draft");
  check("consultation.goal preservado", cons.goal === "mechas");
  check("consultation.intensity preservado", cons.intensity === "moderado");
  check("consultation.expiresAt setado (default 30d)", !!cons.expiresAt);
  check("consultation.organizationId = orgA", cons.organizationId === orgA);

  // Contato não existente → lança
  let contactErr: string | null = null;
  try { BeautyVisualConsultationService.startConsultation(orgA, { contactId: "c_inexistente" }); } catch (e: any) { contactErr = e?.message || "err"; }
  check("contato inexistente → lança", !!contactErr);

  // Cross-tenant: contato de outra org não vale
  const orgB = seedOrg();
  contactErr = null;
  try { BeautyVisualConsultationService.startConsultation(orgB, { contactId: anaId }); } catch (e: any) { contactErr = e?.message || "err"; }
  check("cross-tenant: contato de outra org → lança (RN-BS-07)", !!contactErr);

  // ===== 4. uploadReferencePhoto — pré-condições =====
  // Sem consent (contato Bia — tem use_in_marketing mas não hair_simulation)
  const consBiaBadConsent = BeautyVisualConsultationService.startConsultation(orgA, {
    contactId: biaId, goal: "cor",
  });
  const photo = await seedPhoto(true);
  const noConsent = await BeautyVisualConsultationService.uploadReferencePhoto(orgA, consBiaBadConsent.id, photo);
  check("upload SEM consent hair_simulation recusa (RN-BS-11)",
    noConsent.ok === false && (noConsent as any).error?.includes("hair_simulation"),
    (noConsent as any).error);

  // Consulta inexistente
  const noConsult = await BeautyVisualConsultationService.uploadReferencePhoto(orgA, "cons_inexistente", photo);
  check("upload em consulta inexistente recusa", noConsult.ok === false);

  // Imagem inválida (buffer com bytes aleatórios)
  const badImg = await BeautyVisualConsultationService.uploadReferencePhoto(orgA, cons.id, Buffer.from("nao-e-imagem"));
  check("upload com buffer inválido recusa (não crash)", badImg.ok === false);

  // Photo com EXIF setado tem EXIF antes do upload?
  check("photo de teste TEM EXIF antes do upload", await hasExif(photo));

  // Upload feliz (Ana tem consent hair_simulation)
  const up = await BeautyVisualConsultationService.uploadReferencePhoto(orgA, cons.id, photo);
  check("upload feliz retorna ok=true + assetId", up.ok === true && !!(up as any).assetId);
  check("upload nasce em status='quarantined' (RN-BS-11)",
    up.ok && (up as any).status === "quarantined");

  const assetId = (up as any).assetId as string;
  const asset = BeautyVisualConsultationService.getAsset(orgA, assetId);
  check("getAsset retorna a linha", !!asset);
  check("asset.contactId = Ana", asset?.contactId === anaId);
  check("asset.consentId = consentimento hair_simulation da Ana", asset?.consentId === cid1);
  check("asset.storageKey começa com 'beauty/'", asset?.storageKey?.startsWith("beauty/") === true);
  check("asset.expiresAt setado", !!asset?.expiresAt);
  check("asset.status = 'quarantined' na tabela", asset?.status === "quarantined");

  // EXIF strip: arquivo no disco NÃO deve ter EXIF
  const filePath = path.join(tmpDir, "private_media", asset!.storageKey!);
  const savedBuf = fs.readFileSync(filePath);
  check("arquivo gravado no disco existe", savedBuf.length > 0);
  check("EXIF REMOVIDO no re-encode (RN-BS-04)", !(await hasExif(savedBuf)));

  // Consulta ganhou reference_photo_key + consent_id
  const consAfter = BeautyVisualConsultationService.getConsultation(orgA, cons.id)!;
  check("consulta.referencePhotoKey preenchido", consAfter.referencePhotoKey === asset?.storageKey);
  check("consulta.consentId preenchido", consAfter.consentId === cid1);

  // ===== 5. Aprovação / rejeição / avanço de status =====
  const listPreApprove = BeautyVisualConsultationService.listAssetsForContact(orgA, anaId);
  const preApproved = listPreApprove.find(a => a.id === assetId);
  check("listAssetsForContact retorna o asset quarantined", !!preApproved);
  check("asset quarantined NÃO tem signedUrl (só approved recebe)",
    preApproved?.signedUrl === null);

  const approved = BeautyVisualConsultationService.approveAsset(orgA, assetId, { singlePerson: true, safeContent: true });
  check("approveAsset retorna true", approved === true);
  const assetApproved = BeautyVisualConsultationService.getAsset(orgA, assetId)!;
  check("asset agora status='approved'", assetApproved.status === "approved");
  check("safetyReportJson armazenado (só flags — RN-BS-05)",
    !!assetApproved.safetyReportJson && !assetApproved.safetyReportJson.includes("base64"));

  // Consulta avança para 'ready'
  const consReady = BeautyVisualConsultationService.getConsultation(orgA, cons.id)!;
  check("consulta avança para status='ready' após aprovação", consReady.status === "ready");

  // Approve 2ª vez é no-op (só quarantined vira approved)
  const approve2 = BeautyVisualConsultationService.approveAsset(orgA, assetId);
  check("approve 2ª vez retorna false (idempotência)", approve2 === false);

  // Reject de asset já approved é no-op
  const rejectApproved = BeautyVisualConsultationService.rejectAsset(orgA, assetId, "teste");
  check("reject de asset já approved é no-op", rejectApproved === false);

  // Cria outra consulta+upload e testa reject
  BeautyVisualConsultationService.grantConsent(orgA, biaId, "hair_simulation");
  const consBia = BeautyVisualConsultationService.startConsultation(orgA, { contactId: biaId, goal: "corte" });
  const upBia = await BeautyVisualConsultationService.uploadReferencePhoto(orgA, consBia.id, photo);
  const rejected = BeautyVisualConsultationService.rejectAsset(orgA, (upBia as any).assetId, "foto escura",
    { goodLighting: false });
  check("rejectAsset retorna true em quarantined", rejected === true);
  const rejAsset = BeautyVisualConsultationService.getAsset(orgA, (upBia as any).assetId)!;
  check("asset rejected agora status='rejected'", rejAsset.status === "rejected");

  // ===== 6. URL assinada =====
  const listApprovedBia = BeautyVisualConsultationService.listAssetsForContact(orgA, anaId);
  const anaApproved = listApprovedBia.find(a => a.id === assetId)!;
  check("asset approved recebe signedUrl", !!anaApproved.signedUrl);
  check("signedUrl aponta pra rota /api/public/beauty/media",
    anaApproved.signedUrl!.startsWith("/api/public/beauty/media"));
  check("signedUrl inclui exp= e sig=",
    /[?&]exp=\d+/.test(anaApproved.signedUrl!) && /[?&]sig=[a-f0-9]+/.test(anaApproved.signedUrl!));

  // Parse exp/sig e resolve
  const url = new URL("http://x" + anaApproved.signedUrl!);
  const exp = url.searchParams.get("exp")!;
  const sig = url.searchParams.get("sig")!;
  const storageKey = decodeURIComponent(url.pathname.split("/").pop()!);
  const resolved = BeautyVisualConsultationService.resolveSignedFile(storageKey, exp, sig);
  check("resolveSignedFile devolve caminho válido", !!resolved && fs.existsSync(resolved));

  // Sig errada → nega
  const resolvedBadSig = BeautyVisualConsultationService.resolveSignedFile(storageKey, exp, sig.slice(0, -1) + "0");
  check("resolveSignedFile com sig alterada → null", resolvedBadSig === null);
  // Exp no passado → nega
  const resolvedExpired = BeautyVisualConsultationService.resolveSignedFile(storageKey, String(Date.now() - 60_000), sig);
  check("resolveSignedFile com exp expirado → null", resolvedExpired === null);
  // Path traversal → nega (safeStorageKey rejeita)
  const resolvedTraversal = BeautyVisualConsultationService.resolveSignedFile("../secret", exp, sig);
  check("resolveSignedFile com path traversal → null", resolvedTraversal === null);
  // Escopo isolado — assinatura de outra rota (fashion_private_media_v1) não vale aqui
  const { signKey } = await import("../src/server/fileSigning.js");
  const alt = signKey("fashion_private_media_v1", storageKey);
  const resolvedWrongScope = BeautyVisualConsultationService.resolveSignedFile(storageKey, String(alt.exp), alt.sig);
  check("resolveSignedFile com assinatura de OUTRO escopo → null (isolamento por escopo)",
    resolvedWrongScope === null);

  // ===== 7. Retenção / purga =====
  // Força expiração do asset da Ana
  db.prepare(`UPDATE beauty_avatar_assets SET expires_at = datetime('now', '-1 day') WHERE id = ?`).run(assetId);
  const listAfterExpire = BeautyVisualConsultationService.listAssetsForContact(orgA, anaId);
  const anaAfter = listAfterExpire.find(a => a.id === assetId);
  check("listAssets com asset expirado remove (purga preguiçosa)", !anaAfter);
  const anaExpiredRow = db.prepare(`SELECT status, storage_key FROM beauty_avatar_assets WHERE id = ?`).get(assetId) as any;
  check("asset expirado agora status='deleted'", anaExpiredRow.status === "deleted");
  check("storage_key removido do banco", anaExpiredRow.storage_key === null);
  check("arquivo apagado do disco",
    !fs.existsSync(path.join(tmpDir, "private_media", asset!.storageKey!)));

  // purgeExpired em batch
  const consBia2 = BeautyVisualConsultationService.startConsultation(orgA, { contactId: biaId, goal: "cor" });
  const upBia2 = await BeautyVisualConsultationService.uploadReferencePhoto(orgA, consBia2.id, photo);
  db.prepare(`UPDATE beauty_avatar_assets SET expires_at = datetime('now', '-1 day') WHERE id = ?`).run((upBia2 as any).assetId);
  const purged = BeautyVisualConsultationService.purgeExpired();
  check("purgeExpired retorna count >= 1", purged >= 1);

  // Retenção configurável
  db.prepare(`UPDATE organization_settings SET beauty_avatar_retention_days = 7 WHERE organization_id = ?`).run(orgA);
  check("retentionDays lê da config (7)", BeautyVisualConsultationService.retentionDays(orgA) === 7);
  db.prepare(`UPDATE organization_settings SET beauty_avatar_retention_days = 999 WHERE organization_id = ?`).run(orgA);
  check("retentionDays clamp a 365 quando > limite",
    BeautyVisualConsultationService.retentionDays(orgA) === 365);
  db.prepare(`UPDATE organization_settings SET beauty_avatar_retention_days = NULL WHERE organization_id = ?`).run(orgA);
  check("retentionDays default 30 quando NULL",
    BeautyVisualConsultationService.retentionDays(orgA) === 30);

  // ===== 8. Revogação de consent apaga assets (LGPD Art.18) =====
  BeautyVisualConsultationService.grantConsent(orgA, biaId, "hair_simulation");
  const consBiaRevoke = BeautyVisualConsultationService.startConsultation(orgA, { contactId: biaId, goal: "cor" });
  await BeautyVisualConsultationService.uploadReferencePhoto(orgA, consBiaRevoke.id, photo);
  const preRevoke = db.prepare(
    `SELECT COUNT(*) c FROM beauty_avatar_assets WHERE organization_id=? AND contact_id=? AND status != 'deleted'`,
  ).get(orgA, biaId) as any;
  check("Bia tem assets ativos antes da revogação", preRevoke.c >= 1);
  const revokeResult = BeautyVisualConsultationService.revokeConsent(orgA, biaId, "hair_simulation");
  check("revokeConsent retorna revoked=true", revokeResult.revoked === true);
  check("revokeConsent apagou assets (LGPD Art.18)", revokeResult.assetsDeleted >= 1);
  const postRevoke = db.prepare(
    `SELECT COUNT(*) c FROM beauty_avatar_assets WHERE organization_id=? AND contact_id=? AND status != 'deleted'`,
  ).get(orgA, biaId) as any;
  check("Bia sem assets ativos após revogação", postRevoke.c === 0);
  check("hasConsent(hair_simulation) agora false", !BeautyVisualConsultationService.hasConsent(orgA, biaId, "hair_simulation"));

  // Revogar use_in_marketing (NÃO apaga assets — escopo diferente)
  BeautyVisualConsultationService.grantConsent(orgA, biaId, "hair_simulation");
  const consBiaMkt = BeautyVisualConsultationService.startConsultation(orgA, { contactId: biaId, goal: "escova" });
  await BeautyVisualConsultationService.uploadReferencePhoto(orgA, consBiaMkt.id, photo);
  const revokeMkt = BeautyVisualConsultationService.revokeConsent(orgA, biaId, "use_in_marketing");
  check("revokeConsent(use_in_marketing) revoked=true", revokeMkt.revoked === true);
  check("revokeConsent(use_in_marketing) NÃO apaga assets (escopo DIFERENTE — RN-BS-04)",
    revokeMkt.assetsDeleted === 0);

  // Revogar consent inexistente é no-op
  const revokeNoop = BeautyVisualConsultationService.revokeConsent(orgA, biaId, "guardian_approval");
  check("revokeConsent inexistente retorna revoked=false", revokeNoop.revoked === false);

  // ===== 9. Isolamento cross-tenant =====
  const kaeId = seedContact(orgB, "Karen");
  BeautyVisualConsultationService.grantConsent(orgB, kaeId, "hair_simulation");
  const consK = BeautyVisualConsultationService.startConsultation(orgB, { contactId: kaeId, goal: "cor" });
  await BeautyVisualConsultationService.uploadReferencePhoto(orgB, consK.id, photo);

  const listA = BeautyVisualConsultationService.listAssetsForContact(orgA, kaeId);
  check("cross-tenant: orgA NÃO vê assets de Karen (orgB)", listA.length === 0);
  const consKOtherOrg = BeautyVisualConsultationService.getConsultation(orgA, consK.id);
  check("cross-tenant: getConsultation com orgA NÃO retorna consulta de orgB", consKOtherOrg === null);
  check("cross-tenant: hasConsent com orgA errada retorna false",
    !BeautyVisualConsultationService.hasConsent(orgA, kaeId, "hair_simulation"));

  // ===== 10. Zero hardcoded do Studio Márcia (§17/§65) =====
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
  console.log("\n=== TEST: Beauty AI — consent + consulta + upload (ADR-169 F5 / BEAUTY-005) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? "  [" + r.note + "]" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Fundação da Beauty AI pronta — consent + upload + quarentena + URL assinada.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
