import { XMLParser } from "fast-xml-parser";

/**
 * Leitura do XML de NF-e (Smart Inventory Fase 2, ADR-022) — extrai os itens
 * de mercadoria de uma Nota Fiscal Eletrônica sem precisar de IA: o XML já é
 * dado estruturado e assinado digitalmente, muito mais confiável que OCR de
 * foto (Fase 1, ADR-021). O parser aceita tanto o XML "autorizado" (envelope
 * `nfeProc > NFe > infNFe`, como as prefeituras/Sefaz devolvem) quanto o XML
 * assinado isolado (`NFe > infNFe`), e ignora qualquer prefixo de namespace
 * (`nfe:NFe`, `ns2:det`, etc.) — schemas de NF-e variam por emissor/Sefaz.
 */
export interface ParsedInvoiceItem {
  name: string;
  quantity: number;
  unit: string | null;
  unitCost: number;
}

export interface ParsedInvoice {
  supplierName: string | null;
  items: ParsedInvoiceItem[];
}

const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true });

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

  let detList = infNFe.det;
  if (!detList) return { supplierName, items: [] };
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

  return { supplierName, items };
}
