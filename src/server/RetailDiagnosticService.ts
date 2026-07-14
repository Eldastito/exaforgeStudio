/**
 * Retail Ops — Diagnóstico de onboarding + motor de composição (ADR-084 D3/D6).
 *
 * O fluxo do ADR-084 D3 é: diagnóstico curto → PRÉVIA do que será ativado →
 * confirmação → aplica. Esta fatia entrega as PERGUNTAS e o MOTOR de recomendação
 * (função pura, sem efeito colateral): a partir das respostas, recomenda os
 * módulos, o modo de estoque e as capacidades — separando o que já existe do que
 * ainda está por vir. A APLICAÇÃO (confirmação) é fatia seguinte.
 *
 * As respostas ativam CAPACIDADES, não "nichos" (ADR-084 D1/D6).
 */
import { ModuleService } from "./ModuleService.js";
import { RetailStockModeService } from "./RetailStockModeService.js";
import { RetailActivationService } from "./RetailActivationService.js";
import { logAuthEvent } from "./auditLog.js";

export type DiagnosticAnswers = {
  units?: "single" | "multi";
  saleUnit?: "unit" | "weight" | "measure" | "recipe";
  variants?: boolean;
  production?: boolean;
  channels?: string[];            // whatsapp | balcao | ecommerce | delivery | mesa
  externalPdv?: boolean;
  storeOps?: boolean;             // metas/fechamento/comissão por loja
};

/** As 7 perguntas do diagnóstico (para a UI). */
export const DIAGNOSTIC_QUESTIONS = [
  { key: "units", label: "Você tem uma ou várias unidades/lojas?", type: "single", options: [{ value: "single", label: "Uma" }, { value: "multi", label: "Várias" }] },
  { key: "saleUnit", label: "Como você vende o produto?", type: "single", options: [{ value: "unit", label: "Por unidade" }, { value: "weight", label: "Por peso" }, { value: "measure", label: "Por medida (metro/litro)" }, { value: "recipe", label: "Preparado/por receita" }] },
  { key: "variants", label: "Seus produtos têm variações (tamanho, cor, modelo)?", type: "boolean" },
  { key: "production", label: "Você fabrica ou prepara os produtos?", type: "boolean" },
  { key: "channels", label: "Por onde você vende?", type: "multi", options: [{ value: "whatsapp", label: "WhatsApp" }, { value: "balcao", label: "Balcão" }, { value: "ecommerce", label: "E-commerce" }, { value: "delivery", label: "Delivery" }, { value: "mesa", label: "Mesa/salão" }] },
  { key: "externalPdv", label: "Você já usa um ERP/PDV externo?", type: "boolean" },
  { key: "storeOps", label: "Você trabalha com metas, fechamento diário e comissão por loja?", type: "boolean" },
] as const;

type Capability = { key: string; label: string; available: boolean };

export class RetailDiagnosticService {
  static questions() { return DIAGNOSTIC_QUESTIONS; }

  /**
   * Motor de composição: respostas → recomendação (prévia). Função pura.
   * `modules` = módulos opcionais sugeridos; `stockMode` = fonte da verdade;
   * `retailNetworkOps` = ligar o add-on de rede; `capabilities` = o que acende
   * (available) vs. o que ainda está por vir (available=false); `notes` = avisos.
   */
  static recommend(answers: DiagnosticAnswers): {
    modules: string[]; stockMode: "native" | "supervised"; retailNetworkOps: boolean;
    capabilities: Capability[]; notes: string[];
  } {
    const a = answers || {};
    const channels = Array.isArray(a.channels) ? a.channels : [];
    const notes: string[] = [];

    // Módulos-base de comércio (sempre úteis).
    const modules = new Set<string>(["catalogo", "vendas", "pagamentos", "campanhas", "cadencias", "integracoes", "diretor", "rie", "execucao"]);
    if (channels.includes("ecommerce")) modules.add("loja");

    // Retail Network Ops: opera rede a supervisionar? (metas/fechamento OU multi).
    const retailNetworkOps = !!a.storeOps || a.units === "multi";
    if (retailNetworkOps) modules.add("retail");

    // Fonte da verdade do estoque (ADR-084 D4).
    const stockMode: "native" | "supervised" = a.externalPdv ? "supervised" : "native";
    if (a.units === "multi" && !a.externalPdv) {
      notes.push("Multiloja nativo (estoque por loja no próprio ZappFlow) ainda não está disponível — comece supervisionado (integrando seu PDV) ou loja a loja, e migre depois.");
    }

    // Capacidades: o que já existe × o que ainda vem.
    const capabilities: Capability[] = [
      { key: "variants", label: "Variações (tamanho/cor/modelo)", available: true },
      { key: "weight", label: "Venda por peso/medida", available: false },
      { key: "recipe", label: "Produção por receita (ficha técnica)", available: false },
      { key: "perishable", label: "Lote e validade (perecíveis)", available: false },
    ];
    if (a.variants) notes.push("Variações já são suportadas — ative na configuração do catálogo.");
    if (a.saleUnit === "weight" || a.saleUnit === "measure") notes.push("Venda por peso/medida está no roadmap — por ora, cadastre por unidade equivalente.");
    if (a.production || a.saleUnit === "recipe") notes.push("Produção por receita (baixa por ingrediente) está no roadmap.");

    return {
      modules: [...modules],
      stockMode,
      retailNetworkOps,
      capabilities,
      notes,
    };
  }

  /**
   * Aplica a recomendação (a "confirmação" do fluxo ADR-084 D3): módulos + modo
   * de estoque + ativação do Retail Network Ops. Reusa os serviços já existentes.
   * Une os módulos recomendados aos já habilitados (não remove o que a org tem —
   * grandfather). Auditado. Retorna o que foi aplicado.
   */
  static apply(orgId: string, answers: DiagnosticAnswers, actorId?: string): {
    applied: { modules: string[]; stockMode: "native" | "supervised"; retailActivated: boolean };
    recommendation: ReturnType<typeof RetailDiagnosticService.recommend>;
  } {
    const rec = this.recommend(answers);

    const current = ModuleService.enabledModules(orgId);
    const merged = [...new Set([...(Array.isArray(current) ? current : []), ...rec.modules])];
    const modules = ModuleService.setModules(orgId, merged);

    RetailStockModeService.setOrgMode(orgId, rec.stockMode, actorId);

    let retailActivated = false;
    if (rec.retailNetworkOps) {
      RetailActivationService.activate(orgId, actorId);
      retailActivated = true;
    }

    try { logAuthEvent(orgId, actorId || "system", null, "RETAIL_DIAGNOSTIC_APPLIED", { stockMode: rec.stockMode, retailActivated }); } catch { /* noop */ }

    return { applied: { modules, stockMode: rec.stockMode, retailActivated }, recommendation: rec };
  }
}
