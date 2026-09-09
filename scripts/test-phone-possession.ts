/**
 * TEST — F3.2 (RF-04 §10): prova de posse do telefone.
 *
 * Prova, offline (tmp db), que PhonePossessionService:
 *  - startVerification gera+entrega código (injetável), guarda só o hash, NÃO
 *    devolve o código; confirm com o código certo verifica (confidence high).
 *  - código errado incrementa tentativa e barra; expira; cap de 5 tentativas.
 *  - verificar número NOVO do usuário REVOGA o vínculo anterior dele.
 *  - verificar o MESMO número por OUTRO usuário revoga o vínculo do primeiro.
 *  - verifiedBinding devolve o dono verificado; NÃO escreve users.phone.
 *  - revoke explícito; isolamento entre orgs; entrada inválida.
 *
 * Uso: npm run test:phone-possession
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-phone-poss-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-phone-poss-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { PhonePossessionService: P } = await import("../src/server/PhonePossessionService.js");

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'T', 'active')`).run(randomUUID(), id);
  const mkUser = (org: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'U', ?, 'agent', 'active')`).run(id, org, `${id}@t.com`);
    return id;
  };

  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B);
  const u1 = mkUser(A); const u2 = mkUser(A); const ub = mkUser(B);

  // Captura de código por entrega injetável (o transporte é do chamador).
  let lastCode = ""; const deliver = (_phone: string, code: string) => { lastCode = code; };

  // ── 1. Fluxo feliz: solicita → confirma ──
  const r1 = await P.startVerification(A, u1, "(11) 98765-4321", { deliver });
  check("1.1 requested", r1.requested === true && !!r1.bindingId);
  check("1.2 código foi entregue (6 dígitos)", /^\d{6}$/.test(lastCode));
  check("1.3 startVerification NÃO devolve o código", !("code" in (r1 as any)));
  const conf = P.confirm(A, u1, "5511987654321", lastCode); // outro formato do mesmo número
  check("1.4 verificado", conf.verified === true);
  const vb = P.verifiedBinding(A, "11987654321");
  check("1.5 verifiedBinding → dono u1, confiança high", vb?.userId === u1 && vb?.confidence === "high");

  // 1.6 NÃO escreve users.phone (telefone é endereço do canal, não o usuário)
  const uRow = db.prepare(`SELECT phone FROM users WHERE id = ?`).get(u1) as any;
  check("1.6 users.phone intocado", uRow.phone == null);

  // ── 2. Código errado / expirado / cap ──
  lastCode = ""; await P.startVerification(A, u1, "1133334444", { deliver });
  let threw = false; try { P.confirm(A, u1, "1133334444", "000000"); } catch { threw = true; }
  check("2.1 código errado barra", threw === true && lastCode !== "000000");
  // expirado: now no futuro além do TTL (10min)
  let exp = false; try { P.confirm(A, u1, "1133334444", lastCode, { now: new Date(Date.now() + 11 * 60_000) }); } catch (e: any) { exp = /expirado/i.test(e.message); }
  check("2.2 código expirado barra", exp === true);
  // cap: 5 tentativas erradas → trava
  await P.startVerification(A, u1, "1133334444", { deliver });
  for (let i = 0; i < 5; i++) { try { P.confirm(A, u1, "1133334444", "111111"); } catch { /* conta */ } }
  let capped = false; try { P.confirm(A, u1, "1133334444", lastCode); } catch (e: any) { capped = /tentativas/i.test(e.message); }
  check("2.3 cap de 5 tentativas trava", capped === true);

  // ── 3. Reverificação: número NOVO do MESMO usuário revoga o anterior ──
  lastCode = ""; await P.startVerification(A, u1, "21999990000", { deliver });
  P.confirm(A, u1, "21999990000", lastCode);
  const list1 = P.list(A, u1);
  const verifiedForU1 = list1.filter((x) => x.status === "verified");
  check("3.1 só 1 vínculo verificado do usuário (anterior revogado)", verifiedForU1.length === 1);
  check("3.2 o verificado é o número novo", verifiedForU1[0].phone.includes("21999990000") || P.verifiedBinding(A, "21999990000")?.userId === u1);
  check("3.3 número antigo não resolve mais", P.verifiedBinding(A, "11987654321") === null);

  // ── 4. MESMO número verificado por OUTRO usuário revoga o do primeiro ──
  lastCode = ""; await P.startVerification(A, u2, "21999990000", { deliver });
  P.confirm(A, u2, "21999990000", lastCode);
  const owner = P.verifiedBinding(A, "21999990000");
  check("4.1 número agora pertence a u2", owner?.userId === u2);
  const u1Verified = P.list(A, u1).filter((x) => x.status === "verified");
  check("4.2 u1 não tem mais vínculo verificado desse número", u1Verified.every((x) => !x.phone.includes("21999990000")));

  // ── 5. revoke explícito (usa u1 p/ não revogar o 21999990000 de u2 — que a
  //       reverificação por usuário revogaria; ver regra "1 número/usuário") ──
  lastCode = ""; const r5 = await P.startVerification(A, u1, "1140001111", { deliver });
  P.confirm(A, u1, "1140001111", lastCode);
  P.revoke(A, u1, r5.bindingId);
  check("5.1 após revoke, número não resolve", P.verifiedBinding(A, "1140001111") === null);

  // ── 6. Isolamento entre orgs ──
  check("6.1 org B não vê vínculo de A", P.verifiedBinding(B, "21999990000") === null);
  lastCode = ""; await P.startVerification(B, ub, "21999990000", { deliver });
  P.confirm(B, ub, "21999990000", lastCode);
  check("6.2 verificar em B não mexe no dono de A", P.verifiedBinding(A, "21999990000")?.userId === u2 && P.verifiedBinding(B, "21999990000")?.userId === ub);

  // ── 7. Entrada inválida ──
  let badPhone = false; try { await P.startVerification(A, u1, "123", { deliver }); } catch { badPhone = true; }
  check("7.1 telefone curto rejeitado", badPhone === true);
  let noDeliver = false; try { await P.startVerification(A, u1, "11988887777", {} as any); } catch { noDeliver = true; }
  check("7.2 sem transporte de entrega rejeitado", noDeliver === true);
  let noPending = false; try { P.confirm(A, u1, "11955554444", "123456"); } catch { noPending = true; }
  check("7.3 confirm sem verificação pendente barra", noPending === true);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} phone-possession: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
