import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import db from "../db.js";

const JWT_SECRET = process.env.JWT_SECRET || 'zappflow_secret_key_123';

export interface AuthRequest extends Request {
  user?: any;
  organizationId?: string;
}

export const requireAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "Unauthorized: No token provided" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    req.user = decoded;
    req.organizationId = decoded.organizationId;
    req.headers['x-organization-id'] = decoded.organizationId; // for backwards compatibility
    next();
  } catch (error) {
    return res.status(401).json({ error: "Unauthorized: Invalid token" });
  }
};

export const requireOrganizationAccess = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.organizationId) {
    return res.status(403).json({ error: "Forbidden: No organization assigned" });
  }

  try {
    const org: any = db.prepare('SELECT status FROM organization_settings WHERE organization_id = ?').get(req.organizationId);
    
    if (!org) {
       return res.status(404).json({ error: "Organization not found" });
    }

    if (org.status === 'blocked') {
       return res.status(403).json({ error: "CONTA BLOQUEADA. Entre em contato com o suporte." });
    }
    
    next();
  } catch (e) {
    return res.status(500).json({ error: "Internal server error checking organization" });
  }
};

export const requireMasterAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user || req.user.email !== 'eldastito@gmail.com') { // Basic check for master admin for now
     return res.status(403).json({ error: "Forbidden: Master Admin Access Required" });
  }
  next();
};
