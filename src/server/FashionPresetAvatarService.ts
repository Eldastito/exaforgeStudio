import db from "./db.js";
import { v4 as uuidv4 } from "uuid";

/**
 * Avatares PRESET da loja (ADR-103, item #13). Modelos curados pelo lojista (por
 * tipo de corpo) que o cliente da vitrine ESCOLHE para o provador, em vez de
 * subir a própria foto. São conteúdo da loja (por organização) — sem
 * customer_id, sem consentimento, sem quarentena. Imagem pública em /media.
 */
const BODY_TYPES = ["magro", "atletico", "medio", "plus", "outro"];
const SKIN_TONES = ["clara", "media", "escura"];

export class FashionPresetAvatarService {
  /** Lista os presets da loja (todos, ou só ativos). Para staff e vitrine. */
  static list(orgId: string, opts: { activeOnly?: boolean } = {}): any[] {
    const where = opts.activeOnly ? "AND active = 1" : "";
    return db.prepare(
      `SELECT id, label, body_type, skin_tone, image_url, active, position, created_at
       FROM fashion_preset_avatars WHERE organization_id = ? ${where}
       ORDER BY position ASC, created_at ASC`
    ).all(orgId) as any[];
  }

  /** Só os campos que a vitrine precisa (ativos). */
  static publicList(orgId: string): { id: string; label: string; bodyType: string; imageUrl: string }[] {
    return this.list(orgId, { activeOnly: true }).map((r) => ({
      id: r.id, label: r.label || "Modelo", bodyType: r.body_type || "outro", imageUrl: r.image_url,
    }));
  }

  static get(orgId: string, id: string): any | null {
    return db.prepare(`SELECT * FROM fashion_preset_avatars WHERE id = ? AND organization_id = ?`).get(id, orgId) as any || null;
  }

  /** Imagem ATIVA de um preset — usada pelo try-on. null se não existe/inativo. */
  static activeImageUrl(orgId: string, id: string): string | null {
    const r = db.prepare(`SELECT image_url FROM fashion_preset_avatars WHERE id = ? AND organization_id = ? AND active = 1`).get(id, orgId) as any;
    return r?.image_url || null;
  }

  static create(orgId: string, input: { label?: string; bodyType?: string; skinTone?: string; imageUrl: string }): { ok: boolean; id?: string; error?: string } {
    const imageUrl = String(input.imageUrl || "").trim();
    // Só aceita imagem já hospedada no /media da própria plataforma (upload do
    // lojista) — evita apontar o provador para URL externa arbitrária.
    if (!imageUrl.startsWith("/media/")) return { ok: false, error: "Envie a imagem pelo upload da loja (deve ficar em /media)." };
    const bodyType = BODY_TYPES.includes(String(input.bodyType)) ? String(input.bodyType) : "outro";
    const skinTone = SKIN_TONES.includes(String(input.skinTone)) ? String(input.skinTone) : "media";
    const pos = (db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM fashion_preset_avatars WHERE organization_id = ?`).get(orgId) as any).p;
    const id = uuidv4();
    db.prepare(`INSERT INTO fashion_preset_avatars (id, organization_id, label, body_type, skin_tone, image_url, active, position) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
      .run(id, orgId, String(input.label || "Modelo").slice(0, 60), bodyType, skinTone, imageUrl, pos);
    return { ok: true, id };
  }

  static update(orgId: string, id: string, patch: { label?: string; bodyType?: string; skinTone?: string; active?: boolean; position?: number }): boolean {
    const cur = this.get(orgId, id);
    if (!cur) return false;
    const sets: string[] = []; const vals: any[] = [];
    if (patch.label !== undefined) { sets.push("label = ?"); vals.push(String(patch.label).slice(0, 60)); }
    if (patch.bodyType !== undefined) { sets.push("body_type = ?"); vals.push(BODY_TYPES.includes(String(patch.bodyType)) ? String(patch.bodyType) : "outro"); }
    if (patch.skinTone !== undefined) { sets.push("skin_tone = ?"); vals.push(SKIN_TONES.includes(String(patch.skinTone)) ? String(patch.skinTone) : "media"); }
    if (patch.active !== undefined) { sets.push("active = ?"); vals.push(patch.active ? 1 : 0); }
    if (patch.position !== undefined) { sets.push("position = ?"); vals.push(Math.max(0, Number(patch.position) || 0)); }
    if (!sets.length) return true;
    vals.push(id, orgId);
    db.prepare(`UPDATE fashion_preset_avatars SET ${sets.join(", ")} WHERE id = ? AND organization_id = ?`).run(...vals);
    return true;
  }

  static remove(orgId: string, id: string): boolean {
    const r = db.prepare(`DELETE FROM fashion_preset_avatars WHERE id = ? AND organization_id = ?`).run(id, orgId);
    return (r.changes || 0) > 0;
  }
}
