# O que o Bruno e a equipe precisam fazer (o que eu não consigo fazer daqui)

Os roteiros detalhados JÁ existem no repositório; esta página só diz **a ordem** e **quem faz**. Nada abaixo exige programar.

## Em ordem
1. **Escolher a rotina do piloto (Bruno, 30 min).** Duas semanas na TOULON, com 1 dono + 1 gerente + 2 vendedores (perfis diferentes). Registrar antes "o que a equipe faz hoje no sistema" (`fase2-piloto-toulon.md` §0).
2. **Ligar só na TOULON (Bruno, 10 min):** Configurações → Módulos → *Menu simplificado (piloto)* e *Medir o uso do menu (piloto)*. Avisar a equipe que o sistema conta **quais telas abrem** (nunca o conteúdo) — é consentimento LGPD (`fase2-piloto-toulon.md` §1).
3. **Conferir os dados que sustentam tudo (Bruno + quem cuida do Alterdata).** Sem isso as respostas ficam "parciais": vendas do PDV chegando, estoque por loja atualizado, **custo (avg_cost) preenchido nos produtos**, metas e cotas por loja, vendedores saneados (`fase1-homologacao.md` passos 1–2; `toulon-piloto-kit.md` §3).
4. **Treinar vendedores no celular (gerente, 20 min por pessoa)** com `piloto-vendedores-passo-a-passo.md` (instalar, entrar, rotina do dia). Anotar qualquer problema na **ficha de ocorrência** (`piloto-ficha-ocorrencia.md`).
5. **Validar em desktop E celular (cada perfil)** os itens da §2 de `fase2-piloto-toulon.md` (dono, gerente, vendedor). Marcar o que não funcionou — é a lista de correções que eu faço depois.
6. **Rodar a bateria de perguntas ao FalaTu (Bruno, 1 hora)** com frases reais do dia a dia ("Como estão as lojas hoje?" → "Por quê?" → "E a Grande Rio?" → "Quem está há dois meses sem bater meta?" → "Vale comprar R$180 mil?"). Copiar as que erraram (loja errada, não entendeu, inventou) numa folha. **Esta folha é o que mais melhora o produto.**
7. **Teste de quem nunca usou:** dar a 1 pessoa 5 tarefas sem explicar onde clicar (problema mais importante do dia; quem não bate meta; avaliar uma compra; saber se uma campanha vendeu; analisar um fornecedor) e só observar.
8. **Decidir limiares (Bruno, depois de 1–2 semanas):** o que é "loja crítica", quanto de queda é alerta, se a margem mínima é 25%/30%, piso de contribuição, se aceita retirada na loja. Eu proponho valores; você confirma com número real da TOULON.
9. **Para o Commerce Growth (redes → loja):**
   - conectar o Instagram da TOULON em **Canais e I.A.** (um login oficial do Instagram, sem token);
   - decidir a **loja de retirada** e a **reserva de estoque online** (flag `online_store_reserve` + loja virtual por filial);
   - informar **piso de margem** e **impostos/taxa de cartão** (para a economia por canal);
   - **frete**: decidir a política (retirada grátis? frete fixo por faixa? grátis acima de quanto?) e, se quiser cotação nacional, contratar **Correios ou Melhor Envio** (isso é contrato/credencial, não código);
   - pedir/confirmar a **aprovação das permissões da Meta** (App Review) para comentários/Direct em produção — se o app ainda está em modo de desenvolvimento, só contas de teste funcionam;
   - para anúncios pagos automáticos no futuro: conta de anúncios + Marketing API (etapa posterior).
10. **Fechar o piloto (Bruno, 1 hora):** ler *Empresa → "Como a equipe está usando o menu"* e `fase2-piloto-toulon.md` §4. Decisão: fica, ajusta ou volta. Me mandar as folhas dos passos 5, 6 e 8.

## O que NÃO dá para fazer sem pessoas
Usar no celular, observar vendedor, entrevistar, decidir limiar, contratar frete/Correios, aprovar app na Meta, confirmar estoque físico real, certificar um playbook com uso real. Isso eu preparo (roteiros, medição, correções), mas só vocês executam.
