import { Router, Response } from "express";
import { PermissionService, RBAC_MODULES, RBAC_MODULE_LABELS } from "../PermissionService.js";
import { requirePermission, AuthRequest } from "../middleware/auth.js";
import { logAuthEvent } from "../auditLog.js";
import { MASTER_ADMIN_EMAIL } from "../config/secret.js";

// RBAC granular (ADR-095 Bloco 2) — API de gestão de perfis de acesso.
//
// Leitura de "quem sou eu / o que posso" é liberada a qualquer usuário logado
// (o frontend usa /me para montar menu e botões). Já criar/editar/atribuir
// perfis exige permissão no módulo administrativo "usuarios".
const router = Router();

const orgOf = (req: AuthRequest) => req.organizationId as string;

// GET /api/permissions/me — mapa módulo→nível do próprio usuário (menu/botões).
router.get("/me", (req: AuthRequest, res: Response): any => {
  res.json({
    permissions: PermissionService.permissionMap(orgOf(req), req.user),
    hasProfile: PermissionService.hasProfile(orgOf(req), req.user),
    // Fonte única de verdade do "sou o operador da plataforma?" — o front usa
    // para mostrar/esconder o Admin Master, o Radar Consultor e o console Meta,
    // em vez de comparar o e-mail hardcoded (ADR-106). O servidor SEMPRE reforça
    // via requireMasterAdmin; isto é só a coerência do menu.
    isMasterAdmin: !!(req.user?.email && req.user.email === MASTER_ADMIN_EMAIL),
  });
});

// GET /api/permissions/modules — catálogo de módulos + rótulos (editor de perfis).
router.get("/modules", requirePermission("usuarios", "read"), (_req: AuthRequest, res: Response): any => {
  res.json({ modules: RBAC_MODULES.map((key) => ({ key, label: RBAC_MODULE_LABELS[key] || key })), levels: PermissionService.LEVELS });
});

// GET /api/permissions/profiles — lista de perfis com mapa de permissões + nº usuários.
router.get("/profiles", requirePermission("usuarios", "read"), (req: AuthRequest, res: Response): any => {
  try { res.json({ profiles: PermissionService.listProfiles(orgOf(req)) }); }
  catch (e) { res.status(500).json({ error: "Falha ao listar perfis" }); }
});

// POST /api/permissions/profiles — cria perfil customizado.
router.post("/profiles", requirePermission("usuarios", "write"), (req: AuthRequest, res: Response): any => {
  const { name, permissions } = req.body || {};
  if (!name || typeof name !== "string") return res.status(400).json({ error: "Nome obrigatório" });
  try {
    const id = PermissionService.createProfile(orgOf(req), name, permissions);
    logAuthEvent(orgOf(req), req.user?.userId, undefined, "ROLE_PROFILE_CREATED", { id, name });
    res.json(PermissionService.getProfile(orgOf(req), id));
  } catch (e) { res.status(500).json({ error: "Falha ao criar perfil" }); }
});

// PUT /api/permissions/profiles/:id — atualiza nome/permissões (Dono é imutável).
router.put("/profiles/:id", requirePermission("usuarios", "write"), (req: AuthRequest, res: Response): any => {
  const { name, permissions } = req.body || {};
  const r = PermissionService.updateProfile(orgOf(req), req.params.id, { name, permissions });
  if (!r.ok) {
    if (r.error === "not_found") return res.status(404).json({ error: "Perfil não encontrado" });
    if (r.error === "owner_immutable") return res.status(400).json({ error: "O perfil Dono não pode ser alterado" });
    return res.status(400).json({ error: r.error });
  }
  logAuthEvent(orgOf(req), req.user?.userId, undefined, "ROLE_PROFILE_UPDATED", { id: req.params.id });
  res.json(PermissionService.getProfile(orgOf(req), req.params.id));
});

// POST /api/permissions/profiles/:id/duplicate — clona um perfil.
router.post("/profiles/:id/duplicate", requirePermission("usuarios", "write"), (req: AuthRequest, res: Response): any => {
  const id = PermissionService.duplicateProfile(orgOf(req), req.params.id, req.body?.name);
  if (!id) return res.status(404).json({ error: "Perfil não encontrado" });
  logAuthEvent(orgOf(req), req.user?.userId, undefined, "ROLE_PROFILE_DUPLICATED", { from: req.params.id, id });
  res.json(PermissionService.getProfile(orgOf(req), id));
});

// DELETE /api/permissions/profiles/:id — exclui perfil custom sem usuários.
router.delete("/profiles/:id", requirePermission("usuarios", "delete"), (req: AuthRequest, res: Response): any => {
  const r = PermissionService.deleteProfile(orgOf(req), req.params.id);
  if (!r.ok) {
    if (r.error === "not_found") return res.status(404).json({ error: "Perfil não encontrado" });
    if (r.error === "owner_immutable") return res.status(400).json({ error: "O perfil Dono não pode ser excluído" });
    if (r.error === "has_users") return res.status(400).json({ error: "Reatribua os usuários deste perfil antes de excluí-lo" });
    return res.status(400).json({ error: r.error });
  }
  logAuthEvent(orgOf(req), req.user?.userId, undefined, "ROLE_PROFILE_DELETED", { id: req.params.id });
  res.json({ success: true });
});

// PUT /api/permissions/users/:userId/profile — atribui um perfil a um usuário.
router.put("/users/:userId/profile", requirePermission("usuarios", "write"), (req: AuthRequest, res: Response): any => {
  const { profileId } = req.body || {};
  if (!profileId) return res.status(400).json({ error: "profileId obrigatório" });
  const r = PermissionService.assignToUser(orgOf(req), req.params.userId, profileId);
  if (!r.ok) return res.status(400).json({ error: r.error });
  logAuthEvent(orgOf(req), req.user?.userId, req.params.userId, "USER_PROFILE_ASSIGNED", { profileId });
  res.json({ success: true });
});

export default router;
