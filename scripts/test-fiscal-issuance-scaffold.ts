/**
 * TEST — Emissão fiscal NFS-e/NFC-e: scaffold honesto (ADR-181 F6). DB-backed, determinístico.
 * Prova: nunca marca 'connected' sem homologação (RN-FISCAL-8); credencial cifrada + status
 * REDIGIDO (segredo nunca volta); capacidades indisponíveis sem homologação; issue LANÇA
 * (nunca finge emitir nota); opt-in/reversível; isolamento.
 *
 * Uso: npm run test:fiscal-issuance-scaffold
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fisciss-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-fisciss-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FiscalIssuanceService: FI } = await import("../src/server/FiscalIssuanceService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org', 'active')`).run(randomUUID(), o);

  // 1. Sem config → not_configured, capacidades indisponíveis, sem segredo.
  const s0 = FI.status(A);
  check("1.1 estado inicial not_configured", s0.state === "not_configured" && s0.configured === false);
  check("1.2 capacidades indisponíveis", s0.capabilities.every((c: any) => c.available === false && c.reason === "awaiting_homologation"));
  check("1.3 sem credencial", s0.hasCredentials === false);

  // 2. Configura com credencial + opt-in → awaiting_homologation (NUNCA connected). RN-FISCAL-8.
  const s1 = FI.configure(A, { provider: "focus_nfe", providerToken: "SECRET-TOKEN-123", municipalityIbge: "4314902", environment: "homolog" }, { enabled: true }, "u");
  check("2.1 estado awaiting_homologation (não connected)", s1.state === "awaiting_homologation");
  check("2.2 configured + enabled + hasCredentials", s1.configured === true && s1.enabled === true && s1.hasCredentials === true);
  check("2.3 campo público volta (provider)", s1.config.provider === "focus_nfe" && s1.config.municipalityIbge === "4314902");
  check("2.4 capacidades ainda indisponíveis (sem homologação)", s1.capabilities.every((c: any) => c.available === false));

  // 3. Segredo NUNCA volta no status nem em JSON; guardado CIFRADO no banco.
  const statusJson = JSON.stringify(FI.status(A));
  check("3.1 status não vaza o token", !statusJson.includes("SECRET-TOKEN-123"));
  const rawEnc = db.prepare(`SELECT config_enc FROM fiscal_issuance_connections WHERE organization_id = ?`).get(A) as any;
  check("3.2 config cifrada no banco (não plaintext)", typeof rawEnc.config_enc === "string" && !rawEnc.config_enc.includes("SECRET-TOKEN-123"));

  // 4. issue LANÇA (nunca finge emitir nota) — RN-FISCAL-8.
  let eIssue = false; try { await FI.issue(A, { kind: "nfse", amountCents: 20000, date: "2026-06-01" }); } catch (e: any) { eIssue = e.message === "fiscal_awaiting_homologation"; }
  check("4.1 issue com config lança awaiting_homologation", eIssue);
  let eIssueB = false; try { await FI.issue(B, { kind: "nfce" }); } catch (e: any) { eIssueB = e.message === "fiscal_not_configured"; }
  check("4.2 issue sem config lança not_configured", eIssueB);

  // 5. Opt-out/reversível: disconnect limpa (segredo some).
  const s2 = FI.disconnect(A, "u");
  check("5.1 disconnect volta pra not_configured", s2.state === "not_configured" && s2.configured === false && s2.enabled === false);
  check("5.2 segredo apagado do banco", (db.prepare(`SELECT config_enc FROM fiscal_issuance_connections WHERE organization_id = ?`).get(A) as any).config_enc === null);

  // 6. Desabilitar sem apagar → disabled (config guardada, mas não opera).
  FI.configure(A, { provider: "enotas", providerToken: "TK2", municipalityIbge: "3550308" }, { enabled: true }, "u");
  const s3 = FI.configure(A, {}, { enabled: false }, "u");
  check("6.1 enabled false com credencial → disabled", s3.state === "disabled" && s3.hasCredentials === true);

  // 7. Isolamento: B intacto.
  check("7.1 B segue not_configured", FI.status(B).state === "not_configured");

  // 8. Audit.
  const audit = db.prepare(`SELECT COUNT(*) n FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'FISCAL_ISSUANCE_CONFIGURED'`).get(A) as any;
  check("8.1 audit FISCAL_ISSUANCE_CONFIGURED gravado", Number(audit?.n) >= 1);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} fiscal-issuance-scaffold: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
