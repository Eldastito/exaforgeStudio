/**
 * TEST — Utilitário de comparação de telefones (ADR-051, Fase 2).
 *
 * Coração do roteamento do CoordenadorService: se essa função erra,
 * mensagens de um colaborador podem parar como "número desconhecido"
 * (falso negativo) ou executar comando em nome de outra pessoa
 * (falso positivo — grave).
 *
 * Uso: npm run test:phone-match
 */
import { phoneMatches, onlyDigits } from "../src/server/phoneMatch.js";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

// ==== 1. Casos claramente iguais ====
console.log("\n=== 1. Igualdade direta ===");
check("1.1 idênticos completos", phoneMatches("5511987654321", "5511987654321") === true);
check("1.2 idênticos curtos", phoneMatches("11987654321", "11987654321") === true);
check("1.3 idênticos com formatação", phoneMatches("+55 (11) 98765-4321", "5511987654321") === true);

// ==== 2. DDI presente/ausente ====
console.log("\n=== 2. DDI ausente vs presente ===");
check("2.1 com DDI vs sem DDI (11 dígitos)", phoneMatches("5511987654321", "11987654321") === true);
check("2.2 sem DDI vs com DDI (invertido)", phoneMatches("11987654321", "5511987654321") === true);

// ==== 3. 9º dígito adicional ====
console.log("\n=== 3. Nono dígito adicional ===");
// Antigo (10 dígitos): DDD + 8 dígitos. Novo (11 dígitos): DDD + 9 dígitos.
check("3.1 com 9 vs sem 9 (10 vs 11 dígitos)", phoneMatches("1187654321", "11987654321") === true);
check("3.2 sem 9 vs com 9 (invertido)", phoneMatches("11987654321", "1187654321") === true);
check("3.3 DDI + com 9 vs sem DDI e sem 9", phoneMatches("5511987654321", "1187654321") === true);

// ==== 4. NÃO devem casar ====
console.log("\n=== 4. Números claramente diferentes ===");
check("4.1 sufixos diferentes", phoneMatches("5511987654321", "5511987654322") === false);
check("4.2 DDDs diferentes", phoneMatches("11987654321", "21987654321") === false);
check("4.3 números totalmente diferentes", phoneMatches("5511987654321", "5521912345678") === false);

// ==== 5. Guards contra inputs inválidos ====
console.log("\n=== 5. Guards ===");
check("5.1 vazio × vazio", phoneMatches("", "") === false);
check("5.2 vazio × válido", phoneMatches("", "5511987654321") === false);
check("5.3 null × válido", phoneMatches(null, "5511987654321") === false);
check("5.4 undefined × válido", phoneMatches(undefined as any, "5511987654321") === false);
check("5.5 só letras × válido (extrai 0 dígitos = vazio)", phoneMatches("hello", "5511987654321") === false);

// ==== 6. Números curtos: proteção anti-falso-positivo ====
console.log("\n=== 6. Anti-falso-positivo ===");
// A regra k = min(11, max(8, min(x, y))) — se um for 3 dígitos, o mínimo dispara para 8.
// Mas 3 dígitos < 8, o slice(-8) devolve "3". Não deveria casar contra qualquer sufixo.
check("6.1 3 dígitos vs telefone completo (curto demais)", phoneMatches("321", "5511987654321") === false);
check("6.2 4 dígitos vs telefone completo", phoneMatches("4321", "5511987654321") === false);
// 8 dígitos EM PONTO — deve casar se coincidir com os últimos 8 do outro.
check("6.3 8 dígitos que coincidem com últimos 8 do longo", phoneMatches("87654321", "5511987654321") === true);
// 8 dígitos que NÃO coincidem
check("6.4 8 dígitos que NÃO coincidem", phoneMatches("87654322", "5511987654321") === false);

// ==== 7. Casos exóticos do mundo real ====
console.log("\n=== 7. Formatos reais do WhatsApp ===");
// WhatsApp Cloud API envia "5511987654321" (só dígitos, sem +).
// Evolution costuma vir "5511987654321@s.whatsapp.net" — mas o parser limpa antes.
// Interface do dono digita "(11) 98765-4321" ou "+55 11 98765 4321".
check("7.1 formato WhatsApp Cloud", phoneMatches("5511987654321", "(11) 98765-4321") === true);
check("7.2 formato +55 espaçado", phoneMatches("+55 11 98765 4321", "11987654321") === true);
check("7.3 formato com barra vertical (lixo)", phoneMatches("11|98765|4321", "11987654321") === true);

// ==== 8. onlyDigits helper ====
console.log("\n=== 8. onlyDigits helper ===");
check("8.1 extrai só dígitos", onlyDigits("+55 (11) 98765-4321") === "5511987654321");
check("8.2 vazio pra null", onlyDigits(null) === "");
check("8.3 vazio pra undefined", onlyDigits(undefined) === "");
check("8.4 só letras vira vazio", onlyDigits("abc") === "");

// ==== Relatório ====
console.log("\n=========================================");
console.log("RELATÓRIO — phoneMatches (ADR-051)");
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
