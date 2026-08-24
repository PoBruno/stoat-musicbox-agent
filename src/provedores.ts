import { config } from "./config.ts";
import { executar } from "./executar.ts";

/**
 * Uma faixa resolvida, independente de onde veio.
 *
 * Este formato é o contrato entre o agente e o Stoat. Nada aqui menciona
 * YouTube de propósito: um provedor futuro preenche os mesmos campos.
 */
export type Faixa = {
  /** Identificador dentro do provedor */
  id: string;
  /** Qual provedor resolveu, ex. "youtube" */
  provedor: string;
  titulo: string;
  autor: string | null;
  /** Duração em segundos; nulo em transmissão ao vivo */
  duracaoS: number | null;
  capaUrl: string | null;
  /** Endereço original, para reabrir depois */
  paginaUrl: string;
};

/**
 * Descobre O QUE tocar.
 *
 * Separado da entrega dos bytes de propósito. Há serviços que sabem dizer o
 * que existe mas não entregam o áudio — o Spotify é o caso óbvio, porque o
 * som dele é protegido. Com um único método "tocar", esse caso não teria
 * como ser expresso.
 */
export interface Provedor {
  readonly id: string;
  /** Se esta entrada é deste provedor */
  reconhece(entrada: string): boolean;
  /** Resolve busca ou URL em faixas */
  resolver(entrada: string, limite: number): Promise<Faixa[]>;
}

/**
 * Entrega os BYTES de uma faixa.
 *
 * Um provedor pode implementar os dois, um só, ou nenhum.
 */
export interface Fonte {
  readonly id: string;
  /** Endereço direto de mídia, válido por algumas horas e preso ao IP que pediu */
  enderecoDireto(faixa: Faixa): Promise<string>;
}

/**
 * Erro que o chamador consegue distinguir e explicar ao usuário.
 *
 * Os campos são atribuídos no corpo, e não declarados nos parâmetros do
 * construtor: o modo de remoção de tipos do Node apenas apaga anotações, e
 * propriedade declarada em parâmetro é açúcar que **gera** código. Escrita
 * daquele jeito, esta classe não carrega.
 */
export class ErroDeProvedor extends Error {
  readonly motivo: "bloqueado" | "nao_encontrado" | "ferramenta" | "desconhecido";

  constructor(
    mensagem: string,
    motivo: "bloqueado" | "nao_encontrado" | "ferramenta" | "desconhecido",
  ) {
    super(mensagem);
    this.name = "ErroDeProvedor";
    this.motivo = motivo;
  }
}

/**
 * Traduz a saída do yt-dlp num motivo que o usuário entenda.
 *
 * "Deu erro" não ajuda ninguém: bloqueio de IP e vídeo removido pedem ações
 * completamente diferentes de quem estiver lendo.
 */
function classificar(erro: string): ErroDeProvedor["motivo"] {
  const texto = erro.toLowerCase();
  if (texto.includes("sign in to confirm") || texto.includes("not a bot")) {
    return "bloqueado";
  }
  if (
    texto.includes("video unavailable") ||
    texto.includes("private video") ||
    texto.includes("does not exist")
  ) {
    return "nao_encontrado";
  }
  if (texto.includes("enoent") || texto.includes("command not found")) {
    return "ferramenta";
  }
  return "desconhecido";
}

const RE_URL_YOUTUBE =
  /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i;

/**
 * Endereço da miniatura, derivado do id.
 *
 * A busca roda com `--flat-playlist`, que é rápido justamente por não abrir
 * cada vídeo — e por isso não traz miniatura. Buscar uma por resultado
 * multiplicaria as requisições ao YouTube, que é o padrão que atrai bloqueio.
 *
 * O endereço das miniaturas é previsível a partir do id, então dá para montá-lo
 * sem pedir nada a ninguém.
 */
function capaPorId(id: string): string | null {
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

/**
 * YouTube: implementa os dois papéis.
 *
 * A busca usa o próprio yt-dlp (`ytsearch`) em vez da YouTube Data API. Isso
 * evita chave, projeto no Google Cloud e cota — ao custo de ser mais lenta.
 * Se a busca virar gargalo, a API oficial entra aqui sem tocar no resto.
 */
export class YouTube implements Provedor, Fonte {
  readonly id = "youtube";

  reconhece(entrada: string): boolean {
    return RE_URL_YOUTUBE.test(entrada.trim());
  }

  async resolver(entrada: string, limite = 5): Promise<Faixa[]> {
    const alvo = this.reconhece(entrada)
      ? entrada.trim()
      : `ytsearch${limite}:${entrada.trim()}`;

    const { codigo, saida, erro } = await executar(
      config.ytdlp,
      [
        "--no-warnings",
        "--ignore-config",
        // Uma linha JSON por faixa: aguenta playlist sem carregar tudo na memória.
        "--dump-json",
        "--flat-playlist",
        "--playlist-end",
        String(limite),
        alvo,
      ],
      { limiteMs: 45_000 },
    );

    if (codigo !== 0 && !saida.trim()) {
      throw new ErroDeProvedor(
        erro.trim().split("\n").at(-1) ?? "falha ao resolver",
        classificar(erro),
      );
    }

    return saida
      .split("\n")
      .filter((linha) => linha.trim().startsWith("{"))
      .map((linha) => {
        const cru = JSON.parse(linha) as Record<string, unknown>;
        const id = String(cru.id ?? "");
        return {
          id,
          provedor: this.id,
          titulo: String(cru.title ?? "sem título"),
          autor: (cru.uploader as string) ?? (cru.channel as string) ?? null,
          duracaoS:
            typeof cru.duration === "number" ? Math.round(cru.duration) : null,
          capaUrl: (cru.thumbnail as string) ?? capaPorId(id),
          paginaUrl:
            (cru.webpage_url as string) ??
            `https://www.youtube.com/watch?v=${id}`,
        } satisfies Faixa;
      });
  }

  async enderecoDireto(faixa: Faixa): Promise<string> {
    const { codigo, saida, erro } = await executar(
      config.ytdlp,
      [
        "--no-warnings",
        "--ignore-config",
        // 251 é Opus a 48 kHz, exatamente o que o LiveKit consome. Pedir esse
        // formato evita recodificar: Opus -> Opus perde qualidade e gasta CPU
        // à toa. O `ba` no fim é a rede de segurança se 251 não existir.
        "-f",
        "251/bestaudio[acodec=opus]/ba",
        "-g",
        faixa.paginaUrl,
      ],
      { limiteMs: 30_000 },
    );

    const endereco = saida.trim().split("\n").at(-1) ?? "";
    if (codigo !== 0 || !endereco.startsWith("https://")) {
      throw new ErroDeProvedor(
        erro.trim().split("\n").at(-1) ?? "não resolveu o endereço",
        classificar(erro),
      );
    }
    return endereco;
  }
}

/** Provedores conhecidos, na ordem em que são consultados */
export const provedores: Provedor[] = [new YouTube()];

/** Fontes conhecidas, indexadas pelo id do provedor */
export const fontes = new Map<string, Fonte>([["youtube", new YouTube()]]);

/**
 * Resolve uma entrada usando o primeiro provedor que a reconheça.
 *
 * Se nenhum reconhecer, cai no primeiro da lista, que trata a entrada como
 * texto de busca.
 */
export function resolver(entrada: string, limite = 5): Promise<Faixa[]> {
  const provedor =
    provedores.find((p) => p.reconhece(entrada)) ?? provedores[0];
  if (!provedor) throw new ErroDeProvedor("nenhum provedor", "desconhecido");
  return provedor.resolver(entrada, limite);
}
