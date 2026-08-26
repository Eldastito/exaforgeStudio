/**
 * TEST — Processo / legal_cases (ADR-191 F4). DB-backed, determinístico.
 * Prova a entidade longitudinal do caso (modelada no episódio clínico, tabela própria)
 * + o número CNJ VALIDADO pelo dígito verificador (módulo 97) — nunca inventado.
 *
 * Cobre: CNJ válido normaliza / DV errado rejeita / 20 dígitos exigidos / ausente=null ·
 * abrir processo (cliente/área/advogado validados) · unicidade do CNJ na org · listar
 * por cliente/advogado/status · transferir advogado · fase · encerrar/reabrir (histórico
 * preservado) · isolamento.
 *
 * Uso: npm run test:legal-case
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-legalcase-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-legalcase-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// Gera um número CNJ VÁLIDO computando o DV correto (mesmo algoritmo do serviço —
// prova a auto-consistência sem depender de vetor externo que poderia estar errado).
function makeValidCnj(seq: string, ano: string, seg: string, trib: string, orig: string): string {
  const dv = (98n - (BigInt(seq + ano + seg + trib + orig + "00") % 97n)).toString().padStart(2, "0");
  return `${seq}-${dv}.${ano}.${seg}.${trib}.${orig}`;
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { LegalCaseService: C } = await import("../src/server/LegalCaseService.js");
  const { LegalPracticeService: L } = await import("../src/server/LegalPracticeService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Silva Advogados', 'active', 'advocacia')`).run(randomUUID(), A);
  const clientId = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Cliente Ltda', ?)`).run(clientId, A, "5511999" + Math.floor(Math.random() * 1e6));
  const area = L.createArea(A, { name: "Cível" }, "u1");
  const lawyer = L.createLawyer(A, { name: "Dra. Ana", oabUf: "SP", oabNumber: "111222" }, "u1");

  // ── 1. Validação do número CNJ (módulo 97) — nunca inventa ──
  const validCnj = makeValidCnj("0000123", "2024", "8", "26", "0100");
  check("1.1 CNJ válido normaliza (formato NNNNNNN-DD.AAAA.J.TR.OOOO)", C.normalizeCnj(validCnj) === validCnj);
  check("1.2 CNJ sem máscara também valida", C.normalizeCnj(validCnj.replace(/\D/g, "")) === validCnj);
  check("1.3 ausente → null (caso consultivo, honesto)", C.normalizeCnj("") === null && C.normalizeCnj(null) === null);
  // DV errado → rejeita
  const wrongDv = validCnj.replace(/-(\d\d)\./, (_m, d) => `-${d === "00" ? "01" : "00"}.`);
  let threwDv = false; try { C.normalizeCnj(wrongDv); } catch { threwDv = true; }
  check("1.4 DV errado rejeitado", threwDv);
  let threwLen = false; try { C.normalizeCnj("123"); } catch { threwLen = true; }
  check("1.5 número com dígitos != 20 rejeitado", threwLen);

  // ── 2. Abrir processo ──
  const cs = C.open(A, { contactId: clientId, practiceAreaId: area.id, responsibleLawyerId: lawyer.id, cnjNumber: validCnj, title: "Ação de cobrança", court: "3ª Vara Cível", comarca: "São Paulo", opposingParty: "Devedor S/A" }, "u1");
  check("2.1 processo aberto (status active)", cs.status === "active" && cs.title === "Ação de cobrança");
  check("2.2 CNJ persistido normalizado", cs.cnj_number === validCnj);
  check("2.3 cliente/área/advogado amarrados", cs.contact_id === clientId && cs.practice_area_id === area.id && cs.responsible_lawyer_id === lawyer.id);

  // cliente inexistente → erro
  let threwClient = false; try { C.open(A, { contactId: "nope", title: "X" }, "u1"); } catch { threwClient = true; }
  check("2.4 cliente inexistente rejeitado", threwClient);

  // ── 3. Unicidade do CNJ na org ──
  let threwDup = false; try { C.open(A, { contactId: clientId, cnjNumber: validCnj, title: "Duplicado" }, "u1"); } catch { threwDup = true; }
  check("3.1 CNJ duplicado na org rejeitado", threwDup);
  // processo SEM CNJ (consultivo) é permitido, mesmo vários
  const consultivo = C.open(A, { contactId: clientId, title: "Parecer tributário", caseType: "consultivo" }, "u1");
  const consultivo2 = C.open(A, { contactId: clientId, title: "Outro parecer", caseType: "consultivo" }, "u1");
  check("3.2 múltiplos casos sem CNJ permitidos (consultivo)", !!consultivo.id && !!consultivo2.id && consultivo.cnj_number === null);

  // ── 4. Listagens ──
  check("4.1 listar por cliente", C.listByClient(A, clientId).length === 3);
  check("4.2 listar por advogado", C.listByLawyer(A, lawyer.id).length === 1);
  check("4.3 listar por status active", C.list(A, { status: "active" }).length === 3);

  // ── 5. Transferir advogado + fase ──
  const lawyer2 = L.createLawyer(A, { name: "Dr. Bruno", oabUf: "SP", oabNumber: "333444" }, "u1");
  const t = C.transfer(A, cs.id, lawyer2.id, "u1");
  check("5.1 advogado responsável reatribuído", t.responsible_lawyer_id === lawyer2.id);
  const ph = C.setPhase(A, cs.id, "recurso", "u1");
  check("5.2 fase atualizada", ph.phase === "recurso");

  // ── 6. Encerrar + reabrir (histórico preservado, nunca DELETE) ──
  const closed = C.close(A, cs.id, "acordo homologado", "u1");
  check("6.1 encerrado (closed + reason + closed_at)", closed.status === "closed" && closed.closed_reason === "acordo homologado" && !!closed.closed_at);
  let threwClose = false; try { C.close(A, cs.id, null, "u1"); } catch { threwClose = true; }
  check("6.2 encerrar 2× rejeitado", threwClose);
  const reopened = C.reopen(A, cs.id, "u1");
  check("6.3 reaberto (active + closed_at limpo, histórico preservado)", reopened.status === "active" && reopened.closed_at === null);

  // ── 7. Isolamento ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Outro', 'active', 'advocacia')`).run(randomUUID(), B);
  check("7.1 org B não vê processos de A", C.list(B).length === 0);
  // mesmo CNJ é permitido em OUTRA org (unicidade é por org)
  const clientB = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Cli B', ?)`).run(clientB, B, "5511888" + Math.floor(Math.random() * 1e6));
  const csB = C.open(B, { contactId: clientB, cnjNumber: validCnj, title: "Mesmo CNJ, outra org" }, "u1");
  check("7.2 mesmo CNJ permitido em outra org (unicidade por org)", csB.cnj_number === validCnj);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} legal-case: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
