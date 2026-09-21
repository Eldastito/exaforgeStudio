/**
 * FiscalInboundProvider — interface interna do provedor de documentos fiscais
 * de ENTRADA (ADR-200, Fase 3). O resto do domínio fala só com esta interface;
 * ninguém conhece OAuth, endpoints, ambiente ou formato do docZip do provedor.
 *
 * Implementações: NuvemFiscalAdapter (provedor). O ManualXmlAdapter (upload) já
 * converge no mesmo pipeline de persistência sem passar por aqui.
 */

/** Eventos de manifestação do destinatário (tpEvento entre parênteses). */
export type FiscalManifestationEvent =
  | "ciencia_operacao"          // 210210 — libera o XML completo (único automático na v1)
  | "confirmacao_operacao"      // 210200
  | "desconhecimento_operacao"  // 210220
  | "operacao_nao_realizada";   // 210240

export const MANIFESTATION_TP_EVENTO: Record<FiscalManifestationEvent, string> = {
  ciencia_operacao: "210210",
  confirmacao_operacao: "210200",
  desconhecimento_operacao: "210220",
  operacao_nao_realizada: "210240",
};

export type FiscalDocSchema = "resNFe" | "procNFe" | "procEventoNFe" | "unknown";

export interface FiscalProbeResult {
  connected: boolean;
  capabilities?: Record<string, any>;
  errorCode?: string | null; // código sanitizado (nunca segredo)
}

export interface FiscalDistributionDoc {
  nsu: string;
  schema: FiscalDocSchema;
  accessKey: string | null;
  /** XML já decodificado (string), quando o provedor o entrega pronto. */
  xml: string | null;
}

export interface FiscalDistributionBatch {
  ultNsu: string;
  maxNsu: string | null;
  documents: FiscalDistributionDoc[];
  /** Backoff sinalizado pelo provedor (429/consumo indevido); pausa o polling. */
  blocked?: { until: string; reason: string } | null;
}

export interface FiscalEventResult {
  ok: boolean;
  protocol?: string | null;
  status?: string | null;
  errorCode?: string | null;
}

export interface FiscalInboundProvider {
  /** Valida credenciais/capacidade sem efeito colateral. */
  probe(): Promise<FiscalProbeResult>;
  /** Lista documentos distribuídos ao CNPJ a partir do cursor (NSU). */
  listSinceNsu(input: { cnpj: string; ultNsu: string }): Promise<FiscalDistributionBatch>;
  /** Busca por chave de acesso (atalho operacional). */
  getByAccessKey(input: { cnpj: string; accessKey: string }): Promise<FiscalDistributionBatch>;
  /** Envia manifestação do destinatário. */
  manifest(input: { cnpj: string; accessKey: string; event: FiscalManifestationEvent; justification?: string }): Promise<FiscalEventResult>;
}
