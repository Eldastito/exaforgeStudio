---
id: save-offer-ladder
estagio: compose
modulos: [falatu]
fonte: coreyhaines31/marketingskills — churn-prevention (cancel flow + save offers). Adaptado, não copiado. MIT.
versao: 1
---

# Ladder de save offers (retenção antes do cancelamento/reembolso)

## Quando aplicar

Quando o cliente **pede cancelamento ou reembolso** do FalaTu (ADR-154 F2.2 E), **antes** de executar o hard cancel/refund. O objetivo é **reter oferecendo valor**, não criar fricção. Primeiro **capture o motivo** (uma pergunta curta), depois roteie a oferta pelo motivo. Ofertas de downgrade/pausa ligam no entitlement (ADR-153).

## Deve conter

- **Captura do motivo** antes de qualquer oferta: "Posso te perguntar rapidinho o que motivou?"
- **Oferta mapeada ao motivo** (ladder — ofereça o degrau certo, não todos):
  - **Preço/custo** → desconto temporário **ou** downgrade pro tier menor (ADR-153).
  - **Pouco uso / não engatou** → mini-onboarding, dica de uso, ou **pausa** de 1 ciclo.
  - **Faltou uma feature** → status no roadmap + alternativa atual, se houver.
  - **Problema técnico** → encaminhar suporte e **resolver** antes de aceitar a saída.
- **Saída sempre limpa**: se recusar a oferta, o fluxo segue direto pro cancelamento/reembolso — sem novo obstáculo.
- **Transparência**: deixar claro que dentro da **garantia de 7 dias** o reembolso é um direito (CDC Art. 49).

## Nunca fazer

- **Bloquear ou atrasar a garantia de 7 dias** com a oferta — dentro da janela o reembolso é direito, a oferta é opcional e a recusa vai **direto** ao estorno (ADR-154 RN-E; RN-155 §5).
- Criar **fricção pra cancelar** (mais de um passo de retenção, esconder o botão, "fale com um atendente" obrigatório).
- Oferta **enganosa** (desconto que não existe, "última chance" falsa).
- Insistir depois do **"não"** — uma oferta, uma recusa, encerra.

## Exemplos (PT-BR)

- **Captura:** "Poxa, que pena que você quer sair 😕 Posso te perguntar rapidinho o que pesou? (preço, pouco uso, faltou algo, ou problema técnico)"
- **Preço → downgrade:** "Se o valor apertou, dá pra continuar no plano {menor} por {valor} — mantém o essencial e reduz o custo. Quer que eu troque, ou prefere seguir com o cancelamento?"
- **Pouco uso → pausa:** "Se foi falta de tempo pra usar, posso **pausar** sua conta por 1 mês sem cobrança — você volta de onde parou. Te serve, ou seguimos com o cancelamento?"
- **Recusa (saída limpa):** "Tranquilo, respeito totalmente. Vou seguir com o cancelamento. Como você está dentro dos 7 dias de garantia, o reembolso é automático — confirma que quer prosseguir?"

## Lições (post-mortem)

_(vazio — acumula via F1.4 quando A/B ou `business_signal` marcar cadência ruim; cada lição entra datada e passa a ser injetada junto com a rubrica.)_
