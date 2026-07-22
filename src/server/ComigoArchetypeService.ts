import db from "./db.js";
import { randomUUID } from "crypto";

/**
 * ZappFlow Comigo — Onboarding por arquétipo (ADR-120 / ADR-088 D1).
 *
 * 3 perguntas em linguagem de gente moldam o produto pelo TIPO de negócio, não
 * pelo segmento. Motor PURO (recommend) + apply que persiste — mesmo padrão do
 * RetailDiagnosticService. Isolado por organization_id.
 */

export type ArchetypeAnswers = {
  archetype?: string;              // o que faz (chave abaixo)
  service?: "balcao" | "agenda";   // chegou-e-comprou × hora marcada
  mobile?: boolean;                // fixo × móvel
};

type ArchetypeDef = { key: string; label: string; emoji: string; recipeKind: "revenda" | "fabricacao" | "servico"; mode: "balcao" | "agenda"; mesa: boolean };

// Arquétipos curados (ADR-088 D1). `mesa` = Mesa/QR faz sentido por padrão.
export const ARCHETYPES: ArchetypeDef[] = [
  { key: "marmita", label: "Marmita / comida por encomenda", emoji: "🍱", recipeKind: "fabricacao", mode: "balcao", mesa: false },
  { key: "salgados", label: "Doces, salgados e bolos", emoji: "🧁", recipeKind: "fabricacao", mode: "balcao", mesa: false },
  { key: "foodtruck", label: "Foodtruck / galeto / lanche", emoji: "🚚", recipeKind: "fabricacao", mode: "balcao", mesa: true },
  { key: "feira", label: "Barraca de feira / praia", emoji: "🏖️", recipeKind: "revenda", mode: "balcao", mesa: false },
  { key: "unhas", label: "Manicure / pedicure", emoji: "💅", recipeKind: "servico", mode: "agenda", mesa: false },
  { key: "cabelo", label: "Cabelo / barbearia", emoji: "✂️", recipeKind: "servico", mode: "agenda", mesa: false },
  { key: "servico_tecnico", label: "Chaveiro / serviço técnico", emoji: "🔧", recipeKind: "servico", mode: "balcao", mesa: false },
  { key: "revenda", label: "Revenda / ambulante", emoji: "🛒", recipeKind: "revenda", mode: "balcao", mesa: false },
  { key: "outro", label: "Outro", emoji: "✨", recipeKind: "revenda", mode: "balcao", mesa: false },
];

export const ARCHETYPE_QUESTIONS = [
  { key: "archetype", label: "O que você faz?", type: "single", options: ARCHETYPES.map((a) => ({ value: a.key, label: `${a.emoji} ${a.label}` })) },
  { key: "service", label: "Como você atende?", type: "single", options: [{ value: "balcao", label: "Chegou e comprou" }, { value: "agenda", label: "Com hora marcada" }] },
  { key: "mobile", label: "Você fica num ponto ou se move?", type: "single", options: [{ value: "fixo", label: "Fico num ponto" }, { value: "movel", label: "Me movo (feira, praia, rua)" }] },
] as const;

const byKey = (k?: string) => ARCHETYPES.find((a) => a.key === k) || ARCHETYPES[ARCHETYPES.length - 1];

export class ComigoArchetypeService {
  static questions() { return ARCHETYPE_QUESTIONS; }

  /** Respostas → config (função pura). */
  static recommend(answers: ArchetypeAnswers) {
    const base = byKey(answers?.archetype);
    const mode: "balcao" | "agenda" = answers?.service || base.mode;
    const mobile = !!answers?.mobile;
    // Mesa/QR só em chegou-e-comprou de comida com consumo no local.
    const mesaEnabled = mode === "balcao" && base.mesa;
    // Ficha padrão: hora marcada = serviço; senão, o tipo do arquétipo.
    const defaultRecipeKind = mode === "agenda" ? "servico" : base.recipeKind;

    const tips: string[] = [];
    if (mode === "agenda") tips.push("Seu tempo é seu maior custo — na ficha, informe quanto vale sua hora pra saber se o preço cobre.");
    if (mesaEnabled) tips.push("Ligamos a Mesa/QR: o cliente pede e paga sozinho pelo QR, e o pedido só cai na sua fila quando pago.");
    if (!mesaEnabled && mode === "balcao") tips.push("Sem Mesa/QR: você vende direto no Balcão, por toque. Dá pra ligar depois se quiser.");
    if (mobile) tips.push("Como você se move, dá pra vender offline e sincronizar quando a internet voltar.");

    return { archetype: base.key, archetypeLabel: base.label, emoji: base.emoji, mode, mobile, mesaEnabled, defaultRecipeKind, tips };
  }

  /** Persiste a config do arquétipo (idempotente, auditado). */
  static apply(orgId: string, answers: ArchetypeAnswers, actorId?: string) {
    const rec = this.recommend(answers);
    db.prepare(`UPDATE organization_settings SET comigo_archetype = ?, comigo_mode = ?, comigo_mobile = ?, comigo_mesa_enabled = ?, comigo_default_recipe_kind = ? WHERE organization_id = ?`)
      .run(rec.archetype, rec.mode, rec.mobile ? 1 : 0, rec.mesaEnabled ? 1 : 0, rec.defaultRecipeKind, orgId);
    try {
      db.prepare(`INSERT INTO auth_audit_logs (id, organization_id, actor_user_id, event_type, metadata_json) VALUES (?, ?, ?, 'comigo_archetype_apply', ?)`)
        .run(randomUUID(), orgId, actorId || null, JSON.stringify({ archetype: rec.archetype, mode: rec.mode }));
    } catch { /* noop */ }
    return rec;
  }

  /** Config atual (ou configured:false se ainda não passou pelo onboarding). */
  static getConfig(orgId: string) {
    const o = db.prepare("SELECT comigo_archetype, comigo_mode, comigo_mobile, comigo_mesa_enabled, comigo_default_recipe_kind FROM organization_settings WHERE organization_id = ?").get(orgId) as any || {};
    if (!o.comigo_archetype) return { configured: false, mesaEnabled: o.comigo_mesa_enabled == null ? true : !!o.comigo_mesa_enabled };
    const def = byKey(o.comigo_archetype);
    return {
      configured: true,
      archetype: o.comigo_archetype,
      archetypeLabel: def.label,
      emoji: def.emoji,
      mode: o.comigo_mode || def.mode,
      mobile: !!o.comigo_mobile,
      mesaEnabled: !!o.comigo_mesa_enabled,
      defaultRecipeKind: o.comigo_default_recipe_kind || def.recipeKind,
    };
  }
}

export default ComigoArchetypeService;
