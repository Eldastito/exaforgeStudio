/**
 * TEST — PRD 1 Fase 2 (fecho de segurança): RBAC por CLASSIFICAÇÃO de artefato.
 *
 * Antes, qualquer membro da org podia listar/mintar/baixar qualquer artefato,
 * inclusive 'sensitive'. Agora a EMISSÃO/LISTAGEM é gated por classificação
 * (o download público segue bearer — a URL assinada é a credencial):
 *   public/internal → qualquer membro; sensitive → só o CRIADOR ou visão ampla
 *   (owner/gerente, reusa hasFullBusinessVisibility — nenhum RBAC novo).
 *
 * Prova (determinístico; perfis RBAC de sistema reais):
 *   - canAccess por classificação e papel (público/interno livres; sensível
 *     restrito ao criador + owner/gerente; vendedor/financeiro negados no que
 *     não é deles); fail-closed sem user;
 *   - listForUser oculta sensível de terceiros; getForUser/signedUrlForUser negam;
 *   - link mintado por quem pode ainda resolve (bearer, por design);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:artifact-rbac
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-artifact-rbac-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-artifact-rbac-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ArtifactService: AS } = await import("../src/server/ArtifactService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");

  const org = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  PermissionService.seedSystemProfiles(org);
  const userFor = (key: string) => ({ userId: randomUUID(), role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id, role: key });
  const owner = userFor("owner"), gerente = userFor("gerente"), vendedor = userFor("vendedor"), financeiro = userFor("financeiro");

  const mk = (cls: string, by: string) => AS.create(org, { kind: "report", title: `t-${cls}`, mimeType: "application/pdf", content: Buffer.from("%PDF-1.4 x"), classification: cls, createdBy: by, origin: "report" });
  const pub = mk("public", owner.userId);
  const internal = mk("internal", owner.userId);
  const sensFin = mk("sensitive", financeiro.userId);   // criado pelo financeiro
  const sensVend = mk("sensitive", vendedor.userId);     // criado pelo vendedor

  // ===== 1. canAccess: público/interno livres =====
  check("1.1 público: qualquer papel acessa", [owner, vendedor, financeiro].every((u) => AS.canAccess(org, u, pub)));
  check("1.2 interno: qualquer papel acessa", [owner, vendedor, financeiro].every((u) => AS.canAccess(org, u, internal)));

  // ===== 2. canAccess: sensível restrito =====
  check("2.1 sensível: CRIADOR acessa (financeiro no dele)", AS.canAccess(org, financeiro, sensFin) === true);
  check("2.2 sensível: owner/gerente (visão ampla) acessam", AS.canAccess(org, owner, sensFin) && AS.canAccess(org, gerente, sensFin));
  check("2.3 sensível: vendedor NÃO acessa o do financeiro", AS.canAccess(org, vendedor, sensFin) === false);
  check("2.4 sensível: financeiro NÃO acessa o do vendedor (não é criador nem amplo)", AS.canAccess(org, financeiro, sensVend) === false);
  check("2.5 sensível: criador vendedor acessa o dele", AS.canAccess(org, vendedor, sensVend) === true);
  check("2.6 fail-closed: sem user → sensível negado", AS.canAccess(org, null, sensFin) === false);

  // ===== 3. listForUser oculta sensível de terceiros =====
  const vendList = AS.listForUser(org, vendedor, {}).map((a: any) => a.id);
  check("3.1 vendedor vê público+interno+o SEU sensível, não o do financeiro", vendList.includes(pub.id) && vendList.includes(internal.id) && vendList.includes(sensVend.id) && !vendList.includes(sensFin.id));
  const ownerList = AS.listForUser(org, owner, {}).map((a: any) => a.id);
  check("3.2 owner vê todos os 4", [pub, internal, sensFin, sensVend].every((a) => ownerList.includes(a.id)));

  // ===== 4. getForUser / signedUrlForUser negam =====
  check("4.1 getForUser: vendedor não pega o sensível do financeiro", AS.getForUser(org, vendedor, sensFin.id) == null && AS.getForUser(org, owner, sensFin.id)?.id === sensFin.id);
  check("4.2 signedUrlForUser: vendedor não minta link do sensível alheio", AS.signedUrlForUser(org, vendedor, sensFin.id) == null);
  const ownerUrl = AS.signedUrlForUser(org, owner, sensFin.id);
  check("4.3 owner minta o link do sensível", typeof ownerUrl === "string");

  // ===== 5. Link mintado ainda resolve (bearer, por design) =====
  const q = new URLSearchParams(ownerUrl!.split("?")[1]);
  check("5.1 URL assinada válida entrega o arquivo (bearer)", !!AS.resolveSigned(org, sensFin.id, q.get("exp")!, q.get("sig")!));

  // ===== 6. Isolamento multi-tenant (não regride) =====
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), orgB);
  check("6.1 artefato de A não vaza em B", AS.getForUser(orgB, owner, sensFin.id) == null && AS.get(orgB, sensFin.id) == null);

  console.log("\n=== TEST: RBAC por classificação de artefato (PRD 1 Fase 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ RBAC por classificação de artefato OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
