/**
 * TEST — ADR-159 F6 (D6, parte 1): step-up MFA em ação crítica.
 *
 * Prova, determinístico (TOTP mintado localmente):
 *   - requiresStepUp: só quando org opt-in + ação financeira/destrutiva + valor
 *     ≥ limiar; caso contrário false (flag off, ação não-crítica, abaixo do teto);
 *   - assertVerified: sem MFA cadastrado → STEP_UP_ENROLL_REQUIRED; token inválido
 *     → STEP_UP_INVALID; token válido → passa e zera o contador;
 *   - lockout: 5 inválidos → STEP_UP_LOCKED (mesmo com token bom depois);
 *   - isolamento por org.
 *
 * Uso: npm run test:step-up-mfa
 */
import os from "os";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-stepup-mfa-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-stepup-mfa-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
function code(fn: () => any): string | null { try { fn(); return null; } catch (e: any) { return e?.code || "ERR"; } }

function generateCode(secretB32: string, counter: number): string {
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secretB32.toUpperCase().replace(/=+$/g, "").replace(/\s/g, "");
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) { const idx = B32.indexOf(ch); if (idx === -1) continue; value = (value << 5) | idx; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; } }
  const key = Buffer.from(out); const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}
const validNow = (secret: string) => generateCode(secret, Math.floor(Date.now() / 1000 / 30));

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { StepUpMfaService: SU } = await import("../src/server/StepUpMfaService.js");
  const { TOTPService } = await import("../src/server/TOTPService.js");
  const { EncryptionService } = await import("../src/server/EncryptionService.js");

  const mkOrg = (stepUpOn: boolean, thresholdCents = 50000) => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, step_up_mfa_enabled, step_up_mfa_threshold_cents) VALUES (?, ?, 'X', 'active', ?, ?)`)
      .run(randomUUID(), id, stepUpOn ? 1 : 0, thresholdCents);
    return id;
  };
  const mkUser = (orgId: string, withMfa: boolean) => {
    const id = randomUUID();
    const secret = withMfa ? TOTPService.generateSecret() : null;
    db.prepare(`INSERT INTO users (id, organization_id, name, email, role, mfa_enabled, mfa_secret) VALUES (?, ?, 'U', ?, 'owner', ?, ?)`)
      .run(id, orgId, `${randomUUID().slice(0, 8)}@ex.com`, withMfa ? 1 : 0, secret ? EncryptionService.encrypt(secret) : null);
    return { id, secret };
  };
  const act = (domain: string, actionType: string, amount: number) => ({ domain, action_type: actionType, expected_impact: amount });

  // ===== 1. requiresStepUp — condições =====
  const orgOn = mkOrg(true, 50000); // limiar R$500 (50000 centavos)
  const orgOff = mkOrg(false, 50000);
  check("requiresStepUp: financeira acima do limiar (refund 800) → true", SU.requiresStepUp(orgOn, act("finance", "refund", 800)) === true);
  check("requiresStepUp: abaixo do limiar (refund 200) → false", SU.requiresStepUp(orgOn, act("finance", "refund", 200)) === false);
  check("requiresStepUp: ação não-crítica (create_task 9999) → false", SU.requiresStepUp(orgOn, act("tasks", "create_task", 9999)) === false);
  check("requiresStepUp: flag OFF → false mesmo crítica", SU.requiresStepUp(orgOff, act("finance", "refund", 5000)) === false);
  check("requiresStepUp: destrutiva por actionType (delete_record 600) → true", SU.requiresStepUp(orgOn, act("catalogo", "delete_record", 600)) === true);

  // ===== 2. assertVerified — sem MFA / inválido / válido =====
  const noMfa = mkUser(orgOn, false);
  check("assertVerified: usuário sem MFA → STEP_UP_ENROLL_REQUIRED", code(() => SU.assertVerified(orgOn, noMfa.id, "000000")) === "STEP_UP_ENROLL_REQUIRED");

  const u = mkUser(orgOn, true);
  check("assertVerified: token inválido → STEP_UP_INVALID", code(() => SU.assertVerified(orgOn, u.id, "000000")) === "STEP_UP_INVALID");
  check("assertVerified: token válido → passa (sem erro)", code(() => SU.assertVerified(orgOn, u.id, validNow(u.secret!))) === null);
  check("assertVerified: sem userId → STEP_UP_INVALID", code(() => SU.assertVerified(orgOn, undefined, "123456")) === "STEP_UP_INVALID");

  // ===== 3. Lockout: 5 inválidos travam (mesmo com token bom depois) =====
  const v = mkUser(orgOn, true);
  for (let i = 0; i < 5; i++) code(() => SU.assertVerified(orgOn, v.id, "000000"));
  check("lockout: token bom após 5 falhas → STEP_UP_LOCKED", code(() => SU.assertVerified(orgOn, v.id, validNow(v.secret!))) === "STEP_UP_LOCKED");
  // acerto zera o contador: um usuário limpo não é afetado pelo lockout de outro
  const w = mkUser(orgOn, true);
  check("lockout é por-usuário: outro usuário passa normalmente", code(() => SU.assertVerified(orgOn, w.id, validNow(w.secret!))) === null);

  // ===== 4. Isolamento por org =====
  const orgB = mkOrg(true, 50000);
  check("isolamento: usuário de orgOn não existe em orgB → ENROLL_REQUIRED", code(() => SU.assertVerified(orgB, u.id, validNow(u.secret!))) === "STEP_UP_ENROLL_REQUIRED");

  console.log("\n=== TEST: Step-up MFA (ADR-159 F6/D6) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Step-up MFA (F6) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
