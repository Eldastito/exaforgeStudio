import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middleware/auth.js";

const router = Router();

const logAuthEvent = (orgId: string | undefined, actorId: string | undefined, targetId: string | undefined, eventType: string, meta: any = {}) => {
  try {
    db.prepare(`
      INSERT INTO auth_audit_logs (id, organization_id, actor_user_id, target_user_id, event_type, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), orgId || null, actorId || null, targetId || null, eventType, JSON.stringify(meta));
  } catch(e) {
    console.error("Failed to log auth event", e);
  }
};

// List knowledge base documents
router.get("/documents", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const docs = db.prepare('SELECT id, name, created_at FROM rag_documents WHERE organization_id = ?').all(orgId);
    res.json(docs);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Upload knowledge base document (placeholder for actual content processing)
router.post("/documents", (req: AuthRequest, res) => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  const { name, content } = req.body;
  const id = uuidv4();

  try {
    db.prepare(`
      INSERT INTO rag_documents (id, organization_id, name, content)
      VALUES (?, ?, ?, ?)
    `).run(id, orgId, name, content);

    logAuthEvent(orgId, userId, id, 'RAG_DOCUMENT_CREATED', { name });

    res.json({ success: true, id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
