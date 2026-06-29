import { Router } from "express";
import multer from "multer";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middleware/auth.js";
import { processDocument, deleteDocument } from "../geminiRAG.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// Apenas formatos de texto são suportados (o pipeline lê o conteúdo como texto).
const ALLOWED_EXT = ['.txt', '.csv', '.md', '.json'];
function hasAllowedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED_EXT.some((ext) => lower.endsWith(ext));
}

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

// Lista os documentos da base de conhecimento
router.get("/documents", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const docs = db.prepare(`
      SELECT id, title AS name, status, channel_id, area_id, chunk_count, size_bytes, created_at
      FROM knowledge_documents
      WHERE organization_id = ?
      ORDER BY created_at DESC
    `).all(orgId);
    res.json(docs);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Upload de documento (arquivo de texto) -> vetoriza e persiste
router.post("/upload", upload.single("document"), async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" });
    if (!hasAllowedExtension(req.file.originalname)) {
      return res.status(400).json({ error: "Formato não suportado. Envie .txt, .csv, .md ou .json." });
    }
    const channelId = req.body.channelId || 'global';
    const areaId = req.body.areaId ? String(req.body.areaId) : null;
    const result = await processDocument(req.file.buffer, req.file.originalname, orgId, channelId, areaId);
    logAuthEvent(orgId, userId, result.documentId, 'RAG_DOCUMENT_UPLOADED', { name: req.file.originalname, chunks: result.chunksProcessed });
    res.json({ message: "Documento vetorizado com sucesso", ...result });
  } catch (e: any) {
    console.error("[RAG Upload]", e);
    res.status(500).json({ error: e.message || "Erro ao vetorizar documento" });
  }
});

// Cria um documento a partir de texto colado (ex.: FAQ digitado) -> vetoriza
router.post("/documents", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  const { name, content, channelId, areaId } = req.body;
  if (!name || !content) return res.status(400).json({ error: "Missing name or content" });

  try {
    const result = await processDocument(Buffer.from(String(content), 'utf-8'), name, orgId, channelId || 'global', areaId ? String(areaId) : null);
    logAuthEvent(orgId, userId, result.documentId, 'RAG_DOCUMENT_CREATED', { name, chunks: result.chunksProcessed });
    res.json({ success: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Promove uma resposta do atendimento para a base de conhecimento (curadoria
// manual). O atendente aprova uma boa resposta da IA e ela vira "fonte de
// verdade" para conversas futuras — sem o risco de auto-ingestão (loop de
// alucinação).
router.post("/promote", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  const { question, answer, contactName } = req.body || {};
  const ans = String(answer || "").trim();
  if (!ans) return res.status(400).json({ error: "Resposta vazia." });

  try {
    const q = String(question || "").trim();
    const content = q ? `Pergunta do cliente: ${q}\nResposta aprovada: ${ans}` : `Resposta aprovada: ${ans}`;
    const stamp = new Date().toLocaleDateString("pt-BR");
    const name = `Atendimento curado — ${contactName ? String(contactName).slice(0, 40) + " · " : ""}${stamp}`;
    const result = await processDocument(Buffer.from(content, "utf-8"), name, orgId, "global", null);
    logAuthEvent(orgId, userId, result.documentId, 'RAG_ANSWER_PROMOTED', { name, chunks: result.chunksProcessed });
    res.json({ success: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Remove um documento e seus chunks
router.delete("/documents/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const ok = deleteDocument(req.params.id, orgId);
    if (!ok) return res.status(404).json({ error: "Documento não encontrado" });
    logAuthEvent(orgId, userId, req.params.id, 'RAG_DOCUMENT_DELETED', {});
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
