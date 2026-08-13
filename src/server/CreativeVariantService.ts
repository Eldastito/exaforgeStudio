/**
 * CreativeVariantService (PRD 10 / ADR-167 F9 — Creative Variants) — a partir do BRIEFING
 * orientado (F8) deriva VARIANTES A/B/C: o mesmo propósito em ângulos criativos distintos,
 * pro operador escolher/testar. Fecha um dos gaps reais do Estúdio apontados na F0
 * (`StudioService` gerava 1 arte, sem variação). ESTENDE o Estúdio (§42 — sem 2º Estúdio):
 * cada variante é um `briefingText` DISTINTO pronto p/ `StudioService.generate` — a geração
 * real de imagem/legenda continua sendo a do Estúdio, só multiplicada por ângulo.
 *
 * Read-only/DETERMINÍSTICO (sem LLM, sem tabela nova): as variantes são derivações por
 * TEMPLATE do briefing. GROUNDED (RN-SI-02): tudo vem do brief (que já é fundamentado em
 * inteligência fresca) — nada inventado. Cada variante carrega `variantKey` ESTÁVEL
 * (`{signalId}:{label}`) e o `correlationId` do sinal (fio ADR-158) — o A/B/C dá pra
 * escalonar/atribuir depois (F10/F12) sem perder o fio. Procedência (`evidenceMode`)
 * preservada. Isolamento (convenção #1): `orgId` 1º arg; leitura filtra a org.
 */
import { StudioBriefService, type StudioBrief } from "./StudioBriefService.js";
import type { StudioFormat } from "./StudioService.js";

export type VariantLabel = "A" | "B" | "C";

export interface CreativeVariant {
  label: VariantLabel;
  variantKey: string;
  angleName: string;
  angle: string;
  briefingText: string;
  suggestedFormat: StudioFormat;
  correlationId: string | null;
  evidenceMode: string;
}

export interface CreativeVariantSet {
  signalId: string;
  correlationId: string | null;
  vertical: string | null;
  topic: string | null;
  channel: string | null;
  count: number;
  variants: CreativeVariant[];
  caveats: string[];
}

// Estratégias de ângulo (determinísticas). Cada uma diverge o MESMO propósito de um jeito
// diferente — a diversidade é o valor do A/B/C (não 3 cópias do mesmo texto).
const ANGLES: Array<{ label: VariantLabel; name: string; instruction: string; formatHint?: StudioFormat }> = [
  { label: "A", name: "Benefício direto", instruction: "Destaque o benefício concreto pro cliente e uma chamada à ação clara." },
  { label: "B", name: "Tendência / prova social", instruction: "Ancore no movimento atual do nicho (o que está em alta) e use prova social.", formatHint: "story" },
  { label: "C", name: "Identidade de marca", instruction: "Conecte com a identidade/bastidores da marca, tom autêntico." },
];

export class CreativeVariantService {
  /**
   * Deriva as variantes A/B/C de uma oportunidade. Retorna null se não há brief (sinal
   * inexistente/expirado). Determinístico: mesma entrada → mesma saída.
   */
  static variants(orgId: string, signalId: string): CreativeVariantSet | null {
    const brief: StudioBrief | null = StudioBriefService.fromOpportunity(orgId, signalId);
    if (!brief) return null;

    const variants: CreativeVariant[] = ANGLES.map((a) => {
      // Cada variante = o briefing base + a instrução do ângulo (divergência real).
      const briefingText = `${brief.briefingText} Ângulo ${a.label} (${a.name}): ${a.instruction}`;
      return {
        label: a.label,
        variantKey: `${signalId}:${a.label}`,   // estável → escalonar/atribuir depois (F10/F12)
        angleName: a.name,
        angle: a.instruction,
        briefingText,
        suggestedFormat: a.formatHint || brief.suggestedFormat,
        correlationId: brief.correlationId,
        evidenceMode: brief.evidenceMode,
      };
    });

    return {
      signalId,
      correlationId: brief.correlationId,
      vertical: brief.vertical,
      topic: brief.topic,
      channel: brief.channel,
      count: variants.length,
      variants,
      caveats: brief.caveats,
    };
  }
}

export default CreativeVariantService;
