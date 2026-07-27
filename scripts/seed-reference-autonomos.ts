/**
 * SEEDER — Contas de REFERÊNCIA de autônomos (peixaria + chaveiro).
 *
 * Assim como a TOULON é a referência viva do varejo, estas duas contas mostram
 * o que cada PERFIL de autônomo (ZappFlow Comigo) oferece quando recebe dados:
 *   - 🐟 Peixaria (vertical `varejo`, arquétipo `revenda`): catálogo VENDIDO POR
 *     KG (Tilápia, camarão, salmão) — exercita a venda por peso no Balcão.
 *   - 🔧 Chaveiro (vertical `servicos`, arquétipo `servico_tecnico`): catálogo de
 *     SERVIÇOS (cópia de chave, abertura de porta) com valor/hora.
 *
 * Idempotente: org id/e-mail fixos; re-rodar não duplica (só completa o que
 * faltar). Plano `autonomo`; `copiloto` (Balcão do Comigo) ligado explicitamente
 * — a vertical não o liga sozinho, mas é onde a venda por peso acontece.
 *
 * Uso:  npm run seed:reference-autonomos
 *       REF_ACCOUNT_PASSWORD=... npm run seed:reference-autonomos  (senha custom)
 */
import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

type SeededProduct = { name: string; type?: "product" | "service"; price: number; saleMode?: "unit" | "weight"; steps?: number[]; category?: string };
type RefSpec = {
  orgId: string; businessName: string; email: string; ownerName: string;
  vertical: string; archetype: string; service: "balcao" | "agenda"; mobile: boolean;
  comigo: { hourValue?: number; fixedCostsMonthly?: number; fiadoLimit?: number };
  catalog: SeededProduct[];
};

// Perfis de referência. Preços são exemplos plausíveis (R$), não tabela real.
export const REFERENCE_AUTONOMOS: RefSpec[] = [
  {
    orgId: "org_ref_peixaria", businessName: "Peixaria do Zé (referência)",
    email: "peixaria@demo.zappflow.app", ownerName: "Zé da Peixaria",
    vertical: "varejo", archetype: "revenda", service: "balcao", mobile: false,
    comigo: { fixedCostsMonthly: 3500, fiadoLimit: 100 },
    catalog: [
      { name: "Tilápia fresca (inteira)", price: 39.9, saleMode: "weight", steps: [500, 1000, 2000], category: "Peixes" },
      { name: "Filé de tilápia", price: 54.9, saleMode: "weight", steps: [500, 1000], category: "Peixes" },
      { name: "Camarão cinza", price: 79.9, saleMode: "weight", steps: [250, 500, 1000], category: "Frutos do mar" },
      { name: "Salmão em posta", price: 89.9, saleMode: "weight", steps: [250, 500, 1000], category: "Peixes" },
      { name: "Sardinha (lata)", price: 8.5, saleMode: "unit", category: "Mercearia" },
      { name: "Gelo em escama (2 kg)", price: 12, saleMode: "unit", category: "Diversos" },
    ],
  },
  {
    orgId: "org_ref_chaveiro", businessName: "Chaveiro Rápido (referência)",
    email: "chaveiro@demo.zappflow.app", ownerName: "Bento Chaveiro",
    vertical: "servicos", archetype: "servico_tecnico", service: "balcao", mobile: true,
    comigo: { hourValue: 60, fixedCostsMonthly: 1800, fiadoLimit: 0 },
    catalog: [
      { name: "Cópia de chave simples", type: "service", price: 15, category: "Chaves" },
      { name: "Cópia de chave codificada", type: "service", price: 120, category: "Chaves" },
      { name: "Abertura de porta (residencial)", type: "service", price: 90, category: "Serviços" },
      { name: "Confecção de chave de partida (auto)", type: "service", price: 180, category: "Automotivo" },
      { name: "Troca de segredo de fechadura", type: "service", price: 140, category: "Serviços" },
    ],
  },
];

/** Provisiona (idempotente) as contas de referência. Retorna um resumo por conta. */
export async function seedReferenceAutonomos(password: string): Promise<Array<{ orgId: string; businessName: string; email: string; created: boolean; products: number }>> {
  const db = (await import("../src/server/db.js")).default;
  const { ComigoArchetypeService } = await import("../src/server/ComigoArchetypeService.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { applyPlanGrade } = await import("../src/server/plansGrade.js");
  const { uniqueProductSlug } = await import("../src/server/productSlug.js");

  applyPlanGrade(db); // garante o plano `autonomo`
  const passwordHash = await bcrypt.hash(password, 10);
  const out: Array<{ orgId: string; businessName: string; email: string; created: boolean; products: number }> = [];

  for (const spec of REFERENCE_AUTONOMOS) {
    const existing = db.prepare("SELECT organization_id FROM organization_settings WHERE organization_id = ?").get(spec.orgId) as any;
    const created = !existing;
    if (created) {
      db.prepare(
        `INSERT INTO organization_settings (id, organization_id, business_name, status, onboarding_status, plan_id, comigo_hour_value, comigo_fixed_costs_monthly, comigo_fiado_default_limit)
         VALUES (?, ?, ?, 'active', 'completed', 'autonomo', ?, ?, ?)`
      ).run(randomUUID(), spec.orgId, spec.businessName, spec.comigo.hourValue ?? null, spec.comigo.fixedCostsMonthly ?? null, spec.comigo.fiadoLimit ?? 0);
    } else {
      // Mantém o plano/valores em dia mesmo re-rodando (não recria).
      db.prepare(
        `UPDATE organization_settings SET business_name = ?, status = 'active', onboarding_status = 'completed', plan_id = 'autonomo',
           comigo_hour_value = COALESCE(comigo_hour_value, ?), comigo_fixed_costs_monthly = COALESCE(comigo_fixed_costs_monthly, ?)
         WHERE organization_id = ?`
      ).run(spec.businessName, spec.comigo.hourValue ?? null, spec.comigo.fixedCostsMonthly ?? null, spec.orgId);
    }

    // Dono (idempotente por e-mail).
    const owner = db.prepare("SELECT id FROM users WHERE organization_id = ? AND email = ?").get(spec.orgId, spec.email) as any;
    if (!owner) {
      db.prepare(`INSERT INTO users (id, organization_id, name, email, password_hash, role, global_status) VALUES (?, ?, ?, ?, ?, 'owner', 'active')`)
        .run(randomUUID(), spec.orgId, spec.ownerName, spec.email, passwordHash);
    }

    // Arquétipo Comigo + módulos (vertical ∩ plano) + Balcão (copiloto).
    ComigoArchetypeService.apply(spec.orgId, { archetype: spec.archetype, service: spec.service, mobile: spec.mobile }, "seed");
    ModuleService.applyVertical(spec.orgId, spec.vertical);
    ModuleService.enableModule(spec.orgId, "copiloto");

    // Catálogo de exemplo (dedupe por nome).
    let productCount = 0;
    for (const p of spec.catalog) {
      const dupe = db.prepare("SELECT id FROM products_services WHERE organization_id = ? AND name = ?").get(spec.orgId, p.name) as any;
      if (dupe) { productCount++; continue; }
      const type = p.type || "product";
      const saleMode = type === "product" ? (p.saleMode || "unit") : "unit";
      const saleOptions = saleMode === "weight" && p.steps?.length ? JSON.stringify({ steps: p.steps }) : null;
      const slug = type === "product" ? uniqueProductSlug(spec.orgId, p.name) : null;
      db.prepare(
        `INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled, category, slug, sale_mode, sale_options_json)
         VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)`
      ).run(randomUUID(), spec.orgId, type, p.name, p.price, p.category || null, slug, saleMode, saleOptions);
      productCount++;
    }

    out.push({ orgId: spec.orgId, businessName: spec.businessName, email: spec.email, created, products: productCount });
  }
  return out;
}

async function main() {
  const password = process.env.REF_ACCOUNT_PASSWORD || "Referencia@2026";
  const summary = await seedReferenceAutonomos(password);
  console.log("\n=== Contas de referência de autônomos ===");
  for (const s of summary) {
    console.log(`\n${s.businessName}`);
    console.log(`  org:      ${s.orgId} ${s.created ? "(criada)" : "(já existia — atualizada)"}`);
    console.log(`  login:    ${s.email}`);
    console.log(`  senha:    ${password}`);
    console.log(`  produtos: ${s.products}`);
  }
  console.log("\nPronto. As contas usam o plano Autônomo com o Balcão (copiloto) ligado.");
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
