import { Router } from "express";
import multer from "multer";
import { AuthRequest } from "../middleware/auth.js";
import { SmartImportService } from "../SmartImportService.js";

// Importação inteligente (ADR-101): recebe PDF ou imagem, a IA extrai as linhas
// no schema da tela, e o front mostra um preview para o dono revisar antes de
// salvar. NÃO salva nada aqui — só extrai.

const ACCEPTED = new Set([
  "application/pdf",
  "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
  fileFilter: (_req, file, cb) => {
    if (ACCEPTED.has(file.mimetype)) cb(null, true);
    else cb(new Error("Formato não suportado. Envie um PDF ou imagem (PNG/JPG/WEBP)."));
  },
});

const router = Router();

// POST /api/import/extract  (multipart: file + type) -> { rows, warnings, fields }
router.post("/extract", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  upload.single("file")(req, res, async (err: any) => {
    if (err) return res.status(400).json({ error: err.message || "Falha no upload." });
    const file = (req as any).file;
    const type = String(req.body?.type || "");
    if (!file) return res.status(400).json({ error: "Nenhum arquivo enviado." });
    if (!SmartImportService.getSchema(type)) return res.status(400).json({ error: "Tipo de importação inválido." });

    try {
      const result = await SmartImportService.extract(file.buffer, file.mimetype, type);
      if (!result.ok) {
        const msg = result.error === "pdf_sem_texto"
          ? "Não consegui ler o texto deste PDF (parece escaneado). Tente enviar como imagem (foto/print) para a IA ler."
          : result.error === "formato_nao_suportado"
          ? "Formato não suportado. Envie um PDF ou imagem."
          : "Não consegui extrair os dados deste arquivo.";
        return res.status(400).json({ error: msg, code: result.error });
      }
      res.json({ rows: result.rows, warnings: result.warnings, fields: result.fields });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Falha na extração." });
    }
  });
});

export default router;
