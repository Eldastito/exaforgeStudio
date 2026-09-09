/**
 * Prova de posse do telefone (PRD WhatsApp Unificado — RF-04 §10, F3.2).
 *
 * No cadastro novo, o telefone é vinculado ao usuário AUTENTICADO só depois de
 * ELE PROVAR que possui o aparelho: um código de 6 dígitos é enviado ao número
 * e conferido aqui. Reusa o MOLDE de verificação já validado no projeto (PIN
 * Fase 28 / FalaTuProtocolService): `sha256` + `timingSafeEqual` + TTL + cap de
 * tentativas — não é um segundo mecanismo de segurança, é a mesma receita
 * aplicada ao vínculo telefone↔usuário.
 *
 * Invariantes (RF-04 §10):
 *  - Telefone é ENDEREÇO do canal, não substitui o usuário/perfil. Esta fatia
 *    NÃO escreve `users.phone` — o vínculo verificado vive em
 *    `user_phone_bindings` (aditivo). O resolvedor de identidade (F3.1b) passa
 *    a PREFERIR o vínculo verificado na fatia de modo misto (F3.3).
 *  - Verificar um número NOVO exige reverificação e REVOGA o vínculo anterior:
 *    (a) o vínculo verificado ANTERIOR do próprio usuário (mudou de número), e
 *    (b) qualquer vínculo verificado do MESMO número a OUTRO usuário da org
 *    (um dono verificado por número). Revogação é UPDATE status='revoked'
 *    (nunca DELETE — convenção nº 9).
 *  - Confiança do vínculo verificado por posse = 'high' (a busca tolerante por
 *    9º dígito da F3.1b é 'medium'; um vínculo legado migrado seria menor).
 *  - Multi-tenant: toda consulta filtra `organization_id`.
 *
 * Entrega do código: injetável (`opts.deliver`) — o TRANSPORTE (WhatsApp/SMS)
 * é responsabilidade do chamador (rota/handler), não deste serviço. Mantém a
 * fatia pura/testável e evita acoplar a resolução de canal aqui.
 */
import { randomUUID, randomInt, createHash, timingSafeEqual } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { onlyDigits } from "./phoneMatch.js";

const VERIFY_TTL_MIN = 10;
const VERIFY_MAX_ATTEMPTS = 5;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const safeEq = (aHex: string, bHex: string) => {
  const a = Buffer.from(aHex, "hex"); const b = Buffer.from(bHex, "hex");
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
};

/** Dígitos sem DDI 55 — mesma régua de igualdade do phoneMatch/SenderIdentity. */
function normalizePhone(v: unknown): string {
  const d = onlyDigits(v);
  return d.length >= 12 && d.startsWith("55") ? d.slice(2) : d;
}

export type PhoneDeliver = (phone: string, code: string) => Promise<void> | void;

export interface PhoneBindingView {
  id: string;
  phone: string;
  status: "pending" | "verified" | "revoked";
  confidence: string | null;
  verifiedAt: string | null;
}

export class PhonePossessionService {
  /**
   * Inicia a prova de posse: gera e ENVIA (via `opts.deliver`) um código de 6
   * dígitos pro número, guardando só o hash + TTL. Reabre/renova o vínculo
   * `pending` do par (org,user,phone). NUNCA devolve o código.
   */
  static async startVerification(
    orgId: string,
    userId: string,
    phoneInput: string,
    opts: { deliver: PhoneDeliver; now?: Date },
  ): Promise<{ requested: true; bindingId: string }> {
    if (!orgId || !userId) throw new Error("Organização e usuário são obrigatórios.");
    const phone = String(phoneInput || "").trim();
    const normalized = normalizePhone(phone);
    // 10-15 dígitos após normalizar (DDD+assinante BR = 10/11; internacionais maiores).
    if (normalized.length < 10 || normalized.length > 15) {
      throw new Error("Telefone inválido. Informe com DDD, ex.: (11) 98765-4321.");
    }
    if (typeof opts?.deliver !== "function") throw new Error("Transporte de entrega do código não configurado.");

    const now = opts.now || new Date();
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expires = new Date(now.getTime() + VERIFY_TTL_MIN * 60_000).toISOString();

    // Reusa o vínculo pending existente do par (org,user,phone); senão cria.
    const existing = db.prepare(
      `SELECT id FROM user_phone_bindings WHERE organization_id = ? AND user_id = ? AND phone_normalized = ? AND status = 'pending'`,
    ).get(orgId, userId, normalized) as any;

    let bindingId: string;
    if (existing) {
      bindingId = existing.id;
      db.prepare(
        `UPDATE user_phone_bindings SET phone = ?, verify_code_hash = ?, verify_expires_at = ?, verify_attempts = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ).run(phone, sha256(code), expires, bindingId);
    } else {
      bindingId = randomUUID();
      db.prepare(
        `INSERT INTO user_phone_bindings (id, organization_id, user_id, phone, phone_normalized, status, verify_code_hash, verify_expires_at, verify_attempts)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 0)`,
      ).run(bindingId, orgId, userId, phone, normalized, sha256(code), expires);
    }

    // Entrega fora do serviço (transporte é do chamador). Só depois de gravar o
    // hash — se a entrega falhar, o código já está armado para nova tentativa.
    await opts.deliver(phone, code);
    logAuthEvent(orgId, userId, null, "PHONE_POSSESSION_REQUEST", { bindingId, phoneNormalized: normalized });
    return { requested: true, bindingId };
  }

  /**
   * Confirma o código. Em caso de sucesso: revoga o vínculo anterior do usuário
   * e qualquer vínculo verificado do MESMO número a outro usuário, e marca este
   * como verified/high. Erros seguem o molde PIN (expirado / muitas tentativas /
   * código incorreto com incremento).
   */
  static confirm(orgId: string, userId: string, phoneInput: string, codeInput: unknown, opts?: { now?: Date }): { verified: true; bindingId: string } {
    const normalized = normalizePhone(phoneInput);
    const now = opts?.now || new Date();
    const b = db.prepare(
      `SELECT * FROM user_phone_bindings WHERE organization_id = ? AND user_id = ? AND phone_normalized = ? AND status = 'pending'`,
    ).get(orgId, userId, normalized) as any;
    if (!b) throw new Error("Nenhuma verificação pendente para este número. Peça o código primeiro.");
    if (!b.verify_code_hash || !b.verify_expires_at) throw new Error("Peça o código de verificação primeiro.");
    if (new Date(b.verify_expires_at).getTime() < now.getTime()) throw new Error("Código expirado — peça um novo.");
    if (Number(b.verify_attempts) >= VERIFY_MAX_ATTEMPTS) throw new Error("Muitas tentativas — peça um novo código.");

    const code = String(codeInput || "").replace(/\D/g, "");
    if (code.length !== 6 || !safeEq(sha256(code), b.verify_code_hash)) {
      db.prepare(`UPDATE user_phone_bindings SET verify_attempts = verify_attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(b.id);
      throw new Error("Código incorreto.");
    }

    const tx = db.transaction(() => {
      // (a) reverificação: revoga o vínculo verificado ANTERIOR do usuário
      //     (mudou de número) e (b) o MESMO número verificado a OUTRO usuário.
      db.prepare(
        `UPDATE user_phone_bindings SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE organization_id = ? AND status = 'verified' AND id != ? AND (user_id = ? OR phone_normalized = ?)`,
      ).run(orgId, b.id, userId, normalized);
      db.prepare(
        `UPDATE user_phone_bindings SET status = 'verified', confidence = 'high', verified_at = CURRENT_TIMESTAMP,
           verify_code_hash = NULL, verify_expires_at = NULL, verify_attempts = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ).run(b.id);
    });
    tx();
    logAuthEvent(orgId, userId, null, "PHONE_POSSESSION_VERIFIED", { bindingId: b.id, phoneNormalized: normalized });
    return { verified: true, bindingId: b.id };
  }

  /** Vínculo VERIFICADO de um número na org (pro resolvedor de identidade, F3.3). null se não houver. */
  static verifiedBinding(orgId: string, phoneInput: string): { userId: string; confidence: string | null; bindingId: string } | null {
    const normalized = normalizePhone(phoneInput);
    if (!orgId || !normalized) return null;
    const b = db.prepare(
      `SELECT id, user_id, confidence FROM user_phone_bindings WHERE organization_id = ? AND phone_normalized = ? AND status = 'verified' ORDER BY verified_at DESC LIMIT 1`,
    ).get(orgId, normalized) as any;
    return b ? { userId: b.user_id, confidence: b.confidence ?? null, bindingId: b.id } : null;
  }

  /** Revoga explicitamente um vínculo do usuário (UPDATE, nunca DELETE). */
  static revoke(orgId: string, userId: string, bindingId: string): { ok: true } {
    const r = db.prepare(
      `UPDATE user_phone_bindings SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ? AND user_id = ? AND status != 'revoked'`,
    ).run(bindingId, orgId, userId);
    if (r.changes === 0) throw new Error("Vínculo não encontrado.");
    logAuthEvent(orgId, userId, null, "PHONE_POSSESSION_REVOKE", { bindingId });
    return { ok: true };
  }

  /** Vínculos do usuário (REDIGIDO — nunca devolve hash/código). */
  static list(orgId: string, userId: string): PhoneBindingView[] {
    const rows = db.prepare(
      `SELECT id, phone, status, confidence, verified_at FROM user_phone_bindings WHERE organization_id = ? AND user_id = ? ORDER BY created_at DESC`,
    ).all(orgId, userId) as any[];
    return rows.map((r) => ({ id: r.id, phone: r.phone, status: r.status, confidence: r.confidence ?? null, verifiedAt: r.verified_at ?? null }));
  }
}

export default PhonePossessionService;
