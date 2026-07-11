# Backlog — Módulo Clínica, Fase F (Conectores TISS)

**Status:** PENDENTE (tarefa registrada). Decisão de arquitetura em `docs/adr/ADR-081-conectores-tiss.md`.
**Gatilho para iniciar:** primeira operadora real com quem a clínica tenha credenciamento **e** acesso ao ambiente de homologação.

As Fases A–E do Módulo Clínica estão implementadas e em produção (autorização em modo **manual**, que continua o fallback universal). A Fase F liga a troca eletrônica no padrão **TISS** da ANS, **por operadora**. Não existe "uma integração para todas": Amil, Bradesco Saúde e cada Unimed são conectores distintos.

---

## 1. Questionário para a clínica (levantamento de conexão aos planos)

Perguntas a fazer a cada clínica antes de conectar. Agrupadas por tema; as marcadas com ⛔ são bloqueantes (sem elas não há como conectar).

### A. Credenciamento e operadoras
1. ⛔ Com **quais operadoras** a clínica é credenciada/contratada hoje? (liste todas)
2. Dessas, quais representam **maior volume/faturamento**? (para escolher a piloto)
3. Para cada operadora: qual o **código do prestador** da clínica nela?
4. A clínica atende por **quais tipos de guia**? (consulta, SP/SADT, exames, internação…)
5. Atende **Unimed**? Se sim, **quais singulares**? (Unimed-Rio, Unimed-BH, Unimed Nacional… — cada uma é uma operadora separada, com integração própria)

### B. Certificado digital
6. ⛔ A clínica possui **certificado digital ICP-Brasil**? É **A1** (arquivo `.pfx`/`.p12`) ou **A3** (token/cartão)?
   - Só **A1** é suportado no MVP. Se for A3, a clínica segue no modo manual até haver solução de agente local.
7. Quem é o **titular** do certificado (CNPJ da clínica ou PF do responsável técnico)? Qual a **validade**?
8. O certificado está **acessível** (a clínica consegue exportar/enviar o arquivo com a senha)?

### C. Dados cadastrais obrigatórios
9. ⛔ **CNES** da clínica.
10. ⛔ **Registro dos profissionais** que executam procedimentos (conselho + número + UF, ex.: CRM/UF, CREFITO…).
11. CNPJ, razão social e endereço fiscal da clínica.

### D. Acesso técnico por operadora (para homologar)
12. ⛔ A clínica tem **login/senha** do portal da operadora? E credenciais de **WebService**, se houver?
13. A operadora oferece **ambiente de homologação/testes**? A clínica tem acesso a ele?
14. A clínica (ou a operadora) tem a **documentação de integração TISS** da operadora? (manual do WebService, layout de guia, versão)
15. Qual **versão do padrão TISS** a operadora exige/aceita hoje?
16. A operadora aceita **envio por WebService/API** (Nível 3) ou só **upload de arquivo/portal** (Nível 2)?

### E. Fluxo e volume atuais (para dimensionar o valor)
17. Quantas **autorizações/guias por mês** a clínica processa (aprox.)?
18. Quanto tempo hoje leva para **solicitar e acompanhar** uma autorização?
19. Qual o **percentual de glosas/negativas** e os motivos mais comuns?
20. Quem na clínica opera a autorização hoje (recepção, faturamento, terceiro)?

---

## 2. O que precisamos, resumido

- **Para começar a construção genérica (F1):** os **XSDs oficiais da versão TISS** (site da ANS) + confirmação de **certificado A1**.
- **Para homologar de verdade:** por operadora-piloto → código de prestador, credenciais, **acesso ao ambiente de homologação** e a documentação de integração dela.
- **Recomendação:** uma operadora-piloto por vez, **Nível 2 (XML) antes do Nível 3 (WebService/API)**.

---

## 3. O que o ZappFlow passa a fazer DEPOIS de conectado ao plano

A conexão TISS transforma cada etapa do atendimento que hoje é manual/telefone/portal em fluxo automático dentro do ZappFlow — reduzindo glosa, retrabalho e tempo de espera do paciente. O valor se apoia no que as Fases A–E já entregaram (agenda clínica, ficha do paciente, autorização, cadências, RIC).

### 3.1 Antes da consulta — elegibilidade e autorização sem telefone
- **Verificação de elegibilidade em tempo real:** ao agendar, o sistema consulta a operadora e confirma se a carteirinha está **ativa e o procedimento é coberto** — antes do paciente sair de casa. Some a viagem perdida por "plano vencido/sem cobertura".
- **Solicitação de autorização automática:** para procedimentos que exigem autorização, o ZappFlow monta a guia (com o **TUSS** correto, a partir do cadastro — nunca inventado), **assina digitalmente** e envia à operadora. A recepção deixa de digitar guia no portal.
- **Acompanhamento de protocolo automático:** o status (em análise → aprovada → negada) atualiza sozinho na tela e dispara as **cadências clínicas** já existentes: WhatsApp de "autorização em análise", "autorização liberada — vamos confirmar seu horário?" ou "houve uma pendência". O paciente é avisado sem ninguém ligar.

### 3.2 Durante — agenda que só confirma o que está autorizado
- **Agenda ciente da autorização:** o card do paciente na Agenda Clínica mostra o status da autorização; procedimentos sem liberação não "furam" a agenda por engano.
- **Snapshot de plano por atendimento:** o plano fica congelado no momento da autorização (evita cobrar/faturar com dados desatualizados quando o paciente troca de convênio).

### 3.3 Depois — faturamento limpo e menos glosa
- **Menos glosas por erro cadastral:** guia gerada a partir de dados validados (carteirinha, TUSS, código de prestador) erra menos — a glosa administrativa cai.
- **Continuidade/retorno:** a cadência de retorno/continuidade já semeada reengaja o paciente para as próximas sessões (fisioterapia, estética, tratamentos por pacote).

### 3.4 Inteligência para a clínica (qualificar o trabalho)
Com os dados de autorização fluindo, o **RIC (Revenue Intelligence Center)** e os relatórios passam a responder:
- Quais **operadoras** mais negam, e por quê (padrão de glosa) → renegociar ou corrigir processo.
- **Receita presa** em autorizações pendentes/paradas → cobrança proativa.
- **Tempo médio** de autorização por operadora → previsibilidade de agenda.
- **Procedimentos mais rentáveis** e ociosidade de profissional/sala → decisão de escala.

### 3.5 Onde a IA ajuda — sempre com o humano no comando
- Prepara a solicitação, **aponta pendências** de documento e **resume o status** para a recepção.
- Redige as mensagens ao paciente (confirmação, pendência, liberação) no tom da clínica.
- **Nunca** promete cobertura, **nunca** inventa TUSS, **nunca** envia autorização sem revisão humana (guardrails do ADR-080). A IA acelera; a clínica decide.

### Resumo em uma frase
> Conectado ao plano, o ZappFlow tira a autorização do telefone e do portal: confirma cobertura antes da consulta, solicita e acompanha a liberação sozinho, avisa o paciente por WhatsApp, reduz glosa no faturamento e mostra à clínica onde está a receita presa — mantendo a decisão sempre com a equipe.

---

## 4. Passo a passo quando a Fase F for disparada (resumo do ADR-081)

- **F1 (genérico, sem operadora):** interface `TissConnector` + `ManualConnector` (default) → `TissXmlConnector` (geração + assinatura A1 do XML numa versão fixada) → importação da tabela TUSS → testes (XML válido contra XSD, assinatura verificável, isolamento, auditoria).
- **F1 (por operadora):** ligar credenciais/código de prestador da operadora-piloto e **homologar** no ambiente de testes dela.
- **F2:** conector de WebService/API da operadora específica (transmissão + leitura de retorno), quando houver endpoint documentado.
