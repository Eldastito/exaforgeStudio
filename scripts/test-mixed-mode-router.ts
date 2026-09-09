/**
 * TEST — F3.3a (RF-04 §10): roteador do modo misto.
 *
 * Prova, offline (tmp db), a decisão de FAIXA de MixedModeRouterService.route,
 * compondo SenderIdentity (F3.1b) + vínculo verificado (F3.2):
 *  - mensagem própria (fromMe) → skip.
 *  - canal atendimento + desconhecido → attendance (0-regressão).
 *  - canal interno + usuário conhecido → internal (com papel real).
 *  - canal interno + desconhecido → reject_unknown_internal.
 *  - canal interno + identidade ambígua (sem verificado) → ambiguous_identity.
 *  - vínculo VERIFICADO (F3.2) tem precedência: resolve QUEM e desfaz ambiguidade.
 *  - MODO MISTO (interno num canal de atendimento): contexto de cliente →
 *    attendance; contexto interno → internal; sem contexto → ask_which.
 *  - manager legado (sem users) → internal em canal interno, sem elevar papel.
 *  - isolamento entre orgs.
 *
 * Uso: npm run test:mixed-mode-router
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mixed-router-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mixed-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MixedModeRouterService: R } = await import("../src/server/MixedModeRouterService.js");
  const { PhonePossessionService: P } = await import("../src/server/PhonePossessionService.js");

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'T', 'active')`).run(randomUUID(), id);
  const mkUser = (org: string, phone: string | null, role: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role, global_status) VALUES (?, ?, 'U', ?, ?, ?, 'active')`).run(id, org, `${id}@t.com`, phone, role);
    return id;
  };
  const mkManager = (org: string, identifier: string) =>
    db.prepare(`INSERT INTO authorized_managers (id, organization_id, identifier, name) VALUES (?, ?, ?, 'Mgr')`).run(randomUUID(), org, identifier);

  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B);

  // ── 1. Própria / sem remetente → skip ──
  check("1.1 fromMe → skip", R.route(A, "5511999999999", { isFromMe: true }).lane === "skip");
  check("1.2 sem sender → skip", R.route(A, "", {}).lane === "skip");

  // ── 2. Canal de atendimento + desconhecido → attendance (0-regressão) ──
  const d2 = R.route(A, "5511900001111", { channelKind: "client" });
  check("2.1 cliente desconhecido → attendance", d2.lane === "attendance");
  check("2.2 sem userId/role", d2.userId === null && d2.role === null);

  // ── 3. Canal interno + usuário conhecido → internal (com papel real) ──
  const owner = mkUser(A, "5511988887777", "owner");
  const d3 = R.route(A, "5511988887777", { channelKind: "internal" });
  check("3.1 conhecido no interno → internal", d3.lane === "internal");
  check("3.2 userId resolvido", d3.userId === owner);
  check("3.3 papel real (owner)", d3.role === "owner");

  // ── 4. Canal interno + desconhecido → reject ──
  const d4 = R.route(A, "5511900002222", { channelKind: "internal" });
  check("4.1 desconhecido no interno → reject_unknown_internal", d4.lane === "reject_unknown_internal");

  // ── 5. Interno + identidade AMBÍGUA (2 usuários, mesmo número) → ambiguous ──
  mkUser(A, "5521977776666", "admin");
  mkUser(A, "5521977776666", "agent");
  const d5 = R.route(A, "5521977776666", { channelKind: "internal" });
  check("5.1 ambíguo no interno → ambiguous_identity", d5.lane === "ambiguous_identity");
  check("5.2 não escolhe usuário", d5.userId === null);

  // ── 6. Vínculo VERIFICADO (F3.2) tem precedência: desfaz a ambiguidade ──
  // Verifica o número ambíguo para UM usuário específico.
  const uPick = mkUser(A, null, "agent");
  let code = ""; await P.startVerification(A, uPick, "5521977776666", { deliver: (_p, c) => { code = c; } });
  P.confirm(A, uPick, "5521977776666", code);
  const d6 = R.route(A, "5521977776666", { channelKind: "internal" });
  check("6.1 verificado resolve QUEM → internal", d6.lane === "internal");
  check("6.2 userId = o verificado", d6.userId === uPick);
  check("6.3 confiança high", d6.confidence === "high");

  // ── 7. MODO MISTO: interno num canal de ATENDIMENTO ──
  // 7a. contexto de cliente → attendance
  const dm1 = R.route(A, "5511988887777", { channelKind: "client", hasActiveCustomerContext: true });
  check("7.1 misto + contexto cliente → attendance", dm1.lane === "attendance" && dm1.userId === owner);
  // 7b. contexto interno → internal
  const dm2 = R.route(A, "5511988887777", { channelKind: "client", hasActiveInternalContext: true });
  check("7.2 misto + contexto interno → internal", dm2.lane === "internal");
  // 7c. sem contexto claro → ask_which (§10.7; nunca infere por texto)
  const dm3 = R.route(A, "5511988887777", { channelKind: "client" });
  check("7.3 misto sem contexto → ask_which", dm3.lane === "ask_which" && dm3.userId === owner);
  // 7d. ambos contextos → ask_which (ambíguo)
  const dm4 = R.route(A, "5511988887777", { channelKind: "client", hasActiveCustomerContext: true, hasActiveInternalContext: true });
  check("7.4 misto ambos contextos → ask_which", dm4.lane === "ask_which");

  // ── 8. Manager LEGADO (só authorized_managers, sem users) → internal sem papel ──
  mkManager(A, "5511955554444");
  const d8 = R.route(A, "5511955554444", { channelKind: "internal" });
  check("8.1 manager legado no interno → internal", d8.lane === "internal");
  check("8.2 legacyManagerOnly, papel null (não eleva)", d8.legacyManagerOnly === true && d8.role === null);
  // manager legado num canal de atendimento sem contexto → ask_which (tem papel de gestão)
  const d8b = R.route(A, "5511955554444", { channelKind: "client" });
  check("8.3 manager legado no atendimento sem contexto → ask_which", d8b.lane === "ask_which");

  // ── 9. Isolamento: número conhecido de A é desconhecido em B ──
  const d9 = R.route(B, "5511988887777", { channelKind: "internal" });
  check("9.1 org B não reconhece usuário de A → reject", d9.lane === "reject_unknown_internal");
  const d9b = R.route(B, "5511988887777", { channelKind: "client" });
  check("9.2 org B trata como cliente (attendance)", d9b.lane === "attendance");

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mixed-mode-router: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
