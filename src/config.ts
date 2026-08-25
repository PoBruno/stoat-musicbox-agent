/**
 * Configuração do agente, lida do ambiente.
 *
 * Falha na partida se algo essencial faltar, em vez de descobrir no meio de
 * uma música. Um agente que sobe pela metade é pior que um que não sobe.
 */

function texto(nome: string, padrao?: string): string {
  const valor = process.env[nome]?.trim();
  if (valor) return valor;
  if (padrao !== undefined) return padrao;
  throw new Error(`falta a variável ${nome} no ambiente`);
}

function numero(nome: string, padrao: number): number {
  const bruto = process.env[nome]?.trim();
  if (!bruto) return padrao;
  const valor = Number(bruto);
  if (!Number.isFinite(valor)) {
    throw new Error(`${nome} deveria ser um número, veio "${bruto}"`);
  }
  return valor;
}

function ligado(nome: string, padrao = false): boolean {
  const bruto = process.env[nome]?.trim().toLowerCase();
  if (!bruto) return padrao;
  return ["1", "true", "sim", "yes"].includes(bruto);
}

export const config = {
  /** Porta da API local de diagnóstico */
  porta: numero("PORTA", 7700),

  /**
   * Em qual endereço a API escuta.
   *
   * Importa por causa da rede de anfitrião: sem mapeamento de porta para
   * limitar o alcance, quem decide se isto fica acessível de fora é este
   * valor. O padrão é só a própria máquina — um extrator aberto na rede é um
   * proxy de download para quem quiser.
   */
  endereco: texto("ENDERECO", "127.0.0.1"),

  /**
   * Endereço da instância do Stoat.
   *
   * Opcional: sem ele o agente ainda sobe e resolve, só não se registra.
   * Isso é de propósito — dá para validar a extração nesta máquina antes de
   * existir qualquer rota no servidor.
   */
  stoatUrl: process.env.STOAT_URL?.trim().replace(/\/+$/, "") || null,

  /** Segredo compartilhado com o Stoat; é o que prova que o agente é seu */
  segredo: process.env.AGENTE_SEGREDO?.trim() || null,

  /** Intervalo do batimento, em milissegundos */
  batimentoMs: numero("BATIMENTO_MS", 15_000),

  /** Atualizar o yt-dlp na partida */
  atualizarYtdlp: ligado("ATUALIZAR_YTDLP", true),

  /** Caminhos das ferramentas externas */
  ytdlp: texto("YTDLP_BIN", "yt-dlp"),
  ffmpeg: texto("FFMPEG_BIN", "ffmpeg"),

  /**
   * Vídeo usado no teste de alcance da partida.
   *
   * O primeiro vídeo do YouTube: curto, público e estável há duas décadas.
   * Serve só para responder "este IP consegue falar com o YouTube?".
   */
  videoDeTeste: texto(
    "VIDEO_TESTE",
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  ),
};

export type Config = typeof config;
