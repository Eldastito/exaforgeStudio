import { CAMPAIGN_OBJECTIVES } from "./StudioService.js";
import { HookIntelligenceService } from "./HookIntelligenceService.js";

/**
 * ScriptIntelligenceService — Script Intelligence (PRD 11 / ADR-168 F4).
 *
 * O Estúdio gera vídeo a partir de UM briefing → prompt Veo, sem estrutura. F4 acrescenta o
 * ROTEIRO/STORYBOARD: uma sequência de CENAS (beats) com duração, sugestão visual e fala
 * (VO/texto na tela), abrindo com o GANCHO da F3 e fechando com a CTA do OBJETIVO.
 *
 * ESTENDE o Estúdio (§37 — sem 2º Estúdio); DETERMINÍSTICO (sem LLM, roda em CI, espelha
 * `CreativeVariantService`/`HookIntelligenceService`). O roteiro é grounded no TÓPICO +
 * OBJETIVO + BRAND DNA (F1 — voz/persona/público) e REUSA o `HookIntelligenceService` (F3)
 * pro primeiro beat.
 *
 * Guardrails:
 *  - RN-CG-09 — GROUNDED: usa só tópico + campos de marca existentes; sem tópico → erro.
 *  - RN-CG-04 / respeito à marca — beats com termo PROIBIDO do Brand DNA são saneados (linha
 *    decorativa removida) + caveat.
 *  - convenção nº 1 — isolamento por org.
 */

export type ScriptFormat = "reels" | "story" | "post";

export interface ScriptBeat { order: number; label: string; durationSec: number; visual: string; script: string }
export interface VideoScript {
  topic: string; objectiveId: string | null; format: ScriptFormat;
  hook: string; beats: ScriptBeat[]; totalDurationSec: number;
  brandGrounded: boolean; caveats: string[];
}

interface Ctx { topic: string; persona: string | null; audience: string | null }
function cap(s: string): string { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// CTA por objetivo (fecha o roteiro chamando pra ação certa). Vaidade → CTA de interação.
const CTA_BY_OBJECTIVE: Record<string, string> = {
  vendas: "Garanta já o seu — link na bio.",
  promocao: "Aproveite enquanto a condição dura.",
  agendamento: "Agende agora pelo WhatsApp.",
  reativacao: "Sentimos sua falta — volta pra gente.",
  engajamento: "Comenta aqui o que você achou!",
  alcance: "Compartilha com quem precisa ver isso.",
  educativo: "Salva esse post pra não esquecer.",
  data: "Celebre esse momento com a gente.",
};
const DEFAULT_CTA = "Fala com a gente pra saber mais.";

// Perfil de duração (seg) por formato, na ordem dos 5 beats.
const DURATION_PROFILE: Record<ScriptFormat, number[]> = {
  reels: [3, 4, 6, 4, 3],
  story: [2, 3, 4, 3, 2],
  post: [3, 4, 5, 4, 3],
};

export class ScriptIntelligenceService {
  static isKnownObjective(objectiveId: string): boolean {
    return CAMPAIGN_OBJECTIVES.some((o) => o.id === objectiveId);
  }

  /** Gera o roteiro/storyboard grounded. `format` default `reels`. */
  static async generate(orgId: string, input: { topic: string; objectiveId?: string | null; format?: ScriptFormat }): Promise<VideoScript> {
    const topic = String(input?.topic || "").trim();
    if (!topic) throw new Error("Informe o tópico do vídeo.");
    const objectiveId = input.objectiveId && this.isKnownObjective(String(input.objectiveId)) ? String(input.objectiveId) : null;
    const format: ScriptFormat = (["reels", "story", "post"] as const).includes(input.format as any) ? (input.format as ScriptFormat) : "reels";

    // Brand DNA (F1) — grounded; ausente segue sem (0-regressão).
    let persona: string | null = null, audience: string | null = null, voice: string | null = null;
    let forbidden: string[] = [];
    try {
      const { BrandDnaService } = await import("./BrandDnaService.js");
      const dna = await BrandDnaService.get(orgId);
      persona = dna.persona; audience = dna.audience; voice = dna.voice;
      forbidden = (dna.forbidden || []).map((f) => f.toLowerCase());
    } catch { /* sem Brand DNA → roteiro sem marca (honesto) */ }
    const brandGrounded = !!(persona || audience || voice);
    const ctx: Ctx = { topic, persona, audience };

    // Beat 1 = gancho da F3 (reusa; §37 — sem duplicar geração de gancho).
    let hook: string;
    try {
      const hs = await HookIntelligenceService.generate(orgId, { topic, objectiveId, count: 1 });
      hook = hs.hooks[0]?.text || `Você precisa ver isso sobre ${topic}.`;
    } catch { hook = `Você precisa ver isso sobre ${topic}.`; }

    const cta = objectiveId ? (CTA_BY_OBJECTIVE[objectiveId] || DEFAULT_CTA) : DEFAULT_CTA;
    const who = audience || persona;
    const dur = DURATION_PROFILE[format];

    const raw: { label: string; visual: string; script: string }[] = [
      { label: "Gancho", visual: "Plano de impacto / close — primeiros 3s seguram o scroll.", script: hook },
      { label: "Contexto", visual: `Mostra o cenário${who ? ` de ${who}` : ""}.`, script: `Todo mundo enfrenta isso quando o assunto é ${topic}.` },
      { label: "Demonstração", visual: "Produto/serviço em ação — mão na massa.", script: `Veja ${topic} funcionando de verdade${voice ? ` — no tom ${voice}` : ""}.` },
      { label: "Prova", visual: "Depoimento, antes/depois ou resultado real.", script: `A prova de que ${topic} entrega o que promete.` },
      { label: "CTA", visual: "Tela final com marca + chamada clara.", script: cta },
    ];

    const caveats: string[] = [];
    const beats: ScriptBeat[] = raw.map((b, i) => {
      let script = b.script;
      // Respeito à marca (RN-CG-04): sane a linha se contiver termo proibido (mantém o beat).
      if (forbidden.some((f) => f && script.toLowerCase().includes(f))) {
        caveats.push(`beat "${b.label}" saneado por termo proibido`);
        script = cap(topic) + ".";
      }
      return { order: i + 1, label: b.label, durationSec: dur[i], visual: b.visual, script };
    });
    const totalDurationSec = dur.reduce((a, c) => a + c, 0);
    if (!brandGrounded) caveats.push("sem Brand DNA — roteiro genérico (defina persona/voz pra afinar)");

    return { topic, objectiveId, format, hook, beats, totalDurationSec, brandGrounded, caveats };
  }
}

export default ScriptIntelligenceService;
