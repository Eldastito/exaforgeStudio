import { Router } from "express";
import { requireAuth, VisionRequest } from "../auth.js";
import { calculateStorage } from "../storageCalc.js";

const router = Router();
router.use(requireAuth);

// POST /storage/calc — calculadora de armazenamento (PRD-VISION-VMS §16.2).
// Retorna o dimensionamento de disco recomendado para gravar N câmeras por
// M dias com uma dada combinação de resolução/FPS/codec. Pura, sem side
// effects — só um teto de decisão para o lojista antes de comprar hardware.
router.post("/calc", (req: VisionRequest, res) => {
  try {
    const out = calculateStorage(req.body || {});
    res.json(out);
  } catch (e: any) {
    res.status(400).json({ error: e.message || "invalid_input" });
  }
});

export default router;
