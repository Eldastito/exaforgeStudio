/**
 * TEST — BEAUTY-007 (ADR-169 F7): rotas HTTP da Beauty AI.
 *
 * Prova a superfície HTTP end-to-end:
 *   AUTENTICADAS (/api/beauty via protectedApi — auth+enforce module):
 *     - GET /vocabulary
 *     - POST /consents + DELETE /consents
 *     - POST /consultations + GET /consultations/:id
 *     - POST /consultations/:id/upload (multipart)
 *     - POST /assets/:id/approve + /assets/:id/reject
 *     - POST /consultations/:id/simulate + GET /simulations/:id
 *     - POST /simulations/:id/cancel
 *     - POST /consultations/:id/select
 *
 *   PÚBLICAS (/api/public/beauty/media/:key):
 *     - Serve arquivo com URL assinada (HMAC + expiração + timingSafeEqual).
 *
 * Gates validados:
 *   - `vertical=beleza` obrigatório (404 sem — não vaza existência).
 *   - `beauty_hair_simulator_enabled=1` obrigatório pra /simulate (403).
 *   - Multi-tenant: contact/consulta/asset de outra org → 404/403.
 *   - Sig alterada / exp expirado / path traversal → 403 (não 500).
 *
 * O teste boota um Express mínimo (sem passar pelo middleware pesado do
 * `server.ts` — só a auth stub que injeta req.organizationId + req.user).
 * Isso testa a AMARRAÇÃO real (router + handlers + middleware multer +
 * BeautyVisualConsultationService + BeautyHairSimulationService) contra
 * um servidor HTTP real via fetch().
 *
 * Uso: npm run test:beauty-routes
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-routes-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-beauty-routes-1234567890abcdef";
process.env.BEAUTY_HAIR_SIMULATION_PROVIDER = "stub"; // determinístico

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));

  const express = (await import("express")).default;
  const sharp = (await import("sharp")).default;
  const { default: beautyRoutes } = await import("../src/server/routes/beauty.js");
  const { default: beautyPublicRoutes } = await import("../src/server/routes/beautyPublic.js");
  const { BeautyVisualConsultationService } = await import("../src/server/BeautyVisualConsultationService.js");

  // ── Mini-app (protectedApi stub — injeta req.user + orgId) ──
  const app = express();
  app.use(express.json());
  // Auth stub: pega orgId + userId + role de headers 'x-test-org'/'x-test-user'/'x-test-role'
  const authStub = (req: any, _res: any, next: any) => {
    req.organizationId = req.headers["x-test-org"] || null;
    req.user = {
      userId: req.headers["x-test-user"] || null,
      role: req.headers["x-test-role"] || "owner",
      organizationId: req.headers["x-test-org"] || null,
    };
    next();
  };
  app.use("/api/beauty", authStub, beautyRoutes);
  app.use("/api/public/beauty", beautyPublicRoutes);

  const server = app.listen(0);
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  const seedOrgBeleza = (simulatorOn = true) => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, beauty_hair_simulator_enabled) VALUES (?, ?, 'X', 'active', 'beleza', ?)`,
    ).run(randomUUID(), orgId, simulatorOn ? 1 : 0);
    return orgId;
  };
  const seedOrgOutra = (vertical: string) => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'X', 'active', ?)`,
    ).run(randomUUID(), orgId, vertical);
    return orgId;
  };
  const seedContact = (orgId: string, name = "Cliente") => {
    const id = `c_${randomUUID().slice(0, 6)}`;
    db.prepare(
      `INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch1', ?, ?)`,
    ).run(id, orgId, name, `${orgId}:${id}`);
    return id;
  };

  const call = async (method: string, url: string, opts: { orgId?: string | null; body?: any; headers?: any; fileBuf?: Buffer; fileField?: string } = {}) => {
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    if (opts.orgId !== null && opts.orgId !== undefined) headers["x-test-org"] = opts.orgId;
    let body: any = undefined;
    if (opts.fileBuf) {
      // multipart mínimo — field 'file' por default (o contrato do backend);
      // `fileField` permite testar campo ERRADO (regressão do 500-HTML).
      const field = opts.fileField || "file";
      const bd = `--------------${randomUUID().replace(/-/g, "")}`;
      const parts: Buffer[] = [];
      parts.push(Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="${field}"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`));
      parts.push(opts.fileBuf);
      parts.push(Buffer.from(`\r\n--${bd}--\r\n`));
      body = Buffer.concat(parts);
      headers["content-type"] = `multipart/form-data; boundary=${bd}`;
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["content-type"] = "application/json";
    }
    const r = await fetch(`${base}${url}`, { method, headers, body });
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not-json */ }
    return { status: r.status, json, text, headers: r.headers };
  };

  try {
    const orgA = seedOrgBeleza(true);
    const orgB = seedOrgBeleza(false);        // vertical beleza mas simulador desligado
    const orgVarejo = seedOrgOutra("varejo"); // vertical errada
    const ana = seedContact(orgA, "Ana");

    // ===== 1. Gate vertical: sem beleza → 404 =====
    let r = await call("GET", "/api/beauty/vocabulary", { orgId: orgVarejo });
    check("GET /vocabulary com vertical=varejo → 404 (não vaza)", r.status === 404);

    r = await call("GET", "/api/beauty/vocabulary", { orgId: null });
    check("GET /vocabulary sem orgId → 401", r.status === 401);

    r = await call("GET", "/api/beauty/vocabulary", { orgId: orgA });
    check("GET /vocabulary com beleza → 200", r.status === 200,
      `status=${r.status} json=${JSON.stringify(r.json).slice(0, 100)}`);
    check("vocabulary retorna consentScopes + simulationTypes + colors + cuts",
      Array.isArray(r.json?.consentScopes) && Array.isArray(r.json?.simulationTypes) &&
      Array.isArray(r.json?.colors) && Array.isArray(r.json?.cuts));
    // F32 — objetivos de consulta prontos pro dropdown ({value,label}).
    check("vocabulary retorna goals com {value,label} (F32)",
      Array.isArray(r.json?.goals) && r.json.goals.length > 0 &&
      r.json.goals.every((g: any) => typeof g?.value === "string" && typeof g?.label === "string") &&
      r.json.goals.some((g: any) => g.value === "coloracao"));

    // ===== 2. Consent =====
    r = await call("POST", "/api/beauty/consents", {
      orgId: orgA, body: { contactId: ana, consentType: "hair_simulation" },
    });
    check("POST /consents ok → 200 + id", r.status === 200 && !!r.json?.id);

    r = await call("POST", "/api/beauty/consents", {
      orgId: orgA, body: { contactId: ana, consentType: "escopo_invalido" },
    });
    check("POST /consents com escopo inválido → 400", r.status === 400);

    r = await call("POST", "/api/beauty/consents", {
      orgId: orgA, body: { contactId: ana }, // sem consentType
    });
    check("POST /consents sem consentType → 400", r.status === 400);

    // ===== 3. Consultations =====
    r = await call("POST", "/api/beauty/consultations", {
      orgId: orgA, body: { contactId: ana, goal: "mechas", intensity: "moderado" },
    });
    check("POST /consultations → 200 + id + status=draft",
      r.status === 200 && !!r.json?.id && r.json?.status === "draft");
    const consultationId = r.json.id;

    r = await call("POST", "/api/beauty/consultations", {
      orgId: orgA, body: {}, // sem contactId
    });
    check("POST /consultations sem contactId → 400", r.status === 400);

    r = await call("POST", "/api/beauty/consultations", {
      orgId: orgA, body: { contactId: "c_inexistente" },
    });
    check("POST /consultations com contactId inexistente → 400", r.status === 400);

    // ===== 4. Upload =====
    const jpeg = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 128, g: 64, b: 32 } },
    }).jpeg().toBuffer();

    r = await call("POST", `/api/beauty/consultations/${consultationId}/upload`, {
      orgId: orgA, fileBuf: jpeg,
    });
    check("POST /upload com file → 200 + assetId + status=quarantined",
      r.status === 200 && !!r.json?.assetId && r.json?.status === "quarantined");
    const assetId = r.json.assetId;

    r = await call("POST", `/api/beauty/consultations/${consultationId}/upload`, {
      orgId: orgA, // sem file
    });
    check("POST /upload sem file → 400", r.status === 400);

    // Regressão do 500-HTML (BeautyView mandava field 'photo' em vez de 'file'):
    // campo inesperado agora vira JSON 400 pelo wrapper uploadSingleFile — NUNCA
    // HTML "Internal Server Error" (que quebrava o parse no frontend).
    r = await call("POST", `/api/beauty/consultations/${consultationId}/upload`, {
      orgId: orgA, fileBuf: jpeg, fileField: "photo",
    });
    check("POST /upload com field errado ('photo') → 400 JSON (não 500 HTML)",
      r.status === 400 && r.json !== null && typeof r.json?.error === "string",
      `status=${r.status} json=${r.json ? "sim" : "null(HTML?)"}`);
    check("POST /upload field errado → code=LIMIT_UNEXPECTED_FILE",
      r.json?.code === "LIMIT_UNEXPECTED_FILE", `code=${r.json?.code}`);

    // ===== 5. Approve asset → consulta ready =====
    r = await call("POST", `/api/beauty/assets/${assetId}/approve`, {
      orgId: orgA, body: { safetyReport: { singlePerson: true } },
    });
    check("POST /assets/:id/approve → 200 + ok", r.status === 200 && r.json?.ok === true);

    r = await call("POST", `/api/beauty/assets/${assetId}/approve`, {
      orgId: orgA, body: {},
    });
    check("POST /assets/:id/approve 2ª vez → 404 (não mais em quarentena)", r.status === 404);

    r = await call("GET", `/api/beauty/consultations/${consultationId}`, { orgId: orgA });
    check("GET /consultations/:id retorna consulta+assets+simulations",
      r.status === 200 && !!r.json?.consultation && Array.isArray(r.json?.assets) && Array.isArray(r.json?.simulations));
    check("consulta agora status='ready' após aprovação", r.json.consultation.status === "ready");
    check("assets inclui 1 asset approved", r.json.assets.length === 1 && r.json.assets[0].status === "approved");
    check("asset approved tem signedUrl", !!r.json.assets[0].signedUrl);

    // ===== 6. Simulate =====
    // Gate simulator: orgB tem beleza mas simulador off
    const consultationBId = await (async () => {
      const bAna = seedContact(orgB, "Bia");
      // consent + consulta na orgB (beleza mas simulador off)
      BeautyVisualConsultationService.grantConsent(orgB, bAna, "hair_simulation");
      const cons = BeautyVisualConsultationService.startConsultation(orgB, { contactId: bAna, goal: "cor" });
      const up = await BeautyVisualConsultationService.uploadReferencePhoto(orgB, cons.id, jpeg);
      BeautyVisualConsultationService.approveAsset(orgB, (up as any).assetId);
      return cons.id;
    })();
    r = await call("POST", `/api/beauty/consultations/${consultationBId}/simulate`, {
      orgId: orgB, body: { simulationType: "color", parameters: { color: "loiro" } },
    });
    check("POST /simulate com simulator OFF → 403", r.status === 403,
      `status=${r.status} json=${JSON.stringify(r.json)}`);

    r = await call("POST", `/api/beauty/consultations/${consultationId}/simulate`, {
      orgId: orgA, body: { simulationType: "color", parameters: { color: "morena_iluminada" } },
    });
    check("POST /simulate ok → 200 + simulationId + status=QUEUED",
      r.status === 200 && !!r.json?.simulationId && r.json?.status === "QUEUED");
    const simulationId = r.json.simulationId;

    r = await call("POST", `/api/beauty/consultations/${consultationId}/simulate`, {
      orgId: orgA, body: { simulationType: "invalido" },
    });
    check("POST /simulate com simulationType inválido → 400", r.status === 400);

    // Executa o job síncrono via service (no server real, JobQueue processa em bg)
    const { BeautyHairSimulationService } = await import("../src/server/BeautyHairSimulationService.js");
    await BeautyHairSimulationService.processJob(simulationId);

    r = await call("GET", `/api/beauty/simulations/${simulationId}`, { orgId: orgA });
    check("GET /simulations/:id retorna sim SUCCEEDED", r.status === 200 && r.json?.status === "SUCCEEDED");
    check("GET /simulations/:id inclui signedUrl", !!r.json?.signedUrl);
    const signedUrl = r.json.signedUrl;

    // ===== 7. Select (cliente escolhe visual) =====
    r = await call("POST", `/api/beauty/consultations/${consultationId}/select`, {
      orgId: orgA, body: { simulationId },
    });
    check("POST /select ok → 200 + status=selected", r.status === 200 && r.json?.status === "selected");
    check("consulta grava selected_simulation_id", r.json?.selectedSimulationId === simulationId);
    check("selected_at preenchido", !!r.json?.selectedAt);

    // F27: re-seleção PERMITIDA — a cliente troca de visual quantas vezes
    // quiser antes de agendar ('scheduled' é o que trava).
    r = await call("POST", `/api/beauty/consultations/${consultationId}/select`, {
      orgId: orgA, body: { simulationId },
    });
    check("POST /select 2ª vez (re-seleção antes de agendar) → 200 (F27)",
      r.status === 200 && r.json?.status === "selected");

    // ===== 8. Multi-tenant duro =====
    r = await call("GET", `/api/beauty/consultations/${consultationId}`, { orgId: orgB });
    check("GET /consultations/:id com orgB → 404 (multi-tenant)", r.status === 404);

    r = await call("GET", `/api/beauty/simulations/${simulationId}`, { orgId: orgB });
    check("GET /simulations/:id com orgB → 404 (multi-tenant)", r.status === 404);

    // ===== 9. URL assinada resolve (pública) =====
    // signedUrl vem como /api/public/beauty/media/<key>?exp&sig — bate direto no base
    r = await call("GET", signedUrl, { orgId: null });
    check("GET signedUrl com assinatura válida → 200", r.status === 200,
      `status=${r.status} url=${signedUrl}`);
    check("resposta tem Content-Type imagem", (r.headers.get("content-type") || "").startsWith("image/"));
    check("resposta tem X-Content-Type-Options: nosniff",
      r.headers.get("x-content-type-options") === "nosniff");

    // Sig alterada → 403
    const badSig = signedUrl.replace(/sig=[a-f0-9]+/i, "sig=0000000000000000000000000000000000000000000000000000000000000000");
    r = await call("GET", badSig, { orgId: null });
    check("GET signedUrl com sig alterada → 403", r.status === 403,
      `status=${r.status}`);

    // Exp no passado → 403
    const badExp = signedUrl.replace(/exp=\d+/, `exp=${Date.now() - 60_000}`);
    r = await call("GET", badExp, { orgId: null });
    check("GET signedUrl com exp expirado → 403", r.status === 403);

    // Sem exp/sig → 400
    const noSigUrl = signedUrl.split("?")[0];
    r = await call("GET", noSigUrl, { orgId: null });
    check("GET media sem exp/sig → 400", r.status === 400);

    // Path traversal negado
    r = await call("GET", "/api/public/beauty/media/..%2Fsecret?exp=9999999999999&sig=abc", { orgId: null });
    check("GET media com path traversal → 403 (safeStorageKey rejeita)",
      r.status === 403 || r.status === 400 || r.status === 404);

    // ===== 10. revoke consent (apaga assets — LGPD Art.18) =====
    r = await call("DELETE", "/api/beauty/consents", {
      orgId: orgA, body: { contactId: ana, consentType: "hair_simulation" },
    });
    check("DELETE /consents (hair_simulation) → 200 + revoked=true + assetsDeleted>=1",
      r.status === 200 && r.json?.revoked === true && r.json?.assetsDeleted >= 1);

    // ===== 11. Cancel simulação em QUEUED =====
    // Cria uma nova consulta+simulação pra cancelar
    const consK = BeautyVisualConsultationService.startConsultation(orgA, {
      contactId: seedContact(orgA, "Karen"), goal: "cor",
    });
    BeautyVisualConsultationService.grantConsent(orgA, consK.contactId!, "hair_simulation");
    const upK = await BeautyVisualConsultationService.uploadReferencePhoto(orgA, consK.id, jpeg);
    BeautyVisualConsultationService.approveAsset(orgA, (upK as any).assetId);
    r = await call("POST", `/api/beauty/consultations/${consK.id}/simulate`, {
      orgId: orgA, body: { simulationType: "cut", parameters: { cut: "chanel" } },
    });
    const simK = r.json.simulationId;
    // O JobQueue processa via setImmediate — pra testar o path do cancel,
    // forçamos status='QUEUED' de volta no banco (pode já ter virado
    // SUCCEEDED entre o enqueue e o próximo await).
    db.prepare(`UPDATE beauty_visual_simulations SET status = 'QUEUED', output_storage_key = NULL, completed_at = NULL WHERE id = ?`).run(simK);
    r = await call("POST", `/api/beauty/simulations/${simK}/cancel`, { orgId: orgA });
    check("POST /simulations/:id/cancel em QUEUED → 200 + ok=true", r.status === 200 && r.json?.ok === true);
    r = await call("POST", `/api/beauty/simulations/${simK}/cancel`, { orgId: orgA });
    check("POST /simulations/:id/cancel 2ª vez → 200 + ok=false (não estava mais QUEUED)",
      r.status === 200 && r.json?.ok === false);

    // ===== 12. Zero hardcoded do Studio Márcia (§17/§65) =====
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
    console.log("\n=== TEST: Rotas HTTP Beauty AI (ADR-169 F7 / BEAUTY-007) ===\n");
    for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}${rr.note ? "  [" + rr.note + "]" : ""}`);
    console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
    if (failures > 0) console.error(`\n❌ ${failures} FALHA(S).`);
    else console.log("\n✅ Rotas HTTP amarradas — auth+gate+multi-tenant+URL assinada OK.");
  } finally {
    server.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
