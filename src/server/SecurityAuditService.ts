import db from "./db.js";

interface SecurityIssue {
  id: string;
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  recommendation: string;
}

export class SecurityAuditService {
  static async runSecurityCheck(): Promise<SecurityIssue[]> {
    const issues: SecurityIssue[] = [];

    // 1. Check Env Vars
    if (!process.env.GEMINI_API_KEY) {
      issues.push({
        id: 'env-gemini-key',
        category: 'environment',
        severity: 'critical',
        title: 'Chave Gemini ausente',
        description: 'A variável GEMINI_API_KEY não está configurada.',
        recommendation: 'Configure a variável no seu arquivo .env ou painel de deploy.'
      });
    }

    if (process.env.NODE_ENV !== 'production' && !process.env.EVOLUTION_API_KEY) {
       issues.push({
        id: 'env-evolution-key',
        category: 'environment',
        severity: 'medium',
        title: 'Chave Evolution API ausente',
        description: 'O webhook de WhatsApp/Instagram pode falhar ou usar chave padrão.',
        recommendation: 'Configure EVOLUTION_API_KEY.'
       });
    }

    // 2. Check Database Consistency
    try {
      // Check orgs without owner
      const orgsWithoutOwnerCount = db.prepare(`
         SELECT COUNT(*) as count 
         FROM organization_settings o
         LEFT JOIN users u ON u.organization_id = o.organization_id AND u.role = 'owner'
         WHERE u.id IS NULL
      `).get() as any;

      if (orgsWithoutOwnerCount?.count > 0) {
        issues.push({
          id: 'db-org-owner',
          category: 'database',
          severity: 'high',
          title: 'Empresas sem proprietário (owner)',
          description: `Existem ${orgsWithoutOwnerCount.count} empresas sem usuário admin associado.`,
          recommendation: 'Crie um usuário owner para cada empresa para garantir a administração.'
        });
      }

      // Check for tables missing organization_id might be done through schema inspection, but we'll mock it 
      // or rely on our known schema constraints.
      // We check if tickets have org id
      const ticketsWithoutOrg = db.prepare(`SELECT COUNT(*) as count FROM tickets WHERE organization_id IS NULL OR organization_id = ''`).get() as any;
      if (ticketsWithoutOrg?.count > 0) {
        issues.push({
          id: 'db-ticket-tenant',
          category: 'database',
          severity: 'critical',
          title: 'Vazamento de tenant em tickets',
          description: `Existem ${ticketsWithoutOrg.count} tickets sem organization_id! Risco de vazamento de dados.`,
          recommendation: 'Corrija as inserções no banco para sempre associar a uma empresa.'
        });
      }

    } catch(e) {
      console.error(e);
      issues.push({
          id: 'db-query-error',
          category: 'database',
          severity: 'high',
          title: 'Erro de auditoria de banco',
          description: 'A query de verificação falhou.',
          recommendation: 'Valide o schema.'
      });
    }

    // 3. CORS Check
    // We can just add an issue if CORS is * in production. Since we can't introspect app easily from here, we check ENV.
    if (process.env.NODE_ENV === 'production' && (!process.env.CORS_ORIGIN || process.env.CORS_ORIGIN === '*')) {
      issues.push({
        id: 'sec-cors',
        category: 'security',
        severity: 'high',
        title: 'CORS aberto em Produção',
        description: 'Vulnerabilidade: a API aceita requisições de qualquer origem (CORS *).',
        recommendation: 'Defina a variável CORS_ORIGIN com o domínio exato.'
      });
    }

    // 4. Rate Limiting check (mock representation of configuration check)
    // Here we just warn if it's not explicitly in our code
    const hasRateLimitConfigured = process.env.ENABLE_RATE_LIMIT === 'true';
    if (!hasRateLimitConfigured) {
      issues.push({
        id: 'sec-rate-limit',
        category: 'security',
        severity: 'medium',
        title: 'Rate Limit (DDoS)',
        description: 'A API não tem controle de Rate Limit ativo na configuração.',
        recommendation: 'Ative middlewares de rate limit nas rotas públicas (webhooks e logins).'
      });
    }

    // Prompt Injection Check Warning (LGPD & Security)
    if (process.env.STRICT_PROMPT_FILTER !== 'true') {
      issues.push({
          id: 'sec-prompt-injection',
          category: 'ai_security',
          severity: 'low',
          title: 'Proteção contra Prompt Injection (Filtro Estrito)',
          description: 'Recomenda-se validar as entradas dos usuários com filtros estritos. A variável STRICT_PROMPT_FILTER não está habilitada.',
          recommendation: 'Adicione STRICT_PROMPT_FILTER=true no servidor para ativar o bloqueio rigoroso (heurístico) ou semântico no RAG.'
      });
    }

    return issues;
  }
}
