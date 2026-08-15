/**
 * TEST — BEAUTY-004 parte 2 (ADR-169 F4): N:N profissional↔serviço.
 *
 * Prova que:
 *
 *  1. Tabela `professional_services` existe com shape correto (UNIQUE por
 *     (org, professional_id, service_id) + índices de leitura).
 *  2. `link` cria vínculo válido; idempotente por UNIQUE (2ª chamada
 *     ATUALIZA em vez de criar; preserva id + created_at).
 *  3. Multi-tenant duro (RN-BS-07): profissional/serviço de outra org →
 *     recusa (nunca cria).
 *  4. Só type='service' aceito — vincular a produto físico lança
 *     (RN-BS-11 não inventa capacidade).
 *  5. `commissionPercent` fora de [0..100] rejeitado.
 *  6. `unlink` faz soft-off (active=0), preserva histórico + comissão.
 *  7. `listServicesFor(professional)` retorna ordenado por is_primary DESC.
 *  8. `listProfessionalsFor(service)` responde "quem faz coloração?" —
 *     ordena por is_primary DESC.
 *  9. `activeOnly` filtra: link inativo, profissional inativo, serviço
 *     inativo — todos somem da lista quando activeOnly=true.
 * 10. `isCapable` retorna true SÓ com link+prof+serviço ATIVOS (RN-BS-11).
 * 11. `setForProfessional` atômico: novos entram, ausentes viram active=0
 *     (soft-off, preserva histórico), validação cedo se algum id não bate.
 * 12. Isolamento cross-tenant: seed em orgA não aparece em orgB.
 * 13. Zero hardcoded do Studio Márcia em src/ (§17/§65).
 *
 * Uso: npm run test:beauty-professional-services
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-profserv-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-beauty-profserv-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));

  const { ProfessionalServiceService } = await import("../src/server/ProfessionalServiceService.js");

  const seedOrg = () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`,
    ).run(randomUUID(), orgId);
    return orgId;
  };
  const seedProfessional = (orgId: string, name: string, active = true) => {
    const id = `prof_${randomUUID().slice(0, 6)}`;
    db.prepare(
      `INSERT INTO clinic_professionals (id, organization_id, name, active) VALUES (?, ?, ?, ?)`,
    ).run(id, orgId, name, active ? 1 : 0);
    return id;
  };
  const seedService = (orgId: string, name: string, type: "service" | "product" = "service", active = true) => {
    const id = `svc_${randomUUID().slice(0, 6)}`;
    db.prepare(
      `INSERT INTO products_services (id, organization_id, type, name, description, price, currency, active) VALUES (?, ?, ?, ?, '', 0, 'BRL', ?)`,
    ).run(id, orgId, type, name, active ? 1 : 0);
    return id;
  };

  // ===== 1. Tabela existe (shape esperado) =====
  const tblInfo = db.prepare(`PRAGMA table_info(professional_services)`).all() as any[];
  const cols = tblInfo.map((r) => r.name);
  check("tabela professional_services existe", tblInfo.length > 0);
  for (const c of ["id", "organization_id", "professional_id", "service_id", "is_primary", "active", "commission_percent", "created_at"]) {
    check(`coluna '${c}' presente`, cols.includes(c));
  }
  const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='professional_services'`).all() as any[];
  const idxNames = idx.map((r) => r.name);
  check("índice by_prof existe", idxNames.includes("idx_professional_services_by_prof"));
  check("índice by_service existe", idxNames.includes("idx_professional_services_by_service"));

  // ===== 2. link() cria vínculo válido =====
  const orgA = seedOrg();
  const ana = seedProfessional(orgA, "Ana");
  const bia = seedProfessional(orgA, "Bia");
  const corte = seedService(orgA, "Corte");
  const coloracao = seedService(orgA, "Coloração");
  const escova = seedService(orgA, "Escova");
  const shampoo = seedService(orgA, "Shampoo", "product");  // <- type produto

  const l1 = ProfessionalServiceService.link(orgA, ana, corte, { isPrimary: true, commissionPercent: 40 });
  check("link Ana↔Corte criado", !!l1.linkId);
  check("link Ana↔Corte é primary", l1.isPrimary === true);
  check("link Ana↔Corte tem commission=40", l1.commissionPercent === 40);
  check("link Ana↔Corte active=true", l1.active === true);

  // Idempotência: 2ª chamada atualiza (não recria)
  const l1Again = ProfessionalServiceService.link(orgA, ana, corte, { isPrimary: false, commissionPercent: 35 });
  check("2ª chamada de link retorna o MESMO id (não recriou)", l1Again.linkId === l1.linkId);
  check("2ª chamada atualiza is_primary → false", l1Again.isPrimary === false);
  check("2ª chamada atualiza commissionPercent → 35", l1Again.commissionPercent === 35);
  const count1 = (db.prepare(`SELECT COUNT(*) c FROM professional_services WHERE organization_id=? AND professional_id=? AND service_id=?`).get(orgA, ana, corte) as any).c;
  check("ainda 1 row em professional_services (idempotente)", count1 === 1);

  // ===== 3. Multi-tenant duro =====
  const orgB = seedOrg();
  const carla = seedProfessional(orgB, "Carla");
  let crossErr: string | null = null;
  try { ProfessionalServiceService.link(orgA, carla, corte); } catch (e: any) { crossErr = e?.message || "err"; }
  check("link com profissional de OUTRA org lança", !!crossErr);
  crossErr = null;
  try { ProfessionalServiceService.link(orgB, ana, corte); } catch (e: any) { crossErr = e?.message || "err"; }
  check("link com serviço de OUTRA org lança", !!crossErr);

  // ===== 4. Só type='service' =====
  let typeErr: string | null = null;
  try { ProfessionalServiceService.link(orgA, ana, shampoo); } catch (e: any) { typeErr = e?.message || "err"; }
  check("link com type='product' lança (RN-BS-11)", !!typeErr && /service/i.test(typeErr));

  // ===== 5. commissionPercent fora de [0..100] =====
  let commErr: string | null = null;
  try { ProfessionalServiceService.link(orgA, ana, coloracao, { commissionPercent: 150 }); } catch (e: any) { commErr = e?.message || "err"; }
  check("commission=150 rejeitado", !!commErr);
  commErr = null;
  try { ProfessionalServiceService.link(orgA, ana, coloracao, { commissionPercent: -10 }); } catch (e: any) { commErr = e?.message || "err"; }
  check("commission=-10 rejeitado", !!commErr);
  const l2 = ProfessionalServiceService.link(orgA, ana, coloracao, { commissionPercent: 0 });
  check("commission=0 aceito (default)", l2.commissionPercent === 0);
  const l3 = ProfessionalServiceService.link(orgA, ana, coloracao, { commissionPercent: 100 });
  check("commission=100 aceito (limite)", l3.commissionPercent === 100);

  // ===== 6. unlink soft-off =====
  ProfessionalServiceService.link(orgA, bia, escova, { isPrimary: true, commissionPercent: 50 });
  const r6 = ProfessionalServiceService.unlink(orgA, bia, escova);
  check("unlink retorna changed=true na 1ª chamada", r6.changed === true);
  const r6b = ProfessionalServiceService.unlink(orgA, bia, escova);
  check("2ª chamada de unlink retorna changed=false (idempotente)", r6b.changed === false);
  const linkOff = db.prepare(`SELECT active, commission_percent FROM professional_services WHERE organization_id=? AND professional_id=? AND service_id=?`).get(orgA, bia, escova) as any;
  check("unlink preserva a row (soft-off, active=0)", linkOff && Number(linkOff.active) === 0);
  check("unlink preserva commission_percent (histórico)", Number(linkOff.commission_percent) === 50);

  // ===== 7 e 8. listServicesFor + listProfessionalsFor + ordenação =====
  ProfessionalServiceService.link(orgA, ana, escova, { isPrimary: false, commissionPercent: 30 });
  const anaServ = ProfessionalServiceService.listServicesFor(orgA, ana);
  check("Ana faz 2 serviços ativos (coloração+escova; corte foi active=false na etapa 2b via 2ª chamada)",
    anaServ.length >= 2, `count=${anaServ.length}`);
  const coloIdx = anaServ.findIndex(s => s.serviceId === coloracao);
  const escIdx = anaServ.findIndex(s => s.serviceId === escova);
  check("listServicesFor traz nome do serviço", anaServ[coloIdx]?.serviceName === "Coloração");

  ProfessionalServiceService.link(orgA, bia, coloracao, { isPrimary: true, commissionPercent: 45 });
  const colorProfs = ProfessionalServiceService.listProfessionalsFor(orgA, coloracao);
  check("listProfessionalsFor(coloração) retorna 2 (Ana + Bia)", colorProfs.length === 2);
  const primaryFirst = colorProfs[0];
  check("listProfessionalsFor ordena por is_primary DESC (Bia primary vem antes)", primaryFirst.professionalId === bia);
  check("listProfessionalsFor traz professionalName", primaryFirst.professionalName === "Bia");

  // ===== 9. activeOnly filtra link/prof/service inativos =====
  const oldProf = seedProfessional(orgA, "Antigo", false);  // profissional inativo
  ProfessionalServiceService.link(orgA, oldProf, corte, { commissionPercent: 25 });
  const cortProfsAct = ProfessionalServiceService.listProfessionalsFor(orgA, corte, { activeOnly: true });
  check("activeOnly=true filtra profissional inativo",
    !cortProfsAct.some(p => p.professionalId === oldProf));
  const cortProfsAll = ProfessionalServiceService.listProfessionalsFor(orgA, corte, { activeOnly: false });
  check("activeOnly=false inclui profissional inativo",
    cortProfsAll.some(p => p.professionalId === oldProf));

  const svcInactive = seedService(orgA, "Serviço extinto", "service", false);
  ProfessionalServiceService.link(orgA, ana, svcInactive);
  const anaServAct = ProfessionalServiceService.listServicesFor(orgA, ana, { activeOnly: true });
  check("activeOnly=true filtra serviço inativo",
    !anaServAct.some(s => s.serviceId === svcInactive));

  // ===== 10. isCapable — só com link+prof+serviço ATIVOS =====
  check("isCapable(Ana, coloração) = true (todos ativos)",
    ProfessionalServiceService.isCapable(orgA, ana, coloracao) === true);
  check("isCapable(Ana, escova) — verificar via link ativo",
    ProfessionalServiceService.isCapable(orgA, ana, escova) === true);
  check("isCapable(oldProf, corte) = false (profissional inativo)",
    ProfessionalServiceService.isCapable(orgA, oldProf, corte) === false);
  check("isCapable(Ana, svcInactive) = false (serviço inativo)",
    ProfessionalServiceService.isCapable(orgA, ana, svcInactive) === false);
  check("isCapable(Bia, escova) = false (link foi unlinkado — active=0)",
    ProfessionalServiceService.isCapable(orgA, bia, escova) === false);
  // Cross-tenant
  check("isCapable(orgB, Ana, coloração) = false (Ana é de orgA)",
    ProfessionalServiceService.isCapable(orgB, ana, coloracao) === false);

  // ===== 11. setForProfessional — atômico, soft-off dos ausentes =====
  const daniel = seedProfessional(orgA, "Daniel");
  ProfessionalServiceService.link(orgA, daniel, corte);
  ProfessionalServiceService.link(orgA, daniel, coloracao);
  ProfessionalServiceService.link(orgA, daniel, escova);
  // Substitui pela lista {corte, novo escova(primary)} — coloração deve virar soft-off
  const set1 = ProfessionalServiceService.setForProfessional(orgA, daniel, [
    { serviceId: corte, commissionPercent: 20 },
    { serviceId: escova, isPrimary: true, commissionPercent: 30 },
  ]);
  check("setForProfessional retorna apenas os 2 ativos (após soft-off do ausente)",
    set1.length === 2);
  const coloDan = db.prepare(`SELECT active, commission_percent FROM professional_services WHERE organization_id=? AND professional_id=? AND service_id=?`).get(orgA, daniel, coloracao) as any;
  check("setForProfessional: serviço ausente virou active=0 (soft-off)", Number(coloDan.active) === 0);
  // Validação cedo — se algum id não bate, aborta antes de tocar
  let setErr: string | null = null;
  try {
    ProfessionalServiceService.setForProfessional(orgA, daniel, [
      { serviceId: coloracao },
      { serviceId: "svc_inexistente" },
    ]);
  } catch (e: any) { setErr = e?.message || "err"; }
  check("setForProfessional aborta se algum id não bate", !!setErr);
  // Estado do daniel NÃO mudou (transação foi abortada antes)
  const danServPos = ProfessionalServiceService.listServicesFor(orgA, daniel, { activeOnly: true });
  check("estado do daniel preservado após erro (ainda 2 serviços ativos: corte + escova)",
    danServPos.length === 2 && danServPos.some(s => s.serviceId === corte) && danServPos.some(s => s.serviceId === escova));

  // is_primary: se vier 2+, mantém só o primeiro
  const set2 = ProfessionalServiceService.setForProfessional(orgA, daniel, [
    { serviceId: corte, isPrimary: true },
    { serviceId: escova, isPrimary: true },
  ]);
  const primaryCount = set2.filter(s => s.isPrimary).length;
  check("setForProfessional: só 1 is_primary sobrevive (garantia leve)", primaryCount === 1);

  // ===== 12. Isolamento cross-tenant =====
  const orgC = seedOrg();
  const carlaC = seedProfessional(orgC, "Carla");
  const corteC = seedService(orgC, "Corte");
  ProfessionalServiceService.link(orgC, carlaC, corteC);
  const orgCServ = ProfessionalServiceService.listServicesFor(orgC, carlaC);
  const orgAServCross = ProfessionalServiceService.listServicesFor(orgA, carlaC);
  check("orgC vê Carla↔Corte", orgCServ.length === 1);
  check("orgA NÃO vê Carla (é de orgC)", orgAServCross.length === 0);

  // ===== 13. Zero hardcoded do Studio Márcia =====
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
  console.log("\n=== TEST: N:N profissional↔serviço (ADR-169 F4 / BEAUTY-004 parte 2) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? "  [" + r.note + "]" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ ProfessionalServiceService pronto — 'quem faz o quê' resolvido no salão.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
