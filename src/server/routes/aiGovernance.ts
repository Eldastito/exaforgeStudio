import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { AiGovernanceService } from "../AiGovernanceService.js";
import { ReportPdfService } from "../ReportPdfService.js";

// Governança de IA (ADR-130) — política vigente + auditoria de decisões que
// afetam pessoas. Rota core (todas as verticais).
const router = Router();

// GET /api/ai-governance — política de governança de IA (controles vigentes).
router.get("/", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  res.json(AiGovernanceService.policy());
});

// GET /api/ai-governance/decisions — auditoria das decisões que afetam pessoas.
router.get("/decisions", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ decisions: AiGovernanceService.decisions(orgId) });
});

// GET /api/ai-governance/decisions/export?format=csv|pdf — relatório de
// auditoria externa (todas as decisões que afetam pessoas).
router.get("/decisions/export", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const rows = AiGovernanceService.decisionsReportRows(orgId);
  const format = String(req.query.format || "csv");
  if (format === "pdf") {
    try {
      const pdf = await ReportPdfService.generateGovernancePdf(orgId, { policy: AiGovernanceService.policy(), rows });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="governanca-ia.pdf"`);
      return res.send(pdf);
    } catch (e: any) {
      return res.status(500).json({ error: "Falha ao gerar o PDF." });
    }
  }
  // CSV (padrão) — com BOM p/ acentos abrirem certo no Excel.
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="governanca-ia.csv"`);
  return res.send("﻿" + csv);
});

// GET /api/ai-governance/rehabilitation — restrições antigas ainda ativas,
// candidatas a revisão (trilha de reabilitação do checklist de fairness).
router.get("/rehabilitation", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const days = Math.min(3650, Math.max(1, Number(req.query.days) || 30));
  res.json({ days, items: AiGovernanceService.rehabilitationDue(orgId, days) });
});

export default router;
