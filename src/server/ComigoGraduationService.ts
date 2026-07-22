import db from "./db.js";

/**
 * ZappFlow Comigo — Graduação MEI + nota fiscal (ADR-122 / ADR-088 graduação).
 *
 * ORIENTA a formalização (não emite fiscal): detecta quando vale virar MEI pelo
 * faturamento que o Comigo já registra e conduz os passos, em linguagem de gente.
 * Emissão real de NF-e (certificado + SEFAZ) fica fora — é integração futura.
 * Isolado por organization_id.
 */

// Teto do MEI (R$/ano). Centralizado aqui — muda por lei; fácil de atualizar.
export const MEI_ANNUAL_LIMIT = 81000;

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// Passos da formalização MEI (gratuito no gov.br/empreendedor).
const MEI_STEPS = [
  "Tenha em mãos seu CPF, RG e o título de eleitor (ou recibo do IR).",
  "Acesse gov.br/empreendedor e faça login na conta gov.br.",
  "Escolha suas atividades (o que você vende/faz) e o nome fantasia.",
  "Confirme o endereço do negócio (pode ser sua casa).",
  "Pronto: sai o CNPJ na hora. Guarde o Certificado da Condição de MEI (CCMEI).",
  "Todo mês pague o DAS (guia única, valor fixo baixo) — garante seu INSS.",
];

export class ComigoGraduationService {
  static status(orgId: string) {
    const o = db.prepare("SELECT comigo_formalization, comigo_cnpj FROM organization_settings WHERE organization_id = ?").get(orgId) as any || {};
    const formalization = o.comigo_formalization || "informal";

    // Faturamento: 12 meses cheios + média dos últimos 90 dias (projeção adiante).
    const rev12 = (db.prepare("SELECT COALESCE(SUM(total),0) s FROM comigo_orders WHERE organization_id = ? AND status IN ('paid','done') AND created_at >= datetime('now','-365 days')").get(orgId) as any).s;
    const rev90 = (db.prepare("SELECT COALESCE(SUM(total),0) s FROM comigo_orders WHERE organization_id = ? AND status IN ('paid','done') AND created_at >= datetime('now','-90 days')").get(orgId) as any).s;
    const monthlyAvg = round2(rev90 / 3);
    const projectedAnnual = round2(monthlyAvg * 12);
    const pctOfMei = MEI_ANNUAL_LIMIT > 0 ? round2((projectedAnnual / MEI_ANNUAL_LIMIT) * 100) : 0;

    let readiness: "cedo" | "vale_formalizar" | "perto_do_teto" | "acima_mei";
    if (projectedAnnual < 12000) readiness = "cedo";
    else if (projectedAnnual <= 70000) readiness = "vale_formalizar";
    else if (projectedAnnual <= MEI_ANNUAL_LIMIT) readiness = "perto_do_teto";
    else readiness = "acima_mei";

    const formalized = formalization !== "informal";
    let recommendation: string;
    if (formalized) {
      recommendation = readiness === "acima_mei"
        ? "Seu faturamento passou do teto do MEI. Fale com um contador sobre virar Microempresa (ME)."
        : readiness === "perto_do_teto"
          ? "Você está chegando perto do teto do MEI (R$ 81 mil/ano). Fique de olho pra não estourar."
          : "Tudo certo com sua formalização. Emita nota quando o cliente pedir.";
    } else if (readiness === "cedo") {
      recommendation = "Ainda dá pra focar em crescer. Quando o movimento firmar, viramos MEI juntos — é grátis e rápido.";
    } else if (readiness === "acima_mei") {
      recommendation = "Seu negócio já fatura acima do MEI — vale procurar um contador pra abrir como ME e emitir nota.";
    } else {
      recommendation = "Seu movimento já justifica virar MEI: você passa a emitir nota, garante seu INSS e destrava crédito. É grátis no gov.br/empreendedor.";
    }

    const notaFiscal = formalized
      ? { canIssue: true, text: "Como MEI, você emite Nota Fiscal de Serviço (NFS-e) pelo portal do seu município, ou nota avulsa. Para produto a consumidor, a nota costuma ser opcional — emita quando pedirem." }
      : { canIssue: false, text: "Nota fiscal exige CNPJ. Vire MEI primeiro — aí a nota fica liberada." };

    return {
      formalization,
      cnpj: o.comigo_cnpj || null,
      revenue12mo: round2(rev12),
      monthlyAvg,
      projectedAnnual,
      meiLimit: MEI_ANNUAL_LIMIT,
      pctOfMei,
      readiness,
      formalized,
      recommendation,
      steps: formalized ? [] : MEI_STEPS,
      notaFiscal,
    };
  }

  static declare(orgId: string, params: { type?: string; cnpj?: string }) {
    const type = ["mei", "empresa", "informal"].includes(String(params.type)) ? String(params.type) : "mei";
    db.prepare("UPDATE organization_settings SET comigo_formalization = ?, comigo_cnpj = ? WHERE organization_id = ?")
      .run(type, (params.cnpj || "").replace(/\D/g, "").slice(0, 14) || null, orgId);
    return this.status(orgId);
  }
}

export default ComigoGraduationService;
