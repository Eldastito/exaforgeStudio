import db from "./db.js";

interface SecurityIssue {
  id: string;
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  recommendation: string;
}

/**
 * Security Audit — checks reais (não mais mocks).
 *
 * Rodado sob demanda pelo Admin. Cada check é isolado num try/catch —
 * uma auditoria que quebra não pode derrubar o painel.
 */
export class SecurityAuditService {
  static async runSecurityCheck(): Promise<SecurityIssue[]> {
    const issues: SecurityIssue[] = [];
    const isProd = process.env.NODE_ENV === 'production';

    // ==== 1. Segredos e chaves ====

    if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY) {
      issues.push({
        id: 'env-ai-key',
        category: 'environment',
        severity: 'critical',
        title: 'Nenhuma chave de IA configurada',
        description: 'Nem GEMINI_API_KEY nem OPENAI_API_KEY estão configuradas. Toda IA vai falhar.',
        recommendation: 'Configure pelo menos uma no painel de deploy.'
      });
    }

    // JWT_SECRET — check de robustez (não só existência).
    const jwt = process.env.JWT_SECRET || '';
    if (!jwt) {
      issues.push({
        id: 'env-jwt-missing',
        category: 'environment',
        severity: 'critical',
        title: 'JWT_SECRET ausente',
        description: 'Sem JWT_SECRET, tokens de sessão não são assináveis com segurança.',
        recommendation: 'Configure JWT_SECRET com pelo menos 32 caracteres aleatórios.'
      });
    } else if (jwt.length < 32) {
      issues.push({
        id: 'env-jwt-weak',
        category: 'environment',
        severity: isProd ? 'critical' : 'high',
        title: 'JWT_SECRET curto demais',
        description: `JWT_SECRET tem ${jwt.length} caracteres — recomendado ≥ 32 (256 bits).`,
        recommendation: 'Gere um novo com `openssl rand -hex 32` e substitua.'
      });
    } else if (/^(test|dev|ci|change|secret|placeholder)/i.test(jwt)) {
      issues.push({
        id: 'env-jwt-default',
        category: 'environment',
        severity: 'critical',
        title: 'JWT_SECRET parece placeholder',
        description: `JWT_SECRET começa com "${jwt.slice(0, 8)}…" — provavelmente é um placeholder.`,
        recommendation: 'Substitua por um valor gerado aleatoriamente antes de subir.'
      });
    }

    // ENCRYPTION_KEY — check dedicado (segredos em repouso).
    const enc = process.env.ENCRYPTION_KEY || '';
    if (isProd && !enc) {
      issues.push({
        id: 'env-encryption-derived',
        category: 'environment',
        severity: 'high',
        title: 'ENCRYPTION_KEY não dedicada',
        description: 'Sem ENCRYPTION_KEY explícita, a criptografia de segredos em repouso é derivada do JWT_SECRET. Se você rotacionar o JWT, perde acesso aos tokens de canal salvos.',
        recommendation: 'Gere `openssl rand -hex 32` e configure ENCRYPTION_KEY como variável dedicada.'
      });
    }

    if (isProd && !process.env.EVOLUTION_API_KEY) {
      issues.push({
        id: 'env-evolution-key',
        category: 'environment',
        severity: 'medium',
        title: 'Chave Evolution API ausente em produção',
        description: 'Sem EVOLUTION_API_KEY, canais que usam Evolution não vão enviar mensagens.',
        recommendation: 'Configure EVOLUTION_API_KEY.'
      });
    }

    // ==== 2. Consistência de dados (tenant leak) ====

    try {
      const orgsWithoutOwner = db.prepare(`
        SELECT COUNT(*) as count
        FROM organization_settings o
        LEFT JOIN users u ON u.organization_id = o.organization_id AND u.role = 'owner'
        WHERE u.id IS NULL AND o.status = 'active'
      `).get() as any;

      if (orgsWithoutOwner?.count > 0) {
        issues.push({
          id: 'db-org-owner',
          category: 'database',
          severity: 'high',
          title: 'Empresas ativas sem proprietário (owner)',
          description: `Existem ${orgsWithoutOwner.count} empresas ativas sem usuário owner.`,
          recommendation: 'Crie um owner para cada empresa — sem isso, ela é órfã e ninguém consegue administrar.'
        });
      }
    } catch (e) { /* schema pode variar entre versões — ignora silenciosamente */ }

    // Tenant leak em tabelas críticas — check universal, sem depender de schema.
    const tenantTables = ['tickets', 'messages', 'contacts', 'channels', 'products_services'];
    for (const t of tenantTables) {
      try {
        const row = db.prepare(`SELECT COUNT(*) as count FROM ${t} WHERE organization_id IS NULL OR organization_id = ''`).get() as any;
        if (row?.count > 0) {
          issues.push({
            id: `db-${t}-tenant-leak`,
            category: 'database',
            severity: 'critical',
            title: `Vazamento de tenant em ${t}`,
            description: `${row.count} linha(s) em ${t} sem organization_id.`,
            recommendation: `Identifique a origem da inserção (grep no código) e adicione o organization_id no INSERT.`,
          });
        }
      } catch { /* tabela pode não existir em instalações mínimas */ }
    }

    // ==== 3. CORS aberto em produção ====
    if (isProd && (!process.env.CORS_ORIGIN || process.env.CORS_ORIGIN === '*')) {
      issues.push({
        id: 'sec-cors',
        category: 'security',
        severity: 'high',
        title: 'CORS aberto em produção',
        description: 'A API aceita requisições de qualquer origem (CORS *).',
        recommendation: 'Defina CORS_ORIGIN com o domínio EXATO da aplicação.'
      });
    }

    // ==== 4. Rate limit ====
    if (isProd && process.env.ENABLE_RATE_LIMIT !== 'true') {
      issues.push({
        id: 'sec-rate-limit',
        category: 'security',
        severity: 'medium',
        title: 'Rate limit desligado em produção',
        description: 'ENABLE_RATE_LIMIT !== "true". Rotas públicas (webhooks, login) ficam expostas a abuso.',
        recommendation: 'Configure ENABLE_RATE_LIMIT=true e valide os limites por endpoint.'
      });
    }

    // ==== 5. Prompt injection (heurística) ====
    if (process.env.STRICT_PROMPT_FILTER !== 'true') {
      issues.push({
        id: 'sec-prompt-injection',
        category: 'ai_security',
        severity: 'low',
        title: 'Filtro estrito de prompt injection desligado',
        description: 'STRICT_PROMPT_FILTER !== "true". Inputs do usuário na IA passam sem filtro adicional.',
        recommendation: 'Configure STRICT_PROMPT_FILTER=true pra ligar o filtro heurístico (regex + comprimento máximo).'
      });
    }

    // ==== 6. Auditoria acontecendo? ====
    // Check: houve pelo menos 1 evento de auth_events nas últimas 24h em prod?
    // Se produção está ativa mas ninguém logou/emitiu evento em 24h, é sinal de:
    // (a) tabela travada / bug de write
    // (b) sistema morto
    // (c) audit não chamado nos hot paths (mais comum, indica regressão)
    if (isProd) {
      try {
        const recent = db.prepare(
          `SELECT COUNT(*) as count FROM auth_events WHERE created_at >= datetime('now', '-24 hours')`
        ).get() as any;
        if (recent && recent.count === 0) {
          issues.push({
            id: 'audit-silent',
            category: 'observability',
            severity: 'medium',
            title: 'Auditoria silenciosa nas últimas 24h',
            description: 'Nenhum auth_event registrado nas últimas 24h em produção. Pode ser produção ociosa OU auditoria quebrada em algum caminho crítico.',
            recommendation: 'Se a plataforma tem tráfego real, verifique logAuthEvent em rotas de login/logout/mudança de plano.'
          });
        }
      } catch { /* tabela pode não existir em versões mais antigas */ }
    }

    // ==== 7. Backup recente? ====
    if (isProd) {
      try {
        const row = db.prepare(
          `SELECT MAX(created_at) as last FROM backup_jobs WHERE status = 'completed'`
        ).get() as any;
        const last = row?.last ? new Date(row.last) : null;
        const daysAgo = last ? Math.floor((Date.now() - last.getTime()) / 86400000) : Infinity;
        if (!last || daysAgo > 7) {
          issues.push({
            id: 'ops-backup-stale',
            category: 'operations',
            severity: last ? 'medium' : 'high',
            title: last ? `Último backup há ${daysAgo} dias` : 'Nenhum backup registrado',
            description: last
              ? `Último backup completo em ${last.toLocaleString('pt-BR')}. Backups semanais são a política mínima.`
              : 'Não há backup completo registrado em backup_jobs.',
            recommendation: 'Rode um backup manual agora e agende o Scheduler pra backup semanal.',
          });
        }
      } catch { /* backup_jobs pode não existir */ }
    }

    return issues;
  }
}
