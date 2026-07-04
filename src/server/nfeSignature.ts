import { SignedXml } from "xml-crypto";
import { DOMParser } from "@xmldom/xmldom";
import * as xpath from "xpath";
import { X509Certificate } from "node:crypto";

/**
 * Verificação LOCAL da assinatura digital da NF-e (backlog ADR-029, item 29).
 *
 * O que isto verifica: que o XML tem uma assinatura XML-DSig íntegra
 * (digest do conteúdo assinado bate + assinatura RSA confere com o
 * certificado embutido) e extrai quem assinou e a validade do certificado.
 * Um XML adulterado depois de assinado, ou fabricado sem assinatura, é
 * detectado aqui.
 *
 * O que isto NÃO verifica (deliberado, documentado na ADR): a situação da
 * nota na Sefaz (autorizada/cancelada) e a cadeia do certificado até a raiz
 * ICP-Brasil — a consulta online exige certificado digital da própria
 * organização (infraestrutura que não existe no produto hoje). Por isso o
 * resultado é INFORMATIVO: a importação nunca é bloqueada por assinatura —
 * o lojista importando a própria compra vê o aviso e decide.
 */
export interface NFeSignatureCheck {
  signed: boolean;
  valid: boolean | null; // null = sem assinatura para verificar
  certSubject: string | null;
  certIssuer: string | null;
  certNotAfter: string | null;
  certExpired: boolean | null;
  error: string | null;
}

const NOT_SIGNED: NFeSignatureCheck = { signed: false, valid: null, certSubject: null, certIssuer: null, certNotAfter: null, certExpired: null, error: null };

export function verifyNFeSignature(xmlText: string): NFeSignatureCheck {
  try {
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    const sigNode = (xpath.select(
      "//*[local-name(.)='Signature' and namespace-uri(.)='http://www.w3.org/2000/09/xmldsig#']",
      doc as any
    ) as any[])[0];
    if (!sigNode) return { ...NOT_SIGNED };

    const certB64 = String(
      (xpath.select("string(.//*[local-name(.)='X509Certificate'])", sigNode) as any) || ""
    ).replace(/\s+/g, "");
    if (!certB64) {
      return { ...NOT_SIGNED, signed: true, valid: false, error: "Assinatura sem certificado embutido (X509Certificate ausente)." };
    }
    const certPem = `-----BEGIN CERTIFICATE-----\n${(certB64.match(/.{1,64}/g) || []).join("\n")}\n-----END CERTIFICATE-----`;

    let certSubject: string | null = null;
    let certIssuer: string | null = null;
    let certNotAfter: string | null = null;
    let certExpired: boolean | null = null;
    try {
      const cert = new X509Certificate(certPem);
      certSubject = cert.subject?.split("\n").find((l) => l.startsWith("CN="))?.slice(3) || cert.subject || null;
      certIssuer = cert.issuer?.split("\n").find((l) => l.startsWith("CN="))?.slice(3) || cert.issuer || null;
      certNotAfter = cert.validTo || null;
      certExpired = certNotAfter ? new Date(certNotAfter).getTime() < Date.now() : null;
    } catch { /* certificado ilegível: segue só com a verificação criptográfica */ }

    const sig = new SignedXml({ publicCert: certPem });
    sig.loadSignature(sigNode);
    let valid = false;
    let error: string | null = null;
    try {
      valid = sig.checkSignature(xmlText);
      if (!valid) error = "Digest/assinatura não conferem — o conteúdo foi alterado depois de assinado.";
    } catch (e: any) {
      valid = false;
      error = e?.message || "Falha ao verificar a assinatura.";
    }

    return { signed: true, valid, certSubject, certIssuer, certNotAfter, certExpired, error };
  } catch (e: any) {
    return { ...NOT_SIGNED, error: e?.message || "Falha ao inspecionar o XML." };
  }
}
