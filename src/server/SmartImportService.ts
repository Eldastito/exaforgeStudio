import { chat, extractStructuredFromImage, extractPdfText } from "./llm.js";

/**
 * Importação inteligente (ADR-101): recebe um PDF ou imagem e extrai linhas
 * estruturadas no schema da tela de destino, para o dono revisar antes de salvar
 * (preview obrigatório — NUNCA salva direto). Reusa a extração de PDF (pdf-parse)
 * e o multimodal (GPT-4o) já existentes.
 *
 * Um mecanismo, três telas: Catálogo (produtos), Prospecção (contas), Reservas
 * (recursos). O schema é a única coisa que muda; o núcleo é o mesmo.
 */

export interface SmartImportField { key: string; label: string; hint: string; }
export interface SmartImportSchema { domain: string; fields: SmartImportField[]; }

export const SMART_IMPORT_SCHEMAS: Record<string, SmartImportSchema> = {
  products: {
    domain: "um catálogo/lista de produtos de uma loja (varejo brasileiro)",
    fields: [
      { key: "nome", label: "Nome", hint: "nome comercial do produto" },
      { key: "preco", label: "Preço", hint: "preço de venda em reais, só o número (ex.: 89.90); vazio se não houver" },
      { key: "quantidade", label: "Qtd.", hint: "quantidade em estoque, só o número inteiro; vazio se não houver" },
      { key: "descricao", label: "Descrição", hint: "descrição curta do produto (ou vazio)" },
      { key: "tipo", label: "Tipo", hint: "'produto' ou 'servico' (padrão 'produto')" },
    ],
  },
  prospect: {
    domain: "uma lista de empresas/contatos para prospecção comercial",
    fields: [
      { key: "company", label: "Empresa", hint: "nome da empresa" },
      { key: "name", label: "Contato", hint: "nome da pessoa de contato (ou vazio)" },
      { key: "email", label: "E-mail", hint: "e-mail (ou vazio)" },
      { key: "phone", label: "Telefone", hint: "telefone/WhatsApp, só dígitos (ou vazio)" },
    ],
  },
  reservas: {
    domain: "uma lista de recursos reserváveis (quartos, mesas, salas, itens) com tarifas",
    fields: [
      { key: "name", label: "Recurso", hint: "nome do quarto/mesa/recurso" },
      { key: "price", label: "Preço", hint: "tarifa/diária em reais, só o número (ou vazio)" },
      { key: "capacity", label: "Capacidade", hint: "capacidade/quantidade de unidades, número inteiro (ou vazio)" },
      { key: "unit", label: "Unidade", hint: "unidade da tarifa: 'night', 'hour', 'day' (ou vazio)" },
    ],
  },
};

const MAX_TEXT = 12000; // teto de texto de PDF enviado à IA (controle de custo)

function buildSystem(schema: SmartImportSchema): string {
  const fieldLines = schema.fields.map(f => `  "${f.key}": ${f.hint}`).join(",\n");
  return `Você extrai registros tabulares de ${schema.domain}. Devolva SOMENTE um JSON no formato:
{"rows": [ { ${schema.fields.map(f => `"${f.key}": "..."`).join(", ")} } ], "warnings": ["avisos curtos se algo ficou ilegível/duvidoso"]}
Onde cada campo significa:
${fieldLines}
Regras rígidas: extraia SÓ o que está de fato no documento — NUNCA invente dados. Deixe o campo como string vazia ("") quando não houver a informação. Uma linha por registro. Ignore cabeçalhos, totais e rodapés. Se não conseguir ler algo, registre um aviso em "warnings" em vez de chutar. Responda SOMENTE o JSON.`;
}

export function normalizeRows(raw: string, schema: SmartImportSchema): { rows: any[]; warnings: string[] } {
  let parsed: any = {};
  try { parsed = JSON.parse(raw || "{}"); } catch { return { rows: [], warnings: ["Não consegui interpretar o retorno da IA."] }; }
  const rowsIn = Array.isArray(parsed?.rows) ? parsed.rows : (Array.isArray(parsed) ? parsed : []);
  const warnings: string[] = Array.isArray(parsed?.warnings) ? parsed.warnings.map((w: any) => String(w)).slice(0, 20) : [];
  const rows = rowsIn.slice(0, 2000).map((r: any) => {
    const out: Record<string, string> = {};
    for (const f of schema.fields) {
      const v = r?.[f.key];
      out[f.key] = v === null || v === undefined ? "" : String(v).trim();
    }
    return out;
  }).filter((r: any) => schema.fields.some(f => r[f.key])); // descarta linhas 100% vazias
  return { rows, warnings };
}

export class SmartImportService {
  static getSchema(type: string): SmartImportSchema | null {
    return SMART_IMPORT_SCHEMAS[type] || null;
  }

  /**
   * Extrai linhas de um arquivo (PDF ou imagem) no schema pedido. NÃO salva —
   * devolve as linhas para o preview. `warnings` sinaliza baixa confiança.
   */
  static async extract(buffer: Buffer, mimetype: string, type: string): Promise<{ ok: boolean; error?: string; rows?: any[]; warnings?: string[]; fields?: SmartImportField[] }> {
    const schema = this.getSchema(type);
    if (!schema) return { ok: false, error: "tipo_invalido" };
    const mt = (mimetype || "").toLowerCase();

    try {
      if (mt.includes("pdf")) {
        let text = "";
        try { text = await extractPdfText(buffer); } catch { /* noop */ }
        if (!text) {
          // PDF escaneado/sem texto: o multimodal não lê PDF direto. Orienta reenvio como imagem.
          return { ok: false, error: "pdf_sem_texto" };
        }
        const raw = await chat(`${buildSystem(schema)}\n\nCONTEÚDO DO DOCUMENTO:\n${text.slice(0, MAX_TEXT)}`, { json: true, temperature: 0 });
        const { rows, warnings } = normalizeRows(raw, schema);
        return { ok: true, rows, warnings, fields: schema.fields };
      }

      if (mt.startsWith("image/")) {
        const raw = await extractStructuredFromImage(buffer.toString("base64"), mimetype, buildSystem(schema));
        const { rows, warnings } = normalizeRows(raw, schema);
        return { ok: true, rows, warnings, fields: schema.fields };
      }

      return { ok: false, error: "formato_nao_suportado" };
    } catch (e: any) {
      console.error("[SmartImport] extração falhou:", e?.message || e);
      return { ok: false, error: "falha_na_extracao" };
    }
  }
}
