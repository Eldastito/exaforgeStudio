# ADR-081 — Conectores TISS (Módulo Clínica, Fase F)

**Status:** Aceito (arquitetura e faseamento; implementação sob demanda de operadora real).

**Origem:** Fase F do PRD "Quick-Start Saúde / Clínica" e do ADR-080 (D4), que deliberadamente reservou os conectores TISS para um ADR próprio "por envolver certificado digital A1/A3 e homologação por operadora — um tema de segurança que merece decisão dedicada". As Fases A–E entregaram o Módulo Clínica com **autorização assistida/manual**; este ADR define como (e quando) evoluir para a troca eletrônica no padrão TISS da ANS.

---

## Contexto

### O que já existe (Fases A–E, mescladas)

- **Autorização manual completa** (`ClinicAuthorizationService`, ADR-080 Fase E): `health_plan_operators` (com `connector_type` DEFAULT `'manual'`), `health_plan_credentials` (usuário/senha **cifrados** via `EncryptionService`, e um campo `certificate_ref` já reservado), `clinic_procedures` (TUSS cadastrado à mão) e `procedure_authorization_requests` com máquina de status (`draft → ready_to_submit → submitted → approved/denied/…`).
- **Guardrails** (ADR-080 D7): envio é sempre ação humana; a IA nunca inventa TUSS nem promete cobertura.
- **Precedente de assinatura XML**: `src/server/nfeSignature.ts` já usa `xml-crypto` (`SignedXml`) para assinar NF-e — o mesmo mecanismo criptográfico que a guia TISS exige.
- **Precedente de conector externo**: o padrão de credenciais cifradas + `config_json` por operadora já está montado.

### O que o TISS exige (e por que é um ADR à parte)

O **TISS** (Troca de Informação de Saúde Suplementar) é o padrão **obrigatório** da ANS para troca eletrônica entre prestadores e operadoras. Implementá-lo de verdade traz quatro dificuldades que não existiam nas Fases A–E:

1. **Certificado digital ICP-Brasil** para assinar as guias. **A1** (arquivo `.pfx`/`.p12`, cifrável e usável sem presença física) vs. **A3** (token/smartcard — exige hardware presente, inviável num SaaS multi-tenant sem um agente local no cliente).
2. **Versão do padrão**: a ANS publica versões do TISS (a atual referida no PRD é "Maio/2026") com XSDs próprios; a tabela **TUSS** de procedimentos é versionada e volumosa.
3. **Homologação por operadora**: cada operadora tem ambiente de homologação, código de prestador próprio e peculiaridades de layout — não existe "uma integração para todas".
4. **Dado sensível de saúde em trânsito** (LGPD Art. 11): assinatura, confidencialidade e trilha de auditoria do que foi transmitido.

## Decisão

### D1. Manter o manual como fallback universal; TISS é aditivo por operadora

O modo `manual` do E1 **permanece o padrão e o fallback** para toda operadora sem integração. TISS entra como um `connector_type` alternativo (`tiss_xml` | `tiss_webservice`) escolhido **por operadora**, sem nunca remover o caminho manual. Promessa comercial inalterada (ADR-080 D4): "onde houver integração, enviamos; onde não, deixamos pronto para envio manual".

### D2. Conector plugável por operadora (Strategy), não um "cliente TISS universal"

Introduzir uma interface `TissConnector` com implementações por operadora/versão, resolvida a partir de `health_plan_operators.connector_type` + `config_json`. Um `ManualConnector` (no-op, só marca `submitted`) é o default e o que o E1 já faz na prática. Cada conector real (ex.: `TissXmlConnector`, e conectores específicos de operadora) é adicionado **sob demanda de um cliente/operadora real** — nunca especulativamente. O `ClinicAuthorizationService.submit` delega ao conector resolvido; a máquina de status e a auditoria já existentes não mudam.

### D3. Só A1 no MVP; A3 exige agente local e fica fora

Suportar **apenas certificado A1** (arquivo `.pfx`/`.p12`): o conteúdo do certificado é cifrado em repouso com `EncryptionService` (o `certificate_ref` reservado passa a apontar para o material cifrado ou para o storage seguro), e a assinatura da guia usa o mesmo `xml-crypto`/molde do `nfeSignature.ts`. **A3 (token/smartcard) fica explicitamente fora** — exigiria um agente/desktop no cliente para acessar o hardware; se algum dia for necessário, será outro ADR (agente local), não este.

### D4. Nível 2 (XML) antes do Nível 3 (WebService/API)

Faseamento dentro da Fase F:

- **F1 — Elegibilidade + Solicitação em XML TISS (Nível 2):** gerar o XML da guia no padrão TISS de uma versão fixada, assiná-lo (A1) e disponibilizá-lo para envio (download/anexo ou upload no portal da operadora). É o passo mais próximo do manual, com o menor risco de homologação.
- **F2 — WebService/API por operadora (Nível 3):** quando uma operadora específica com endpoint/homologação existir, adicionar o conector que transmite direto e lê o retorno (protocolo/status), atualizando a mesma máquina de status.

Cada sub-fase entra **puxada por uma operadora real**, com ambiente de homologação antes de produção.

### D5. Versão TISS fixada e explícita; TUSS por importação

Fixar **uma versão do padrão TISS suportada** por vez (gravada em `health_plan_operators`/`config_json`), com os XSDs versionados no repo. A tabela **TUSS** entra por **importação** (CSV/oficial) numa tabela de referência, não hard-coded — a IA continua proibida de inventar código (ADR-080 D7); o cadastro de `clinic_procedures` referencia o TUSS importado.

### D6. Segurança e auditoria reforçadas para transmissão

- Certificado A1 e credenciais **sempre cifrados** (`EncryptionService`); nunca em log, nunca em URL, nunca retornados por API.
- Cada geração/assinatura/transmissão de guia gera evento de auditoria (`CLINIC_TISS_*`) com o protocolo, sem PII sensível no metadata.
- Isolamento por `organization_id` em toda tabela nova (padrão do repo).
- Modo de **homologação** por operadora (flag em `config_json`) separado de produção.

## Consequências

**Positivas:**
- Zero regressão: o manual continua funcionando para todas as operadoras; TISS é opt-in por operadora.
- Reaproveita o que já existe: credenciais cifradas, `certificate_ref`, máquina de status, auditoria e o molde de assinatura XML (`xml-crypto`).
- Faseamento puxado por demanda real evita construir "spec sheet feature" contra operadoras hipotéticas (mesmo princípio do ADR-077).

**Trade-offs aceitos:**
- **A3 fora do escopo** — clínicas que só têm certificado em token/smartcard seguem no modo manual até (e se) existir um ADR de agente local.
- **Uma versão TISS por vez** — acompanhar as publicações da ANS é trabalho recorrente; assumido conscientemente.
- **Sem "integração universal"** — cada operadora Nível 3 é um conector próprio, adicionado sob demanda; a promessa comercial reflete isso.
- **Nenhum código nesta entrega** — este ADR é a decisão de arquitetura; a implementação (F1/F2) é disparada quando houver a primeira operadora real com quem homologar.

## Implementação (quando disparada)

- **F1:** interface `TissConnector` + `ManualConnector` (refatoração sem mudança de comportamento) → `TissXmlConnector` (geração + assinatura A1 do XML da guia numa versão fixada) → tabela de referência TUSS importável → testes (geração de XML válido contra o XSD, assinatura verificável, isolamento, auditoria) → tela de configuração do conector/certificado por operadora.
- **F2:** conector de WebService/API da operadora específica, com ambiente de homologação, transmissão e leitura de retorno atualizando a máquina de status existente.

O gatilho de implementação é o mesmo do ADR-077/080: **um cliente/operadora real com quem homologar** — não antes.
