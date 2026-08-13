/**
 * TEST — Social Connection Hub (PRD 10 / ADR-167 F2). DB-backed, determinístico, isolado.
 *
 * Prova (§5/§7, RN-SI-05/06):
 *   - config CIFRADA em repouso (`config_enc` nunca guarda o token em texto);
 *   - `status()`/`list()` REDIGEM — nunca devolvem o token cru, só `hasToken`/escopos/estado;
 *   - estado de conexão observável (§5) persistido do provider — token vencido nunca "connected";
 *   - capacidades DESCOBERTAS e cacheadas + flags grossas derivadas (RN-SI-06);
 *   - degradação: canal read-only → `publish` capability fora; provider ausente degrada, não finge;
 *   - disconnect zera a credencial e volta a `not_connected`;
 *   - ISOLAMENTO multi-tenant (org A não vê conexão de org B).
 *
 * Uso: npm run test:social-connection-hub
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-social-hub-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-social-hub-1234";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { SocialConnectionService: SC } = await import("../src/server/SocialConnectionService.js");

  const A = "org_social_A", B = "org_social_B";

  // ═══════════════ 1. gravação + cifra em repouso (RN-SI-05) ═══════════════
  SC.setConfig(A, "instagram", { token: "SECRET-IG-TOKEN-123", accountId: "17841400000000000" }, { provider: "stub", enabled: true, scopes: ["publish", "read_insights"] });
  const rawRow = db.prepare(`SELECT config_enc, scopes_json, provider, enabled FROM social_connections WHERE organization_id = ? AND channel = ?`).get(A, "instagram") as any;
  check("1.1 config gravada", !!rawRow);
  check("1.2 token CIFRADO em repouso (nunca em texto)", typeof rawRow.config_enc === "string" && rawRow.config_enc.startsWith("enc:") && !rawRow.config_enc.includes("SECRET-IG-TOKEN"));
  check("1.3 provider + enabled + scopes persistidos", rawRow.provider === "stub" && rawRow.enabled === 1 && rawRow.scopes_json.includes("publish"));
  const cfg = SC.getConfig(A, "instagram");
  check("1.4 getConfig decifra (uso interno)", cfg?.token === "SECRET-IG-TOKEN-123" && cfg?.accountId === "17841400000000000");

  // ═══════════════ 2. status REDIGIDO (nunca vaza token) ═══════════════
  const st = SC.status(A, "instagram");
  check("2.1 status não contém o token", !JSON.stringify(st).includes("SECRET-IG-TOKEN"));
  check("2.2 hasToken=true sem revelar o valor", st.hasToken === true && st.configured === true);
  check("2.3 escopos concedidos visíveis", st.scopes.includes("publish") && st.scopes.includes("read_insights"));
  check("2.4 estado inicial not_connected (§5)", st.state === "not_connected");

  // ═══════════════ 3. passe de saúde: estado + capacidades descobertas ═══════════════
  const afterHealth = await SC.refreshHealth(A, "instagram");
  check("3.1 estado observável persistido = connected (stub full)", afterHealth.state === "connected");
  check("3.2 capacidades DESCOBERTAS cacheadas (RN-SI-06)", afterHealth.capabilities.includes("publish") && afterHealth.capabilities.includes("getPosts"));
  check("3.3 flags grossas derivadas (§7)", afterHealth.capabilityFlags.publish === true && afterHealth.capabilityFlags.analytics === true && afterHealth.capabilityFlags.ads === false);
  check("3.4 healthCheckedAt carimbado", !!afterHealth.healthCheckedAt);

  // ═══════════════ 4. degradação: conta read-only (RN-SI-06) ═══════════════
  // config.capabilities modula o stub (representa uma conta sem permissão de publicar).
  SC.setConfig(B, "instagram", { token: "T-B", capabilities: { canPublish: false, canSchedule: false, canAnalytics: true } }, { provider: "stub", enabled: true });
  const bHealth = await SC.refreshHealth(B, "instagram");
  check("4.1 conta read-only: publish capability FORA", !bHealth.capabilities.includes("publish") && bHealth.capabilityFlags.publish === false);
  check("4.2 mas analytics presente (descoberta honesta)", bHealth.capabilityFlags.analytics === true);
  const prov = SC.providerFor(B, "instagram");
  const pub = await prov.publish({ kind: "image", idempotencyKey: "x1" });
  check("4.3 publish sem capacidade → manual_required (não finge)", pub.status === "manual_required");

  // ═══════════════ 5. estado honesto quando permissão < escopos pedidos (§5) ═══════════════
  // conta sem publish, mas pediu escopo 'publish' → permission_limited (token nunca finge conectado).
  SC.setConfig(A, "tiktok", { token: "T-TT", capabilities: { canPublish: false } }, { provider: "stub", enabled: true, scopes: ["publish"] });
  const ttHealth = await SC.refreshHealth(A, "tiktok");
  check("5.1 escopo além da permissão → permission_limited", ttHealth.state === "permission_limited");

  // ═══════════════ 6. isolamento multi-tenant (convenção #1) ═══════════════
  const listA = SC.list(A).map((c) => c.channel).sort();
  const listB = SC.list(B).map((c) => c.channel).sort();
  check("6.1 A vê só seus canais (instagram+tiktok)", JSON.stringify(listA) === JSON.stringify(["instagram", "tiktok"]));
  check("6.2 B vê só o seu (instagram)", JSON.stringify(listB) === JSON.stringify(["instagram"]));
  check("6.3 config de A não vaza pra B", SC.getConfig(B, "tiktok") === null);

  // ═══════════════ 7. disconnect zera credencial ═══════════════
  SC.disconnect(A, "instagram");
  const disc = SC.status(A, "instagram");
  check("7.1 após disconnect: sem token, not_connected", disc.hasToken === false && disc.state === "not_connected" && disc.enabled === false);
  check("7.2 config_enc zerada em repouso", (db.prepare(`SELECT config_enc FROM social_connections WHERE organization_id = ? AND channel = ?`).get(A, "instagram") as any).config_enc === null);
  check("7.3 linha preservada p/ histórico (não deleta)", !!db.prepare(`SELECT id FROM social_connections WHERE organization_id = ? AND channel = ?`).get(A, "instagram"));

  // ═══════════════ 8. validação de forma ═══════════════
  check("8.1 canal conhecido", SC.isKnownChannel("instagram") === true && SC.isKnownChannel("myspace") === false);
  // sem config → status honesto (not_connected, sem token), nunca lança
  const empty = SC.status(A, "youtube");
  check("8.2 canal sem config → status honesto not_connected", empty.hasToken === false && empty.state === "not_connected" && empty.capabilities.length === 0);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} social-connection-hub: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
