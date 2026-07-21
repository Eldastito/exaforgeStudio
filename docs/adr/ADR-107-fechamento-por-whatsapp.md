# ADR-107 — Fechamento diário pelo WhatsApp da loja (RetailOps)

**Status:** Implementado (Bloco A). **Origem:** áudio do cliente TOULON (Bruno):
_"mandar o fechamento do dia de cada loja no nosso WhatsApp... ou a própria IA
analisasse o papel e mandasse um resumo"_.

## Contexto

O RetailOps (ADR-083/084) já tinha o **motor** de fechamento diário
(`RetailClosingService`), o **OCR** da folha (`llm.extractClosingFromImage`), a
**cota/desvio** e o **checklist com cobrança**. Faltava a **porta de entrada
pelo WhatsApp**: o `webhookProcessor` só roteava foto para o cadastro de estoque
(`WhatsAppInventoryIntake`) — não havia caminho para fechamento. Na prática, o
fechamento só era informado pelo **painel**.

## Decisão

Nova camada `RetailWhatsAppIntakeService` que intercepta mensagens vindas do
**número da loja** (`retail_stores.whatsapp_identifier`) — população distinta do
gestor autorizado — e as trata como fechamento:

- **Foto da folha** → `RetailClosingService.submitFromImage` (OCR já existente)
  → registra o fechamento do dia, calcula o **desvio vs cota**, dá **baixa na
  pendência `fechamento`** (a cobrança para de insistir) e responde com o
  **resumo** (total, formas de pagamento, meta batida/faltou).
- **Valor total em texto** ("R$ 4.850,00") → `parseBrlAmount` → registra
  manualmente o total do dia (mesmo resumo de volta).
- **Baixa confiança** na leitura da foto → status `needs_review` e a resposta
  avisa que o time vai **conferir** antes de aprovar (aprovação sempre humana,
  ADR-083 D4).

### Princípios / guardas

1. **Gated pelo add-on `retail`** (`ModuleService.isEnabled`) — orgs sem o
   módulo não são afetadas.
2. **Casamento tolerante ao 9º dígito BR** (mesma lógica do gestor autorizado).
3. **Não sequestra conversa:** só intercepta com intenção clara de fechamento
   (foto, valor, ou pendência de fechamento aberta no dia). Caso contrário
   devolve `null` e a mensagem segue o fluxo normal de atendimento.
4. **Isolamento multi-tenant:** o número da loja de uma org nunca casa em outra.
5. **Auditado:** cada registro por WhatsApp gera evento (`logAuthEvent`).

### Ponto de integração

`webhookProcessor.processIncomingMessage`, seção **4.45** — depois de resolver
contato/ticket (mensagem fica logada e visível no painel), antes da IA de
atendimento. Espelha o padrão dos blocos de fornecedor/CSAT (intercepta e sai).

## Consequências

**Positivas:** destrava o pedido nº 1 do cliente reaproveitando 100% do motor +
OCR já prontos; a loja opera pelo WhatsApp sem abrir o painel; a cobrança para
sozinha quando o fechamento chega. **Trade-offs:** malote/escala pelo WhatsApp e
a **baixa por respondente individual** ficam para o Bloco B (a foto hoje é sempre
interpretada como fechamento). Sem token/ERP vivo, a conferência de divergência
segue por import CSV (ADR-084).

## Testes

`npm run test:retail-whatsapp-closing` (21 checks): matchStore tolerante, foto
alta/baixa confiança, valor em texto, baixa da pendência, guarda anti-sequestro,
`parseBrlAmount` e isolamento. Regressão RetailOps (`test:retail-closing`,
`test:retail-cobranca`) verde.
