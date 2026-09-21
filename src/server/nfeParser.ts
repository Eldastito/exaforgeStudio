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
  ean: string | null;
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
      const rawEan = String(prod.cEAN || prod.cEANTrib || "").trim();
      const ean = rawEan && /^\d{8,14}$/.test(rawEan) && rawEan !== "SEM GTIN" ? rawEan : null;
      return {
        name: String(prod.xProd || "").trim().slice(0, 120),
        quantity: Math.max(0, Number(prod.qCom) || 0),
        unit: prod.uCom ? String(prod.uCom).trim().slice(0, 20) : null,
        unitCost: Math.max(0, Number(prod.vUnCom) || 0),
        ean,
      };
    })
    .filter((it: ParsedInvoiceItem) => it.name);

  return { supplierName, accessKey, items };
}

/* ==========================================================================
 * Parser EXPANDIDO — Entrada Automática de NF-e v1 (ADR-200, Fase 1).
 *
 * `parseNFeDocument` NÃO substitui `parseNFeXml` (que segue servindo o
 * importador legado sem mudança). É uma leitura mais rica e determinística que:
 *   - classifica a COMPLETUDE do documento (procNFe autorizado × resumo ×
 *     evento × assinado-sem-protocolo × inválido);
 *   - preserva `xProd` SEM truncar (descrição fiscal original);
 *   - mantém quantidade COMERCIAL e TRIBUTÁVEL como decimal (proibido parseInt);
 *   - extrai cProd, EAN/EANTrib, NCM, CFOP, valores, e guarda os grupos de
 *     imposto e a rastreabilidade como JSON bruto para normalização futura.
 *
 * Usa um XMLParser próprio com `parseTagValue:false`: assim `cProd`, `NCM`,
 * `CFOP` e códigos NÃO perdem zeros à esquerda, e os decimais são convertidos
 * explicitamente aqui (nunca truncados).
 * ========================================================================== */

/** Nível de completude do documento fiscal recebido. */
export type NFeContentLevel =
  | "authorized_process"    // NFe + protNFe autorizado (cStat 100/150) — único que segue automático
  | "signed_only"           // NFe presente, sem protocolo de autorização coerente
  | "summary_only"          // resNFe (resumo, sem itens)
  | "event_only"            // procEventoNFe (cancelamento, ciência, etc.)
  | "invalid";              // schema não reconhecido

/** Situação fiscal conhecida a partir do próprio XML (não é consulta online). */
export type NFeFiscalStatus = "unknown" | "authorized" | "cancelled" | "denied";

export interface ParsedNFeItem {
  itemNumber: number;
  supplierProductCode: string | null;   // cProd (preservado como string)
  fiscalDescription: string;             // xProd — NÃO truncado
  ean: string | null;                    // cEAN válido (8..14 díg.) ou null
  eanTax: string | null;                 // cEANTrib válido ou null
  ncm: string | null;
  cfop: string | null;
  commercialUnit: string | null;         // uCom
  commercialQty: number;                 // qCom (decimal)
  commercialUnitValue: number | null;    // vUnCom
  taxUnit: string | null;                // uTrib
  taxQty: number | null;                 // qTrib (decimal)
  taxUnitValue: number | null;           // vUnTrib
  grossValue: number | null;             // vProd
  discountValue: number | null;          // vDesc
  freightValue: number | null;           // vFrete
  otherValue: number | null;             // vOutro
  insuranceValue: number | null;         // vSeg
  taxJson: string | null;                // grupo <imposto> bruto (JSON)
  traceabilityJson: string | null;       // <rastro> bruto (JSON)
}

export interface ParsedNFeDocument {
  contentLevel: NFeContentLevel;
  fiscalStatus: NFeFiscalStatus;
  accessKey: string | null;              // 44 dígitos
  accessKeyValid: boolean;               // dígito verificador (mod 11) confere
  // cabeçalho
  model: string | null;                  // mod (55)
  number: string | null;                 // nNF
  series: string | null;                 // serie
  issueAt: string | null;                // dhEmi / dEmi
  issuerCnpj: string | null;
  issuerName: string | null;
  issuerIe: string | null;
  recipientCnpj: string | null;
  recipientName: string | null;
  // totais (ICMSTot)
  totalProducts: number | null;          // vProd
  totalInvoice: number | null;           // vNF
  freight: number | null;                // vFrete
  discount: number | null;               // vDesc
  otherExpenses: number | null;          // vOutro
  // protocolo
  protocolNumber: string | null;         // nProt
  protocolStatus: string | null;         // cStat
  authorizationAt: string | null;        // dhRecbto
  // evento (quando content_level = event_only)
  eventType: string | null;              // tpEvento
  eventSequence: number | null;          // nSeqEvento
  items: ParsedNFeItem[];
}

// Parser dedicado: parseTagValue:false preserva zeros à esquerda e o texto exato.
const docParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true, parseTagValue: false });

function firstDefined(...vals: any[]): any {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}
function str(v: any): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
/** Número decimal preservado (nunca trunca). Vazio/inválido → null. */
function dec(v: any): number | null {
  const s = str(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function digits44(raw: any): string | null {
  const m = String(raw ?? "").match(/(\d{44})/);
  return m ? m[1] : null;
}
function validEan(raw: any): string | null {
  const s = String(raw ?? "").trim();
  return s && s !== "SEM GTIN" && /^\d{8,14}$/.test(s) ? s : null;
}

/** Valida o dígito verificador (mod 11) de uma chave de acesso de 44 dígitos. */
export function isValidAccessKey(key: string | null): boolean {
  if (!key || !/^\d{44}$/.test(key)) return false;
  const base = key.slice(0, 43);
  let peso = 2, soma = 0;
  for (let i = base.length - 1; i >= 0; i--) { soma += Number(base[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
  let dv = 11 - (soma % 11);
  if (dv >= 10) dv = 0;
  return dv === Number(key[43]);
}

function parseItems(det: any): ParsedNFeItem[] {
  let list = det;
  if (!list) return [];
  if (!Array.isArray(list)) list = [list];
  return list.map((d: any, idx: number): ParsedNFeItem => {
    const prod = d?.prod || {};
    const itemNumber = Number(str(d?.["@_nItem"])) || idx + 1;
    return {
      itemNumber,
      supplierProductCode: str(prod.cProd),
      fiscalDescription: str(prod.xProd) ?? "",
      ean: validEan(prod.cEAN),
      eanTax: validEan(prod.cEANTrib),
      ncm: str(prod.NCM),
      cfop: str(prod.CFOP),
      commercialUnit: str(prod.uCom),
      commercialQty: dec(prod.qCom) ?? 0,
      commercialUnitValue: dec(prod.vUnCom),
      taxUnit: str(prod.uTrib),
      taxQty: dec(prod.qTrib),
      taxUnitValue: dec(prod.vUnTrib),
      grossValue: dec(prod.vProd),
      discountValue: dec(prod.vDesc),
      freightValue: dec(prod.vFrete),
      otherValue: dec(prod.vOutro),
      insuranceValue: dec(prod.vSeg),
      taxJson: d?.imposto ? JSON.stringify(d.imposto) : null,
      traceabilityJson: prod.rastro ? JSON.stringify(prod.rastro) : null,
    };
  });
}

function emptyDoc(level: NFeContentLevel): ParsedNFeDocument {
  return {
    contentLevel: level, fiscalStatus: "unknown", accessKey: null, accessKeyValid: false,
    model: null, number: null, series: null, issueAt: null,
    issuerCnpj: null, issuerName: null, issuerIe: null, recipientCnpj: null, recipientName: null,
    totalProducts: null, totalInvoice: null, freight: null, discount: null, otherExpenses: null,
    protocolNumber: null, protocolStatus: null, authorizationAt: null,
    eventType: null, eventSequence: null, items: [],
  };
}

/**
 * Lê um documento fiscal (procNFe, NFe isolada, resNFe ou procEventoNFe) e
 * devolve estrutura tipada + classificação de completude. Nunca lança por
 * schema desconhecido: retorna `contentLevel: "invalid"`.
 */
export function parseNFeDocument(xmlText: string): ParsedNFeDocument {
  let doc: any;
  try {
    doc = docParser.parse(xmlText);
  } catch {
    return emptyDoc("invalid");
  }

  // 1. Evento (cancelamento, ciência, etc.) --------------------------------
  const procEvento = doc?.procEventoNFe;
  if (procEvento) {
    const inf = procEvento?.evento?.infEvento || {};
    const ret = procEvento?.retEvento?.infEvento || {};
    const out = emptyDoc("event_only");
    out.accessKey = digits44(inf.chNFe) || digits44(ret.chNFe);
    out.accessKeyValid = isValidAccessKey(out.accessKey);
    out.eventType = str(inf.tpEvento);
    out.eventSequence = Number(str(inf.nSeqEvento)) || null;
    out.protocolNumber = str(ret.nProt);
    out.protocolStatus = str(ret.cStat);
    out.authorizationAt = str(ret.dhRegEvento) || str(inf.dhEvento);
    // 110111 = cancelamento (registrado: cStat 135/136/155)
    if (out.eventType === "110111" && ["135", "136", "155"].includes(out.protocolStatus || "")) {
      out.fiscalStatus = "cancelled";
    }
    return out;
  }

  // 2. Resumo (resNFe) -----------------------------------------------------
  const resNFe = doc?.resNFe;
  if (resNFe) {
    const out = emptyDoc("summary_only");
    out.accessKey = digits44(resNFe.chNFe);
    out.accessKeyValid = isValidAccessKey(out.accessKey);
    out.issuerCnpj = str(resNFe.CNPJ);
    out.issuerName = str(resNFe.xNome);
    out.issuerIe = str(resNFe.IE);
    out.issueAt = str(resNFe.dhEmi);
    out.totalInvoice = dec(resNFe.vNF);
    const cSit = str(resNFe.cSitNFe);
    out.fiscalStatus = cSit === "1" ? "authorized" : cSit === "2" ? "cancelled" : cSit === "3" ? "denied" : "unknown";
    return out;
  }

  // 3. NFe / procNFe -------------------------------------------------------
  const infNFe = firstDefined(doc?.nfeProc?.NFe?.infNFe, doc?.NFe?.infNFe, doc?.infNFe);
  if (!infNFe) return emptyDoc("invalid");

  const protNFe = firstDefined(doc?.nfeProc?.protNFe, doc?.protNFe);
  const infProt = protNFe?.infProt;
  const cStat = str(infProt?.cStat);
  const authorized = !!infProt && (cStat === "100" || cStat === "150");

  const out = emptyDoc(authorized ? "authorized_process" : "signed_only");
  const ide = infNFe?.ide || {};
  const emit = infNFe?.emit || {};
  const dest = infNFe?.dest || {};
  const icmsTot = infNFe?.total?.ICMSTot || {};

  out.accessKey = digits44(infNFe?.["@_Id"]) || digits44(infProt?.chNFe);
  out.accessKeyValid = isValidAccessKey(out.accessKey);
  out.model = str(ide.mod);
  out.number = str(ide.nNF);
  out.series = str(ide.serie);
  out.issueAt = str(ide.dhEmi) || str(ide.dEmi);
  out.issuerCnpj = str(emit.CNPJ);
  out.issuerName = str(emit.xNome);
  out.issuerIe = str(emit.IE);
  out.recipientCnpj = str(dest.CNPJ);
  out.recipientName = str(dest.xNome);
  out.totalProducts = dec(icmsTot.vProd);
  out.totalInvoice = dec(icmsTot.vNF);
  out.freight = dec(icmsTot.vFrete);
  out.discount = dec(icmsTot.vDesc);
  out.otherExpenses = dec(icmsTot.vOutro);
  out.protocolNumber = str(infProt?.nProt);
  out.protocolStatus = cStat;
  out.authorizationAt = str(infProt?.dhRecbto);
  // 110/301/302 = denegada; caso contrário desconhecida quando não autorizada.
  out.fiscalStatus = authorized ? "authorized" : (["110", "301", "302"].includes(cStat || "") ? "denied" : "unknown");
  out.items = parseItems(infNFe?.det);
  return out;
}
