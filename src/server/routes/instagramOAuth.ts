import { Router } from "express";
import crypto from "crypto";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middleware/auth.js";
import { JWT_SECRET } from "../config/secret.js";

const router = Router();

// 'state' do OAuth ASSINADO (HMAC) para impedir que um atacante forje um state
// apontando para outra organização (o callback é público). Validade de 10 min.
const STATE_TTL_MS = 10 * 60 * 1000;
function signState(orgId: string): string {
  const payload = Buffer.from(JSON.stringify({ orgId, t: Date.now() })).toString("base64url");
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function verifyState(state: string): string | null {
  if (!state || typeof state !== "string" || !state.includes(".")) return null;
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { orgId, t } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!orgId || typeof t !== "number" || Date.now() - t > STATE_TTL_MS) return null;
    return String(orgId);
  } catch { return null; }
}

// Credenciais do App da Meta (Instagram API with Instagram Login).
const IG_APP_ID = process.env.INSTAGRAM_APP_ID || process.env.IG_APP_ID || '';
const IG_APP_SECRET = process.env.INSTAGRAM_APP_SECRET || process.env.IG_APP_SECRET || '';
const APP_URL = (process.env.APP_URL || 'https://zapflowia.tesseractauto.com.br').replace(/\/$/, '');
const REDIRECT_URI = `${APP_URL}/api/integrations/instagram/callback`;
// Escopos base (mensagens/comentários). O de INSIGHTS só é pedido quando
// IG_INSIGHTS_SCOPE=1 (após o App Review da Meta), para não quebrar o login
// de apps ainda não aprovados para esse escopo.
const BASE_SCOPES = 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments';
const SCOPES = [
  BASE_SCOPES,
  process.env.IG_INSIGHTS_SCOPE === '1' ? 'instagram_business_manage_insights' : '',
  process.env.IG_PUBLISH_SCOPE === '1' ? 'instagram_business_content_publish' : '',
].filter(Boolean).join(',');

// GET /api/integrations/instagram/login-url — devolve a URL de autorização (protegida)
router.get("/instagram/login-url", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!IG_APP_ID || !IG_APP_SECRET) {
    return res.status(400).json({ error: "Configure INSTAGRAM_APP_ID e INSTAGRAM_APP_SECRET no servidor." });
  }
  // 'state' assinado (HMAC) carrega o org para sabermos a quem atribuir no callback.
  const state = signState(orgId);
  const url = `https://www.instagram.com/oauth/authorize`
    + `?force_reauth=true&client_id=${encodeURIComponent(IG_APP_ID)}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&response_type=code&scope=${encodeURIComponent(SCOPES)}`
    + `&state=${state}`;
  res.json({ url });
});

export default router;

// Handler público do callback (registrado em server.ts, fora do protectedApi,
// porque a Meta redireciona o navegador para cá sem o nosso JWT).
export async function instagramCallback(req: any, res: any) {
  const code = req.query.code as string;
  const stateRaw = req.query.state as string;
  if (!code) {
    return res.status(400).send("Falta o parâmetro 'code'.");
  }
  // Valida a assinatura do state — rejeita state forjado/expirado (anti-CSRF/IDOR).
  const orgId = verifyState(stateRaw);
  if (!orgId) {
    console.warn('[IG OAuth] state inválido/expirado — callback rejeitado.');
    return res.redirect(`${APP_URL}/?ig=erro`);
  }

  try {
    // 1. Troca o code por um token de CURTA duração.
    const form = new URLSearchParams();
    form.set('client_id', IG_APP_ID);
    form.set('client_secret', IG_APP_SECRET);
    form.set('grant_type', 'authorization_code');
    form.set('redirect_uri', REDIRECT_URI);
    form.set('code', code);

    const shortRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST', body: form,
    });
    const shortData: any = await shortRes.json().catch(() => ({}));
    if (!shortRes.ok || !shortData.access_token) {
      console.error('[IG OAuth] Falha no token curto:', shortData);
      return res.redirect(`${APP_URL}/?ig=erro`);
    }
    const shortToken = shortData.access_token;
    const igUserId = String(shortData.user_id || shortData.user?.id || '');

    // 2. Troca por um token de LONGA duração (60 dias).
    let longToken = shortToken;
    try {
      const longRes = await fetch(
        `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(IG_APP_SECRET)}&access_token=${encodeURIComponent(shortToken)}`
      );
      const longData: any = await longRes.json().catch(() => ({}));
      if (longRes.ok && longData.access_token) longToken = longData.access_token;
    } catch (e) { /* mantém o curto se falhar */ }

    // 3. Descobre dados da conta (id + username).
    let username = '';
    let businessId = igUserId;
    try {
      const meRes = await fetch(`https://graph.instagram.com/v21.0/me?fields=user_id,username&access_token=${encodeURIComponent(longToken)}`);
      const me: any = await meRes.json().catch(() => ({}));
      if (me.username) username = me.username;
      if (me.user_id) businessId = String(me.user_id);
    } catch (e) { /* ok */ }

    // 4. Salva/atualiza o canal de Instagram da organização (com o token completo).
    const existing = db.prepare("SELECT id FROM channels WHERE provider = 'instagram' AND organization_id = ?").get(orgId) as any;
    if (existing) {
      db.prepare("UPDATE channels SET token_encrypted = ?, identifier = ?, name = ?, status = 'connected', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(longToken, businessId || existing.identifier, username ? `Instagram @${username}` : 'Instagram Direct', existing.id);
    } else {
      db.prepare("INSERT INTO channels (id, organization_id, provider, name, identifier, token_encrypted, status) VALUES (?, ?, 'instagram', ?, ?, ?, 'connected')")
        .run(uuidv4(), orgId, username ? `Instagram @${username}` : 'Instagram Direct', businessId, longToken);
    }
    console.log(`[IG OAuth] Conta conectada via OAuth: @${username || '?'} (id ${businessId}) org ${orgId}`);

    // 5. Inscreve a conta no webhook `messages` do app (subscribed_apps): sem
    // isso a Meta NUNCA entrega DM ao nosso webhook, e o lojista fica sem saber
    // por que a IA não responde. Precisa ser feita explicitamente pelo produto
    // Instagram API with Instagram Login — não vem "por padrão" após o OAuth.
    // Best-effort: falha aqui só é logada; a chamada pode ser refeita mais tarde
    // pela UI, e a conexão do canal continua válida para leitura do feed.
    try {
      const subRes = await fetch(`https://graph.instagram.com/v21.0/me/subscribed_apps?subscribed_fields=messages&access_token=${encodeURIComponent(longToken)}`, { method: 'POST' });
      const subBody: any = await subRes.json().catch(() => ({}));
      if (!subRes.ok || subBody?.error) {
        console.error('[IG OAuth] Falha em subscribed_apps (webhook messages):', subBody?.error || subBody);
      } else {
        console.log('[IG OAuth] Inscrito no webhook messages para @' + (username || '?'));
      }
    } catch (e) {
      console.error('[IG OAuth] Erro em subscribed_apps:', e);
    }

    return res.redirect(`${APP_URL}/?ig=conectado`);
  } catch (e: any) {
    console.error('[IG OAuth] Erro no callback:', e);
    return res.redirect(`${APP_URL}/?ig=erro`);
  }
}
