/**
 * TEST — Tier 1 filosófico (ADR-045): Manifesto do Negócio + 5 refinamentos de prompt.
 *
 * Cobre:
 *   1. BusinessManifestoService: save + get (upsert), sanitização de tamanhos,
 *      how_principles como JSON array, toPromptHeader + toNarrativeContext
 *   2. Injeção do Manifesto no topo do prompt de atendimento
 *   3. Injeção do Manifesto no topo do prompt do orquestrador
 *   4. Diretor IA "brutal honesto" (regras anti-bajulação no orchestrator)
 *   5. Perfeição atrasa vendas no orchestrator (regra Carlos Domingos)
 *   6. Raposa e Leão no negociador
 *   7. Padrões em Ordem Disney no prompt de atendimento
 *   8. PCIS no prompt de atendimento
 *   9. Regressão: Manifesto vazio não quebra o prompt
 *
 * Uso: npm run test:tier1-manifesto-philosophy
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-tier1-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-tier1-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessManifestoService } = await import("../src/server/BusinessManifestoService.js");
  const { AIOrchestratorService } = await import("../src/server/AIOrchestratorService.js");

  const seedOrg = (tag: string) => {
    const id = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), id, `Loja ${tag}`);
    return id;
  };

  const AI = AIOrchestratorService as any;

  // ==== 1. Manifesto CRUD ====
  console.log("\n=== 1. Manifesto CRUD ===");
  const orgA = seedOrg("manA");
  check("1.1 get vazio devolve null", BusinessManifestoService.get(orgA) === null);

  const saved = BusinessManifestoService.save(orgA, {
    whyStatement: "Existimos para desafogar donos de negócio.",
    howPrinciples: ["Nunca vender o que não usaríamos", "Responder em 30min"],
    whatSummary: "SO comercial com IA no WhatsApp.",
    founderStory: "Em 2024, o Eldas...",
    transformationPromise: "Do 14h/dia caótico ao painel claro.",
    toneVoice: "Registro próximo. Usamos: 'a gente'. Evitamos: 'querido'.",
  });
  check("1.2 save devolve manifesto completo", saved.whyStatement === "Existimos para desafogar donos de negócio.");
  check("1.3 how_principles preservado como array", Array.isArray(saved.howPrinciples) && saved.howPrinciples.length === 2);

  const reloaded = BusinessManifestoService.get(orgA);
  check("1.4 get recarrega mesmo conteúdo", reloaded?.whyStatement === saved.whyStatement);
  check("1.5 get preserva array de princípios", reloaded?.howPrinciples[0] === "Nunca vender o que não usaríamos");

  // Upsert: alterar 1 campo mantém os outros
  const updated = BusinessManifestoService.save(orgA, { whyStatement: "Novo por quê" });
  check("1.6 upsert altera só o campo passado", updated.whyStatement === "Novo por quê" && updated.transformationPromise === "Do 14h/dia caótico ao painel claro.");

  // Sanitize: strings gigantes são truncadas
  const trunc = BusinessManifestoService.save(orgA, { founderStory: "A".repeat(5000) });
  check("1.7 founderStory truncada a 2000 chars", (trunc.founderStory?.length || 0) === 2000);

  // Sanitize: how_principles aceita string separada por nova linha
  const fromString = BusinessManifestoService.save(orgA, { howPrinciples: "linha 1\nlinha 2\nlinha 3" as any });
  check("1.8 howPrinciples aceita string com quebras", fromString.howPrinciples.length === 3 && fromString.howPrinciples[0] === "linha 1");

  // Limite: máx 8 princípios (mesmo se enviar 20)
  const limited = BusinessManifestoService.save(orgA, { howPrinciples: Array.from({ length: 20 }, (_, i) => `p${i}`) });
  check("1.9 howPrinciples limitado a 8 items", limited.howPrinciples.length === 8);

  // ==== 2. toPromptHeader / toNarrativeContext ====
  console.log("\n=== 2. Injeção no prompt ===");
  const orgB = seedOrg("manB");
  BusinessManifestoService.save(orgB, {
    whyStatement: "Desafogar donos de negócio",
    howPrinciples: ["Princípio A", "Princípio B"],
    transformationPromise: "Antes caos, depois clareza",
    toneVoice: "próximo",
    founderStory: "Nossa história em 2024...",
  });
  const header = BusinessManifestoService.toPromptHeader(orgB);
  check("2.1 header inclui POR QUÊ", /POR QUÊ.*Desafogar/i.test(header));
  check("2.2 header inclui PROMESSA DE TRANSFORMAÇÃO", /PROMESSA DE TRANSFORMAÇÃO.*Antes caos/i.test(header));
  check("2.3 header inclui princípios numerados", /1\. Princípio A/.test(header) && /2\. Princípio B/.test(header));
  check("2.4 header inclui REGRA-MÃE", /REGRA-MÃE/.test(header));

  const narrative = BusinessManifestoService.toNarrativeContext(orgB);
  check("2.5 narrative inclui história fundadora", /HISTÓRIA FUNDADORA.*Nossa história em 2024/is.test(narrative));

  // Manifesto vazio => header vazio (sem quebrar a IA)
  const orgEmpty = seedOrg("empty");
  check("2.6 header vazio quando manifesto vazio", BusinessManifestoService.toPromptHeader(orgEmpty) === "");

  // ==== 3. Prompt de atendimento com Manifesto ====
  console.log("\n=== 3. Prompt attendance com Manifesto ===");
  const buildForAttendance = (orgId: string) => AI.buildPrompt(
    "attendance_agent",
    { organizationId: orgId, message: "oi", senderId: "5511900000000", ticketStage: "novo_lead" },
    "", "produto teste", "", "", "", "", "", "", "", "", "", "", "", "", ""
  );

  const promptWithManifesto = buildForAttendance(orgB);
  check("3.1 Prompt de atendimento com manifesto contém MANIFESTO DA MARCA", /MANIFESTO DA MARCA/.test(promptWithManifesto));
  check("3.2 Prompt sem manifesto NÃO contém o cabeçalho", !/MANIFESTO DA MARCA/.test(buildForAttendance(orgEmpty)));

  // ==== 4. Padrões em Ordem (Disney) no attendance ====
  console.log("\n=== 4. Padrões em Ordem (Disney) ===");
  check("4.1 Contém PADRÕES EM ORDEM", /PADRÕES EM ORDEM/.test(promptWithManifesto));
  check("4.2 Menciona hierarquia SEGURANÇA/CORTESIA/EXPERIÊNCIA/EFICIÊNCIA", /SEGURAN[ÇC]A.*CORTESIA.*EXPERI[ÊE]NCIA.*EFICI[ÊE]NCIA/s.test(promptWithManifesto));
  check("4.3 Explicita que cortesia não pode ser sacrificada por eficiência", /Cortesia NUNCA é sacrificada/i.test(promptWithManifesto));

  // ==== 5. PCIS (Storytelling) no attendance ====
  console.log("\n=== 5. PCIS ===");
  check("5.1 Regra NARRATIVA PCIS presente", /NARRATIVA PCIS/.test(promptWithManifesto));
  check("5.2 Menciona Personagem / Conflito / Interação / Solução", /Personagem/i.test(promptWithManifesto) && /Conflito/i.test(promptWithManifesto) && /Intera[çc][ãa]o/i.test(promptWithManifesto) && /Solu[çc][ãa]o/i.test(promptWithManifesto));
  check("5.3 Instrui uso em CONSIDERAÇÃO ou PROPOSTA (não em toda msg)", /CONSIDERA[ÇC][ÃA]O ou PROPOSTA/i.test(promptWithManifesto));

  // ==== 6. Diretor IA brutal honesto + Perfeição atrasa vendas ====
  console.log("\n=== 6. Orquestrador brutal honesto ===");
  const orchestratorPrompt = AI.buildPrompt(
    "orchestrator_agent",
    { organizationId: orgB, message: "zap, como estou?", senderId: "5511900000000", contactName: "Eldas" },
    "", "produto", "PANORAMA: vendas caindo 15%", "", "", "", "", "", "", "", "", "", "", "", ""
  );
  check("6.1 Orquestrador inclui manifesto no topo", /MANIFESTO DA MARCA/.test(orchestratorPrompt));
  check("6.2 Postura assessor honesto", /assessor.*honesto/i.test(orchestratorPrompt) || /honesto/i.test(orchestratorPrompt));
  check("6.3 Evita bajular", /baju|flattering/i.test(orchestratorPrompt));
  check("6.4 Menciona Gracián / Maquiavel / dizer verdades", /Maquiavel|Graci[áa]n/i.test(orchestratorPrompt));
  check("6.5 Regra PERFEIÇÃO ATRASA VENDAS presente", /PERFEIÇÃO ATRASA VENDAS/i.test(orchestratorPrompt));
  check("6.6 Cita Airbnb ou Post-it como caso (Carlos Domingos)", /Airbnb|Post-it/i.test(orchestratorPrompt));

  // ==== 7. Negociador Raposa e Leão ====
  console.log("\n=== 7. Negociador Raposa e Leão ===");
  const orgN = seedOrg("neg");
  db.prepare(`UPDATE organization_settings SET negotiator_enabled = 1, negotiator_max_discount = 10 WHERE organization_id = ?`).run(orgN);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, min_price, active) VALUES (?, ?, 'product', 'X', 100, 80, 1)`).run(randomUUID(), orgN);
  const negText = AI.negotiatorContext(orgN);
  check("7.1 negotiatorContext gera texto", negText.length > 100);
  check("7.2 Menciona RAPOSA E LEÃO", /RAPOSA E LE[ÃA]O/i.test(negText));
  check("7.3 Explica raposa = flexibilidade em forma", /flexibiliza[çc][ãa]o|forma de pagamento|flexibilidade/i.test(negText));
  check("7.4 Explica leão = firmeza em essência", /qualidade.*prazo de garantia|essência|inegoci[áa]vel/i.test(negText));
  check("7.5 Regra 'nunca inverta' presente", /nunca inverta/i.test(negText));

  // ==== 8. Regressão: filosofia consultiva anterior preservada ====
  console.log("\n=== 8. Regressão do batch Ferrari ===");
  check("8.1 POSTURA CONSULTIVA continua", /POSTURA CONSULTIVA/.test(promptWithManifesto));
  check("8.2 DESPERTAR A NECESSIDADE continua", /DESPERTAR A NECESSIDADE/.test(promptWithManifesto));
  check("8.3 FECHAMENTO POR CONSEQU continua", /FECHAMENTO POR CONSEQU/.test(promptWithManifesto));
  check("8.4 VOU PENSAR continua", /VOU PENSAR/.test(promptWithManifesto));
  check("8.5 CLASSIFIQUE OBJEÇÕES continua", /CLASSIFIQUE.*OBJE/.test(promptWithManifesto));

  console.log("\n──── Resultados ────");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` [${r.detail}]` : ""}`);
  console.log(`\n${results.length} verificações, ${failures} falha(s).`);
  process.exit(failures > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
