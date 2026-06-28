import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middleware/auth.js";
import { chat, isAIConfigured } from "../llm.js";

const router = Router();
const orgOf = (req: any) => req.organizationId;

const view = (a: any) => ({
  id: a.id, name: a.name, description: a.description || "", persona: a.persona || "",
  assigned_user_id: a.assigned_user_id || null, position: a.position, active: !!a.active,
});

// POST /api/areas/ai/persona  { name, description } -> a IA sugere a persona/
// instruções da área, para o dono ajustar em vez de começar do zero.
router.post("/ai/persona", async (req: AuthRequest, res): Promise<any> => {
  const orgId = orgOf(req);
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!isAIConfigured()) return res.status(400).json({ error: "IA não configurada nesta instância." });
  const name = String(req.body?.name || "").trim();
  const description = String(req.body?.description || "").trim();
  if (!name && !description) return res.status(400).json({ error: "Preencha o nome ou a descrição da área primeiro." });

  try {
    const biz = db.prepare("SELECT business_name FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    const brand = biz?.business_name ? `A empresa se chama "${biz.business_name}". ` : "";
    const system = "Você cria instruções (persona) para um assistente de atendimento por WhatsApp de uma empresa brasileira. Escreve em português do Brasil, em 2ª pessoa ('Você é...'), de forma objetiva e prática. NÃO invente serviços, preços ou políticas que não foram informados — descreva o comportamento, o tom e como conduzir o atendimento. Responda SOMENTE com o texto da persona, sem títulos nem aspas.";
    const prompt = `${brand}Crie a persona/instruções de IA para a área de atendimento "${name}"${description ? ` (descrição: ${description})` : ""}.
Inclua: quem a IA representa e o tom de voz; o que essa área atende; como acolher e conduzir (tirar dúvidas, oferecer agendamento/orçamento quando fizer sentido); e quando encaminhar para um humano. Seja conciso (até ~120 palavras).`;
    const raw = await chat(prompt, { temperature: 0.7, system });
    const persona = String(raw || "").trim().slice(0, 8000);
    if (!persona) return res.status(502).json({ error: "A IA não retornou um texto válido. Tente novamente." });
    res.json({ persona });
  } catch (e: any) {
    console.error("[Areas AI persona] erro", e);
    res.status(500).json({ error: "Falha ao gerar com a IA. Tente novamente." });
  }
});

// GET /api/areas
router.get("/", (req: AuthRequest, res): any => {
  const orgId = orgOf(req);
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const rows = db.prepare(
    "SELECT * FROM service_areas WHERE organization_id = ? ORDER BY position ASC, created_at ASC"
  ).all(orgId) as any[];
  res.json(rows.map(view));
});

// POST /api/areas  { name, description?, persona?, assigned_user_id? }
router.post("/", (req: AuthRequest, res): any => {
  const orgId = orgOf(req);
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const name = String(req.body?.name || "").trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: "Informe o nome da área." });
  const pos = ((db.prepare("SELECT MAX(position) AS m FROM service_areas WHERE organization_id = ?").get(orgId) as any)?.m ?? -1) + 1;
  const id = uuidv4();
  db.prepare(
    "INSERT INTO service_areas (id, organization_id, name, description, persona, assigned_user_id, position, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
  ).run(id, orgId, name, String(req.body?.description || "").slice(0, 600), String(req.body?.persona || "").slice(0, 8000), req.body?.assigned_user_id || null, pos);
  res.json(view(db.prepare("SELECT * FROM service_areas WHERE id = ?").get(id)));
});

// PUT /api/areas/:id
router.put("/:id", (req: AuthRequest, res): any => {
  const orgId = orgOf(req);
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const a = db.prepare("SELECT id FROM service_areas WHERE id = ? AND organization_id = ?").get(req.params.id, orgId);
  if (!a) return res.status(404).json({ error: "Área não encontrada." });
  const b = req.body || {};
  const sets: string[] = []; const vals: any[] = [];
  if (b.name !== undefined) { sets.push("name = ?"); vals.push(String(b.name).trim().slice(0, 60)); }
  if (b.description !== undefined) { sets.push("description = ?"); vals.push(String(b.description).slice(0, 600)); }
  if (b.persona !== undefined) { sets.push("persona = ?"); vals.push(String(b.persona).slice(0, 8000)); }
  if (b.assigned_user_id !== undefined) { sets.push("assigned_user_id = ?"); vals.push(b.assigned_user_id || null); }
  if (b.active !== undefined) { sets.push("active = ?"); vals.push(b.active ? 1 : 0); }
  if (sets.length) db.prepare(`UPDATE service_areas SET ${sets.join(", ")} WHERE id = ? AND organization_id = ?`).run(...vals, req.params.id, orgId);
  res.json({ success: true });
});

// DELETE /api/areas/:id
router.delete("/:id", (req: AuthRequest, res): any => {
  const orgId = orgOf(req);
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  db.prepare("DELETE FROM service_areas WHERE id = ? AND organization_id = ?").run(req.params.id, orgId);
  // Solta as conversas que estavam nessa área (voltam ao menu na próxima msg).
  db.prepare("UPDATE tickets SET area_id = NULL WHERE area_id = ? AND organization_id = ?").run(req.params.id, orgId);
  res.json({ success: true });
});

export default router;
