/**
 * TEST — Big Idea Bar (Tier 2, ADR-048).
 *
 * Cobre:
 *  1. hashData determinístico (ordem de chaves não altera)
 *  2. get() sem IA configurada devolve null (cache vazio)
 *  3. Cache hit: insere linha manual + get() devolve sem chamar LLM
 *  4. force=true ignora cache mas sem IA continua null
 *  5. latest() devolve a linha mais recente por (org, panel)
 *  6. rowToIdea mapeia colunas corretamente
 *  7. Isolamento entre orgs (hash igual, orgs diferentes = miss)
 *  8. Prompt inclui o Manifesto quando presente
 *
 * Uso: npm run test:tier2-big-idea-bar
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-bigidea-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-bigidea-1234567890abcdef";
// Sem OPENAI_API_KEY: isAIConfigured() = false, então cai no caminho sem-LLM
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BigIdeaBarService } = await import("../src/server/BigIdeaBarService.js");
  const { BusinessManifestoService } = await import("../src/server/BusinessManifestoService.js");

  const seedOrg = (tag: string) => {
    const id = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), id, `Loja ${tag}`);
    return id;
  };

  const orgA = seedOrg("A");
  const orgB = seedOrg("B");

  // ==== 1. hashData determinístico ====
  console.log("\n=== 1. hashData determinístico ===");
  // Como hashData é interno, testamos via cache: dois payloads equivalentes
  // com ordens de chaves diferentes devem cair no MESMO hash — logo, o cache
  // que casa {a:1,b:2} também casa {b:2,a:1}.
  const payload1 = { totalTickets: 100, sales: 30, conversion: 30 };
  const payload2 = { conversion: 30, sales: 30, totalTickets: 100 };
  // Insere direto uma linha com um hash sintético para payload1 e vê se lookup por payload2 acha.
  // Estratégia: usa cache real — pega hash indiretamente rodando get sem IA e populando manualmente.
  // Como não temos hashData exportado, usamos a rota inversa: inserimos com hash calculado
  // igualzinho ao serviço via crypto.
  const crypto = await import("node:crypto");
  const hashOf = (d: any) =>
    crypto.createHash("sha1").update(JSON.stringify(d, Object.keys(d || {}).sort())).digest("hex").slice(0, 16);
  const h1 = hashOf(payload1);
  const h2 = hashOf(payload2);
  check("1.1 mesmo payload em ordens diferentes = mesmo hash", h1 === h2, `${h1} vs ${h2}`);

  // ==== 2. get() sem IA devolve null quando cache vazio ====
  console.log("\n=== 2. get() sem IA + cache vazio ===");
  const noIdea = await BigIdeaBarService.get(orgA, "dashboard:month", payload1);
  check("2.1 sem IA e sem cache = null", noIdea === null);

  // ==== 3. Cache hit devolve sem chamar LLM ====
  console.log("\n=== 3. Cache hit ===");
  const cachedId = randomUUID();
  db.prepare(
    `INSERT INTO big_ideas (id, organization_id, panel_key, data_hash, headline, recommended_action, confidence, raw_data_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(cachedId, orgA, "dashboard:month", h1, "Conversão travada em 30% — culpa do canal Instagram.", "Corte 20% do orçamento do Insta para o WhatsApp por 14 dias.", 82, JSON.stringify(payload1));

  const hit = await BigIdeaBarService.get(orgA, "dashboard:month", payload1);
  check("3.1 cache hit devolve idea", !!hit && hit.id === cachedId);
  check("3.2 headline preservada", hit?.headline?.includes("Conversão travada") ?? false);
  check("3.3 action preservada", hit?.recommendedAction?.includes("14 dias") ?? false);
  check("3.4 confidence preservada", hit?.confidence === 82);

  // Ordem diferente de chaves — mesmo hash — MESMO cache hit:
  const hit2 = await BigIdeaBarService.get(orgA, "dashboard:month", payload2);
  check("3.5 cache hit ignora ordem de chaves", hit2?.id === cachedId);

  // ==== 4. force=true ignora cache; sem IA volta null ====
  console.log("\n=== 4. force ignora cache ===");
  const forced = await BigIdeaBarService.get(orgA, "dashboard:month", payload1, { force: true });
  check("4.1 force + sem IA = null (não usa cache)", forced === null);

  // ==== 5. latest() ====
  console.log("\n=== 5. latest() ===");
  // Insere segunda linha mais nova para o mesmo painel
  const newerId = randomUUID();
  // A coluna created_at tem DEFAULT CURRENT_TIMESTAMP mas SQLite resolução é 1s.
  // Para garantir ordem, forçamos manualmente created_at.
  db.prepare(
    `INSERT INTO big_ideas (id, organization_id, panel_key, data_hash, headline, recommended_action, confidence, raw_data_snapshot, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+1 hour'))`
  ).run(newerId, orgA, "dashboard:month", "outrahash1234567", "Nova leitura", "Nova ação", 70, "{}");

  const latest = BigIdeaBarService.latest(orgA, "dashboard:month");
  check("5.1 latest devolve a mais recente", latest?.id === newerId);
  check("5.2 latest de painel inexistente = null", BigIdeaBarService.latest(orgA, "inexistente:xxx") === null);

  // ==== 6. rowToIdea ====
  console.log("\n=== 6. rowToIdea ===");
  const row = { id: "x", organization_id: "y", panel_key: "p", headline: "h", recommended_action: null, confidence: null, created_at: "2026-01-01" };
  const mapped = BigIdeaBarService.rowToIdea(row);
  check("6.1 recommended_action null → ''", mapped.recommendedAction === "");
  check("6.2 confidence null → default 70", mapped.confidence === 70);
  check("6.3 organization_id → organizationId", mapped.organizationId === "y");
  check("6.4 panel_key → panelKey", mapped.panelKey === "p");

  // ==== 7. Isolamento entre orgs ====
  console.log("\n=== 7. Isolamento entre orgs ===");
  const missB = await BigIdeaBarService.get(orgB, "dashboard:month", payload1);
  check("7.1 outra org com mesmo hash = miss (isolamento)", missB === null);
  // Insere cache pra B e confirma que A não vê:
  db.prepare(
    `INSERT INTO big_ideas (id, organization_id, panel_key, data_hash, headline, recommended_action, confidence, raw_data_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), orgB, "dashboard:month", h1, "B só", "B só ação", 90, "{}");
  const bHit = await BigIdeaBarService.get(orgB, "dashboard:month", payload1);
  check("7.2 B agora acha seu próprio cache", bHit?.headline === "B só");
  const aStill = await BigIdeaBarService.get(orgA, "dashboard:month", payload1);
  check("7.3 A continua vendo apenas seu cache", aStill?.id === cachedId);

  // ==== 8. Prompt inclui Manifesto quando presente ====
  console.log("\n=== 8. Prompt inclui Manifesto ===");
  BusinessManifestoService.save(orgA, {
    whyStatement: "Ajudar donas de loja de bairro a competir com marketplace grande.",
    howPrinciples: ["Atendimento humano + IA que aprende a marca em 5 minutos.", "Sem descontar sem margem."],
    whatSummary: "Assistente de vendas conversacional 24/7.",
    transformationPromise: "Dona da loja fecha o dia sem ansiedade.",
    toneVoice: "Amiga, direta, brasileira.",
  });
  const header = BusinessManifestoService.toPromptHeader(orgA);
  check("8.1 Manifesto foi persistido", !!header && header.length > 0);
  check("8.2 header traz Por Quê", (header || "").includes("Ajudar donas"));

  // ==== Relatório ====
  console.log("\n=========================================");
  console.log("RELATÓRIO — Big Idea Bar (Tier 2)");
  console.log("=========================================");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
  }
  console.log("=========================================");
  console.log(`${results.length - failures}/${results.length} passaram`);
  if (failures > 0) {
    console.log(`❌ ${failures} falhas`);
    process.exit(1);
  }
  console.log("✅ Todos os testes passaram");
  process.exit(0);
}

main().catch((e) => {
  console.error("💥 Teste explodiu:", e);
  process.exit(1);
});
