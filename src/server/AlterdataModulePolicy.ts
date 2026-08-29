/**
 * PRD-ZF-ALTERDATA-GOLIVE-01 (PR 1) — política de módulos por vertical.
 *
 * Constante que define, POR VERTICAL, o status de cada módulo Alterdata.
 * O readiness (PR 4, RF-10) usa isso pra decidir o gate de go-live:
 *
 *   - `required`: bloqueia go-live se falhar
 *   - `conditional`: bloqueia SE `condition_flag` estiver ligada na org
 *   - `optional`: falha vira warning, não bloqueia
 *   - `unsupported`: HTTP 200 NÃO conta como sucesso — módulo não integrado
 *   - `disabled`: cliente pediu pra desligar
 *
 * O PR 4 popula `alterdata_module_policy` na primeira leitura do readiness
 * usando `resolvePolicyForVertical(vertical)`. Órgãos podem sobrescrever
 * módulos individuais na tabela (não implementado neste PR — só schema).
 *
 * Adicionar vertical nova = adicionar entry aqui + seed.
 */
export type ModulePolicy =
  | "required"
  | "conditional"
  | "optional"
  | "unsupported"
  | "disabled";

export interface ModulePolicyEntry {
  policy: ModulePolicy;
  /** Ex.: 'pdvCustomerImport' — flag na org que ativa condicional. */
  conditionFlag?: string;
}

/** Módulos que o ZapFlow reconhece do ecossistema Alterdata/ModaUp. */
export type AlterdataModule =
  | "guardian"
  | "supply"
  | "price"
  | "sales"
  | "crm"
  | "financial"
  | "hr"
  | "logistic"
  | "purchase"
  | "tributary"
  | "ecommerce"
  | "receber";

/**
 * Vertical → política padrão de cada módulo.
 *
 * Toulon (moda/varejo, RF-04 do PRD): Guardian/Supply/Price/Sales obrigatórios;
 * CRM condicional a `pdvCustomerImport`; demais não suportados (o runner
 * atual não consome — HTTP 200 não é sinal de integração).
 */
export const DEFAULT_POLICY_BY_VERTICAL: Record<string, Record<AlterdataModule, ModulePolicyEntry>> = {
  "moda-varejo": {
    guardian:  { policy: "required" },
    supply:    { policy: "required" },
    price:     { policy: "required" },
    sales:     { policy: "required" },
    crm:       { policy: "conditional", conditionFlag: "pdvCustomerImport" },
    financial: { policy: "unsupported" },
    hr:        { policy: "unsupported" },
    logistic:  { policy: "unsupported" },
    purchase:  { policy: "unsupported" },
    tributary: { policy: "unsupported" },
    ecommerce: { policy: "unsupported" },
    receber:   { policy: "unsupported" },
  },
};

/**
 * Retorna a política pra uma vertical. Fallback pra "moda-varejo" enquanto
 * outras verticais não têm entry — evita crash na primeira leitura.
 */
export function resolvePolicyForVertical(vertical: string | null | undefined): Record<AlterdataModule, ModulePolicyEntry> {
  const key = (vertical || "moda-varejo").toLowerCase();
  return DEFAULT_POLICY_BY_VERTICAL[key] || DEFAULT_POLICY_BY_VERTICAL["moda-varejo"];
}

/**
 * Todos os módulos conhecidos (útil pra iterar no readiness/seed).
 */
export const ALL_ALTERDATA_MODULES: AlterdataModule[] = [
  "guardian", "supply", "price", "sales", "crm",
  "financial", "hr", "logistic", "purchase", "tributary", "ecommerce", "receber",
];
