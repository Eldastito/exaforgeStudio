/**
 * TEST — BEAUTY-016 (ADR-169 F15): classificador determinístico de intenções
 * beauty no Fala Tu.
 *
 * Prova que o helper opt-in `classifyBeautyIntent` reconhece as 3 intenções
 * beauty com padrões PT-BR reais de salão SEM tocar o FalaTuService global
 * (0-regressão dura pras 8 verticais existentes).
 *
 * Checks-âncora:
 *  - BEAUTY_INTENTS = ['BEAUTY_SIMULATE','BEAUTY_BOOK','BEAUTY_AVAILABILITY'].
 *  - "quero simular mechas na Ana" → BEAUTY_SIMULATE + contactName='Ana' +
 *    serviceHint='mecha'.
 *  - "marca a Bia pra escova sábado 10h" → BEAUTY_BOOK + contactName='Bia' +
 *    serviceHint='escova'.
 *  - "tem horário livre pra Maria amanhã?" → BEAUTY_AVAILABILITY +
 *    contactName='Maria'.
 *  - Prioridade: SIMULATE > BOOK > AVAILABILITY quando texto contém múltiplos
 *    verbos (SIMULATE ganha).
 *  - BOOK genérico SEM "cheiro beauty" NÃO classifica (evita canibalizar
 *    EVENT geral do FalaTu — RN-BS-11).
 *  - "hoje", "amanhã", "sábado" NÃO viram contactName (whitelist temporal).
 *  - Nomes que na verdade são keywords de serviço NÃO viram contactName.
 *  - Texto vazio/nulo → intent=null.
 *  - Determinístico: 2 chamadas retornam mesmo resultado.
 *  - 0-regressão dura: FalaTuService.classifyFalaTuListType continua
 *    intocado (importável e retornando o esperado).
 *
 * Uso: npm run test:beauty-falatu-intents
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-intent-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-intent-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 100));
  void db; // só pra garantir bootstrap

  const { classifyBeautyIntent, BEAUTY_INTENTS } = await import(
    "../src/server/BeautyFalaTuIntents.js"
  );

  // ===== 1. Constantes =====
  check(
    "BEAUTY_INTENTS contém as 3 intents",
    BEAUTY_INTENTS.length === 3 &&
      BEAUTY_INTENTS.includes("BEAUTY_SIMULATE") &&
      BEAUTY_INTENTS.includes("BEAUTY_BOOK") &&
      BEAUTY_INTENTS.includes("BEAUTY_AVAILABILITY"),
  );

  // ===== 2. BEAUTY_SIMULATE =====
  const s1 = classifyBeautyIntent("Quero simular mechas na Ana");
  check("'quero simular mechas na Ana' → BEAUTY_SIMULATE", s1.intent === "BEAUTY_SIMULATE");
  check("'... na Ana' → contactName='Ana'", s1.contactName === "Ana");
  check("'... mechas ...' → serviceHint='mecha'", s1.serviceHint === "mecha");

  const s2 = classifyBeautyIntent("Vamos ver como fica um bob nela");
  check("'como fica um bob' → BEAUTY_SIMULATE", s2.intent === "BEAUTY_SIMULATE");

  const s3 = classifyBeautyIntent("Faz uma simulação de coloração pra Ana amanhã");
  check(
    "'simulação de coloração pra Ana amanhã' → BEAUTY_SIMULATE",
    s3.intent === "BEAUTY_SIMULATE",
  );
  check("contactName='Ana' (não 'Amanhã')", s3.contactName === "Ana");
  check("serviceHint casa 'colora'", s3.serviceHint?.startsWith("colora") || false);

  const s4 = classifyBeautyIntent("Posso experimentar um balayage?");
  check("'experimentar balayage' → BEAUTY_SIMULATE", s4.intent === "BEAUTY_SIMULATE");
  check("serviceHint='balayage'", s4.serviceHint === "balayage");

  // ===== 3. BEAUTY_BOOK =====
  const b1 = classifyBeautyIntent("Marca a Bia pra escova sábado 10h");
  check("'marca ... pra escova ...' → BEAUTY_BOOK", b1.intent === "BEAUTY_BOOK");
  check("contactName='Bia'", b1.contactName === "Bia");
  check("serviceHint='escova'", b1.serviceHint === "escova");

  const b2 = classifyBeautyIntent("Agenda coloração pra Carla semana que vem");
  check("'agenda coloração pra Carla' → BEAUTY_BOOK", b2.intent === "BEAUTY_BOOK");

  // BOOK sem cheiro beauty NÃO deve classificar (deixa pro EVENT genérico)
  const bNoCue = classifyBeautyIntent("Marca a Denise pra terça 14h");
  check(
    "'marca a Denise pra terça' (sem cheiro beauty) → intent=null (não canibaliza EVENT)",
    bNoCue.intent === null,
  );

  const bWithSalon = classifyBeautyIntent("Marca a Denise no salão pra terça");
  check(
    "'marca ... no salão ...' (cheiro beauty via 'salão') → BEAUTY_BOOK",
    bWithSalon.intent === "BEAUTY_BOOK",
  );

  // ===== 4. BEAUTY_AVAILABILITY =====
  const a1 = classifyBeautyIntent("Tem horário livre pra Maria amanhã?");
  check(
    "'tem horário livre pra Maria amanhã?' → BEAUTY_AVAILABILITY",
    a1.intent === "BEAUTY_AVAILABILITY",
  );
  check("contactName='Maria' (não 'Amanhã')", a1.contactName === "Maria");

  const a2 = classifyBeautyIntent("Quando ela tem livre?");
  check("'quando ela tem livre' → BEAUTY_AVAILABILITY", a2.intent === "BEAUTY_AVAILABILITY");

  const a3 = classifyBeautyIntent("Tem vaga pra escova hoje?");
  check("'tem vaga pra escova hoje?' → BEAUTY_AVAILABILITY", a3.intent === "BEAUTY_AVAILABILITY");

  // ===== 5. Prioridade SIMULATE > BOOK > AVAILABILITY =====
  const p1 = classifyBeautyIntent("Quero simular mechas na Ana e depois marcar");
  check(
    "texto com SIMULATE + BOOK → SIMULATE ganha (prioridade)",
    p1.intent === "BEAUTY_SIMULATE",
  );

  // ===== 6. contactName NÃO captura palavras temporais =====
  const tw1 = classifyBeautyIntent("Marca coloração pra Amanhã");
  check(
    "'pra Amanhã' NÃO vira contactName (whitelist temporal)",
    tw1.contactName === null,
  );

  const tw2 = classifyBeautyIntent("Marca coloração pra Sábado");
  check(
    "'pra Sábado' NÃO vira contactName",
    tw2.contactName === null,
  );

  // ===== 7. contactName NÃO captura keyword de serviço =====
  const kw1 = classifyBeautyIntent("Marca a Escova pra Ana"); // ambíguo — 'Escova' é service
  check(
    "'Escova' capitalizada NÃO vira contactName (é serviço, não nome)",
    kw1.contactName !== "Escova",
  );

  // ===== 8. Texto vazio =====
  const e1 = classifyBeautyIntent("");
  check(
    "texto vazio → intent=null, entidades null",
    e1.intent === null && e1.contactName === null && e1.serviceHint === null,
  );

  const e2 = classifyBeautyIntent("   ");
  check(
    "texto só espaço → intent=null",
    e2.intent === null,
  );

  // ===== 9. Texto genérico não-beauty =====
  const g1 = classifyBeautyIntent("Comprar batata no mercado");
  check("texto de compra genérico → intent=null", g1.intent === null);

  const g2 = classifyBeautyIntent("Reunião com fornecedor às 15h");
  check("texto de reunião genérica → intent=null", g2.intent === null);

  // ===== 10. Determinismo =====
  const d1 = classifyBeautyIntent("Simula mechas na Ana");
  const d2 = classifyBeautyIntent("Simula mechas na Ana");
  check(
    "2 chamadas mesmo texto → mesmo resultado (determinismo)",
    JSON.stringify(d1) === JSON.stringify(d2),
  );

  // ===== 11. 0-regressão FalaTuService.classifyFalaTuListType =====
  const { classifyFalaTuListType } = await import("../src/server/FalaTuService.js");
  check(
    "FalaTuService.classifyFalaTuListType('lista de compras') === 'shopping' (intocado)",
    classifyFalaTuListType("lista de compras") === "shopping",
  );
  check(
    "FalaTuService.classifyFalaTuListType('itens da reunião') === 'general' (intocado)",
    classifyFalaTuListType("itens da reunião") === "general",
  );

  // ===== 12. Zero hardcoded Studio Márcia =====
  const forbiddenNeedles = [
    "studio_marcia",
    "studio de beleza márcia",
    "marcia_studio",
    "\"marcia\"",
    "'marcia'",
  ];
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
  check(
    "nenhum hardcoded do Studio Márcia em src/server ou src/features (§17/§65)",
    hardcoded === null,
    hardcoded || undefined,
  );

  // --- Relatório ---
  console.log("\n=== TEST: Beauty Fala Tu Intents (ADR-169 F15 / BEAUTY-016) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? "  [" + r.note + "]" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Classificador determinístico de intents beauty pronto — helper opt-in, 0-regressão no FalaTuService.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
