import type { EvidenceMode } from "./ExternalResearchProvider.js";

/**
 * F4 (GAP-CLOSURE-03) — procedência do Prospect ALINHADA ao vocabulário canônico
 * do PRD 9 (`ExternalResearchProvider`), em vez de um 3º modelo paralelo.
 *
 * O Prospect já registrava origem em `prospect_data_sources` (provider/terms_profile/
 * confidence), mas SEM declarar se o dado veio de uma RECUPERAÇÃO VIVA (fonte externa,
 * verificável, com carimbo de tempo) ou não — a distinção `model_synthesis ≠ live`
 * (RN-EI-1) que o resto da plataforma usa. Este mapa determinístico (puro, sem I/O)
 * é a ÚNICA fonte da verdade provider→procedência, consumida pelos 3 sites que gravam
 * fonte de dados de prospecção (descoberta por região, import RFB, import CSV/usuário).
 *
 * Honestidade dura: dado DECLARADO pelo usuário (csv/manual) NÃO é `live` nem
 * `model_knowledge` — não se força no par binário; procedência fica null (o consumidor
 * sabe que a origem é primeira-parte, não uma recuperação externa). Provider
 * desconhecido também → null (nunca inventa modo).
 */

export type SourceTier = "A" | "B" | "C"; // A=primária/oficial · B=recuperada/verificável · C=citada sem recuperação

export interface ProspectProvenance {
  evidenceMode: EvidenceMode | null; // 'live' (recuperação externa) | 'model_knowledge' | null (declarado/primeira-parte)
  tier: SourceTier | null;
}

// Providers que representam RECUPERAÇÃO VIVA de fonte externa (carimbo de tempo válido).
// Registro público oficial (Receita Federal) é fonte PRIMÁRIA → tier A; diretórios de
// POIs (OSM/Google Places) são recuperados/verificáveis, não oficiais → tier B.
const LIVE_TIER: Record<string, SourceTier> = {
  rfb_open_data: "A",
  osm_overpass: "B",
  google_places: "B",
  places_live: "B",
  licensed_provider: "B",
};

/** Mapa determinístico provider→procedência canônica. Nunca inventa: origem declarada
 *  ou desconhecida → null (honesto), jamais um `evidenceMode` fabricado. */
export function provenanceForProvider(provider: string | null | undefined): ProspectProvenance {
  const p = String(provider || "").trim();
  const tier = LIVE_TIER[p];
  if (tier) return { evidenceMode: "live", tier };
  return { evidenceMode: null, tier: null }; // csv_import | user_input | radar_ia | desconhecido
}

/**
 * Descreve a procedência de uma linha de `prospect_data_sources` já persistida.
 * `retrievedAt` é DERIVADO (RN-004, sem coluna redundante): só existe quando a origem
 * é `live` — é o momento da coleta (`collected_at`); em origem declarada → null.
 */
export function describeSourceProvenance(row: { evidence_mode?: string | null; source_tier?: string | null; collected_at?: string | null } | null | undefined): {
  evidenceMode: EvidenceMode | null; tier: SourceTier | null; retrievedAt: string | null;
} {
  const mode = (row?.evidence_mode === "live" || row?.evidence_mode === "model_knowledge") ? row.evidence_mode as EvidenceMode : null;
  const tier = (row?.source_tier === "A" || row?.source_tier === "B" || row?.source_tier === "C") ? row.source_tier as SourceTier : null;
  return { evidenceMode: mode, tier, retrievedAt: mode === "live" ? (row?.collected_at || null) : null };
}
