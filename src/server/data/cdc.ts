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
  fonte?: string; // 'cdc' (padrão) | 'sumula_stj' | 'procon'
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

/**
 * Base ampliada (ADR-115 Fatia 3): súmulas do STJ e orientações do PROCON que
 * mais afetam o lojista, além do CDC. Súmulas são texto público do tribunal;
 * as entradas de PROCON são ORIENTAÇÃO de conduta (como responder), ancoradas
 * no CDC — não inventam norma. Mesma disciplina de grounding.
 */
export const EXTRA_NORMS: LegalArticle[] = [
  {
    fonte: "sumula_stj",
    numero: "359",
    titulo: "Aviso antes de negativar (Súmula 359 do STJ)",
    texto:
      "Cabe ao órgão mantenedor do cadastro de proteção ao crédito a notificação do devedor antes de proceder à inscrição do seu nome. A ausência de notificação prévia gera dever de indenizar.",
    orientacao:
      "Confirme que o cliente será notificado por escrito ANTES de o nome entrar no SPC/Serasa. Negativar sem esse aviso prévio gera indenização contra quem inscreveu — não pule essa etapa.",
    termos: ["negativar", "notificacao previa", "aviso antes de negativar", "spc", "serasa", "inscricao", "sumula 359"],
  },
  {
    fonte: "sumula_stj",
    numero: "385",
    titulo: "Negativação preexistente afasta dano moral (Súmula 385 do STJ)",
    texto:
      "Da anotação irregular em cadastro de proteção ao crédito não cabe indenização por dano moral quando preexistente legítima inscrição, ressalvado o direito ao cancelamento da anotação irregular.",
    orientacao:
      "Se o cliente já tinha outra negativação legítima anterior, ele não costuma ganhar dano moral por uma nova anotação — mas você ainda pode ser obrigado a cancelar a que estiver irregular. Mantenha sua negativação correta e documentada.",
    termos: ["dano moral", "negativacao anterior", "ja estava negativado", "inscricao preexistente", "sumula 385"],
  },
  {
    fonte: "sumula_stj",
    numero: "532",
    titulo: "Envio de produto/cartão não solicitado é abusivo (Súmula 532 do STJ)",
    texto:
      "Constitui prática comercial abusiva o envio de cartão de crédito (ou produto) sem prévia e expressa solicitação do consumidor, configurando ato ilícito indenizável e sujeito a sanção administrativa.",
    orientacao:
      "Nunca envie produto, brinde cobrado ou 'cortesia' que gere cobrança sem o cliente ter pedido de forma expressa — é prática abusiva que gera multa e indenização. Ofereça e espere o 'sim' antes de mandar e cobrar.",
    termos: ["produto nao solicitado", "envio sem pedir", "amostra cobrada", "cartao nao solicitado", "sumula 532", "mandar sem pedir"],
  },
  {
    fonte: "sumula_stj",
    numero: "130",
    titulo: "Responsabilidade por furto no estacionamento (Súmula 130 do STJ)",
    texto:
      "A empresa responde, perante o cliente, pela reparação de dano ou furto de veículo ocorrido em seu estacionamento.",
    orientacao:
      "Se você oferece estacionamento (ainda que gratuito) para atrair clientes, pode responder por furto ou dano ao veículo lá dentro. Placa de 'não nos responsabilizamos' não afasta isso. Avalie câmeras, controle de acesso e um seguro.",
    termos: ["estacionamento", "furto de veiculo", "roubaram o carro", "dano no carro", "responsabilidade estacionamento", "sumula 130"],
  },
  {
    fonte: "procon",
    numero: "resposta",
    titulo: "Como responder a uma reclamação no PROCON",
    texto:
      "Recebida uma reclamação (PROCON ou consumidor.gov.br), o fornecedor é notificado e tem prazo para se manifestar. A ausência de resposta ou a recusa injustificada pesam contra o fornecedor e podem gerar sanção administrativa.",
    orientacao:
      "Não ignore a notificação do PROCON: responda dentro do prazo, de forma educada e documentada, apresentando sua versão e uma proposta de solução (conserto, troca ou reembolso conforme o caso). Guarde comprovantes. Resolver por acordo costuma sair muito mais barato do que a multa e o desgaste.",
    termos: ["procon", "reclamacao", "consumidor.gov", "notificacao", "reclame aqui", "responder reclamacao", "fui notificado"],
  },
  {
    fonte: "procon",
    numero: "chargeback",
    titulo: "Chargeback / contestação de cartão",
    texto:
      "No chargeback, o cliente contesta a compra junto à administradora do cartão e o valor pode ser estornado do lojista. A defesa depende de PROVAR a entrega/serviço e a legitimidade da venda; em compras não presenciais, o risco de fraude recai em boa parte sobre o vendedor.",
    orientacao:
      "Contra chargeback, sua defesa é a PROVA: guarde comprovante de entrega, conversa com o cliente, nota e dados da venda. Em venda a distância, confira os dados antes de despachar e desconfie de pedidos atípicos. Reúna as evidências e conteste no prazo da adquirente; se foi arrependimento legítimo (7 dias), o reembolso é devido de qualquer forma.",
    termos: ["chargeback", "contestacao", "estorno de cartao", "cliente contestou", "compra contestada", "fraude no cartao", "adquirente"],
  },
];

/** Biblioteca legal completa (recuperação percorre tudo). */
export const LEGAL_LIBRARY: LegalArticle[] = [...CDC_ARTICLES, ...EXTRA_NORMS];

/** Rótulo legível para citação, conforme a fonte. */
export function refLabel(a: { fonte?: string; numero: string; titulo?: string }): string {
  switch (a.fonte) {
    case "sumula_stj": return `Súmula ${a.numero} do STJ`;
    case "procon": return "Orientação PROCON";
    default: return `Art. ${a.numero} do CDC`;
  }
}

/** Chave única por norma: `${fonte}:${numero}` (fonte ausente = cdc). */
export function normKey(a: { fonte?: string; numero: string }): string {
  return `${a.fonte || "cdc"}:${a.numero}`;
}

/** Índice por número do artigo do CDC (citação rápida, compatível). */
export const CDC_BY_NUMERO: Record<string, LegalArticle> = Object.fromEntries(
  CDC_ARTICLES.map((a) => [a.numero, a]),
);

/** Índice por chave `${fonte}:${numero}` sobre a biblioteca inteira. */
export const NORM_BY_KEY: Record<string, LegalArticle> = Object.fromEntries(
  LEGAL_LIBRARY.map((a) => [normKey(a), a]),
);
