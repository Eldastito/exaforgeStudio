import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { ReservationService } from "../ReservationService.js";

const router = Router();
const orgOf = (req: AuthRequest) => req.organizationId;

// GET /api/reservations/resources — recursos reserváveis (quartos/mesas/itens).
router.get("/resources", (req: AuthRequest, res): any => {
  const orgId = orgOf(req);
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ReservationService.listResources(orgId));
});

// POST /api/reservations/resources — cria um recurso reservável.
router.post("/resources", (req: AuthRequest, res): any => {
  const orgId = orgOf(req);
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  if (!String(b.name || "").trim()) return res.status(400).json({ error: "Informe o nome do recurso." });
  try {
    const r = ReservationService.createResource(orgId, {
      name: b.name, price: b.price, capacity: b.capacity, reservationUnit: b.reservation_unit,
    });
    res.json({ success: true, id: r.id });
  } catch (e: any) {
    res.status(500).json({ error: "Falha ao criar o recurso." });
  }
});

// GET /api/reservations/availability?resource=&start=&end=&units=
router.get("/availability", (req: AuthRequest, res): any => {
  const orgId = orgOf(req);
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { resource, start, end } = req.query as any;
  const units = parseInt(String(req.query.units || "1"), 10) || 1;
  if (!resource || !start || !end) return res.status(400).json({ error: "Informe resource, start e end." });
  res.json(ReservationService.availability(orgId, String(resource), String(start), String(end), units));
});

// GET /api/reservations — lista (agenda de ocupação).
router.get("/", (req: AuthRequest, res): any => {
  const orgId = orgOf(req);
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { status, resource } = req.query as any;
  res.json(ReservationService.list(orgId, { status: status || undefined, resourceId: resource || undefined }));
});

// POST /api/reservations — cria reserva (manual).
router.post("/", (req: AuthRequest, res): any => {
  const orgId = orgOf(req);
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  if (!b.resourceId || !b.startAt || !b.endAt) return res.status(400).json({ error: "Informe resourceId, startAt e endAt." });
  try {
    const r = ReservationService.create(orgId, {
      resourceId: String(b.resourceId), contactId: b.contactId || undefined, ticketId: b.ticketId || undefined,
      startAt: String(b.startAt), endAt: String(b.endAt),
      units: b.units, guests: b.guests, notes: b.notes, createdBy: "owner", depositAmount: b.depositAmount,
    });
    res.json({ success: true, id: r.id });
  } catch (e: any) {
    const map: Record<string, string> = {
      no_availability: "Sem disponibilidade para o período/quantidade.",
      invalid_period: "Período inválido (a saída deve ser depois da entrada).",
      resource_not_found: "Recurso não encontrado.",
    };
    res.status(400).json({ error: map[e.message] || "Não foi possível criar a reserva." });
  }
});

// PATCH /api/reservations/:id — muda status (confirmar/cancelar/etc.).
router.patch("/:id", (req: AuthRequest, res): any => {
  const orgId = orgOf(req);
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    ReservationService.updateStatus(orgId, req.params.id, String(req.body?.status || ""));
    res.json({ success: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message === "invalid_status" ? "Status inválido." : "Falha ao atualizar." });
  }
});

// DELETE /api/reservations/:id — cancela (libera a disponibilidade).
router.delete("/:id", (req: AuthRequest, res): any => {
  const orgId = orgOf(req);
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    ReservationService.updateStatus(orgId, req.params.id, "cancelled");
    res.json({ success: true });
  } catch (e: any) {
    res.status(400).json({ error: "Falha ao cancelar." });
  }
});

export default router;
