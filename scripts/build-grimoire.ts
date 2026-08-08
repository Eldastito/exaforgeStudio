/**
 * build-grimoire — compila docs/grimoire/copy/** num módulo TS embarcável
 * (src/server/grimoire/compiled.ts), consumido pelo GrimoireService (ADR-155
 * F1.2, padrão 4 grimoire).
 *
 * POR QUÊ compilar em vez de ler fs em runtime: o server é bundlado por esbuild
 * (`--packages=external`); depender de ler docs/ em runtime seria frágil (path
 * não embarcado no deploy). Compilar num .ts versionado deixa o grimoire
 * determinístico, embarcado no bundle e diffável no PR.
 *
 * O arquivo gerado é COMMITADO; o test:grimoire-service confere que está em
 * sync (freshness). Rode `npm run grimoire:build` após editar o grimoire.
 *
 * Uso: npm run grimoire:build
 */
import fs from "fs";
import path from "path";

const ROOT = path.resolve("docs/grimoire/copy");
const OUT = path.resolve("src/server/grimoire/compiled.ts");
const NON_RUBRIC = new Set(["_TEMPLATE.md", "README.md"]);

interface Rubric { id: string; estagio: string; modulos: string[]; fonte: string; versao: string; titulo: string; corpo: string; }

function parseFrontmatter(raw: string): { fm: Record<string, any>; body: string } {
  if (!raw.startsWith("---")) return { fm: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { fm: {}, body: raw };
  const fm: Record<string, any> = {};
  for (const line of raw.slice(3, end).trim().split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val: any = line.slice(idx + 1).trim();
    if (val.startsWith("[") && val.endsWith("]")) val = val.slice(1, -1).split(",").map((s: string) => s.trim()).filter(Boolean);
    fm[key] = val;
  }
  // corpo = tudo após o bloco de frontmatter (após a linha "---" de fechamento)
  const bodyStart = raw.indexOf("\n", end + 1);
  const body = bodyStart === -1 ? "" : raw.slice(bodyStart + 1).trim();
  return { fm, body };
}

function firstHeading(body: string): string {
  for (const line of body.split("\n")) if (line.startsWith("# ")) return line.slice(2).trim();
  return "";
}

/** Coleta as rubricas em disco (paths ordenados, determinístico). */
function collectRubrics(): Record<string, Rubric> {
  const estagios: string[] = JSON.parse(fs.readFileSync(path.join(ROOT, "INDEX.json"), "utf8")).estagios;
  const out: Record<string, Rubric> = {};
  const rels: string[] = [];
  for (const e of estagios) {
    const dir = path.join(ROOT, e);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith(".md") && !NON_RUBRIC.has(f)) rels.push(`${e}/${f}`);
  }
  rels.sort();
  for (const rel of rels) {
    const { fm, body } = parseFrontmatter(fs.readFileSync(path.join(ROOT, rel), "utf8"));
    out[rel] = {
      id: String(fm.id ?? ""),
      estagio: String(fm.estagio ?? ""),
      modulos: Array.isArray(fm.modulos) ? fm.modulos : [],
      fonte: String(fm.fonte ?? ""),
      versao: String(fm.versao ?? ""),
      titulo: firstHeading(body),
      corpo: body,
    };
  }
  return out;
}

/** Gera o CONTEÚDO do módulo compilado (string). Puro — não escreve nada. */
export function buildGrimoireModule(): string {
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, "INDEX.json"), "utf8"));
  const rubrics = collectRubrics();
  return `// AUTO-GERADO por scripts/build-grimoire.ts a partir de docs/grimoire/copy/**.
// NAO EDITAR A MAO — rode \`npm run grimoire:build\` apos alterar o grimoire.
// Fonte compilada e diffavel que o GrimoireService consome (ADR-155 F1.2).

export interface GrimoireRubric {
  id: string;
  estagio: string;
  modulos: string[];
  fonte: string;
  versao: string;
  titulo: string;
  corpo: string;
}

export const GRIMOIRE_INDEX = ${JSON.stringify(index, null, 2)} as const;

export const GRIMOIRE_RUBRICS: Record<string, GrimoireRubric> = ${JSON.stringify(rubrics, null, 2)};
`;
}

// Escreve só quando invocado diretamente (o test importa buildGrimoireModule sem escrever).
if (process.argv[1] && process.argv[1].includes("build-grimoire")) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, buildGrimoireModule());
  console.log(`✅ grimoire compilado → ${path.relative(process.cwd(), OUT)}`);
}
