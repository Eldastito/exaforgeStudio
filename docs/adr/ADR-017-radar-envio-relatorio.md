# ADR-017 — Radar: envio do relatório (canal da própria organização + compartilhamento nativo)

**Status:** Implementado e testado ponta a ponta em navegador real.
**Origem:** pedido para priorizar, entre os 3 itens ainda pendentes do Radar, o que entrega mais valor à experiência do cliente. Recomendei o envio automático do relatório: sem ele, o PDF/narrativa por IA gerados na ADR-016 ficam presos atrás de um clique manual em "Abrir relatório gerado" que o dono do negócio pode nunca dar — todo o valor já construído fica invisível. O usuário topou e pediu, além do envio pelo canal da organização, que o app também abra o compartilhamento nativo do celular (WhatsApp/e-mail/qualquer app já instalado) quando o teste for feito no telefone.

## Duas formas de entrega, propositalmente separadas

1. **Compartilhamento nativo (Web Share API, `navigator.share`)** — 100% no aparelho de quem está vendo a tela, não passa pelo backend além de gerar o PDF. Funciona em QUALQUER sessão que tenha resultado, mesmo sem telefone/e-mail de contato cadastrado — é o próprio usuário escolhendo pra onde mandar. Só aparece em navegadores que suportam a API (a maioria dos navegadores mobile; a maioria dos desktops não tem folha de compartilhar do sistema, então o botão nem aparece lá — comportamento correto, não é um bug).
2. **Envio pelo canal já conectado da PRÓPRIA organização** (WhatsApp via `MessageProviderService`, e-mail via `GoogleOAuthService.gmailSend`) — só aparece quando a sessão TEM telefone/e-mail de contato registrado, e só funciona de verdade quando a organização já tem canal/Google conectado (o mesmo canal que ela já usa pra atender os PRÓPRIOS clientes — corrigindo uma afirmação errada de uma resposta anterior, isso não depende de nenhuma infraestrutura da ZappFlow).

## Ordem de validação em `RadarService.sendReport` — importa

Checa telefone/e-mail de contato e canal/conta Google conectados **antes** de gerar o PDF (que já dispara uma chamada de IA para a narrativa) — não faz sentido gastar essa chamada sabendo de antemão que o relatório não vai ter pra onde ir. Só depois de passar por essas checagens é que o relatório é (re)gerado na hora (nunca reaproveita um PDF antigo, pro caso de ter mudado algo desde a última geração — ex.: evidência anexada depois).

## Por que link, não anexo binário de verdade

Os dois canais recebem um **link** para o PDF, não o arquivo em anexo:
- WhatsApp Cloud API já funciona só com link (`MessageProviderService.sendDocument` — infraestrutura que já existia, usada aqui sem alteração).
- E-mail com anexo binário de verdade exigiria mexer na codificação de `GoogleOAuthService.gmailSend`, que hoje só foi testada para conteúdo texto (ex.: convite `.ics`) — o `Buffer.from(attachment.content, "utf-8")` ali dentro corromperia um PDF (binário) se eu tentasse encaixar nesse caminho sem entender a codificação primeiro. Link é suficiente, mais simples, e não arrisca quebrar um caminho que já funciona para outra coisa.

## Validação real

**10 verificações novas** (`scripts/test-radar-send.ts`), todas alcançáveis **sem nenhuma chamada de rede de verdade** — nem Graph API, nem Google, nem Evolution: o único "canal conectado" usado no teste tem `provider='instagram'`, que `MessageProviderService.sendDocument` já rejeita de propósito antes de tentar qualquer `fetch`. Isso permitiu testar a cadeia de validação inteira (sem contato → sem canal → sem conta Google → sem URL pública → chega no provedor de envio) sem risco de vazar uma chamada de API real durante os testes automatizados. Suíte completa do projeto: **11 scripts, 198 verificações, todas passando**, nenhuma alterada por este PR.

Fluxo end-to-end real em navegador: `navigator.share` simulado (para rodar em CI headless, que não tem folha de compartilhar de verdade) confirmou que o botão "Compartilhar" aparece, chama a API com uma URL **absoluta** (não a relativa que o servidor às vezes devolve) e título/texto preenchidos; sessão sem telefone/e-mail não mostra os botões de envio direto; sessão com telefone/e-mail mostra os botões e, ao clicar sem canal/conta conectados, mostra o erro claro na tela (não trava, não falha silenciosamente).

## Não incluído nesta rodada (deliberado)

- **Anexo binário de verdade no e-mail** (em vez de link) — exigiria entender/testar a codificação de `GoogleOAuthService.gmailSend` para conteúdo binário, fora do escopo desta entrega.
- **Envio automático ao concluir/aprovar** — os botões continuam sob demanda, mesma decisão já registrada na ADR-016.
- **Convite de respondente por link próprio** e **matriz `radar_processes`/`execution_gap_index`** continuam fora de escopo pelos mesmos motivos já registrados nas ADRs 015/016.
