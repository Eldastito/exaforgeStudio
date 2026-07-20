/**
 * TEST — Perfil de fornecedor da rede: contato + validação (ADR-099, bloco #11).
 *
 * A aba "Ser fornecedor" não tinha campos de contato — quem achava a loja na
 * rede não tinha como chamá-la. Este teste trava o backend do contato:
 * `SupplyNetworkService.saveProfile`/`profile` persistem WhatsApp + e-mail,
 * normalizando (WhatsApp com DDI 55, e-mail minúsculo) e descartando lixo,
 * sem apagar o que não foi enviado no patch.
 *
 * Uso: npm run test:supplier-profile-contact
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-supplier-contact-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-supplier-contact-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SupplyNetworkService } = await import("../src/server/SupplyNetworkService.js");

  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Fornecedora A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja B', 'active')`).run(randomUUID(), orgB);

  // ===== 1. Schema — colunas de contato existem =====
  const cols = (db.prepare(`PRAGMA table_info(organization_settings)`).all() as any[]).map(c => c.name);
  check("coluna network_contact_whatsapp existe", cols.includes("network_contact_whatsapp"));
  check("coluna network_contact_email existe", cols.includes("network_contact_email"));

  // ===== 2. Salva contato — normaliza WhatsApp (DDI 55) e e-mail (minúsculo) =====
  await SupplyNetworkService.saveProfile(orgA, {
    enabled: true, categories: "camisaria, alfaiataria", city: "Rio de Janeiro", state: "RJ",
    contactWhatsapp: "(21) 99999-8888", contactEmail: "Compras@TOULON.com.BR",
  });
  let p = SupplyNetworkService.profile(orgA);
  check("WhatsApp normalizado com DDI 55", p.contactWhatsapp === "5521999998888");
  check("e-mail normalizado (minúsculo)", p.contactEmail === "compras@toulon.com.br");
  check("perfil manteve categoria/cidade", p.categories === "camisaria, alfaiataria" && p.city === "Rio de Janeiro");

  // ===== 3. WhatsApp já com DDI (13 dígitos) é preservado =====
  await SupplyNetworkService.saveProfile(orgA, { contactWhatsapp: "5521988887777" });
  p = SupplyNetworkService.profile(orgA);
  check("WhatsApp com DDI existente preservado", p.contactWhatsapp === "5521988887777");
  check("e-mail NÃO foi apagado (patch parcial)", p.contactEmail === "compras@toulon.com.br");

  // ===== 4. E-mail inválido é descartado (validação leve) =====
  await SupplyNetworkService.saveProfile(orgA, { contactEmail: "isso-nao-e-email" });
  p = SupplyNetworkService.profile(orgA);
  check("e-mail inválido vira vazio", p.contactEmail === "");

  // ===== 5. WhatsApp curto/lixo é descartado =====
  await SupplyNetworkService.saveProfile(orgA, { contactWhatsapp: "123" });
  p = SupplyNetworkService.profile(orgA);
  check("WhatsApp curto demais vira vazio", p.contactWhatsapp === "");

  // ===== 6. Isolamento multi-tenant — org B não herdou nada =====
  const pB = SupplyNetworkService.profile(orgB);
  check("org B tem contato vazio (isolado)", pB.contactWhatsapp === "" && pB.contactEmail === "");

  // ===== 7. Patch de outro campo não mexe no contato =====
  await SupplyNetworkService.saveProfile(orgA, { contactEmail: "vendas@toulon.com.br" });
  await SupplyNetworkService.saveProfile(orgA, { minOrderAmount: 500 });
  p = SupplyNetworkService.profile(orgA);
  check("salvar minOrderAmount preservou e-mail", p.contactEmail === "vendas@toulon.com.br");
  check("minOrderAmount aplicado", p.minOrderAmount === 500);

  // --- Relatório ---
  console.log("\n=== TEST: Perfil de fornecedor — contato (ADR-099) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Contato do perfil de fornecedor OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
