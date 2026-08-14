/**
 * TEST — XSS armazenado no JSON-LD da loja pública (achado de injeção). Determinístico, sem DB.
 *
 * Prova que `jsonForScript` impede que dados do produto (nome/descrição digitados pelo lojista)
 * QUEBREM o bloco `<script type="application/ld+json">` e executem JavaScript no navegador do
 * visitante — mantendo o JSON válido (parseável de volta).
 *
 * Uso: npm run test:security-xss-jsonld
 */
import { jsonForScript } from "../src/server/htmlSafe.js";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// Payload de ataque num campo de formulário (nome do produto).
const evil = { "@type": "Product", name: "</script><script>alert(document.cookie)</script>", description: "a & b > c < d" };
const out = jsonForScript(evil);

check("1.1 saida nao contem '</script>' literal", !/<\/script>/i.test(out));
check("1.2 saida nao contem nenhum '<' literal", !out.includes("<"));
check("1.3 saida nao contem nenhum '>' literal", !out.includes(">"));
check("1.4 '&' foi escapado", !out.includes("&") && out.includes("\\u0026"));
check("1.5 o '<' virou \\u003c", out.includes("\\u003c"));
// O JSON continua VALIDO e volta identico ao original (o parser desfaz o \uXXXX).
let parsed: any = null; let parseOk = true;
try { parsed = JSON.parse(out); } catch { parseOk = false; }
check("1.6 saida ainda e JSON valido", parseOk);
check("1.7 round-trip preserva o valor original", parsed && parsed.name === evil.name && parsed.description === evil.description);

// Separadores de linha U+2028/U+2029 (quebram <script> em alguns parsers) escapados.
const U2028 = String.fromCharCode(0x2028), U2029 = String.fromCharCode(0x2029);
const sep = jsonForScript({ x: "a" + U2028 + "b" + U2029 + "c" });
check("2.1 U+2028 escapado", sep.includes("\\u2028") && !sep.includes(U2028));
check("2.2 U+2029 escapado", sep.includes("\\u2029") && !sep.includes(U2029));

// Objeto normal (sem caracteres perigosos) passa e parseia de volta.
const normal = jsonForScript({ name: "Camiseta Azul", price: "99.90" });
check("3.1 objeto normal parseia de volta", JSON.parse(normal).name === "Camiseta Azul");

const passed = results.filter((r) => r.ok).length;
for (const r of results) if (!r.ok) console.log("  x " + r.name);
console.log("\n" + (failures === 0 ? "OK" : "FAIL") + " security-xss-jsonld: " + passed + "/" + results.length + " checks");
process.exit(failures === 0 ? 0 : 1);
