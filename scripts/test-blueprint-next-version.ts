/**
 * TESTE — Fatia 3.3 (ADR-153): `VerticalBlueprintService.createNextVersion`
 * e `previewBlueprintDiff`. Rotas admin correspondentes.
 *
 * Cobre:
 *   1. `createNextVersion` a partir de published: auto-incrementa version;
 *      clona toda a config; status = draft.
 *   2. `createNextVersion` sem `edits.config`: config idêntica ao source
 *      (config vira "verbatim").
 *   3. `createNextVersion` com edits parciais (só hiddenModules): merge
 *      preserva requiredModules do source.
 *   4. `createNextVersion` a partir de draft: OK (bumpa pra próxima).
 *   5. `createNextVersion` a partir de deprecated: THROWS (deprecated não
 *      deve gerar linha nova; deve criar do zero com key nova).
 *   6. Blueprint original permanece IMUTÁVEL — publishing a v2 não muda a v1.
 *   7. `previewBlueprintDiff` retorna added/removed corretos por categoria.
 *   8. `previewBlueprintDiff` cobre commercialUpgrades + runtimePlaybooks +
 *      escalares (name, minimumPlanId, defaultPlanId, quickStartPack).
 *   9. `previewBlueprintDiff` NÃO depende de org atribuída.
 *  10. Rota POST /api/admin/blueprints/:id/next-version funciona.
 *  11. Rota GET /api/admin/blueprints/:id/diff funciona.
 *  12. Rota /diff sem `targetId` retorna 400.
 *
 * Uso: npm run test:blueprint-next-version
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import express from "express";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-bp-nextv-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-bp-nextv-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function req(port: number, method: string, url: string, body?: any): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function main() {
  await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 300));
  const { VerticalBlueprintService } = await import("../src/server/VerticalBlueprintService.js");

  // ===== 1. next-version from published =====
  const v1 = VerticalBlueprintService.createBlueprint({
    key: `test_v${randomUUID().slice(0, 4)}`,
    name: "Test Preset",
    baseVertical: "servicos",
    minimumPlanId: "growth",
    defaultPlanId: "growth",
    config: {
      requiredModules: ["atendimento", "contatos"],
      optionalModules: ["agenda"],
      hiddenModules: ["retail"],
      commercialUpgrades: ["scale"],
      quickStartPack: null,
      runtimePlaybooks: [],
    },
  });
  VerticalBlueprintService.publishVersion(v1.id);
  const v1Key = v1.key;

  const v2 = VerticalBlueprintService.createNextVersion(v1.id, {
    config: {
      requiredModules: ["atendimento", "contatos"],
      optionalModules: ["agenda", "clinica"],  // adicionou clinica
      hiddenModules: ["retail"],
      commercialUpgrades: ["scale", "enterprise"],
      quickStartPack: null,
      runtimePlaybooks: [],
    },
  });
  check("createNextVersion: auto-incrementa version (v2)", v2.version === 2, `got ${v2.version}`);
  check("createNextVersion: nova versão é 'draft'", v2.status === "draft", v2.status);
  check("createNextVersion: mantém key do source", v2.key === v1Key);
  check("createNextVersion: clona name (não editado) do source", v2.name === "Test Preset");
  check("createNextVersion: mantém baseVertical do source", v2.baseVertical === "servicos");

  // ===== 2. next-version SEM edits.config =====
  const v3 = VerticalBlueprintService.createNextVersion(v1.id, {});
  check("createNextVersion sem edits.config: config é idêntica ao source", JSON.stringify(v3.config) === JSON.stringify(v1.config), JSON.stringify(v3.config).slice(0, 200));
  check("createNextVersion sem edits: version = 3", v3.version === 3);

  // ===== 3. edits parciais =====
  const v4 = VerticalBlueprintService.createNextVersion(v1.id, {
    config: {
      hiddenModules: ["retail", "escola"],  // muda só isso
      requiredModules: v1.config.requiredModules,
      optionalModules: v1.config.optionalModules,
      commercialUpgrades: v1.config.commercialUpgrades,
      quickStartPack: v1.config.quickStartPack,
      runtimePlaybooks: v1.config.runtimePlaybooks,
    },
  });
  check("edits parciais: hidden mudou", v4.config.hiddenModules.includes("escola") && v4.config.hiddenModules.length === 2);
  check("edits parciais: requiredModules preservado do source",
    JSON.stringify(v4.config.requiredModules) === JSON.stringify(v1.config.requiredModules));

  // ===== 4. from draft: OK =====
  const v5 = VerticalBlueprintService.createNextVersion(v2.id, { name: "Renamed From Draft" });
  check("createNextVersion a partir de draft: OK", v5.version === 5, `got ${v5.version}`);
  check("createNextVersion a partir de draft: nome novo aplicado", v5.name === "Renamed From Draft");

  // ===== 5. from deprecated: THROWS =====
  const oldBp = VerticalBlueprintService.createBlueprint({
    key: `old_${randomUUID().slice(0, 4)}`,
    name: "Old", baseVertical: "servicos",
    config: {
      requiredModules: [], optionalModules: [], hiddenModules: [],
      commercialUpgrades: [], quickStartPack: null, runtimePlaybooks: [],
    },
  });
  VerticalBlueprintService.publishVersion(oldBp.id);
  VerticalBlueprintService.deprecateBlueprint(oldBp.id);
  let threw = false;
  try { VerticalBlueprintService.createNextVersion(oldBp.id, {}); } catch { threw = true; }
  check("createNextVersion a partir de deprecated: THROWS", threw);

  // ===== 6. v1 permanece intocada após bumps =====
  const v1After = VerticalBlueprintService.getBlueprint(v1.id);
  check("v1 permanece IMUTÁVEL após v2/v3/v4/v5", JSON.stringify(v1After?.config) === JSON.stringify(v1.config));
  check("v1 continua 'published'", v1After?.status === "published");

  // ===== 7. previewBlueprintDiff: módulos =====
  const diff = VerticalBlueprintService.previewBlueprintDiff(v1.id, v2.id);
  check("diff v1→v2: optionalAdded inclui 'clinica'", diff.diff.optionalAdded.includes("clinica"));
  check("diff v1→v2: optionalRemoved vazio", diff.diff.optionalRemoved.length === 0);
  check("diff v1→v2: commercialUpgradesAdded inclui 'enterprise'", diff.diff.commercialUpgradesAdded.includes("enterprise"));

  // ===== 8. diff cobre escalares =====
  const v6 = VerticalBlueprintService.createNextVersion(v1.id, {
    name: "Renamed", minimumPlanId: "scale", defaultPlanId: "scale",
  });
  const diffScalar = VerticalBlueprintService.previewBlueprintDiff(v1.id, v6.id);
  const nameChange = diffScalar.diff.scalarChanges.find((c) => c.field === "name");
  check("diff escalar: 'name' mudou (Test Preset → Renamed)",
    nameChange?.from === "Test Preset" && nameChange?.to === "Renamed",
    JSON.stringify(nameChange));
  const minChange = diffScalar.diff.scalarChanges.find((c) => c.field === "minimumPlanId");
  check("diff escalar: minimumPlanId mudou (growth → scale)",
    minChange?.from === "growth" && minChange?.to === "scale");

  // ===== 9. diff funciona sem org atribuída =====
  check("previewBlueprintDiff: source e target retornados sem dependência de org",
    diff.source.id === v1.id && diff.target.id === v2.id);

  // ===== 10-12. Rotas =====
  const adminRoutes = (await import("../src/server/routes/admin.js")).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { userId: "master-uid", email: "master@zappflow.test", role: "owner" };
    next();
  });
  app.use("/api/admin", adminRoutes);
  const server = http.createServer(app);
  const port: number = await new Promise((resolve) => server.listen(0, () => resolve((server.address() as any).port)));

  // ===== 10. rota next-version =====
  const rNext = await req(port, "POST", `/api/admin/blueprints/${v1.id}/next-version`, {
    edits: { name: "Via Rota", config: { requiredModules: ["atendimento"], optionalModules: [], hiddenModules: [], commercialUpgrades: [], quickStartPack: null, runtimePlaybooks: [] } },
  });
  check("rota POST next-version: status 201", rNext.status === 201, `got ${rNext.status}`);
  check("rota POST next-version: retorna novo blueprint com version > 1",
    rNext.json?.version > 1 && rNext.json?.status === "draft",
    JSON.stringify(rNext.json).slice(0, 200));

  // ===== 11. rota /diff =====
  const rDiff = await req(port, "GET", `/api/admin/blueprints/${v1.id}/diff?targetId=${v2.id}`);
  check("rota GET diff: status 200", rDiff.status === 200);
  check("rota GET diff: retorna diff.diff.optionalAdded",
    Array.isArray(rDiff.json?.diff?.optionalAdded) && rDiff.json.diff.optionalAdded.includes("clinica"),
    JSON.stringify(rDiff.json?.diff).slice(0, 200));

  // ===== 12. /diff sem targetId → 400 =====
  const rDiffNoTarget = await req(port, "GET", `/api/admin/blueprints/${v1.id}/diff`);
  check("rota GET diff sem targetId: retorna 400", rDiffNoTarget.status === 400);

  server.close();

  // ===== Resultado =====
  console.log("\n=== Blueprint NextVersion + Diff (F3.3) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  (" + r.detail.slice(0, 200) + ")" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
