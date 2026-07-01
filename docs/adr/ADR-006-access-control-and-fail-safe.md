# ADR-006 — Access Control and Fail-Safe

**Status:** Aceito
**Data:** Fase 0

## Contexto

O PRD (§14.1) exige separação estrita em três camadas — **Identificação → Decisão de política → Ação física** — e define três modos de operação para LPR (§14.2: Sugestão, Assistido, Autônomo), com **Sugestão como padrão obrigatório**. O cliente reforçou explicitamente que a lógica de segurança física da cancela (sensores anti-esmagamento, botão de emergência, modo manual, intertravamentos) deve permanecer no controlador físico — o ZappFlow autoriza, não substitui os mecanismos de segurança do equipamento.

Não existe hoje nenhum código de integração física, relé, cancela ou controlador no projeto — este é território inteiramente novo, sem precedente a reaproveitar além dos padrões gerais de RBAC/auditoria/idempotência já existentes (ex.: idempotência de retry já usada em `Scheduler.ts` para lembretes de PIX).

## Decisão

1. **As três camadas são módulos de código/serviço distintos, nunca uma única função monolítica:**
   - **Vision Identity & Access** (identificação: placa, QR, RFID, NFC, BLE) — apenas lê e normaliza identidade, não decide nem aciona nada.
   - **Access Policy Engine** (decisão determinística, hospedado dentro do Maestro generalizado — ver reconciliação item "Maestro") — avalia cadastro ativo, vínculo, horário, site/portão permitido, bloqueios, segundo fator exigido. Retorna `granted`/`denied`/`review_required`, nunca aciona hardware diretamente.
   - **Vision Access Control** (ação física) — único componente autorizado a enviar comando a um controlador/relé/cancela homologado, e só o faz mediante uma decisão explícita do Access Policy Engine.
2. **Modo padrão de todo ponto de acesso novo é Sugestão** (somente exibe cadastro/confiança ao operador; abertura é sempre manual). Modos Assistido e Autônomo exigem ativação explícita, por portão, feita por um Vision Admin — nunca habilitados por padrão em nenhuma configuração ou migração.
3. **Homologar apenas UM controlador/protocolo de relé/cancela no MVP (Fase 4)**, escolhido durante o laboratório da Fase 0 com base no que o cliente-piloto já possui fisicamente instalado — reforça o princípio geral do PRD de "reaproveitar o que já existe" em vez de construir uma abstração multi-fabricante especulativa antes de validar uma integração real ponta a ponta.
4. **Fail-safe/fail-secure é responsabilidade do equipamento físico, não do software.** O Vision Access Control envia apenas um sinal de autorização/negação; ele nunca é o único mecanismo de segurança de uma cancela/portão. Este ponto deve constar explicitamente do checklist de instalação e do contrato com o cliente, não apenas no código.
5. **Controlador indisponível ou command timeout → nunca abrir automaticamente.** Replicando a tabela de degradação do PRD (§18): encaminha para modo manual/portaria e gera alerta/incidente, nunca reduz a segurança "tentando de novo até funcionar".
6. **Todo comando ao controlador é idempotente e auditado**, gravado em `vision_access_controller_commands` (request, resposta, exceção, `controller_command_id`), seguindo o mesmo princípio de idempotência já usado no retry de lembretes de PIX do `Scheduler.ts`.

## Licenças

Depende do SDK/protocolo do controlador homologado na Fase 0 — a ser avaliado no momento da escolha (item 3), sem antecipação especulativa.

## Riscos

- **Alto**: esta é a única parte do Vision VMS com risco de segurança física direta (pessoas, veículos, responsabilidade civil). Recomenda-se revisão por jurídico/seguros do cliente antes da Fase 4 entrar em produção, não apenas revisão de engenharia.
- **Alto**: erro de OCR de placa, placa clonada ou veículo autorizado conduzido por pessoa não autorizada — mitigado pelo modo Sugestão como padrão e pela exigência de segundo fator no modo Assistido (§14.2 do PRD).
- **Médio**: acoplamento indevido entre Identity/Policy/Access Control violando a separação de camadas do item 1 — mitigar com revisão de arquitetura específica antes do merge de qualquer PR da Fase 4, verificando que nenhum código de detecção (LPR/RFID) chama diretamente o adaptador de hardware.

## Custo

Depende do controlador/relé homologado (custo de hardware fica a cargo do cliente, já instalado na maioria dos casos, conforme princípio de reaproveitamento do PRD).

## Segurança

A separação em três camadas é, em si, um controle de segurança: um bug ou comprometimento no motor de identificação (ex.: um detector de LPR malicioso) não tem caminho direto para acionar hardware físico sem passar pela política e pelo adaptador.

## Impacto de manutenção

Médio — cada novo fabricante de controlador homologado no futuro exige um novo adaptador, mas a interface interna (Access Policy Engine → Access Control) permanece estável.

## Plano de rollback

Qualquer ponto de acesso pode ser revertido para Sugestão (modo manual) instantaneamente via configuração, sem exigir rollback de código — a automação (Assistido/Autônomo) é sempre opt-in reversível por portão.
