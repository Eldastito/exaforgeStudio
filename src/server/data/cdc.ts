/**
 * Código de Defesa do Consumidor (Lei nº 8.078/1990) — semente da base legal da
 * Consultora Jurídica (ADR-115). Lei brasileira é de domínio público.
 *
 * Curadoria dos artigos que mais protegem/afetam o lojista pequeno no dia a dia
 * (troca, garantia, arrependimento, cobrança, oferta, cadastro). Cada artigo traz:
 *  - `texto`: síntese fiel do dispositivo (para citação/conferência);
 *  - `orientacao`: "como proceder" protetivo, dentro da lei (usado quando não há
 *     LLM para sintetizar — mantém a resposta útil e ancorada, custo zero);
 *  - `termos`: gatilhos de recuperação (sem acento, minúsculos) para o match.
 *
 * A base é versionada: `CDC_VERSION` sobe quando o conteúdo muda (a lei muda).
 */

export const CDC_VERSION = "1990-consolidado-2024";
export const LEGAL_SOURCE = "cdc";

export interface LegalArticle {
  numero: string;
  titulo: string;
  texto: string;
  orientacao: string;
  termos: string[];
}

export const CDC_ARTICLES: LegalArticle[] = [
  {
    numero: "6",
    titulo: "Direitos básicos do consumidor",
    texto:
      "São direitos básicos do consumidor a informação adequada e clara sobre produtos e serviços, a proteção contra publicidade enganosa e abusiva, a modificação de cláusulas desproporcionais e a facilitação da defesa de seus direitos.",
    orientacao:
      "Trate o cliente com informação clara e honesta desde o anúncio. A maioria dos conflitos nasce de informação mal dada — descreva preço, condições e prazos por escrito para se proteger de reclamação depois.",
    termos: ["direitos basicos", "direito do consumidor", "informacao", "publicidade enganosa", "propaganda enganosa", "meus direitos"],
  },
  {
    numero: "18",
    titulo: "Vício do produto (garantia legal / defeito)",
    texto:
      "O fornecedor responde pelos vícios de qualidade que tornem o produto impróprio ou lhe diminuam o valor. Não sanado o vício em até 30 dias, o consumidor pode exigir, à sua escolha: a substituição do produto, a devolução da quantia paga (corrigida) ou o abatimento proporcional do preço.",
    orientacao:
      "Produto com defeito: você tem o direito de tentar consertar/trocar em até 30 dias antes de devolver o dinheiro. Ofereça o conserto ou a troca primeiro. Só se não resolver em 30 dias é que o cliente escolhe entre trocar, receber o dinheiro de volta corrigido ou pagar menos. Registre a data em que recebeu a reclamação.",
    termos: ["vicio", "defeito", "produto com defeito", "produto estragado", "quebrou", "garantia", "garantia legal", "consertar", "trocar produto", "troca por defeito", "reparo"],
  },
  {
    numero: "20",
    titulo: "Vício do serviço",
    texto:
      "O fornecedor de serviços responde pelos vícios de qualidade que os tornem impróprios ao consumo ou lhes diminuam o valor. O consumidor pode exigir a reexecução do serviço, a devolução da quantia paga (corrigida) ou o abatimento proporcional do preço.",
    orientacao:
      "Serviço mal feito: ofereça refazer sem custo, devolver o valor corrigido ou dar um desconto — a escolha é do cliente. Refazer costuma ser o caminho que menos prejudica você. Combine e registre o prazo de reexecução.",
    termos: ["vicio do servico", "servico mal feito", "servico ruim", "refazer servico", "reexecucao", "reclamacao de servico"],
  },
  {
    numero: "26",
    titulo: "Prazo para reclamar de vício aparente",
    texto:
      "O direito de reclamar por vícios aparentes ou de fácil constatação caduca em 30 dias para produtos/serviços não duráveis e em 90 dias para os duráveis, contados da entrega efetiva ou do término da execução do serviço.",
    orientacao:
      "Nem toda reclamação está no prazo. Para produto durável (eletro, móvel) o cliente tem 90 dias; para não durável (alimento, perecível) são 30 dias, contados da entrega. Fora desse prazo para vício aparente, você pode recusar educadamente — mas confira se o defeito é oculto (aí o prazo conta de quando apareceu).",
    termos: ["prazo para reclamar", "prazo de troca", "quantos dias", "30 dias", "90 dias", "prazo garantia", "caducou", "decadencia"],
  },
  {
    numero: "30",
    titulo: "A oferta obriga (publicidade e informação vinculam)",
    texto:
      "Toda informação ou publicidade suficientemente precisa, veiculada por qualquer forma, obriga o fornecedor que a fizer veicular e integra o contrato que vier a ser celebrado.",
    orientacao:
      "O que você anuncia, você é obrigado a cumprir — preço, brinde, condição. Se errou o preço no anúncio, o mais seguro é honrar ou negociar com o cliente, não simplesmente ignorar. Para se proteger, revise anúncios antes de publicar e guarde o que foi divulgado.",
    termos: ["oferta", "anuncio", "anunciei", "preco errado", "publicidade", "propaganda", "prometi", "brinde", "promocao"],
  },
  {
    numero: "35",
    titulo: "Descumprimento da oferta",
    texto:
      "Se o fornecedor recusar cumprimento à oferta, apresentação ou publicidade, o consumidor pode: exigir o cumprimento forçado nos termos ofertados; aceitar outro produto/serviço equivalente; ou rescindir o contrato, com devolução da quantia paga (corrigida) e perdas e danos.",
    orientacao:
      "Se você não consegue entregar o que ofertou, o cliente escolhe: cumprir como anunciado, aceitar algo equivalente, ou desfazer o negócio com dinheiro de volta corrigido. Ofereça uma alternativa equivalente de boa-fé — costuma ser a saída que preserva a relação e evita perdas e danos.",
    termos: ["nao consigo entregar", "sem estoque", "descumprir oferta", "cancelar pedido", "nao tenho o produto", "faltou produto"],
  },
  {
    numero: "39",
    titulo: "Práticas abusivas (venda casada e outras)",
    texto:
      "É vedado ao fornecedor, entre outras práticas abusivas: condicionar o fornecimento de produto/serviço a outro (venda casada) ou a limites quantitativos sem justa causa; enviar produto sem solicitação; elevar preço sem justa causa; recusar atendimento às demandas dos consumidores.",
    orientacao:
      "Evite venda casada (só vender A se levar B) e não mande produto que o cliente não pediu — são práticas abusivas que geram multa e processo. Pode definir pedido mínimo por justa causa (ex.: custo de entrega), mas deixe a condição clara e razoável.",
    termos: ["venda casada", "pratica abusiva", "obrigar a comprar", "pedido minimo", "condicionar venda", "aumentar preco"],
  },
  {
    numero: "42",
    titulo: "Cobrança de dívidas (sem constranger)",
    texto:
      "Na cobrança de débitos, o consumidor inadimplente não será exposto ao ridículo, nem submetido a qualquer tipo de constrangimento ou ameaça. O consumidor cobrado em quantia indevida tem direito à repetição do indébito, por valor igual ao dobro do que pagou em excesso, acrescido de correção e juros, salvo engano justificável.",
    orientacao:
      "Pode cobrar quem te deve (inclusive fiado), mas NUNCA expondo ou ameaçando: nada de avisar terceiros, publicar o nome, mandar mensagem vexatória ou cobrar em público. Cobre em particular, de forma cortês, com o valor certo. Cobrar valor indevido pode te obrigar a devolver o dobro. Prefira lembrete educado e acordo de parcelamento.",
    termos: ["cobrar", "cobranca", "cobrar cliente", "fiado", "caloteiro", "me deve", "divida", "inadimplente", "nao pagou", "expor devedor", "negativar", "constrangimento"],
  },
  {
    numero: "43",
    titulo: "Cadastros e bancos de dados (SPC/Serasa)",
    texto:
      "O consumidor tem acesso às informações existentes em cadastros e bancos de dados sobre ele. A abertura de cadastro ou registro negativo deve ser comunicada por escrito ao consumidor, quando não solicitada por ele. Informações negativas não podem constar por período superior a cinco anos.",
    orientacao:
      "Antes de negativar (SPC/Serasa), o cliente precisa ser avisado por escrito com antecedência — negativar direto e errado gera dano moral contra você. Confira se a dívida existe e está correta, envie o aviso e só então registre. A negativação não pode ficar além de 5 anos.",
    termos: ["negativar", "spc", "serasa", "nome sujo", "cadastro de inadimplente", "protesto", "banco de dados"],
  },
  {
    numero: "49",
    titulo: "Direito de arrependimento (7 dias, compra fora da loja)",
    texto:
      "O consumidor pode desistir do contrato no prazo de 7 dias a contar da assinatura ou do ato de recebimento do produto/serviço, sempre que a contratação ocorrer fora do estabelecimento comercial, especialmente por telefone ou internet. Os valores eventualmente pagos são devolvidos, monetariamente atualizados.",
    orientacao:
      "Compra feita FORA da loja física (internet, WhatsApp, telefone, entrega): o cliente pode se arrepender em 7 dias corridos, mesmo sem defeito nenhum, e recebe o valor de volta corrigido (frete incluído). Já a compra feita presencialmente na sua loja NÃO tem esse direito — trocar por gosto/arrependimento é cortesia sua, não obrigação. Deixe sua política de troca visível.",
    termos: ["arrependimento", "7 dias", "sete dias", "desistir", "devolver compra", "comprou pela internet", "comprou online", "comprou pelo whatsapp", "cancelar compra", "trocar sem defeito", "nao gostou", "direito de arrependimento"],
  },
  {
    numero: "51",
    titulo: "Cláusulas abusivas (nulas de pleno direito)",
    texto:
      "São nulas as cláusulas contratuais que coloquem o consumidor em desvantagem exagerada, que sejam incompatíveis com a boa-fé ou a equidade, ou que impossibilitem, exonerem ou atenuem a responsabilidade do fornecedor por vícios do produto/serviço.",
    orientacao:
      "Cláusula do tipo 'não trocamos em hipótese alguma' ou 'sem direito a reembolso' não vale contra o CDC — é nula. Em vez de placa que promete o que a lei não permite, escreva uma política de troca clara e dentro da lei; isso te protege mais do que uma regra inválida.",
    termos: ["clausula abusiva", "nao trocamos", "sem reembolso", "placa nao aceito troca", "contrato abusivo", "regra da loja", "politica de troca"],
  },
];

/** Índice por número do artigo (citação rápida). */
export const CDC_BY_NUMERO: Record<string, LegalArticle> = Object.fromEntries(
  CDC_ARTICLES.map((a) => [a.numero, a]),
);
