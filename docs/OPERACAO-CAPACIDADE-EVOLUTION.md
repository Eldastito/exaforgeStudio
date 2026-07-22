# Quanto meu servidor de WhatsApp (Evolution) aguenta?

Guia prático para o dono e o TI acompanharem a capacidade de números de WhatsApp
conectados ao mesmo tempo. Em linguagem simples.

> **Regra de ouro:** o ZappFlow não limita o número de conexões. O teto prático é
> a **RAM/CPU do servidor onde a Evolution roda** + os **limites de conta do
> próprio WhatsApp**. Este guia ajuda a medir isso.

---

## 1. O que é uma "instância" e por que ela pesa

Cada número de WhatsApp conectado = **uma sessão viva** (como um WhatsApp Web
aberto 24h). Ela mantém uma conexão permanente com o WhatsApp e guarda estado —
consome **memória e CPU o tempo todo**, mesmo sem mensagem chegando.

- **Parada:** gasta poucos MB de RAM cada.
- **Recebendo/enviando:** gasta CPU. Quanto mais mensagens por número, mais pesa.

O ZappFlow, do lado dele, guarda só uma linha de canal por número — custo quase
zero. Por isso o gargalo é a Evolution, não o app.

---

## 2. Os 4 números para acompanhar (no servidor da Evolution)

Peça ao TI para olhar, no servidor da Evolution, estes indicadores:

| # | O que medir | Sinal verde | Sinal amarelo | Sinal vermelho |
|---|-------------|-------------|---------------|----------------|
| 1 | **RAM usada** | < 70% | 70–85% | > 85% |
| 2 | **CPU (média)** | < 60% | 60–80% | > 80% sustentado |
| 3 | **Disco livre** | > 30% | 15–30% | < 15% |
| 4 | **Sessões "desconectando/reconectando"** | nenhuma | 1–2 esporádicas | várias e repetidas |

Regra simples: **se RAM ou CPU vivem no vermelho, chegou perto do teto daquela
máquina** — mesmo que os números "pareçam" funcionar. Aí é hora de reforçar o
servidor ou dividir a carga (seção 5).

---

## 3. Como olhar esses números (para o TI)

No servidor da Evolution (Linux):

- **RAM e CPU ao vivo:** `htop` (ou `top`). Olhe a linha do processo da Evolution
  (Node) e o total da máquina.
- **RAM total x usada:** `free -h`.
- **Disco:** `df -h`.
- **Uso do container (se Docker):** `docker stats` — mostra RAM/CPU por container.
- **Reconexões:** nos logs da Evolution, procurar por `connection` / `close` /
  `reconnect` se repetindo para a mesma instância.

Anote o uso **com a quantidade atual de números conectados**. Isso vira a sua
linha de base para prever quantos mais cabem.

---

## 4. Como estimar quantos números ainda cabem

1. Veja quanta **RAM** a Evolution usa hoje e com **quantos números**.
2. Calcule o custo médio por número: `RAM_usada_pela_Evolution ÷ nº_de_números`.
3. Veja quanta RAM **sobra** (deixando ~20% de folga de segurança).
4. `números_extras ≈ RAM_que_sobra ÷ custo_por_número`.

> Exemplo ilustrativo: se 10 números usam ~2 GB (≈200 MB/número) e sobram 3 GB
> livres, cabem mais ~15 números **desse volume de mensagens**. Números que
> disparam muito consomem mais — refaça a conta com folga.

Referência grosseira de mercado: **dezenas a poucas centenas** de números por
servidor, conforme RAM e volume. Não trate como promessa — **meça o seu**.

---

## 5. O que fazer quando chegar perto do teto

Em ordem de esforço:

1. **Reforçar a máquina** (mais RAM/CPU) — resolve o caso mais comum.
2. **Reduzir volume por número** — evitar disparos em massa pelo mesmo número.
3. **Adicionar um segundo servidor Evolution** e dividir os números entre eles.
   O ZappFlow já guarda a URL do servidor **por canal**, então dá para apontar
   números diferentes para Evolutions diferentes. O cadastro liso disso é o que
   o **ADR-116** planejou (executar pós go-live).

---

## 6. Limites que NÃO são de servidor (importante)

Cada número é uma **conta real de WhatsApp**, com regras antspam do próprio
WhatsApp:

- **Disparo em massa** por um número novo/aquecendo → risco de **bloqueio** da
  conta (isso não é RAM; é regra do WhatsApp).
- Números novos devem ser **aquecidos** gradualmente (volume crescente), não
  sair disparando no primeiro dia.
- Conteúdo repetitivo/denunciável aumenta o risco. Preferir conversa real e
  listas com opt-in.

Ou seja: mesmo com servidor folgado, **o WhatsApp tem o dele** — respeite o
aquecimento e evite spam.

---

## 7. Checklist rápido (imprimir/colar)

- [ ] Sei quantos números estão conectados hoje.
- [ ] Anotei RAM/CPU/disco do servidor Evolution **com essa quantidade**.
- [ ] RAM < 70% e CPU < 60% na média? (senão, planejar reforço)
- [ ] Nenhuma instância reconectando repetidamente?
- [ ] Todos os números com a **URL de webhook + `?secret=`** correta no ZappFlow?
- [ ] Números de disparo estão **aquecidos** (sem blast em conta nova)?
- [ ] Tenho um plano para o "e se precisar de mais" (reforçar máquina ou 2º servidor)?

---

*Referência técnica do desenho multi-servidor/multi-número: `docs/adr/ADR-116-multi-instancia-whatsapp-onboarding.md`.*
