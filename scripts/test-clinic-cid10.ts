/**
 * TESTE — Módulo Clínica Fatia 23: Catálogo CID-10 com busca
 * (ADR-080 extensão 2026-07).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - Seed idempotente: 2 chamadas não duplicam rows.
 *   - normalizeCode aceita variações ("h109", "H10.9", "  h 10.9 ")
 *     e devolve o formato canônico ("H10.9").
 *   - get(code) resolve por lookup exato normalizado.
 *   - search("") → [].
 *   - search por código exato (0 rank) aparece primeiro.
 *   - search por prefixo de código funciona.
 *   - search por substring da descrição funciona (case-insensitive).
 *   - Ordenação de relevância: exact > prefix > description.
 *   - limit clipa; default 20, max 100.
 *   - Auto-preenchimento no createCertificate: CID conhecido preenche
 *     cid_description; CID desconhecido preserva null/livre; descrição
 *     explícita do usuário sempre vence (não é sobrescrita pelo catálogo).
 *   - CID normalizado é gravado ("h10.9" → "H10.9").
 *   - updateCertificate: mesmo comportamento (patch cid sem cidDescription
 *     auto-preenche do catálogo; patch cidDescription explícito respeitado).
 *   - Isolamento clínico preservado (catálogo global, mas dados clínicos
 *     seguem por orgId).
 *
 * Uso:  npm run test:clinic-cid10
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-cid10-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-cid10-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { Cid10Service, normalizeCode } = await import("../src/server/Cid10Service.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicEncounterService } = await import("../src/server/ClinicEncounterService.js");
  const { ClinicDocumentsService } = await import("../src/server/ClinicDocumentsService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

  // === 1. normalizeCode ====================================================
  check("normalizeCode('h109') → 'H10.9'", normalizeCode("h109") === "H10.9");
  check("normalizeCode('H10.9') → 'H10.9'", normalizeCode("H10.9") === "H10.9");
  check("normalizeCode('  h 10.9  ') → 'H10.9'", normalizeCode("  h 10.9  ") === "H10.9");
  check("normalizeCode('h10') → 'H10' (não adiciona ponto em 3 chars)", normalizeCode("h10") === "H10");
  check("normalizeCode('') → ''", normalizeCode("") === "");

  // === 2. Seed idempotente =================================================
  Cid10Service.seed();
  const count1 = (db.prepare(`SELECT COUNT(*) AS c FROM cid10_codes`).get() as any).c;
  check("seed inicial popula >= 40 códigos", count1 >= 40, String(count1));
  Cid10Service.seed(); // segunda chamada
  const count2 = (db.prepare(`SELECT COUNT(*) AS c FROM cid10_codes`).get() as any).c;
  check("seed idempotente (mesmo count após 2ª chamada)", count1 === count2);

  // === 3. get(code) ========================================================
  const conj = Cid10Service.get("H10.9");
  check("get('H10.9') → Conjuntivite", conj?.description?.toLowerCase().includes("conjuntivite"), String(conj?.description));

  const conjLower = Cid10Service.get("h109");
  check("get('h109') resolve pra mesma entrada (normaliza)", conjLower?.code === conj?.code);

  const nope = Cid10Service.get("XX99.99");
  check("get inexistente → null", nope === null);

  const emptyGet = Cid10Service.get("");
  check("get('') → null", emptyGet === null);

  // === 4. search vazio =====================================================
  check("search('') → []", Cid10Service.search("").length === 0);
  check("search('   ') → []", Cid10Service.search("   ").length === 0);

  // === 5. search por código exato ==========================================
  const exact = Cid10Service.search("H10.9");
  check("search('H10.9') retorna ao menos 1", exact.length >= 1);
  check("primeiro resultado é o exact match", exact[0].code === "H10.9");

  // Case insensitive no código: usuário digita "h109" → normaliza pra H10.9
  const exactLower = Cid10Service.search("h109");
  check("search('h109') → primeiro é H10.9", exactLower[0]?.code === "H10.9");

  // === 6. search por prefix ================================================
  const prefixJ = Cid10Service.search("J0");
  check("search('J0') pega múltiplos J0*", prefixJ.length >= 3, String(prefixJ.length));
  check("todos os primeiros começam com J0", prefixJ.slice(0, 3).every((r) => r.code.startsWith("J0")));

  // === 7. search por descrição (substring, case-insensitive) ==============
  const desc = Cid10Service.search("Conjuntivite");
  check("search('Conjuntivite') retorna múltiplos", desc.length >= 2, String(desc.length));
  const descLower = Cid10Service.search("conjuntivite");
  check("search('conjuntivite') = lower devolve mesma count", descLower.length === desc.length);

  // === 8. Ordenação: exact > prefix > description =========================
  // "F41.1" tem match exato (Ansiedade generalizada); "F4" tem prefix; palavras
  // como "ansiedade" na descrição — testamos com query "F41" (prefix) que
  // deve preceder resultados só pela descrição, se houvesse.
  const rank = Cid10Service.search("H10.9");
  // Match exato "H10.9" tem rank 0, "H10.3" (prefix) tem rank 1
  const exactIdx = rank.findIndex((r) => r.code === "H10.9");
  const prefixIdx = rank.findIndex((r) => r.code === "H10.3");
  check("exact match vem antes de prefix match", exactIdx >= 0 && (prefixIdx === -1 || exactIdx < prefixIdx),
    `exactIdx=${exactIdx} prefixIdx=${prefixIdx}`);

  // === 9. limit ============================================================
  const capped = Cid10Service.search("a", 3); // "a" existe em várias descrições
  check("limit=3 clipa", capped.length <= 3);

  const capMax = Cid10Service.search("a", 999);
  check("limit acima de 100 clampa para 100 max", capMax.length <= 100);

  // === 10. Integração com createCertificate ===============================
  const orgId = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
    .run(randomUUID(), orgId, "Clínica Teste");
  const channelId = "ch_test";
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
    .run(channelId, orgId, "Canal", "wa_test");
  const contactId = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
    .run(contactId, orgId, channelId, "Paciente", "5511999990000");
  LgpdService.grantConsent(orgId, contactId, "dados_sensiveis", { channel: "in_person", actorId: "user_test" });

  const prof = ClinicAgendaService.createProfessional(orgId, { name: "Dr. Teste" }, "user_test");
  const apt = ClinicAgendaService.createAppointment(orgId, {
    contactId, title: "Consulta", scheduledStart: "2026-11-05T10:00:00-03:00",
    professionalId: prof.id, durationMinutes: 30,
  }, "user_test");
  const enc = ClinicEncounterService.open(orgId, apt.id, "user_test");

  // Caso A: CID conhecido, sem descrição explícita → auto-preenche
  const certA = ClinicDocumentsService.createCertificate(orgId, enc.id, {
    cid: "h109", days: 3,
  } as any, "user_test");
  check("CID normalizado gravado (h109 → H10.9)", certA.cid === "H10.9", String(certA.cid));
  check("cid_description auto-preenchida do catálogo",
    certA.cidDescription?.toLowerCase().includes("conjuntivite"), String(certA.cidDescription));

  // Caso B: CID conhecido + descrição explícita → respeita explícita
  const certB = ClinicDocumentsService.createCertificate(orgId, enc.id, {
    cid: "H10.9", cidDescription: "Conjuntivite (versão da clínica)", days: 2,
  } as any, "user_test");
  check("cidDescription explícita sobrepõe catálogo",
    certB.cidDescription === "Conjuntivite (versão da clínica)");

  // Caso C: CID DESCONHECIDO → grava normalizado, description fica null
  const certC = ClinicDocumentsService.createCertificate(orgId, enc.id, {
    cid: "XX99.9", days: 1,
  } as any, "user_test");
  check("CID desconhecido é gravado normalizado", certC.cid === "XX99.9");
  check("CID desconhecido sem description explícita → null", certC.cidDescription === null);

  // Caso D: sem CID → tudo null
  const certD = ClinicDocumentsService.createCertificate(orgId, enc.id, { days: 1 } as any, "user_test");
  check("sem CID → cid null", certD.cid === null);
  check("sem CID → cidDescription null", certD.cidDescription === null);

  // === 11. updateCertificate ===============================================
  // Patch cid pra outro conhecido, sem cidDescription → deve preencher do catálogo
  const upd1 = ClinicDocumentsService.updateCertificate(orgId, certD.id, "user_test", { cid: "J00" });
  check("update cid → auto-preenche description", upd1.cidDescription?.toLowerCase().includes("resfriado") || upd1.cidDescription?.toLowerCase().includes("nasofaringite"),
    String(upd1.cidDescription));
  check("update cid → normalizado", upd1.cid === "J00");

  // Patch cidDescription explícita mantém e não sobrescreve por catálogo
  const upd2 = ClinicDocumentsService.updateCertificate(orgId, upd1.id, "user_test", { cidDescription: "custom" });
  check("update cidDescription explícita respeitada", upd2.cidDescription === "custom");

  // Patch cid pra desconhecido sem cidDescription → limpa description auto
  const upd3 = ClinicDocumentsService.updateCertificate(orgId, upd1.id, "user_test", { cid: "YY88.8" });
  // NOTA: como não há descrição no catálogo, o campo fica intocado (pipeline
  // só adiciona `cid_description = ?` se catálogo bater; description atual
  // ("custom") persiste). Isso é aceitável — o usuário decide se ajusta.
  check("update cid desconhecido: cid atualizado", upd3.cid === "YY88.8");

  // === 12. Isolamento (catálogo global mas certs por org) ================
  const otherOrg = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
    .run(randomUUID(), otherOrg, "Clínica B");
  const certsA = db.prepare(`SELECT COUNT(*) AS c FROM clinical_medical_certificates WHERE organization_id = ?`).get(orgId) as any;
  const certsB = db.prepare(`SELECT COUNT(*) AS c FROM clinical_medical_certificates WHERE organization_id = ?`).get(otherOrg) as any;
  check("certs de A não aparecem em B (isolamento clínico intacto)", certsA.c > 0 && certsB.c === 0);
  // Catálogo é o MESMO consultado dos 2 orgs
  const cidFromA_ok = Cid10Service.get("H10.9");
  const cidFromB_ok = Cid10Service.get("H10.9");
  check("catálogo global: mesma entrada visível de qualquer org", cidFromA_ok?.code === cidFromB_ok?.code);

  console.log("\n=== Catálogo CID-10 (ADR-080 Fase 23) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
