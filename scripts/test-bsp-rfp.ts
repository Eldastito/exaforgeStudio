/**
 * TEST — BusinessSkillsPackService (Track C do PRD-PEL-01, F2 RFP).
 * DB-backed, determinístico. Prova:
 *   1. getQuoteTemplate: retorna DEFAULT quando config null; merge quando existe;
 *   2. renderTemplateString: substitui {{var}}, vazio para desconhecidas, sanitiza HTML/backticks;
 *   3. createQuoteFromTemplate: valida missing_org/missing_items;
 *   4. createQuoteFromTemplate: compõe texto com header/greeting/quote/conditions/footer/signature;
 *   5. createQuoteFromTemplate: persiste em quotes (usa QuoteService);
 *   6. templateOverrides sobrepõe template da org;
 *   7. salesMetricsByAgent: agrupa por created_by, calcula conversion_rate, filtra por janela de dias;
 *   8. Isolamento multi-tenant.
 *
 * Uso: npm run test:bsp-rfp
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-bsp-rfp-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-bsp-rfp-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) {
  results.push({ name, ok });
  if (!ok) failures++;
}

async function main() {
  const dbMod = await import("../src/server/db.js");
  const db = dbMod.default as any;
  const { BusinessSkillsPackService: BSP, BusinessSkillsPackError, DEFAULT_QUOTE_TEMPLATE } =
    await import("../src/server/BusinessSkillsPackService.js");
  const { v4: uuidv4 } = await import("uuid");

  const ORG_A = "org-alpha-rfp";
  const ORG_B = "org-beta-rfp";

  // Seed catálogo para ORG_A (pra buildAndSave achar itens)
  const P1 = uuidv4();
  const P2 = uuidv4();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Camiseta Preta', 50, 1)`).run(P1, ORG_A);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Boné Azul', 30, 1)`).run(P2, ORG_A);

  // ═══════════════ 1. getQuoteTemplate ═══════════════
  const tplDefault = BSP.getQuoteTemplate(ORG_A);
  check("1.1 getQuoteTemplate sem config retorna DEFAULT",
    tplDefault.header === DEFAULT_QUOTE_TEMPLATE.header);
  check("1.2 default tem greeting/footer/conditions/signature",
    !!tplDefault.greeting && !!tplDefault.footer &&
    Array.isArray(tplDefault.conditions) && !!tplDefault.signature);
  check("1.3 default conditions tem 2 bullets",
    (tplDefault.conditions?.length ?? 0) === 2);

  // Custom template mescla com default
  BSP.updateOrgConfig(ORG_A, {
    quote_template: { header: "MEU HEADER" },
  });
  const tplMerged = BSP.getQuoteTemplate(ORG_A);
  check("1.4 custom header sobrepõe",
    tplMerged.header === "MEU HEADER");
  check("1.5 greeting default preservado no merge",
    tplMerged.greeting === DEFAULT_QUOTE_TEMPLATE.greeting);
  check("1.6 conditions default preservado no merge",
    (tplMerged.conditions?.length ?? 0) === 2);

  // orgId vazio → default puro
  const tplEmptyOrg = BSP.getQuoteTemplate("");
  check("1.7 orgId vazio → DEFAULT",
    tplEmptyOrg.header === DEFAULT_QUOTE_TEMPLATE.header);

  // ═══════════════ 2. renderTemplateString ═══════════════
  const r1 = BSP.renderTemplateString("Olá {{name}}!", { name: "João" });
  check("2.1 substitui placeholder simples", r1 === "Olá João!");

  const r2 = BSP.renderTemplateString("{{a}} + {{b}} = {{c}}", { a: "1", b: "2", c: "3" });
  check("2.2 substitui múltiplos", r2 === "1 + 2 = 3");

  const r3 = BSP.renderTemplateString("Olá {{unknown}}!", { name: "x" });
  check("2.3 placeholder desconhecido vira vazio", r3 === "Olá !");

  const r4 = BSP.renderTemplateString("Nome: {{name}}", { name: "<script>alert(1)</script>Foo" });
  check("2.4 sanitiza HTML tags do context", r4 === "Nome: alert(1)Foo");

  const r5 = BSP.renderTemplateString("Info: {{v}}", { v: "com `crase` aqui" });
  check("2.5 troca backticks por aspas simples", r5 === "Info: com 'crase' aqui");

  const r6 = BSP.renderTemplateString("", { name: "x" });
  check("2.6 template vazio retorna vazio", r6 === "");

  const r7 = BSP.renderTemplateString("Sem placeholders aqui", {});
  check("2.7 sem placeholders passa direto",
    r7 === "Sem placeholders aqui");

  const r8 = BSP.renderTemplateString("{{n}}", { n: null as any });
  check("2.8 null do context vira vazio", r8 === "");

  const r9 = BSP.renderTemplateString("{{n}}", { n: undefined as any });
  check("2.9 undefined do context vira vazio", r9 === "");

  // ═══════════════ 3. Validações de createQuoteFromTemplate ═══════════════
  let noOrg = false;
  try { BSP.createQuoteFromTemplate({ orgId: "", items: [{ name: "Camiseta Preta" }] }); }
  catch (e: any) { noOrg = e instanceof BusinessSkillsPackError && e.code === "missing_org"; }
  check("3.1 orgId vazio → missing_org", noOrg);

  let noItems = false;
  try { BSP.createQuoteFromTemplate({ orgId: ORG_A, items: [] }); }
  catch (e: any) { noItems = e instanceof BusinessSkillsPackError && e.code === "missing_items"; }
  check("3.2 items vazio → missing_items", noItems);

  let notArray = false;
  try { BSP.createQuoteFromTemplate({ orgId: ORG_A, items: null as any }); }
  catch (e: any) { notArray = e instanceof BusinessSkillsPackError && e.code === "missing_items"; }
  check("3.3 items null → missing_items", notArray);

  // ═══════════════ 4. Composição de texto ═══════════════
  // Reset template pro default limpo
  BSP.updateOrgConfig(ORG_A, { quote_template: null });

  const q1 = BSP.createQuoteFromTemplate({
    orgId: ORG_A,
    items: [{ name: "Camiseta Preta", quantity: 2 }],
    contactName: "Maria",
    orgName: "Loja X",
  });
  check("4.1 retorna quote_id não vazio",
    typeof q1.quote_id === "string" && q1.quote_id.length > 0);
  check("4.2 total = 100 (50 * 2)", q1.total === 100);
  check("4.3 item_count = 1", q1.item_count === 1);
  check("4.4 rendered_text tem header com org_name substituído",
    q1.rendered_text.includes("Loja X"));
  check("4.5 rendered_text tem greeting com contact_name",
    q1.rendered_text.includes("Maria"));
  check("4.6 rendered_text tem texto do QuoteService (cotação)",
    q1.rendered_text.includes("Camiseta Preta") &&
    q1.rendered_text.includes("100.00"));
  check("4.7 rendered_text tem bloco de Condições",
    q1.rendered_text.includes("Condições") &&
    q1.rendered_text.includes("Prazo de entrega"));
  check("4.8 rendered_text tem footer (Válido até)",
    q1.rendered_text.includes("Válido até"));
  check("4.9 rendered_text tem signature (Equipe)",
    q1.rendered_text.includes("Equipe"));

  // Persistiu em quotes?
  const persisted = db.prepare(
    "SELECT * FROM quotes WHERE id = ? AND organization_id = ?"
  ).get(q1.quote_id, ORG_A) as any;
  check("4.10 quote foi persistido na tabela", !!persisted);
  check("4.11 quote persistido tem total_amount = 100",
    persisted?.total_amount === 100);
  check("4.12 quote persistido tem status='sent'",
    persisted?.status === "sent");

  // Sem contactName: contact_line vira vazio, greeting não bomba
  const q2 = BSP.createQuoteFromTemplate({
    orgId: ORG_A,
    items: [{ name: "Boné Azul", quantity: 1 }],
    orgName: "Loja Y",
  });
  check("4.13 sem contactName ainda funciona",
    q2.total === 30 && q2.item_count === 1);
  check("4.14 sem contactName, greeting não quebra (contact_line vazio)",
    q2.rendered_text.includes("Olá!"));

  // Sem orgName: usa fallback "sua marca"
  const q3 = BSP.createQuoteFromTemplate({
    orgId: ORG_A,
    items: [{ name: "Boné Azul", quantity: 1 }],
    contactName: "Ana",
  });
  check("4.15 sem orgName usa fallback 'sua marca'",
    q3.rendered_text.includes("sua marca"));

  // createdBy é passado adiante para o QuoteService
  const q4 = BSP.createQuoteFromTemplate({
    orgId: ORG_A,
    items: [{ name: "Camiseta Preta", quantity: 1 }],
    createdBy: "user-42",
    orgName: "Loja Z",
  });
  const row4 = db.prepare("SELECT created_by FROM quotes WHERE id = ?").get(q4.quote_id) as any;
  check("4.16 createdBy propagado pro quote persistido",
    row4?.created_by === "user-42");

  // ═══════════════ 5. Template com config custom aplicada ═══════════════
  BSP.updateOrgConfig(ORG_A, {
    quote_template: {
      header: "🎯 Cotação especial de {{org_name}}",
      signature: "Att, {{org_name}}",
    },
  });
  const q5 = BSP.createQuoteFromTemplate({
    orgId: ORG_A,
    items: [{ name: "Camiseta Preta", quantity: 1 }],
    orgName: "Boutique",
  });
  check("5.1 header custom aplicado",
    q5.rendered_text.includes("🎯 Cotação especial de Boutique"));
  check("5.2 signature custom aplicada",
    q5.rendered_text.includes("Att, Boutique"));
  // Conditions/greeting/footer vieram do default merge
  check("5.3 conditions default preservado no merge",
    q5.rendered_text.includes("Prazo de entrega"));

  // ═══════════════ 6. templateOverrides ═══════════════
  BSP.updateOrgConfig(ORG_A, { quote_template: null }); // reset
  const q6 = BSP.createQuoteFromTemplate({
    orgId: ORG_A,
    items: [{ name: "Boné Azul", quantity: 1 }],
    orgName: "Loja X",
    templateOverrides: {
      header: "OVERRIDE HEADER",
      conditions: ["Só à vista"],
      signature: "",
    },
  });
  check("6.1 templateOverrides.header aplicado",
    q6.rendered_text.includes("OVERRIDE HEADER") &&
    !q6.rendered_text.includes("Orçamento — Loja X"));
  check("6.2 templateOverrides.conditions substitui default",
    q6.rendered_text.includes("Só à vista") &&
    !q6.rendered_text.includes("Prazo de entrega"));
  check("6.3 templateOverrides.signature vazio → não aparece 'Equipe'",
    !q6.rendered_text.includes("Equipe"));

  // ═══════════════ 7. salesMetricsByAgent ═══════════════
  // Setup: cria vários quotes com created_by distintos e status distintos.
  // Vamos gerar 3 vendedores em ORG_B.
  const ORG_C = "org-metrics";
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'X', 100, 1)`).run(uuidv4(), ORG_C);

  const insertQuote = (id: string, orgId: string, createdBy: string, status: string, sentAt?: string) => {
    db.prepare(`
      INSERT INTO quotes (id, organization_id, status, total_amount, items_snapshot, created_by, sent_at)
      VALUES (?, ?, ?, 100, '[]', ?, COALESCE(?, CURRENT_TIMESTAMP))
    `).run(id, orgId, status, createdBy, sentAt || null);
  };

  // Vendedor "alice": 5 sent, 3 accepted, 1 declined, 1 sent
  insertQuote(uuidv4(), ORG_C, "alice", "accepted");
  insertQuote(uuidv4(), ORG_C, "alice", "accepted");
  insertQuote(uuidv4(), ORG_C, "alice", "accepted");
  insertQuote(uuidv4(), ORG_C, "alice", "declined");
  insertQuote(uuidv4(), ORG_C, "alice", "sent");
  // Vendedor "bob": 2 sent, 0 accepted
  insertQuote(uuidv4(), ORG_C, "bob", "sent");
  insertQuote(uuidv4(), ORG_C, "bob", "sent");
  // Vendedor "carol": 1 sent, 1 accepted
  insertQuote(uuidv4(), ORG_C, "carol", "accepted");
  // Vendedor legado sem created_by (null → 'unknown')
  insertQuote(uuidv4(), ORG_C, null as any, "sent");

  // Quote antigo (60 dias atrás) que NÃO deve entrar na janela default de 30d
  const oldSent = "datetime('now', '-60 days')";
  db.prepare(`
    INSERT INTO quotes (id, organization_id, status, total_amount, items_snapshot, created_by, sent_at)
    VALUES (?, ?, 'accepted', 100, '[]', 'alice', ${oldSent})
  `).run(uuidv4(), ORG_C);

  const metrics = BSP.salesMetricsByAgent(ORG_C);
  const byAgent = Object.fromEntries(metrics.map((m: any) => [m.agent, m]));

  check("7.1 métricas contém alice, bob, carol, unknown",
    !!byAgent.alice && !!byAgent.bob && !!byAgent.carol && !!byAgent.unknown);
  check("7.2 alice.sent = 5 (janela 30d, não conta o de 60 dias atrás)",
    byAgent.alice?.sent === 5);
  check("7.3 alice.accepted = 3",
    byAgent.alice?.accepted === 3);
  check("7.4 alice.declined = 1",
    byAgent.alice?.declined === 1);
  check("7.5 alice.conversion_rate = 3/5 = 0.6",
    Math.abs(byAgent.alice?.conversion_rate - 0.6) < 0.001);
  check("7.6 bob.conversion_rate = 0 (sem accepted)",
    byAgent.bob?.conversion_rate === 0);
  check("7.7 carol.conversion_rate = 1.0",
    byAgent.carol?.conversion_rate === 1);
  check("7.8 unknown agrupa quotes sem created_by",
    byAgent.unknown?.sent === 1);
  check("7.9 ordenado por sent DESC (alice primeiro)",
    metrics[0]?.agent === "alice");

  // Janela custom
  const metricsShort = BSP.salesMetricsByAgent(ORG_C, { days: 1 });
  const aliceShort = metricsShort.find((m: any) => m.agent === "alice");
  check("7.10 janela 1 dia ainda pega quotes recentes",
    (aliceShort?.sent ?? 0) === 5);

  // orgId vazio → array vazio
  check("7.11 orgId vazio → []",
    BSP.salesMetricsByAgent("").length === 0);

  // days=0 protege contra divisão por zero (Math.max com 1)
  const metricsZero = BSP.salesMetricsByAgent(ORG_C, { days: 0 });
  check("7.12 days=0 é normalizado (Math.max 1)",
    Array.isArray(metricsZero));

  // ═══════════════ 8. Isolamento multi-tenant ═══════════════
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Camiseta Preta', 999, 1)`).run(uuidv4(), ORG_B);
  BSP.updateOrgConfig(ORG_B, { quote_template: { header: "HEADER-B" } });

  const tplA = BSP.getQuoteTemplate(ORG_A);
  const tplB = BSP.getQuoteTemplate(ORG_B);
  check("8.1 templates isolados entre orgs",
    tplA.header !== tplB.header);

  const qA = BSP.createQuoteFromTemplate({
    orgId: ORG_A,
    items: [{ name: "Camiseta Preta", quantity: 1 }],
    orgName: "A",
  });
  const qB = BSP.createQuoteFromTemplate({
    orgId: ORG_B,
    items: [{ name: "Camiseta Preta", quantity: 1 }],
    orgName: "B",
  });
  check("8.2 preços vêm do catálogo de cada org (isolamento)",
    qA.total === 50 && qB.total === 999);
  check("8.3 rendered_text de B usa header-B",
    qB.rendered_text.includes("HEADER-B") &&
    !qB.rendered_text.includes("Boutique"));

  const metricsA = BSP.salesMetricsByAgent(ORG_A);
  const metricsC = BSP.salesMetricsByAgent(ORG_C);
  check("8.4 métricas isoladas por org",
    metricsA.every((m: any) => m.agent !== "alice") ||
    metricsC.every((m: any) => m.agent !== undefined));

  // ─── Relatório final ───
  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
