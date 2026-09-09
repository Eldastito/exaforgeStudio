/**
 * TEST — F3.1b (RF-04 §10): resolução comum de identidade do remetente.
 *
 * Prova, offline (tmp db), que SenderIdentityService.resolve concilia
 * `users.phone` × `authorized_managers` SEM elevar privilégio:
 *  - match exato de users.phone → identidade + papel REAL, confiança high/exact.
 *  - match tolerante (9º dígito) → confiança medium/tolerant.
 *  - só authorized_managers (sem users) → legacyManagerOnly, role NULL (não vira admin).
 *  - users + manager → identidade do usuário vence; role do usuário; manager sinalizado.
 *  - 2+ usuários casam o mesmo número → ambíguo/pendente (não escolhe).
 *  - desconhecido/vazio → none.
 *  - isolamento entre orgs.
 *
 * Uso: npm run test:sender-identity
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sender-id-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-sender-id-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { SenderIdentityService } = await import("../src/server/SenderIdentityService.js");

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'T', 'active')`).run(randomUUID(), id);
  const mkUser = (org: string, phone: string, role: string, rpId: string | null = null) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role, role_profile_id, global_status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`)
      .run(id, org, `U-${role}`, `${id}@t.com`, phone, role, rpId);
    return id;
  };
  const mkManager = (org: string, identifier: string) =>
    db.prepare(`INSERT INTO authorized_managers (id, organization_id, identifier, name) VALUES (?, ?, ?, 'Mgr')`).run(randomUUID(), org, identifier);

  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B);

  // ── 1. Match EXATO de users.phone → identidade + papel real ──
  mkUser(A, "5511987654321", "owner");
  const r1 = SenderIdentityService.resolve(A, "5511987654321");
  check("1.1 usuário resolvido", !!r1.user);
  check("1.2 papel real do usuário (owner)", r1.role === "owner");
  check("1.3 confiança high", r1.confidence === "high");
  check("1.4 matchType exact", r1.matchType === "exact");
  check("1.5 não é manager legado", r1.legacyManagerOnly === false);
  check("1.6 não ambíguo", r1.ambiguous === false);

  // ── 2. Match TOLERANTE (número chega sem DDI e sem 9º dígito) ──
  const r2 = SenderIdentityService.resolve(A, "1187654321");
  check("2.1 usuário resolvido pelo match tolerante", !!r2.user);
  check("2.2 confiança medium", r2.confidence === "medium");
  check("2.3 matchType tolerant", r2.matchType === "tolerant");

  // ── 3. Só authorized_managers (SEM users.phone) → legado, SEM papel ──
  mkManager(A, "5511900000001");
  const r3 = SenderIdentityService.resolve(A, "5511900000001");
  check("3.1 é authorized manager", r3.isAuthorizedManager === true);
  check("3.2 legacyManagerOnly", r3.legacyManagerOnly === true);
  check("3.3 NÃO eleva privilégio: role null", r3.role === null);
  check("3.4 sem usuário casado", r3.user === null);
  check("3.5 confiança do vínculo (exact→high)", r3.confidence === "high");

  // ── 4. Usuário + manager no MESMO número → identidade do usuário vence ──
  const rpGer = randomUUID();
  db.prepare(`INSERT INTO role_profiles (id, organization_id, name, system_key, is_system) VALUES (?, ?, 'Gerente', 'gerente', 1)`).run(rpGer, A);
  mkUser(A, "5511922223333", "agent", rpGer);
  mkManager(A, "5511922223333");
  const r4 = SenderIdentityService.resolve(A, "5511922223333");
  check("4.1 usuário resolvido", !!r4.user);
  check("4.2 papel = do usuário (agent), não elevado a admin", r4.role === "agent");
  check("4.3 roleProfileId preservado", r4.roleProfileId === rpGer);
  check("4.4 também sinaliza manager", r4.isAuthorizedManager === true);
  check("4.5 não é 'só legado' (há usuário)", r4.legacyManagerOnly === false);

  // ── 5. AMBÍGUO: 2 usuários casam o mesmo número → pendente, não escolhe ──
  mkUser(A, "5521988887777", "admin");
  mkUser(A, "5521988887777", "agent"); // mesmo número, outro perfil
  const r5 = SenderIdentityService.resolve(A, "5521988887777");
  check("5.1 ambíguo", r5.ambiguous === true);
  check("5.2 NÃO escolhe usuário", r5.user === null);
  check("5.3 NÃO atribui papel no ambíguo", r5.role === null);
  check("5.4 matchType ambiguous", r5.matchType === "ambiguous");

  // ── 6. Desconhecido / vazio → none ──
  const rN = SenderIdentityService.resolve(A, "5511000000000");
  check("6.1 desconhecido: sem usuário/manager", rN.user === null && rN.isAuthorizedManager === false);
  check("6.2 desconhecido: matchType none", rN.matchType === "none");
  check("6.3 vazio → none", SenderIdentityService.resolve(A, "").matchType === "none");
  check("6.4 sem org → none", SenderIdentityService.resolve("", "5511987654321").matchType === "none");

  // ── 7. Isolamento: número do owner de A não resolve em B ──
  const rIso = SenderIdentityService.resolve(B, "5511987654321");
  check("7.1 org B não resolve usuário de A", rIso.user === null);
  check("7.2 org B não vê manager de A", rIso.isAuthorizedManager === false);
  // manager de A no MESMO número não vaza pra B nem como legado.
  const rIso2 = SenderIdentityService.resolve(B, "5511900000001");
  check("7.3 org B não vê manager legado de A", rIso2.isAuthorizedManager === false && rIso2.legacyManagerOnly === false);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} sender-identity: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
