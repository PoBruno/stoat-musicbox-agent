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
    texto.includes("does not exist") ||
    // Playlist privada, "Curtidos"/"Assistir mais tarde" (sao da conta de
    // quem colou, o agente nao enxerga) e Mix que expirou.
    texto.includes("playlist is private") ||
    texto.includes("unviewable") ||
    texto.includes("playlist does not exist") ||
    texto.includes("incomplete youtube id") ||
    // Id de playlist que nao existe: o YouTube responde 400 na API da aba.
    (texto.includes("[youtube:tab]") && texto.includes("http error 400"))
  ) {
    return "nao_encontrado";
  }
  if (texto.includes("enoent") || texto.includes("command not found")) {
    return "ferramenta";
  }
  return "desconhecido";
}

const RE_URL_YOUTUBE =
  /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i;

/**
 * Mix ("Mix - artista", lista `RD...`) e gerado pelo YouTube e nao tem fim:
 * cada pagina traz mais recomendacoes. Sem teto proprio, colar o link de um
 * Mix enchia a fila com 200 faixas que ninguem escolheu. 50 cobre umas tres
 * horas, como os bots de Discord costumam carregar.
 */
const TETO_DO_MIX = 50;

/** Titulos que o YouTube poe no lugar de video que saiu da playlist. */
const RE_INDISPONIVEL = /^\[(private|deleted|unavailable) video\]$/i;

/**
 * Le um endereco do YouTube, aceitando o que as pessoas colam de verdade:
 * sem `https://`, com `si=` de compartilhamento, `youtu.be/ID?list=`.
 */
function lerEndereco(entrada: string): URL | null {
  const texto = entrada.trim();
  if (!RE_URL_YOUTUBE.test(texto)) return null;
  try {
    return new URL(/^https?:\/\//i.test(texto) ? texto : `https://${texto}`);
  } catch {
    return null;
  }
}

/** Id do video que o link aponta, se houver (`v=` ou `youtu.be/ID`). */
function videoDoEndereco(url: URL): string | null {
  if (url.hostname.endsWith("youtu.be")) {
    return url.pathname.slice(1).split("/")[0] || null;
  }
  return url.searchParams.get("v");
}

/**
 * Comeca a playlist pelo video do link, sem perder as anteriores.
 *
 * Quem copia o endereco enquanto ouve a 7a faixa de uma playlist manda
 * `watch?v=<a 7a>&list=...`, e o yt-dlp devolve a lista desde a 1a. O que a
 * pessoa espera e que continue dali, como o YouTube faria (o Lavalink marca
 * isso como `selectedTrack`). As que vinham antes vao para o fim: ainda
 * estao na fila, so nao tocam primeiro.
 */
function comecarPor<T extends { id: string }>(faixas: T[], id: string | null) {
  const indice = id ? faixas.findIndex((f) => f.id === id) : -1;
  return indice > 0
    ? [...faixas.slice(indice), ...faixas.slice(0, indice)]
    : faixas;
}

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
    const url = lerEndereco(entrada);
    const lista = url?.searchParams.get("list") ?? null;
    // Mix: a lista comeca no proprio video, nao ha o que reordenar.
    const ehMix = !!lista && /^RD/i.test(lista);
    if (ehMix) limite = Math.min(limite, TETO_DO_MIX);

    const alvo = url ? url.toString() : `ytsearch${limite}:${entrada.trim()}`;

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

    const faixas = saida
      .split("\n")
      .filter((linha) => linha.trim().startsWith("{"))
      .map((linha) => JSON.parse(linha) as Record<string, unknown>)
      // Video privado ou apagado continua listado na playlist, sem titulo nem
      // duracao. Na fila ele so faria o agente falhar e pular sozinho.
      .filter((cru) => {
        const titulo = typeof cru.title === "string" ? cru.title.trim() : "";
        return !!cru.id && !!titulo && !RE_INDISPONIVEL.test(titulo);
      })
      .map((cru) => {
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

    return lista && !ehMix && url
      ? comecarPor(faixas, videoDoEndereco(url))
      : faixas;
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

/**
 * Faixas por playlist do Spotify. A página de embed, de onde lemos sem chave,
 * entrega no máximo 100 (medido em 2026-11-22: "Rock Classics" tem 200).
 */
export const TETO_SPOTIFY = 100;

const RE_SPOTIFY =
  /^(https?:\/\/)?(open\.spotify\.com|spotify\.link|spotify\.app\.link)\/|^spotify:(track|album|playlist):/i;

/** Encontrado no YouTube para cada faixa do Spotify, para não buscar duas vezes. */
const espelhos = new Map<string, string>();

/**
 * Spotify: descobre O QUE tocar; o áudio vem do YouTube.
 *
 * O som do Spotify é protegido, e nenhum bot o toca. Todos fazem o mesmo
 * (o LavaSrc chama de "Mirror"): leem a lista no Spotify e tocam a mesma
 * música do YouTube.
 *
 * **De onde vem a lista.** Da página de embed (`open.spotify.com/embed/...`),
 * a do player que os sites incorporam: pública, sem chave, com título,
 * artistas e duração. A API oficial ficou inútil para isto em fevereiro de
 * 2026: app novo só lê faixas de playlist da própria conta (e exige Premium e
 * no máximo 5 usuários). O custo é o teto de 100 faixas por playlist e
 * depender de uma página que não é contrato.
 *
 * **Quando buscar no YouTube.** Só na hora de tocar, uma faixa por vez.
 * Buscar as 100 ao colar o link encheria a fila mais devagar e seria
 * justamente a rajada de pedidos que faz o YouTube desafiar o IP.
 */
export class Spotify implements Provedor, Fonte {
  readonly id = "spotify";

  reconhece(entrada: string): boolean {
    return RE_SPOTIFY.test(entrada.trim());
  }

  async resolver(entrada: string, limite = TETO_SPOTIFY): Promise<Faixa[]> {
    const { tipo, id } = await this.lerEndereco(entrada);
    const entidade = await this.lerEmbed(tipo, id);

    if (tipo === "track") {
      if (entidade.isPlayable === false) return [];
      return [
        this.faixa(
          String(entidade.id ?? id),
          String(entidade.name ?? entidade.title ?? ""),
          (entidade.artists as { name: string }[] | undefined)
            ?.map((a) => a.name)
            .join(", ") ?? null,
          entidade.duration,
          capaDe(entidade),
        ),
      ].filter((f) => f.titulo);
    }

    // Faixa de playlist não traz capa própria; a de álbum é a do álbum.
    const capa = tipo === "album" ? capaDe(entidade) : null;
    const lista = (entidade.trackList ?? []) as Record<string, unknown>[];
    return lista
      .filter((t) => t.isPlayable !== false && t.title)
      .slice(0, Math.min(limite, TETO_SPOTIFY))
      .map((t) =>
        this.faixa(
          String(t.uri ?? "").split(":").at(-1) ?? "",
          String(t.title),
          (t.subtitle as string) ?? null,
          t.duration,
          capa,
        ),
      );
  }

  /**
   * Acha a faixa no YouTube e devolve o endereço do áudio.
   *
   * Primeiro no YouTube Music, aba "músicas": ali estão as gravações de
   * estúdio ("Provided to YouTube"), e não clipe com introdução falada nem
   * versão ao vivo. Entre os primeiros resultados, fica o de duração parecida
   * com a do Spotify; é o filtro que separa a música do cover e do "1 hora
   * de loop". Sem nenhum parecido, vai o primeiro mesmo: tocar algo próximo
   * é melhor que pular.
   */
  async enderecoDireto(faixa: Faixa): Promise<string> {
    const conhecido = espelhos.get(faixa.id);
    if (conhecido) {
      return youtube.enderecoDireto({ ...faixa, paginaUrl: conhecido });
    }

    const termo = `${faixa.autor ?? ""} ${limparTitulo(faixa.titulo)}`.trim();
    // As duas buscas em paralelo: e espera na troca de faixa, e em serie
    // somavam uns 2 s a mais de silencio.
    const [daMusica, doYoutube] = await Promise.all([
      idsDaBusca(
        `https://music.youtube.com/search?q=${encodeURIComponent(termo)}#songs`,
        3,
      ),
      idsDaBusca(`ytsearch2:${termo}`, 2),
    ]);
    const candidatos = [...daMusica, ...doYoutube].filter(
      (id, i, todos) => todos.indexOf(id) === i,
    );

    if (!candidatos.length) {
      throw new ErroDeProvedor(
        `não achei "${termo}" no YouTube`,
        "nao_encontrado",
      );
    }

    const tolerancia = faixa.duracaoS
      ? Math.max(10, faixa.duracaoS * 0.1)
      : Infinity;
    let primeiro: { pagina: string; endereco: string } | null = null;

    for (const id of candidatos) {
      const pagina = `https://www.youtube.com/watch?v=${id}`;
      const achado = await duracaoEEndereco(pagina).catch(() => null);
      if (!achado) continue;
      primeiro ??= { pagina, endereco: achado.endereco };
      if (
        !faixa.duracaoS ||
        achado.duracaoS === null ||
        Math.abs(achado.duracaoS - faixa.duracaoS) <= tolerancia
      ) {
        console.log(
          `[spotify] "${termo}" (${faixa.duracaoS ?? "?"} s) -> ${id} (${achado.duracaoS ?? "?"} s)`,
        );
        lembrar(faixa.id, pagina);
        return achado.endereco;
      }
    }

    if (!primeiro) {
      throw new ErroDeProvedor(
        `nenhum resultado de "${termo}" pôde ser aberto`,
        "nao_encontrado",
      );
    }
    console.log(
      `[spotify] "${termo}": nenhuma duração bateu, uso o primeiro resultado`,
    );
    lembrar(faixa.id, primeiro.pagina);
    return primeiro.endereco;
  }

  /** Tipo e id, aceitando `/intl-pt/`, `?si=`, `spotify:` e link curto. */
  private async lerEndereco(
    entrada: string,
  ): Promise<{ tipo: "track" | "album" | "playlist"; id: string }> {
    let texto = entrada.trim();

    const uri = /^spotify:(track|album|playlist):([A-Za-z0-9]+)/i.exec(texto);
    if (uri?.[1] && uri[2]) {
      return { tipo: uri[1].toLowerCase() as "track", id: uri[2] };
    }

    if (!/^https?:\/\//i.test(texto)) texto = `https://${texto}`;

    // Link curto do app (spotify.link/xyz): o destino só aparece seguindo o
    // redirecionamento.
    if (/^https:\/\/(spotify\.link|spotify\.app\.link)\//i.test(texto)) {
      const resposta = await fetch(texto, {
        redirect: "follow",
        headers: { "user-agent": NAVEGADOR },
        signal: AbortSignal.timeout(10_000),
      });
      texto = resposta.url;
      // Alguns curtos param numa página que tem o destino só no HTML.
      if (!/open\.spotify\.com\/(intl-[a-z-]+\/)?(track|album|playlist)\//i.test(texto)) {
        const html = await resposta.text();
        texto =
          /https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:track|album|playlist)\/[A-Za-z0-9]+/i.exec(
            html,
          )?.[0] ?? texto;
      }
    }

    const caminho =
      /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(track|album|playlist)\/([A-Za-z0-9]+)/i.exec(
        texto,
      );
    if (!caminho?.[1] || !caminho[2]) {
      throw new ErroDeProvedor(
        "link do Spotify que não é música, álbum nem playlist",
        "nao_encontrado",
      );
    }
    return { tipo: caminho[1].toLowerCase() as "track", id: caminho[2] };
  }

  /** O objeto que a página de embed carrega em `__NEXT_DATA__`. */
  private async lerEmbed(
    tipo: string,
    id: string,
  ): Promise<Record<string, unknown> & { trackList?: unknown[] }> {
    const resposta = await fetch(`https://open.spotify.com/embed/${tipo}/${id}`, {
      headers: { "user-agent": NAVEGADOR, "accept-language": "pt-BR,pt;q=0.9" },
      signal: AbortSignal.timeout(15_000),
    });
    if (resposta.status === 404) {
      throw new ErroDeProvedor("não existe no Spotify", "nao_encontrado");
    }
    if (!resposta.ok) {
      throw new ErroDeProvedor(
        `o Spotify respondeu ${resposta.status}`,
        "desconhecido",
      );
    }

    const html = await resposta.text();
    const dados =
      /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
    const entidade = dados
      ? JSON.parse(dados)?.props?.pageProps?.state?.data?.entity
      : undefined;
    if (!entidade) {
      // Playlist privada cai aqui; formato novo da página também. O texto
      // do log distingue os dois para quem for consertar.
      console.error(
        `[spotify] embed de ${tipo}/${id} sem dados (${html.length} bytes)`,
      );
      throw new ErroDeProvedor(
        "o Spotify não mostrou essa lista (privada ou página mudou)",
        "nao_encontrado",
      );
    }
    return entidade;
  }

  private faixa(
    id: string,
    titulo: string,
    autor: string | null,
    duracaoMs: unknown,
    capaUrl: string | null,
  ): Faixa {
    return {
      id,
      provedor: this.id,
      titulo,
      autor: autor || null,
      duracaoS:
        typeof duracaoMs === "number" && duracaoMs > 0
          ? Math.round(duracaoMs / 1000)
          : null,
      capaUrl,
      paginaUrl: `https://open.spotify.com/track/${id}`,
    };
  }
}

/** Identificação de navegador comum: a página de embed recusa clientes sem. */
const NAVEGADOR =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const youtube = new YouTube();

/** Capa de 300 px, a menor que ainda fica boa no painel. */
function capaDe(entidade: Record<string, unknown>): string | null {
  const imagens =
    ((entidade.visualIdentity as { image?: { url: string; maxWidth?: number }[] })
      ?.image ?? []) as { url: string; maxWidth?: number }[];
  const escolhida =
    imagens.find((i) => i.maxWidth === 300) ?? imagens.at(-1) ?? null;
  return (
    escolhida?.url ??
    (entidade.coverArt as { sources?: { url: string }[] })?.sources?.[0]?.url ??
    null
  );
}

/**
 * Tira do título o que atrapalha a busca: "- Remastered 2011", "(feat. X)".
 * O artista convidado já vai no campo de autor.
 */
function limparTitulo(titulo: string): string {
  return titulo
    .replace(/\s*[([]\s*(feat|ft|with)\.?\s[^)\]]*[)\]]/gi, "")
    .replace(/\s+-\s+.*(remaster|version|mono|stereo|edit|live).*$/i, "")
    .trim();
}

/** Ids dos primeiros resultados de uma busca, sem abrir cada vídeo. */
async function idsDaBusca(alvo: string, quantos: number): Promise<string[]> {
  const { saida } = await executar(
    config.ytdlp,
    [
      "--no-warnings",
      "--ignore-config",
      "--flat-playlist",
      "--playlist-end",
      String(quantos),
      "--print",
      "id",
      alvo,
    ],
    { limiteMs: 30_000 },
  );
  return saida
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z0-9_-]{11}$/.test(l));
}

/** Duração e endereço do áudio de um vídeo, numa execução só do yt-dlp. */
async function duracaoEEndereco(
  pagina: string,
): Promise<{ duracaoS: number | null; endereco: string }> {
  const { codigo, saida, erro } = await executar(
    config.ytdlp,
    [
      "--no-warnings",
      "--ignore-config",
      "-f",
      "251/bestaudio[acodec=opus]/ba",
      "--print",
      "duration",
      "--print",
      "urls",
      pagina,
    ],
    { limiteMs: 30_000 },
  );
  const [duracao, endereco] = saida.trim().split("\n");
  if (codigo !== 0 || !endereco?.startsWith("https://")) {
    throw new ErroDeProvedor(erro.trim().split("\n").at(-1) ?? "falhou", classificar(erro));
  }
  const segundos = Number(duracao);
  return {
    duracaoS: Number.isFinite(segundos) ? Math.round(segundos) : null,
    endereco,
  };
}

/** Guarda o espelho, sem deixar o mapa crescer para sempre. */
function lembrar(spotifyId: string, pagina: string) {
  if (espelhos.size >= 2000) {
    const maisAntigo = espelhos.keys().next().value;
    if (maisAntigo) espelhos.delete(maisAntigo);
  }
  espelhos.set(spotifyId, pagina);
}

/** Provedores conhecidos, na ordem em que são consultados */
export const provedores: Provedor[] = [new YouTube(), new Spotify()];

/** Fontes conhecidas, indexadas pelo id do provedor */
export const fontes = new Map<string, Fonte>([
  ["youtube", new YouTube()],
  ["spotify", new Spotify()],
]);

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
