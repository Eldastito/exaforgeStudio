import {
  GroundedClaim,
  GroundingResult,
  checkGrounding,
} from "./skillosModel.js";
import type { EvidenceReference } from "./contextModel.js";
import { evidenceFromRagHit } from "./contextModel.js";

/**
 * SkillOsGroundingService — PRD 4 F6 (§19): o GROUNDING VALIDATOR.
 *
 * COMPÕE (não reinventa) sobre a primitiva de evidência do PRD 3 (`EvidenceReference`,
 * `evidenceFromRagHit`): monta o conjunto de evidência DISPONÍVEL (do `ContextPacket`
 * + hits de RAG) e roda o gate determinístico `checkGrounding` — toda afirmação
 * factual/estimada tem de citar uma evidência que existe. Sem NLP; roda em CI.
 *
 * GUARDRAILS (testados):
 *   - RN-GND-1 CITAÇÃO OBRIGATÓRIA (§19): fato/estimativa sem evidência que exista →
 *     UNSUPPORTED_CLAIM.
 *   - RN-GND-2 NÃO INVENTA FONTE: citar evidência ausente do contexto = unsupported.
 *   - RN-GND-3 COMPÕE: reusa EvidenceReference/evidenceFromRagHit — sem contrato novo.
 */
export class SkillOsGroundingService {
  /** Roda o gate: as afirmações × a evidência disponível. */
  static check(claims: GroundedClaim[], available: EvidenceReference[]): GroundingResult {
    return checkGrounding(claims, available);
  }

  /**
   * Extrai a evidência DISPONÍVEL de um `ContextPacket` (F3): a união das
   * `EvidenceReference` de todos os fatos. É o conjunto contra o qual as afirmações
   * são validadas. Robusto a pacote parcial.
   */
  static evidenceFromPacket(packet: { facts?: Array<{ evidence?: EvidenceReference[] }> } | null | undefined): EvidenceReference[] {
    const out: EvidenceReference[] = [];
    for (const f of packet?.facts || []) for (const e of f.evidence || []) out.push(e);
    return out;
  }

  /** Evidência disponível a partir de hits de RAG (F7) — reusa o mapper do PRD 3. */
  static evidenceFromRagHits(hits: any[]): EvidenceReference[] {
    return (hits || []).map((h) => evidenceFromRagHit(h));
  }
}

export default SkillOsGroundingService;
