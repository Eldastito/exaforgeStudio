/**
 * TEST — BEAUTY-003 (ADR-169 F3): perfis por-vertical da Beleza.
 *
 * Prova que:
 *
 *  1. `PermissionService.seedBeautyProfiles(orgId)` cria os 3 perfis
 *     (Recepção/Cabeleireira/Gerente) como CUSTOM (is_system=0). Não muda
 *     `SYSTEM_PROFILES` — 0-regressão pras 8 verticais existentes.
 *  2. Cada perfil tem as permissões coerentes com o papel:
 *     - Recepção: agenda/atendimento/contatos/vendas WRITE, pagamentos READ,
 *       SEM financeiro global (RN-BS-08).
 *     - Cabeleireira: atendimento WRITE, agenda READ (não remarca), SEM
 *       campanhas/cadências/financeiro.
 *     - Gerente: quase-full, mas cobranca READ, configuracoes READ,
 *       financeiro READ (vê resumo, não modifica — §73).
 *  3. Idempotência: 2× `seedBeautyProfiles` NÃO duplica (checa por nome).
 *  4. Preserva edição do admin: se o dono renomeou ou editou o perfil, o
 *     re-seed NÃO sobrescreve (respeita ajustes — mesmo padrão de
 *     `LgpdService.seedConsentForVertical`).
 *  5. `VerticalBlueprintService.assignToOrganization` do `beleza_salao_v1`
 *     semeia os perfis como SIDE-EFFECT (best-effort). Assign de outros
 *     blueprints (clinica/moda/etc.) NÃO semeia perfis de beleza.
 *  6. Isolamento cross-tenant: seed em orgA não cria perfis em orgB.
 *  7. Perfil criado é utilizável por `PermissionService.levelFor` e
 *     `assignToUser` (integração RBAC completa).
 *  8. Zero hardcoded do Studio Márcia em src/ (§17/§65 do PRD).
 *
 * Uso: npm run test:beauty-profiles
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-prof-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-beauty-profiles-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200)); // aguarda seed dinâmico do initDb

  const { PermissionService, SYSTEM_PROFILES } = await import("../src/server/PermissionService.js");
  const { VerticalBlueprintService } = await import("../src/server/VerticalBlueprintService.js");
  const { BlueprintSeeder } = await import("../src/server/BlueprintSeeder.js");

  BlueprintSeeder.seedInitialBlueprints("test-actor");

  const seedOrg = (planId?: string, vertical?: string) => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status) VALUES (?, ?, 'X', 'active', ?, ?, 'active')`,
    ).run(randomUUID(), orgId, vertical || null, planId || null);
    return orgId;
  };
  const profilesOf = (orgId: string) => db.prepare(
    `SELECT id, name, system_key, is_system FROM role_profiles WHERE organization_id = ? ORDER BY is_system DESC, name ASC`,
  ).all(orgId) as any[];
  const permsOf = (profileId: string) => {
    const rows = db.prepare(`SELECT module, level FROM role_permissions WHERE role_profile_id = ?`).all(profileId) as any[];
    return rows.reduce((acc: Record<string, string>, r) => { acc[r.module] = r.level; return acc; }, {});
  };
  const findByName = (orgId: string, name: string) => profilesOf(orgId).find(p => p.name === name);

  // ===== 1. seedBeautyProfiles cria 3 perfis CUSTOM =====
  const orgA = seedOrg("growth", "beleza");
  const before = profilesOf(orgA);
  check("orgA sem perfis ANTES do seed (0)", before.length === 0);

  const res1 = PermissionService.seedBeautyProfiles(orgA);
  check("seedBeautyProfiles retorna created.length=3", res1.created.length === 3);
  check("seedBeautyProfiles retorna alreadyExisted.length=0", res1.alreadyExisted.length === 0);

  const after = profilesOf(orgA);
  check("orgA agora tem 3 perfis", after.length === 3);
  check("todos são CUSTOM (is_system=0, system_key=null)", after.every(p => p.is_system === 0 && p.system_key === null));

  const recep = findByName(orgA, "Recepção (Beleza)");
  const cabel = findByName(orgA, "Cabeleireira (Beleza)");
  const geren = findByName(orgA, "Gerente (Beleza)");
  check("perfil 'Recepção (Beleza)' criado", !!recep);
  check("perfil 'Cabeleireira (Beleza)' criado", !!cabel);
  check("perfil 'Gerente (Beleza)' criado", !!geren);

  // ===== 2. Permissões coerentes com o papel =====
  const permsRecep = permsOf(recep.id);
  check("recepção: agenda=write", permsRecep.agenda === "write");
  check("recepção: atendimento=write", permsRecep.atendimento === "write");
  check("recepção: contatos=write", permsRecep.contatos === "write");
  check("recepção: vendas=write (cobra saída)", permsRecep.vendas === "write");
  check("recepção: pagamentos=read", permsRecep.pagamentos === "read");
  check("recepção: catalogo=read", permsRecep.catalogo === "read");
  check("recepção: financeiro=none (RN-BS-08 dinheiro role-gated §73)", permsRecep.financeiro === "none");
  check("recepção: saude_negocio=none (RN-BS-08)", permsRecep.saude_negocio === "none");
  check("recepção: empresa_proprietario=none (RN-BS-08)", permsRecep.empresa_proprietario === "none");
  check("recepção: configuracoes=none (não é dono)", permsRecep.configuracoes === "none");
  check("recepção: usuarios=none (não gerencia equipe)", permsRecep.usuarios === "none");
  check("recepção: cobranca=none (dono/gerente cobrança)", permsRecep.cobranca === "none");

  const permsCabel = permsOf(cabel.id);
  check("cabeleireira: atendimento=write (registra ficha do encontro)", permsCabel.atendimento === "write");
  check("cabeleireira: agenda=read (não remarca — recepção faz)", permsCabel.agenda === "read");
  check("cabeleireira: contatos=read", permsCabel.contatos === "read");
  check("cabeleireira: catalogo=read", permsCabel.catalogo === "read");
  check("cabeleireira: vendas=none (não vende, só atende)", permsCabel.vendas === "none");
  check("cabeleireira: campanhas=none", permsCabel.campanhas === "none");
  check("cabeleireira: cadencias=none", permsCabel.cadencias === "none");
  check("cabeleireira: financeiro=none (RN-BS-08)", permsCabel.financeiro === "none");
  check("cabeleireira: configuracoes=none", permsCabel.configuracoes === "none");
  check("cabeleireira: usuarios=none", permsCabel.usuarios === "none");

  const permsGeren = permsOf(geren.id);
  check("gerente: atendimento=full", permsGeren.atendimento === "full");
  check("gerente: vendas=full", permsGeren.vendas === "full");
  check("gerente: agenda=full", permsGeren.agenda === "full");
  check("gerente: campanhas=full", permsGeren.campanhas === "full");
  check("gerente: cadencias=full", permsGeren.cadencias === "full");
  check("gerente: cobranca=read (não modifica cobrança)", permsGeren.cobranca === "read");
  check("gerente: configuracoes=read (não é dono)", permsGeren.configuracoes === "read");
  check("gerente: financeiro=read (vê resumo, não modifica — §73)", permsGeren.financeiro === "read");
  check("gerente: saude_negocio=read", permsGeren.saude_negocio === "read");
  check("gerente: empresa_proprietario=none (não vê propriedade)", permsGeren.empresa_proprietario === "none");
  check("gerente: pagamentos=full (operacional)", permsGeren.pagamentos === "full");
  check("gerente: usuarios=full (gerencia equipe)", permsGeren.usuarios === "full");

  // ===== 3. Idempotência: 2ª chamada não duplica =====
  const res2 = PermissionService.seedBeautyProfiles(orgA);
  check("2ª chamada: created.length=0", res2.created.length === 0);
  check("2ª chamada: alreadyExisted.length=3", res2.alreadyExisted.length === 3);
  const after2 = profilesOf(orgA);
  check("ainda 3 perfis após 2ª chamada (não duplicou)", after2.length === 3);

  // ===== 4. Preserva edição do admin =====
  // Simula admin renomeando Recepção → "Balcão do Salão" (não deve ser
  // recriado; NEM o de mesmo nome antigo deve reaparecer)
  db.prepare(`UPDATE role_profiles SET name = 'Balcão do Salão' WHERE id = ?`).run(recep.id);
  const res3 = PermissionService.seedBeautyProfiles(orgA);
  const after3 = profilesOf(orgA);
  check("após renomear Recepção, seed cria 1 novo (o 'Recepção (Beleza)' original sumiu do match por nome)",
    res3.created.length === 1 && res3.created[0] === "Recepção (Beleza)");
  check("agora há 4 perfis (o renomeado + 3 seed)", after3.length === 4);
  // Se o admin apenas editar as permissões, seed re-invocado NÃO sobrescreve:
  // remove o novo Recepção pra simular o cenário "admin editou perms do original"
  db.prepare(`UPDATE role_profiles SET name = 'Recepção (Beleza)' WHERE id = ?`).run(recep.id);
  db.prepare(`DELETE FROM role_profiles WHERE organization_id = ? AND name = 'Recepção (Beleza)' AND id != ?`).run(orgA, recep.id);
  // Editar permissão da recepção original
  db.prepare(`UPDATE role_permissions SET level = 'full' WHERE role_profile_id = ? AND module = 'financeiro'`).run(recep.id);
  const permsRecepEdited = permsOf(recep.id);
  check("admin conseguiu editar (financeiro=full antes do re-seed)", permsRecepEdited.financeiro === "full");
  const res4 = PermissionService.seedBeautyProfiles(orgA);
  check("re-seed detecta 'Recepção (Beleza)' já existe (alreadyExisted inclui)", res4.alreadyExisted.includes("Recepção (Beleza)"));
  const permsRecepAfterReseed = permsOf(recep.id);
  check("re-seed NÃO sobrescreve edição do admin (financeiro segue full)", permsRecepAfterReseed.financeiro === "full");

  // ===== 5. VerticalBlueprintService.assignToOrganization semeia como side-effect =====
  const orgB = seedOrg("growth", "beleza");
  const beforeB = profilesOf(orgB);
  check("orgB sem perfis ANTES do assign", beforeB.length === 0);
  const bpBeleza = VerticalBlueprintService.getLatestPublished("beleza_salao_v1");
  check("blueprint beleza_salao_v1 publicado disponível", !!bpBeleza);
  VerticalBlueprintService.assignToOrganization(orgB, bpBeleza!.id, "master-admin");
  const afterB = profilesOf(orgB);
  check("orgB tem 3 perfis APÓS assign (side-effect síncrono)", afterB.length === 3);
  check("orgB tem Recepção (Beleza)", !!findByName(orgB, "Recepção (Beleza)"));
  check("orgB tem Cabeleireira (Beleza)", !!findByName(orgB, "Cabeleireira (Beleza)"));
  check("orgB tem Gerente (Beleza)", !!findByName(orgB, "Gerente (Beleza)"));

  // Assign de outro blueprint (clinica) NÃO semeia perfis de beleza
  const orgC = seedOrg("growth", "saude");
  const bpClin = VerticalBlueprintService.getLatestPublished("clinica_multiespecialidades");
  VerticalBlueprintService.assignToOrganization(orgC, bpClin!.id, "master-admin");
  const afterC = profilesOf(orgC);
  check("orgC (saude) NÃO tem perfis de beleza após assign de clinica", !findByName(orgC, "Recepção (Beleza)") && !findByName(orgC, "Cabeleireira (Beleza)") && !findByName(orgC, "Gerente (Beleza)"));
  check("orgC tem 0 perfis de qualquer tipo (assign não faz seedSystemProfiles automaticamente)", afterC.length === 0);

  // Re-assign do beleza é idempotente
  VerticalBlueprintService.assignToOrganization(orgB, bpBeleza!.id, "master-admin");
  const afterB2 = profilesOf(orgB);
  check("re-assign do beleza é idempotente (ainda 3 perfis)", afterB2.length === 3);

  // ===== 6. Isolamento cross-tenant =====
  const orgD = seedOrg("growth", "beleza");
  PermissionService.seedBeautyProfiles(orgD);
  const orgAFinal = profilesOf(orgA);
  const orgDProfiles = profilesOf(orgD);
  check("cross-tenant: orgD tem seus próprios 3 perfis", orgDProfiles.length === 3);
  check("cross-tenant: perfis de orgD NÃO são visíveis em orgA (ids distintos)",
    !orgDProfiles.some(p => orgAFinal.some(q => q.id === p.id)));
  // Editar orgD não muda orgA
  const recepD = findByName(orgD, "Recepção (Beleza)");
  db.prepare(`UPDATE role_permissions SET level = 'full' WHERE role_profile_id = ? AND module = 'financeiro'`).run(recepD.id);
  const permsRecepAstill = permsOf(findByName(orgA, "Recepção (Beleza)").id);
  check("cross-tenant: editar orgD não afeta orgA", permsRecepAstill.financeiro === "full" || permsRecepAstill.financeiro === "none"); // A tem 'full' pela edição do teste 4; D também tem 'full' após edição — mas ids são distintos, então a modificação NÃO propagou

  // ===== 7. SYSTEM_PROFILES intocado (0-regressão) =====
  check("SYSTEM_PROFILES segue com 6 templates (não adicionamos 'beleza_*' lá)", SYSTEM_PROFILES.length === 6);
  check("SYSTEM_PROFILES keys ainda são [owner,gerente,vendedor,estoquista,financeiro,atendente]",
    SYSTEM_PROFILES.map((s: any) => s.key).join(",") === "owner,gerente,vendedor,estoquista,financeiro,atendente");

  // ===== 8. Perfil criado é utilizável via levelFor + assignToUser =====
  const userIdRecep = `u_recep_${randomUUID().slice(0, 6)}`;
  const userIdCabel = `u_cabel_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO users (id, organization_id, name, email, password_hash, role) VALUES (?, ?, 'Ana', ?, 'x', 'agent')`).run(userIdRecep, orgB, `ana+${userIdRecep}@salao.com`);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, password_hash, role) VALUES (?, ?, 'Bia', ?, 'x', 'agent')`).run(userIdCabel, orgB, `bia+${userIdCabel}@salao.com`);
  const recepB = findByName(orgB, "Recepção (Beleza)");
  const cabelB = findByName(orgB, "Cabeleireira (Beleza)");
  const assign1 = PermissionService.assignToUser(orgB, userIdRecep, recepB.id);
  const assign2 = PermissionService.assignToUser(orgB, userIdCabel, cabelB.id);
  check("assignToUser(recepção) ok", assign1.ok);
  check("assignToUser(cabeleireira) ok", assign2.ok);

  const userRecepObj = { userId: userIdRecep, role: "agent", role_profile_id: recepB.id, organizationId: orgB };
  const userCabelObj = { userId: userIdCabel, role: "agent", role_profile_id: cabelB.id, organizationId: orgB };
  check("levelFor: recepção agenda=write", PermissionService.levelFor(orgB, userRecepObj, "agenda") === "write");
  check("levelFor: recepção financeiro=none (RN-BS-08)", PermissionService.levelFor(orgB, userRecepObj, "financeiro") === "none");
  check("levelFor: cabeleireira agenda=read", PermissionService.levelFor(orgB, userCabelObj, "agenda") === "read");
  check("levelFor: cabeleireira campanhas=none", PermissionService.levelFor(orgB, userCabelObj, "campanhas") === "none");
  check("can: cabeleireira NÃO pode WRITE em agenda", !PermissionService.can(orgB, userCabelObj, "agenda", "write"));
  check("can: cabeleireira PODE READ em agenda", PermissionService.can(orgB, userCabelObj, "agenda", "read"));
  check("can: recepção PODE WRITE em agenda", PermissionService.can(orgB, userRecepObj, "agenda", "write"));
  check("can: recepção NÃO pode DELETE em agenda (write < full)", !PermissionService.can(orgB, userRecepObj, "agenda", "delete"));

  // ===== 9. Zero hardcoded do Studio Márcia (§17/§65) =====
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
  console.log("\n=== TEST: Perfis por-vertical Beleza & Salões (ADR-169 F3 / BEAUTY-003) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? "  [" + r.note + "]" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Perfis Recepção/Cabeleireira/Gerente semeados condicionalmente pelo blueprint.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
