/**
 * TEST — Grimoire de copy operacional (ADR-155 F1.1).
 *
 * Validador ESTRUTURAL determinístico de docs/grimoire/copy/: INDEX de
 * roteamento íntegro, sem rubrica órfã, cada rubrica no formato de contrato
 * (frontmatter + as 5 seções), atribuição MIT onde derivado do marketingskills,
 * os 4 núcleos presentes. É o próprio padrão grimoire aplicado a si mesmo
 * ("scripts enforçam estrutura"). Sem runtime — o GrimoireService é a F1.2.
 *
 * Uso: npm run test:grimoire-copy
 */
import fs from "fs";
import path from "path";

const ROOT = path.resolve("docs/grimoire/copy");

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const REQUIRED_SECTIONS = ["## Quando aplicar", "## Deve conter", "## Nunca fazer", "## Exemplos", "## Lições"];
const REQUIRED_FM = ["id", "estagio", "modulos", "fonte", "versao"];
const NUCLEOS = ["churn-risk-scoring", "dunning-cadence", "save-offer-ladder", "sequence-timing"];
const NON_RUBRIC = new Set(["_TEMPLATE.md", "README.md"]);

function parseFrontmatter(raw: string): Record<string, any> | null {
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return null;
  const fm: Record<string, any> = {};
  for (const line of raw.slice(3, end).trim().split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val: any = line.slice(idx + 1).trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      val = val.slice(1, -1).split(",").map((s: string) => s.trim()).filter(Boolean);
    }
    fm[key] = val;
  }
  return fm;
}

function main() {
  // ===== 1. INDEX.json íntegro =====
  const indexPath = path.join(ROOT, "INDEX.json");
  check("INDEX.json existe", fs.existsSync(indexPath));
  let index: any = {};
  try { index = JSON.parse(fs.readFileSync(indexPath, "utf8")); check("INDEX.json é JSON válido", true); }
  catch { check("INDEX.json é JSON válido", false); }
  check("INDEX tem schemaVersion", typeof index.schemaVersion === "number");
  check("INDEX tem estagios[]", Array.isArray(index.estagios) && index.estagios.length > 0);
  check("INDEX tem modulos{}", !!index.modulos && typeof index.modulos === "object");

  const estagios: string[] = index.estagios || [];
  const modulos: string[] = Object.keys(index.modulos || {});

  // ===== 2. cada estágio é uma pasta existente =====
  for (const e of estagios) check(`pasta do estágio '${e}' existe`, fs.existsSync(path.join(ROOT, e)) && fs.statSync(path.join(ROOT, e)).isDirectory());

  // ===== 3. módulos esperados + todos os estágios mapeados =====
  for (const m of ["cobranca", "recuperacao", "falatu"]) check(`módulo '${m}' no INDEX`, modulos.includes(m));
  for (const m of modulos) for (const e of estagios) check(`'${m}' mapeia estágio '${e}'`, Array.isArray(index.modulos[m]?.[e]) && index.modulos[m][e].length > 0);

  // rubricas referenciadas no INDEX
  const referenced = new Set<string>();
  for (const m of modulos) for (const e of estagios) for (const rel of (index.modulos[m]?.[e] || [])) referenced.add(rel);

  // ===== 4. cada rubrica referenciada existe em disco =====
  for (const rel of referenced) check(`rubrica referenciada existe: ${rel}`, fs.existsSync(path.join(ROOT, rel)));

  // rubricas em disco (por estágio)
  const onDisk: string[] = [];
  for (const e of estagios) {
    const dir = path.join(ROOT, e);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".md") && !NON_RUBRIC.has(f)) onDisk.push(`${e}/${f}`);
  }
  check("há rubricas em disco", onDisk.length > 0);

  // ===== 5. sem órfã: toda rubrica em disco está roteada =====
  for (const rel of onDisk) check(`rubrica em disco está no INDEX: ${rel}`, referenced.has(rel));

  // ===== 6. contrato de cada rubrica =====
  const idsSeen = new Set<string>();
  for (const rel of onDisk) {
    const raw = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const fm = parseFrontmatter(raw);
    check(`${rel}: tem frontmatter`, !!fm);
    if (!fm) continue;
    for (const k of REQUIRED_FM) check(`${rel}: frontmatter tem '${k}'`, fm[k] !== undefined && String(fm[k]).length > 0);
    check(`${rel}: modulos é lista não-vazia`, Array.isArray(fm.modulos) && fm.modulos.length > 0);
    check(`${rel}: estagio bate com a pasta`, fm.estagio === rel.split("/")[0]);
    check(`${rel}: id único`, typeof fm.id === "string" && !idsSeen.has(fm.id));
    if (typeof fm.id === "string") idsSeen.add(fm.id);
    if (Array.isArray(fm.modulos)) check(`${rel}: modulos todos conhecidos`, fm.modulos.every((x: string) => modulos.includes(x)));
    for (const s of REQUIRED_SECTIONS) check(`${rel}: seção '${s}'`, raw.includes(s));
    const fonte = String(fm.fonte || "");
    if (fonte.includes("marketingskills")) check(`${rel}: derivado cita atribuição MIT`, fonte.includes("MIT"));
  }

  // ===== 7. os 4 núcleos existem por id =====
  for (const n of NUCLEOS) check(`núcleo presente: ${n}`, idsSeen.has(n));

  // ===== resultado =====
  console.log("\n=== Grimoire de copy — validação estrutural (ADR-155 F1.1) ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checagens ok`);
  if (failures > 0) { console.error(`\n❌ ${failures} falha(s)`); process.exit(1); }
  console.log("\n✅ grimoire íntegro");
}

main();
