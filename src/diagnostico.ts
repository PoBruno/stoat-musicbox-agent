import { config } from "./config.ts";
import { executar } from "./executar.ts";
import { ErroDeProvedor, YouTube } from "./provedores.ts";

export type Diagnostico = {
  ok: boolean;
  ferramentas: {
    ytdlp: string | null;
    ffmpeg: string | null;
  };
  youtube: {
    alcancavel: boolean;
    /** O que impediu, quando não deu certo */
    motivo?: string;
    ms?: number;
  };
  verificadoEm: string;
};

/**
 * Confere se esta máquina consegue fazer o trabalho.
 *
 * A pergunta que interessa não é "as ferramentas existem", é "o YouTube
 * atende **este** IP". Um agente com tudo instalado e o IP desafiado é
 * exatamente o cenário que se quer descobrir na partida, e não no meio de
 * uma música.
 */
export async function diagnosticar(): Promise<Diagnostico> {
  const [ytdlp, ffmpeg] = await Promise.all([
    versaoDe(config.ytdlp, ["--version"]),
    versaoDe(config.ffmpeg, ["-version"]),
  ]);

  const ferramentas = { ytdlp, ffmpeg };

  if (!ytdlp || !ffmpeg) {
    return {
      ok: false,
      ferramentas,
      youtube: {
        alcancavel: false,
        motivo: "ferramenta ausente; nem tentei falar com o YouTube",
      },
      verificadoEm: new Date().toISOString(),
    };
  }

  const inicio = Date.now();
  try {
    const youtube = new YouTube();
    const faixas = await youtube.resolver(config.videoDeTeste, 1);
    if (faixas.length === 0) {
      throw new ErroDeProvedor("resolveu, mas sem faixas", "desconhecido");
    }
    return {
      ok: true,
      ferramentas,
      youtube: { alcancavel: true, ms: Date.now() - inicio },
      verificadoEm: new Date().toISOString(),
    };
  } catch (erro) {
    const motivo =
      erro instanceof ErroDeProvedor
        ? erro.motivo === "bloqueado"
          ? "o YouTube desafiou este IP: extração não vai funcionar daqui"
          : erro.message
        : String(erro);

    return {
      ok: false,
      ferramentas,
      youtube: { alcancavel: false, motivo, ms: Date.now() - inicio },
      verificadoEm: new Date().toISOString(),
    };
  }
}

async function versaoDe(
  binario: string,
  argumentos: string[],
): Promise<string | null> {
  const { codigo, saida } = await executar(binario, argumentos, {
    limiteMs: 10_000,
  });
  if (codigo !== 0) return null;
  // O ffmpeg despeja um parágrafo; a versão está na primeira linha.
  const primeira = saida.trim().split("\n")[0] ?? "";
  return primeira.replace(/^ffmpeg version /, "").split(" ")[0] ?? null;
}

/**
 * Atualiza o yt-dlp.
 *
 * O YouTube muda de propósito e o yt-dlp corre atrás; uma versão de algumas
 * semanas costuma ser o motivo de "parou de funcionar do nada". Atualizar na
 * partida transforma a correção num reinício.
 */
export async function atualizarYtdlp(): Promise<string> {
  const { codigo, saida, erro } = await executar(
    config.ytdlp,
    ["-U", "--no-warnings"],
    { limiteMs: 60_000 },
  );
  if (codigo !== 0) {
    // Falhar em atualizar não impede de trabalhar com a versão que já existe.
    return `não consegui atualizar: ${erro.trim().split("\n").at(-1) ?? "motivo desconhecido"}`;
  }
  return saida.trim().split("\n").at(-1) ?? "atualizado";
}
