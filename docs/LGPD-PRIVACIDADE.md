# Privacidade & LGPD — ZappFlow

> Como o ZappFlow trata dados pessoais e atende à Lei Geral de Proteção de Dados
> (Lei 13.709/2018). Documento de referência para uso comercial e jurídico.

## 1. Papéis

- **ZappFlow (plataforma):** atua como **operador** — processa dados pessoais em
  nome de cada empresa cliente, conforme as instruções dela.
- **Empresa cliente (hotel, mercado, clínica…):** é a **controladora** dos dados
  dos seus próprios clientes/contatos.

Cada empresa é uma **organização isolada** na plataforma (ver §4).

## 2. Dados tratados

| Categoria | Exemplos | Base legal típica |
|---|---|---|
| Identificação do contato | nome, telefone/WhatsApp, e-mail | execução de contrato / legítimo interesse |
| Conteúdo de atendimento | mensagens, áudios transcritos, imagens | execução de contrato |
| Transacional | pedidos, reservas, pagamentos | execução de contrato / obrigação legal (fiscal) |
| Operacional | tags, score de lead, histórico | legítimo interesse |
| Marketing | opt-out de campanhas | consentimento / legítimo interesse |

> O ZappFlow **não** trata dados sensíveis por padrão. Em saúde, a IA não dá
> diagnóstico/conduta e responde apenas o documentado.

## 3. Medidas de segurança implementadas

- **Isolamento multi-tenant** por `organization_id` (toda consulta escopada pelo
  JWT). Comprovado por teste automatizado: `npm run test:isolation`.
- **Criptografia de segredos em repouso** (AES-256-GCM): token de gateway de
  pagamento e tokens OAuth do Google.
- **2FA / MFA opcional** (TOTP) por usuário.
- **Senhas** com hash bcrypt; bloqueio anti-bruteforce; auditoria de login.
- **Transporte** HTTPS forçado, HSTS, CORS restrito; **SQL** com prepared statements.

## 4. Retenção de dados

Opt-in por organização (Configurações › Privacidade): após `retention_days`
(mín. 30), o **conteúdo das mensagens de atendimentos encerrados** é expurgado
automaticamente (`LgpdService.retentionPass`, roda no Scheduler). Registros
financeiros (pedidos/valores) são mantidos sem dado pessoal para fins contábeis.

## 5. Direitos do titular

Disponíveis por contato em **Contatos**:
- **Acesso / Portabilidade:** "Exportar dados" → baixa um JSON com contato,
  conversas, pedidos, reservas e agendamentos (`GET /api/lgpd/contact/:id/export`).
- **Esquecimento:** "Esquecer (LGPD)" → anonimiza o contato (remove nome,
  telefone, e-mail, foto) e apaga o conteúdo das conversas
  (`POST /api/lgpd/contact/:id/forget`). Mantém o histórico financeiro sem PII.
- **Oposição a marketing:** o cliente que responde "sair/parar" é marcado como
  opt-out e deixa de receber campanhas.

## 6. Subprocessadores (dependem da configuração de cada cliente)

- **OpenAI** (IA/transcrição), **Google** (Calendar/Gmail/Drive, se conectado),
  **Mercado Pago** (pagamento, se conectado), provedor de **WhatsApp/Instagram**.
- A empresa cliente deve refletir esses subprocessadores na sua própria política.

## 7. Pendências recomendadas (roadmap de conformidade)

- Cifra/hash de `pay_webhook_secret` e `integration_token` (hoje em texto por
  serem consultados por valor — exige esquema hash-de-lookup + cifra de exibição).
- Registro de consentimento granular e banner/aviso configurável.
- DPA (acordo de tratamento de dados) modelo para anexar aos contratos.
- Logs de acesso a dados pessoais (trilha de auditoria por titular).
