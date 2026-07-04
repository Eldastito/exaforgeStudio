# ADR-029 — Assinatura digital da NF-e (verificação local) e webhook na fila de jobs (atrás de flag)

**Status:** Implementado e testado (assinatura verificada contra XML assinado DE VERDADE no teste — chave/certificado gerados via openssl e assinados com o mesmo perfil XML-DSig da NF-e; despacho do webhook testado nos dois modos da flag).
**Origem:** itens 29 e 04 do backlog, aprovados por decisão explícita do usuário.

## Item 29 — Assinatura da NF-e: o que dá para verificar sem certificado da organização

O pedido original era "validação Sefaz". A consulta online (nota autorizada/cancelada) exige **certificado digital da própria organização** (e-CNPJ A1) para acessar os web services da Sefaz — infraestrutura que não existe no produto e que nenhum lojista configurou. Implementar só a metade honesta e imediatamente útil:

**`src/server/nfeSignature.ts` — `verifyNFeSignature(xml)`**: verificação criptográfica **local** da assinatura XML-DSig embutida na NF-e (via `xml-crypto`): o digest do conteúdo assinado confere? A assinatura RSA bate com o certificado embutido? Quem assinou (CN do certificado) e até quando ele vale? Isso detecta as duas fraudes baratas: XML **fabricado** (sem assinatura) e XML **adulterado depois de assinado** (digest não confere).

Decisões:
- **Informativa, nunca bloqueia**: o lojista está importando a própria compra; um aviso claro ("assinatura íntegra — emitida para X" / "NÃO confere — o XML pode ter sido alterado" / "sem assinatura — confira a origem") na tela de revisão é o nível certo de fricção. O resultado também fica gravado no rascunho (`raw_extraction_json.signature`) para auditoria.
- **Fora de escopo, documentado**: cadeia até a raiz ICP-Brasil (exigiria bundle de CAs e revogação) e consulta online à Sefaz (exigiria o certificado da org). Se um dia houver infraestrutura de certificado por organização, este módulo é o ponto de extensão.
- Teste sem rede e sem fixture morta: o próprio teste **assina** um XML com o perfil da NF-e (enveloped, C14N, referência por Id) usando chave/certificado descartáveis do openssl, verifica válido, adultera um byte e verifica a rejeição.

## Item 04 — Webhook na fila de jobs, atrás de flag (o jeito seguro de entregar o risco da ADR-011)

A ADR-011 deixou a migração de fora porque "mudar o caminho que atende clientes reais sem poder testar contra tráfego real" era risco demais. A entrega agora empacota exatamente essa cautela:

**`dispatchIncomingMessage()`** em `webhookProcessor.ts`: com `WEBHOOK_QUEUE_ENABLED=true`, o webhook enfileira (`process_incoming_message` na `JobQueueService`) e responde 200 na hora; o worker processa em background com o MESMO `processIncomingMessage` de sempre. **Padrão continua inline** (flag desligada) — zero mudança de comportamento até alguém ligar a flag em um ambiente com tráfego real e observar. Os dois call sites de `server.ts` (Evolution e Meta/Instagram) usam o dispatcher.

Decisão importante: **`maxAttempts: 1`** no job — o processamento de mensagem tem efeito colateral (resposta da IA ao cliente); um retry automático de um job que falhou no MEIO poderia responder o cliente duas vezes. Falha vira registro visível na fila (auditável, reprocessável por decisão humana), não reprocesso silencioso — hoje, uma falha inline também perde a mensagem, então a semântica não regride.

## Validação

`npm run test:nfe-signature` (13 verificações novas) + suíte completa (22 scripts, 404 verificações, zero quebras):
- Assinado de verdade → `valid=true` + certificado extraído (CN, validade); adulterado → `valid=false` com motivo; sem assinatura → `signed=false`; entrada inválida não explode.
- Rota de importação anexa o resultado e nenhum caminho bloqueia por assinatura.
- Flag desligada → nada enfileirado (inline preservado); ligada → job com `maxAttempts=1` e o worker entrega o payload intacto ao handler.
- `npm run lint` e `npm run build` limpos.

**Dependências novas**: `xml-crypto` (+ `@xmldom/xmldom`, `xpath`) — só o caminho de importação de XML as usa.
