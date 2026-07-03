import { XMLParser } from "fast-xml-parser";

/**
 * Leitura do XML de NF-e (Smart Inventory Fase 2, ADR-022; chave de acesso
 * adicionada na ADR-024) — extrai os itens de mercadoria de uma Nota Fiscal
 * Eletrônica sem precisar de IA: o XML já é dado estruturado e assinado
 * digitalmente, muito mais confiável que OCR de foto (Fase 1, ADR-021). O
 * parser aceita tanto o XML "autorizado" (envelope `nfeProc > NFe > infNFe`,
 * como as prefeituras/Sefaz devolvem) quanto o XML assinado isolado
 * (`NFe > infNFe`), e ignora qualquer prefixo de namespace (`nfe:NFe`,
 * `ns2:det`, etc.) — schemas de NF-e variam por emissor/Sefaz.
 */
export interface ParsedInvoiceItem {
  name: string;
  quantity: number;
  unit: string | null;
  unitCost: number;
}

export interface ParsedInvoice {
  supplierName: string | null;
  /** Chave de acesso da NF-e (44 dígitos, do atributo Id="NFe...") — usada para dedupe de importação. */
  accessKey: string | null;
  items: ParsedInvoiceItem[];
}

// ignoreAttributes: false porque a chave de acesso mora no ATRIBUTO
// Id="NFe<44 dígitos>" de <infNFe> — sem ela não há como detectar a
// reimportação da mesma nota (ADR-024).
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });

export function parseNFeXml(xmlText: string): ParsedInvoice {
  let doc: any;
  try {
    doc = parser.parse(xmlText);
  } catch (e: any) {
    throw new Error("Não foi possível ler este arquivo como XML. Confirme que é um XML de NF-e válido.");
  }

  const infNFe = doc?.nfeProc?.NFe?.infNFe || doc?.NFe?.infNFe || doc?.infNFe;
  if (!infNFe) {
    throw new Error("Este XML não parece ser uma NF-e (a tag <infNFe> não foi encontrada).");
  }

  const supplierName = infNFe?.emit?.xNome ? String(infNFe.emit.xNome).trim().slice(0, 120) : null;

  // Id vem como "NFe" + 44 dígitos; guarda só os dígitos. Se o atributo não
  // existir ou vier fora do padrão, segue sem chave (dedupe fica indisponível
  // para essa nota, mas a importação em si não é bloqueada por isso).
  const rawId = String(infNFe?.["@_Id"] || "");
  const keyMatch = rawId.match(/(\d{44})/);
  const accessKey = keyMatch ? keyMatch[1] : null;

  let detList = infNFe.det;
  if (!detList) return { supplierName, accessKey, items: [] };
  if (!Array.isArray(detList)) detList = [detList];

  const items: ParsedInvoiceItem[] = detList
    .map((det: any) => {
      const prod = det?.prod || {};
      return {
        name: String(prod.xProd || "").trim().slice(0, 120),
        quantity: Math.max(0, Number(prod.qCom) || 0),
        unit: prod.uCom ? String(prod.uCom).trim().slice(0, 20) : null,
        unitCost: Math.max(0, Number(prod.vUnCom) || 0),
      };
    })
    .filter((it: ParsedInvoiceItem) => it.name);

  return { supplierName, accessKey, items };
}
