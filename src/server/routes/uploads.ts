import { Router } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middleware/auth.js";

// Upload de imagens (logo/banner da loja e fotos de produto). Salva em MEDIA_DIR
// e devolve a URL pública /media/<arquivo> (servida estaticamente em server.ts).
const MEDIA_DIR = path.join(process.env.DATA_DIR || process.cwd(), "media");
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (e) { /* noop */ }

const EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (EXT[file.mimetype]) cb(null, true);
    else cb(new Error("Formato de imagem não suportado (use PNG, JPG, WEBP ou GIF)."));
  },
});

const router = Router();

// POST /api/uploads/image  (multipart, campo "file") -> { url }
router.post("/image", (req: AuthRequest, res): any => {
  upload.single("file")(req, res, (err: any) => {
    if (err) return res.status(400).json({ error: err.message || "Falha no upload." });
    const file = (req as any).file;
    if (!file) return res.status(400).json({ error: "Nenhum arquivo enviado." });
    try {
      const ext = EXT[file.mimetype] || ".bin";
      const name = `${uuidv4()}${ext}`;
      fs.writeFileSync(path.join(MEDIA_DIR, name), file.buffer);
      res.json({ url: `/media/${name}` });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Falha ao salvar a imagem." });
    }
  });
});

export default router;
