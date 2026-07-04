/**
 * TESTE — Fashion AI Studio FAS-1: conta, consentimento e avatar seguro (ADR-035)
 * -------------------------------------------------------------------------
 * Cobre todo o caminho determinístico do FAS-1 (sem chave de IA — a chamada
 * de visão da validação de foto é a única parte não coberta, mesma limitação
 * documentada desde a ADR-030):
 *   - registro com gate de 18 anos (menor recusado com orientação de usar a
 *     conta do responsável), e-mail duplicado, login, isolamento por loja;
 *   - SEGURANÇA CRÍTICA: o token do cliente do provador NÃO passa no
 *     requireAuth do painel do staff (segredo derivado) e vice-versa;
 *   - lead criado no CRM (canal sintético 'Loja Virtual');
 *   - consentimento obrigatório antes do upload; revogação apaga avatares;
 *   - mapeamento das recusas legíveis (evaluatePhotoReport, seção 6.3);
 *   - URL assinada: válida, expirada, adulterada, path traversal;
 *   - exclusão de avatar/dados e purga por retenção (arquivo some do disco).
 *
 * Uso: npm run test:fashion-avatar
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fashion-fas1-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-fashion-fas1-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const jwt = (await import("jsonwebtoken")).default;
  const { JWT_SECRET } = await import("../src/server/config/secret.js");
  const { FashionCustomerService } = await import("../src/server/FashionCustomerService.js");
  const { FashionAvatarService } = await import("../src/server/FashionAvatarService.js");

  const orgA = `org_${randomUUID().slice(0, 6)}`;
  const orgB = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Boutique A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Boutique B', 'active')`).run(randomUUID(), orgB);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, fashion_studio_enabled) VALUES (?, 'boutique-a', 1, 1)`).run(orgA);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, fashion_studio_enabled) VALUES (?, 'boutique-b', 1, 1)`).run(orgB);

  // ---- registro: gate de 18 anos ----
  const minor = FashionCustomerService.register(orgA, { name: "Jovem", email: "jovem@t.com", password: "12345678", birthDate: "2015-01-01" });
  check("Menor de 18: registro RECUSADO", !minor.ok);
  check("Menor de 18: mensagem orienta a conta do responsável", !minor.ok && /respons/i.test((minor as any).error));

  const badDate = FashionCustomerService.register(orgA, { name: "X", email: "x@t.com", password: "12345678", birthDate: "31/12/1990" });
  check("Data em formato inválido é recusada (exige ISO yyyy-mm-dd)", !badDate.ok);

  const shortPw = FashionCustomerService.register(orgA, { name: "X", email: "x@t.com", password: "123", birthDate: "1990-01-01" });
  check("Senha curta é recusada", !shortPw.ok);

  const adult = FashionCustomerService.register(orgA, { name: "Ana Silva", email: "ana@t.com", phone: "21999998888", password: "senhaforte1", birthDate: "1990-05-10" });
  check("Adulto: registro OK com token", adult.ok && !!(adult as any).token);
  const customerId = (adult as any).customerId as string;
  const custToken = (adult as any).token as string;

  const dup = FashionCustomerService.register(orgA, { name: "Ana 2", email: "ana@t.com", password: "outrasenha1", birthDate: "1985-01-01" });
  check("E-mail duplicado na MESMA loja é recusado", !dup.ok);
  const sameEmailOtherOrg = FashionCustomerService.register(orgB, { name: "Ana B", email: "ana@t.com", password: "outrasenha1", birthDate: "1985-01-01" });
  check("Mesmo e-mail em OUTRA loja é permitido (contas são por loja)", sameEmailOtherOrg.ok);

  // ---- idade: cálculo correto na borda do aniversário ----
  const now = new Date("2026-07-04T12:00:00Z");
  check("Faz 18 anos HOJE: liberado", FashionCustomerService.ageFromBirthDate("2008-07-04", now) === 18);
  check("Faz 18 anos AMANHÃ: ainda 17 (bloqueado)", FashionCustomerService.ageFromBirthDate("2008-07-05", now) === 17);

  // ---- login ----
  const badLogin = FashionCustomerService.login(orgA, "ana@t.com", "senhaerrada");
  check("Senha errada: recusada com mensagem genérica (não confirma e-mail)", !badLogin.ok && (badLogin as any).error === "E-mail ou senha incorretos.");
  const okLogin = FashionCustomerService.login(orgA, "ana@t.com", "senhaforte1");
  check("Login correto funciona", okLogin.ok);
  const crossOrgLogin = FashionCustomerService.login(orgB, "ana@t.com", "senhaforte1");
  check("Login é escopado por loja (conta da loja A não entra na loja B)", !crossOrgLogin.ok);

  // ---- SEGURANÇA: tokens não se cruzam entre provador e painel ----
  const verified = FashionCustomerService.verifyToken(custToken);
  check("Token do provador é verificável pelo próprio serviço", verified?.customerId === customerId && verified?.organizationId === orgA);
  let staffAccepts = false;
  try { jwt.verify(custToken, JWT_SECRET); staffAccepts = true; } catch { /* esperado */ }
  check("CRÍTICO: token do provador NÃO passa na verificação do painel (segredo derivado)", !staffAccepts);
  const staffToken = jwt.sign({ userId: "u1", organizationId: orgA, role: "owner", email: "dono@t.com" }, JWT_SECRET);
  check("CRÍTICO: token do painel NÃO passa na verificação do provador", FashionCustomerService.verifyToken(staffToken) === null);
  check("Token adulterado é recusado", FashionCustomerService.verifyToken(custToken.slice(0, -4) + "abcd") === null);

  // ---- lead no CRM ----
  const channel = db.prepare(`SELECT * FROM channels WHERE organization_id = ? AND provider = 'storefront'`).get(orgA) as any;
  check("Canal sintético 'Loja Virtual' criado", channel?.name === "Loja Virtual");
  const lead = db.prepare(`SELECT * FROM contacts WHERE organization_id = ? AND channel_id = ? AND identifier = '21999998888'`).get(orgA, channel?.id || "") as any;
  check("Cadastro virou LEAD no CRM (contato com telefone)", lead?.name === "Ana Silva" && lead?.email === "ana@t.com");
  const customerRow = db.prepare(`SELECT contact_id FROM storefront_customers WHERE id = ?`).get(customerId) as any;
  check("Conta guarda o vínculo com o lead (contact_id)", customerRow?.contact_id === lead?.id);

  // ---- consentimento obrigatório antes do upload ----
  const fakeJpeg = Buffer.from("nao-e-imagem-de-verdade");
  const noConsent = await FashionAvatarService.submitAvatar(orgA, customerId, fakeJpeg);
  check("Upload SEM consentimento é recusado antes de gravar qualquer arquivo", !noConsent.ok && /termo/i.test((noConsent as any).error));

  FashionAvatarService.grantConsent(orgA, customerId, "avatar_processing", "v1-2026-07");
  const consent = FashionAvatarService.activeConsent(orgA, customerId, "avatar_processing");
  check("Consentimento ativo com versão registrada (RF-003)", consent?.policy_version === "v1-2026-07");

  const noAI = await FashionAvatarService.submitAvatar(orgA, customerId, fakeJpeg);
  check("Sem chave de IA: upload falha com mensagem amigável (nunca aprova sem validar)", !noAI.ok && /indispon/i.test((noAI as any).error));

  // ---- evaluatePhotoReport: recusas legíveis (6.3) — determinístico, sem IA ----
  const allGood = FashionAvatarService.evaluatePhotoReport({ singlePerson: true, adultApparent: true, fullBody: true, frontal: true, goodLighting: true, armsVisible: true, safeContent: true, noDocuments: true });
  check("Foto perfeita: aprovada sem motivos", allGood.approved && allGood.reasons.length === 0);
  const twoPeople = FashionAvatarService.evaluatePhotoReport({ singlePerson: false, adultApparent: true, fullBody: true, frontal: true, goodLighting: true, armsVisible: true, safeContent: true, noDocuments: true });
  check("Duas pessoas: recusa com a mensagem certa", !twoPeople.approved && twoPeople.reasons[0].includes("mais de uma pessoa"));
  const cropped = FashionAvatarService.evaluatePhotoReport({ singlePerson: true, adultApparent: true, fullBody: false, frontal: true, goodLighting: true, armsVisible: true, safeContent: true, noDocuments: true });
  check("Corpo cortado: mensagem pede cabeça e pés (nunca julga o corpo)", !cropped.approved && cropped.reasons[0].includes("corpo inteiro"));
  const unsafe = FashionAvatarService.evaluatePhotoReport({ singlePerson: true, adultApparent: true, fullBody: true, frontal: true, goodLighting: true, armsVisible: true, safeContent: false, noDocuments: true });
  check("Conteúdo impróprio: recusa com mensagem NEUTRA (não descreve o motivo)", !unsafe.approved && unsafe.reasons[0].includes("validar a imagem com segurança"));
  const emptyReport = FashionAvatarService.evaluatePhotoReport({});
  check("IA não respondeu as flags: reprova por segurança (nunca aprova no vácuo)", !emptyReport.approved);

  // ---- URL assinada ----
  const PRIVATE_DIR = path.join(tmpDir, "private_media");
  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  const key = `${randomUUID()}.jpg`;
  fs.writeFileSync(path.join(PRIVATE_DIR, key), Buffer.from("jpegdata"));

  const url = FashionAvatarService.signedUrl(key);
  const parsed = new URL(`http://x${url}`);
  const exp = parsed.searchParams.get("exp")!;
  const sig = parsed.searchParams.get("sig")!;
  check("URL assinada válida resolve o arquivo", FashionAvatarService.resolveSignedFile(key, exp, sig) !== null);
  check("Assinatura adulterada é recusada", FashionAvatarService.resolveSignedFile(key, exp, sig.slice(0, -2) + "ff") === null);
  check("URL expirada é recusada", FashionAvatarService.resolveSignedFile(key, String(Date.now() - 1000), sig) === null);
  const escapeUrl = FashionAvatarService.signedUrl("../zappflow.db");
  const escParsed = new URL(`http://x${escapeUrl}`);
  const resolved = FashionAvatarService.resolveSignedFile("../zappflow.db", escParsed.searchParams.get("exp")!, escParsed.searchParams.get("sig")!);
  check("Path traversal na chave não escapa do diretório privado", resolved === null || resolved.startsWith(PRIVATE_DIR));

  // ---- exclusão e retenção ----
  const avatarId = randomUUID();
  const avatarKey = `${randomUUID()}.jpg`;
  fs.writeFileSync(path.join(PRIVATE_DIR, avatarKey), Buffer.from("avatar"));
  db.prepare(`INSERT INTO fashion_avatar_assets (id, organization_id, customer_id, storage_key, status, expires_at) VALUES (?, ?, ?, ?, 'approved', datetime('now', '+30 days'))`)
    .run(avatarId, orgA, customerId, avatarKey);

  const listed = FashionAvatarService.listAvatars(orgA, customerId);
  check("Avatar aprovado listado com URL assinada", listed.length === 1 && !!listed[0].url && listed[0].url!.includes("sig="));
  check("Outra organização não lista o avatar (isolamento)", FashionAvatarService.listAvatars(orgB, customerId).length === 0);
  check("Outro cliente não apaga o avatar", FashionAvatarService.deleteAvatar(orgA, "outro-cliente", avatarId) === false);

  check("Dona apaga o avatar", FashionAvatarService.deleteAvatar(orgA, customerId, avatarId) === true);
  check("Arquivo físico sumiu do disco após a exclusão", !fs.existsSync(path.join(PRIVATE_DIR, avatarKey)));

  // retenção vencida: purga apaga o arquivo
  const oldId = randomUUID();
  const oldKey = `${randomUUID()}.jpg`;
  fs.writeFileSync(path.join(PRIVATE_DIR, oldKey), Buffer.from("velho"));
  db.prepare(`INSERT INTO fashion_avatar_assets (id, organization_id, customer_id, storage_key, status, expires_at) VALUES (?, ?, ?, ?, 'approved', datetime('now', '-1 day'))`)
    .run(oldId, orgA, customerId, oldKey);
  const purged = FashionAvatarService.purgeExpired();
  check("Purga por retenção apaga avatar vencido (arquivo some do disco)", purged >= 1 && !fs.existsSync(path.join(PRIVATE_DIR, oldKey)));

  // revogar consentimento apaga avatares na hora
  const revokeId = randomUUID();
  const revokeKey = `${randomUUID()}.jpg`;
  fs.writeFileSync(path.join(PRIVATE_DIR, revokeKey), Buffer.from("rev"));
  db.prepare(`INSERT INTO fashion_avatar_assets (id, organization_id, customer_id, storage_key, status, expires_at) VALUES (?, ?, ?, ?, 'approved', datetime('now', '+30 days'))`)
    .run(revokeId, orgA, customerId, revokeKey);
  FashionAvatarService.revokeConsent(orgA, customerId, "avatar_processing");
  check("Revogar consentimento apaga o avatar na hora (RF-004)", !fs.existsSync(path.join(PRIVATE_DIR, revokeKey)));
  check("Consentimento revogado deixa de estar ativo", FashionAvatarService.activeConsent(orgA, customerId, "avatar_processing") === null);

  // exclusão total (direito de exclusão)
  FashionAvatarService.deleteAllCustomerData(orgA, customerId);
  const deletedCustomer = db.prepare(`SELECT * FROM storefront_customers WHERE id = ?`).get(customerId) as any;
  check("Exclusão total: conta anonimizada e marcada", !!deletedCustomer?.deleted_at && deletedCustomer?.name === "Excluído");
  check("Exclusão total: login para de funcionar", !FashionCustomerService.login(orgA, "ana@t.com", "senhaforte1").ok);
  check("Exclusão total: token antigo deixa de valer", FashionCustomerService.verifyToken(custToken) === null);

  // retenção configurável com clamp
  check("Retenção padrão é 30 dias", FashionAvatarService.retentionDays(orgB) === 30);
  db.prepare(`UPDATE storefront_settings SET fashion_avatar_retention_days = 900 WHERE organization_id = ?`).run(orgB);
  check("Retenção corrompida (900) sofre clamp para 365", FashionAvatarService.retentionDays(orgB) === 365);

  // ---- resultado ----
  console.log("\n=== Fashion AI Studio FAS-1 — conta, consentimento e avatar seguro (ADR-035) ===\n");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Erro fatal no teste:", e);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
