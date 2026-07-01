# ADR-004 — Recording and Evidence Chain

**Status:** Aceito
**Data:** Fase 0

## Contexto

O PRD (§11) exige que toda evidência tenha hash de integridade, marca d'água, histórico de acesso/exportação e — para o nível Enterprise — assinatura/HMAC, timestamp confiável e cadeia de custódia imutável. O cliente corrigiu explicitamente a proposta original para deixar claro que o produto deve falar em **"integridade e rastreabilidade"**, nunca em **"valor probatório garantido"**, sem análise jurídica do caso concreto.

Precedente relevante já existente no codebase: `BackupService.ts` já calcula **checksum SHA-256** de snapshots de organização (linhas ~105-107) — é o único precedente real de hashing de integridade no projeto, e serve de padrão a replicar. `EncryptionService.ts` (AES-256-GCM, formato `enc:v1:...`) é o padrão de criptografia/segredo já usado para tokens OAuth, `mfa_secret` e `pay_gateway_token` — reaproveitável para derivar chaves de assinatura por tenant. `LgpdService.ts` já implementa o conceito de "reter até X dias, exceto quando bloqueado" para mensagens de ticket — o mesmo princípio se aplica a evidência vinculada a incidente aberto.

## Decisão

### MVP (Fase 1–2)

1. Todo clipe/segmento de evidência recebe **SHA-256** no momento da geração (Vision Edge), seguindo o padrão já usado em `BackupService.ts`.
2. `vision_evidence` grava: tenant, site, câmera, evento/incidente relacionado, início/fim, hash, timestamp, gateway de origem, usuário/serviço gerador, política de retenção, contagem de exportação — exatamente os campos já modelados no PRD §19.3.
3. Marca d'água é aplicada apenas em **clipes exportados** (não na gravação original), via filtro de overlay no FFmpeg externo (ADR-003) — nunca modifica o arquivo de gravação-fonte.
4. **Incidente aberto bloqueia exclusão física.** Antes de qualquer job de limpeza por retenção apagar um segmento/clipe, ele deve checar `legal_hold = true` (ligado automaticamente quando um `vision_incident` é aberto referenciando aquela evidência) — mesmo princípio de "não apagar evidência vinculada a incidente aberto" já presente no LGPD para dados de contato/mensagem, agora aplicado a mídia.
5. Toda visualização e exportação gera entrada em `vision_access_logs`, reaproveitando a estrutura de `auth_audit_logs` (`actor_user_id`, `event_type`, `metadata_json`, `created_at`).

### Enterprise (Fase 6, avaliação futura — não bloqueia MVP)

6. HMAC-SHA256 por tenant, com chave derivada via o mesmo mecanismo de `EncryptionService` (adicionar um salt por tenant à derivação de chave existente).
7. Timestamp confiável (RFC 3161) — avaliar como spike técnico separado (candidatos: Autoridade de Carimbo de Tempo do ITI/ICP-Brasil, ou provedor comercial). Não bloqueia MVP.
8. Cadeia de custódia imutável: tabela `vision_evidence_custody_log`, **somente-inserção** — a camada de aplicação nunca expõe endpoint de UPDATE/DELETE para essa tabela; qualquer "correção" gera uma nova entrada, nunca sobrescreve a anterior.
9. Pacote de evidência assinado (export bundle com hash + metadados + assinatura) para casos que exijam entrega formal (ex.: ocorrência policial).

### Postura comercial e jurídica

10. Toda documentação de produto e contrato deve usar a redação "integridade e rastreabilidade da evidência", nunca "valor probatório garantido". Este ponto exige revisão do time jurídico/comercial do cliente antes do go-live comercial — não é uma decisão que a engenharia possa tomar sozinha, apenas implementar o suporte técnico correto (hash + timestamp + custódia) que sustente uma eventual perícia.

## Licenças

Nenhuma dependência de terceiros nova é necessária para SHA-256/HMAC (nativo em Node `crypto`, mesma família de API já usada por `EncryptionService`). RFC 3161 (Enterprise) pode depender de um provedor externo — avaliar licença/custo no spike da Fase 6.

## Riscos

- **Alto**: bug na lógica de `legal_hold` que permita apagar evidência de incidente aberto é uma falha grave de responsabilidade civil/criminal para o cliente final. Mitigação: teste de integração obrigatório específico (já previsto no PRD §29 — "retenção preserva evidência de incidente aberto") antes de qualquer liberação em produção.
- **Médio**: prometer "valor probatório" no discurso comercial sem o suporte deste ADR — mitigado pela postura de redação definida no item 10, a ser reforçada com o time comercial.

## Custo

Baixo no MVP (reaproveita primitivas nativas e padrões já existentes). Custo adicional apenas se um provedor de timestamp RFC 3161 pago for adotado na fase Enterprise.

## Segurança

Hash e log de acesso são a primeira linha de defesa contra alegações de adulteração de evidência. HMAC por tenant (Enterprise) impede que uma evidência "vazada" de um tenant seja reaproveitada/forjada como se fosse de outro.

## Impacto de manutenção

Baixo — reaproveita padrões (`crypto`, `EncryptionService`) já mantidos pela equipe.

## Plano de rollback

Campos de evidência são aditivos à tabela `vision_evidence` (nova, não existente). Se a trava de `legal_hold` apresentar bug em produção, a mitigação de curto prazo é suspender o job de limpeza automática (retenção) para o tenant afetado até correção — nunca desativar o próprio `legal_hold`.
