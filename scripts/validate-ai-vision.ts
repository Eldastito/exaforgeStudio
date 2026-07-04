/**
 * VALIDAÇÃO — extração por visão de IA contra a API REAL (ADR-030)
 * ------------------------------------------------------------------
 * Fecha a ressalva registrada nas ADRs 019/020/021: as funções de visão
 * (extractProductFromImage, extractInvoiceItems) nunca foram exercitadas de
 * ponta a ponta porque o sandbox de desenvolvimento não tem OPENAI_API_KEY.
 *
 * ESTE script roda onde a chave EXISTE (ex.: terminal do container no
 * Coolify, onde a env já está configurada):
 *
 *     npm run validate:ai-vision
 *
 * O que ele faz:
 *   1. gera duas imagens JPEG sintéticas na hora (via sharp, sem depender de
 *      arquivo externo): um "rótulo de produto" e uma "nota fiscal" com 2
 *      itens — texto grande e nítido, o caso base que a IA TEM de acertar;
 *   2. chama as duas funções de visão reais (custa ~centavos de API);
 *   3. valida a estrutura e o conteúdo do retorno (nome extraído bate com o
 *      rótulo? itens/quantidades/custos batem com a nota? confidence no
 *      intervalo 0-100? preço NUNCA sugerido no produto?);
 *   4. imprime o JSON cru extraído (para inspeção humana) e sai com código
 *      0 (ok) ou 1 (falha) — dá para usar em CI/健康check se quiser.
 *
 * Custo: 2 chamadas de visão. Nenhum dado é gravado em banco algum — o
 * script não abre o SQLite do produto.
 */
import sharp from "sharp";

function svgLabel(): string {
  return `<svg width="900" height="700" xmlns="http://www.w3.org/2000/svg">
    <rect width="900" height="700" fill="#f5e9d0"/>
    <rect x="40" y="40" width="820" height="620" fill="#1a5c2a" rx="18"/>
    <text x="450" y="170" font-family="Arial" font-size="72" font-weight="bold" fill="#fff" text-anchor="middle">KICALDO</text>
    <text x="450" y="300" font-family="Arial" font-size="88" font-weight="bold" fill="#ffd94d" text-anchor="middle">FEIJÃO PRETO</text>
    <text x="450" y="400" font-family="Arial" font-size="54" fill="#fff" text-anchor="middle">TIPO 1</text>
    <text x="450" y="560" font-family="Arial" font-size="96" font-weight="bold" fill="#fff" text-anchor="middle">1 kg</text>
  </svg>`;
}

function svgInvoice(): string {
  return `<svg width="1000" height="800" xmlns="http://www.w3.org/2000/svg">
    <rect width="1000" height="800" fill="#ffffff"/>
    <text x="500" y="70" font-family="Arial" font-size="40" font-weight="bold" fill="#111" text-anchor="middle">NOTA FISCAL</text>
    <text x="500" y="120" font-family="Arial" font-size="30" fill="#111" text-anchor="middle">ATACADAO CENTRAL LTDA</text>
    <line x1="60" y1="160" x2="940" y2="160" stroke="#111" stroke-width="2"/>
    <text x="80" y="220" font-family="Arial" font-size="28" fill="#111">ITEM</text>
    <text x="560" y="220" font-family="Arial" font-size="28" fill="#111">QTD</text>
    <text x="700" y="220" font-family="Arial" font-size="28" fill="#111">VL UNIT</text>
    <text x="860" y="220" font-family="Arial" font-size="28" fill="#111">TOTAL</text>
    <text x="80" y="300" font-family="Arial" font-size="30" fill="#111">FEIJAO PRETO 1KG</text>
    <text x="560" y="300" font-family="Arial" font-size="30" fill="#111">20</text>
    <text x="700" y="300" font-family="Arial" font-size="30" fill="#111">6,35</text>
    <text x="860" y="300" font-family="Arial" font-size="30" fill="#111">127,00</text>
    <text x="80" y="380" font-family="Arial" font-size="30" fill="#111">ARROZ BRANCO 5KG</text>
    <text x="560" y="380" font-family="Arial" font-size="30" fill="#111">10</text>
    <text x="700" y="380" font-family="Arial" font-size="30" fill="#111">17,00</text>
    <text x="860" y="380" font-family="Arial" font-size="30" fill="#111">170,00</text>
    <line x1="60" y1="440" x2="940" y2="440" stroke="#111" stroke-width="2"/>
    <text x="860" y="510" font-family="Arial" font-size="34" font-weight="bold" fill="#111">297,00</text>
    <text x="700" y="510" font-family="Arial" font-size="30" fill="#111">TOTAL:</text>
  </svg>`;
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("\n⚠️  OPENAI_API_KEY não está definida neste ambiente.");
    console.error("Rode este script onde a chave existe (ex.: terminal do container no Coolify):");
    console.error("    npm run validate:ai-vision\n");
    process.exit(1);
  }

  const { extractProductFromImage, extractInvoiceItems } = await import("../src/server/llm.js");

  // ---- 1. foto de produto ----
  console.log("\n== Produto (extractProductFromImage) ==");
  const labelJpeg = await sharp(Buffer.from(svgLabel())).jpeg({ quality: 90 }).toBuffer();
  const rawProduct = await extractProductFromImage(labelJpeg.toString("base64"), "image/jpeg");
  console.log("JSON cru:", rawProduct);
  let prod: any = {};
  try { prod = JSON.parse(rawProduct); } catch { /* fica {} */ }

  check("Resposta é JSON válido", !!prod && typeof prod === "object" && Object.keys(prod).length > 0);
  check("Nome extraído menciona feijão preto", /feij(ã|a)o/i.test(prod.name || "") && /preto/i.test(prod.name || ""), `name=${prod.name}`);
  check("Peso/volume identificado (1 kg)", /1\s*kg/i.test(String(prod.weightLabel || prod.name || "")), `weightLabel=${prod.weightLabel}`);
  check("confidence é número em 0-100", Number.isFinite(Number(prod.confidence)) && prod.confidence >= 0 && prod.confidence <= 100, `confidence=${prod.confidence}`);
  check("NUNCA sugere preço (regra de produto)", !("price" in prod) && !("preco" in prod), `chaves=${Object.keys(prod).join(",")}`);

  // ---- 2. foto de nota fiscal ----
  console.log("\n== Nota fiscal (extractInvoiceItems) ==");
  const invoiceJpeg = await sharp(Buffer.from(svgInvoice())).jpeg({ quality: 90 }).toBuffer();
  const rawInvoice = await extractInvoiceItems(invoiceJpeg.toString("base64"), "image/jpeg");
  console.log("JSON cru:", rawInvoice);
  let inv: any = {};
  try { inv = JSON.parse(rawInvoice); } catch { /* fica {} */ }

  const items: any[] = Array.isArray(inv.items) ? inv.items : [];
  check("Resposta é JSON válido com array items", items.length > 0, `items=${items.length}`);
  check("Extraiu os 2 itens da nota (não inventou linha de total como item)", items.length === 2, `items=${items.length}`);
  const feijao = items.find((i) => /feij/i.test(i.name || ""));
  const arroz = items.find((i) => /arroz/i.test(i.name || ""));
  check("Item feijão: quantidade 20 e custo ~6,35", !!feijao && Number(feijao.quantity) === 20 && Math.abs(Number(feijao.unitCost) - 6.35) < 0.01, `qtd=${feijao?.quantity} custo=${feijao?.unitCost}`);
  check("Item arroz: quantidade 10 e custo ~17,00", !!arroz && Number(arroz.quantity) === 10 && Math.abs(Number(arroz.unitCost) - 17.0) < 0.01, `qtd=${arroz?.quantity} custo=${arroz?.unitCost}`);
  check("Fornecedor identificado", /atacad/i.test(String(inv.supplierName || "")), `supplierName=${inv.supplierName}`);
  check("confidence geral em 0-100", Number.isFinite(Number(inv.confidence)) && inv.confidence >= 0 && inv.confidence <= 100, `confidence=${inv.confidence}`);

  console.log(failures === 0
    ? "\n🎉 Visão de IA validada contra a API real — a ressalva das ADRs 019/020/021 está fechada."
    : `\n⚠️  ${failures} verificação(ões) falharam — inspecione o JSON cru acima antes de confiar na extração em produção.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro fatal na validação:", e);
  process.exit(1);
});
