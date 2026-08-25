import { spawn, type ChildProcess } from "node:child_process";

import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";

import { config } from "./config.ts";
import { ErroDeProvedor, fontes, type Faixa } from "./provedores.ts";

/**
 * O LiveKit consome Opus a 48 kHz. Decodificamos para PCM nessa taxa e deixamos
 * o LiveKit reencodar — o SDK só aceita quadros crus.
 *
 * Vale registrar o custo dessa escolha: o YouTube já entrega Opus a 48 kHz, e
 * repassar os bytes sem tocar seria de graça. O SDK não expõe esse caminho,
 * então pagamos uma decodificação e uma codificação. Medido em ~4% de um núcleo
 * nesta máquina, o que é aceitável para um grupo de amigos, mas é o primeiro
 * lugar a olhar se a CPU virar problema.
 */
const TAXA = 48_000;
const CANAIS = 2;
/** 10 ms por quadro, que é o tamanho interno do Opus. */
const AMOSTRAS_POR_QUADRO = TAXA / 100;
const BYTES_POR_QUADRO = AMOSTRAS_POR_QUADRO * CANAIS * 2;

export type EstadoDaTocada = {
  tocando: boolean;
  canal: string | null;
  faixa: { titulo: string; paginaUrl: string } | null;
  desde: string | null;
};

let estado: EstadoDaTocada = {
  tocando: false,
  canal: null,
  faixa: null,
  desde: null,
};

export function estadoDaTocada(): EstadoDaTocada {
  return estado;
}

/** O que está no ar agora. Um de cada vez. */
let atual: {
  sala: Room;
  fonte: AudioSource;
  ytdlp: ChildProcess;
  ffmpeg: ChildProcess;
  cancelado: boolean;
} | null = null;

/** Pede ao servidor a credencial de entrada na sala. */
async function pegarToken(canalId: string): Promise<{ token: string; url: string }> {
  const resposta = await fetch(`${config.stoatUrl}/musicbox/agent/token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-musicbox-secret": config.segredo ?? "",
    },
    body: JSON.stringify({ channel_id: canalId }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resposta.ok) {
    throw new ErroDeProvedor(
      `o servidor recusou o token de voz (${resposta.status})`,
      "desconhecido",
    );
  }
  return (await resposta.json()) as { token: string; url: string };
}

/**
 * Interrompe o que estiver tocando.
 *
 * Idempotente de propósito: é chamado tanto por quem pediu para parar quanto
 * pelo fim natural da faixa, e os dois podem acontecer quase juntos.
 */
export async function parar(): Promise<void> {
  const agora = atual;
  if (!agora) return;
  atual = null;
  agora.cancelado = true;

  // Desliga o cano ANTES de matar. O yt-dlp escreve na entrada do ffmpeg; se
  // o ffmpeg morrer com o cano ligado, a escrita seguinte dispara `EPIPE` num
  // socket sem tratador — e no Node isso não é um erro daquela operação, é o
  // processo inteiro caindo.
  agora.ytdlp.stdout?.unpipe();

  // SIGKILL e não SIGTERM no yt-dlp: ele ignora o pedido educado enquanto
  // está escrevendo, e o processo ficaria vivo segurando a conexão.
  agora.ytdlp.kill("SIGKILL");
  agora.ffmpeg.kill("SIGKILL");

  try {
    await agora.sala.disconnect();
  } catch {
    // Já pode ter caído sozinha; não há o que fazer além de seguir.
  }

  estado = { tocando: false, canal: null, faixa: null, desde: null };
  console.log("[tocar] parado");
}

/**
 * Toca uma faixa dentro da chamada de um canal.
 *
 * O áudio vai direto desta máquina para o LiveKit: o servidor nunca vê um
 * byte de música. É o que torna viável extrair de uma conexão residencial sem
 * transformar a VPS em intermediária de mídia.
 */
export async function tocar(canalId: string, faixa: Faixa): Promise<void> {
  await parar();

  const fonteDeAudio = fontes.get(faixa.provedor);
  if (!fonteDeAudio) {
    throw new ErroDeProvedor(
      `o provedor ${faixa.provedor} resolve mas não entrega áudio`,
      "desconhecido",
    );
  }

  const endereco = await fonteDeAudio.enderecoDireto(faixa);
  const { token, url } = await pegarToken(canalId);

  const sala = new Room();
  await sala.connect(url, token, { autoSubscribe: false, dynacast: false });

  const fonte = new AudioSource(TAXA, CANAIS);
  const faixaLocal = LocalAudioTrack.createAudioTrack("musicbox", fonte);
  const opcoes = new TrackPublishOptions();
  opcoes.source = TrackSource.SOURCE_UNKNOWN;

  const eu_participante = sala.localParticipant;
  if (!eu_participante) {
    await sala.disconnect();
    throw new ErroDeProvedor("entrei na sala mas sem participante", "desconhecido");
  }
  await eu_participante.publishTrack(faixaLocal, opcoes);

  // O yt-dlp escreve o fluxo na saída padrão e o ffmpeg decodifica para PCM.
  // Dois processos em vez de um porque o endereço direto expira e é preso ao
  // IP: deixar o yt-dlp cuidar disso evita reimplementar a parte chata.
  const ytdlp = spawn(
    config.ytdlp,
    ["--no-warnings", "--ignore-config", "-o", "-", endereco],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const ffmpeg = spawn(
    config.ffmpeg,
    [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "-ar", String(TAXA),
      "-ac", String(CANAIS),
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  ytdlp.stdout?.pipe(ffmpeg.stdin!);

  // Trocar de faixa mata o ffmpeg enquanto o yt-dlp ainda escreve. Sem estes
  // tratadores, a escrita seguinte emite `EPIPE` num socket sem ouvinte, e o
  // Node trata isso como exceção não capturada: o agente inteiro cai, no meio
  // de uma troca de música. São esperados, então só registram em depuração.
  const engolirCanoQuebrado = (onde: string) => (erro: NodeJS.ErrnoException) => {
    if (erro.code === "EPIPE" || erro.code === "ERR_STREAM_DESTROYED") return;
    console.error(`[tocar] ${onde}: ${erro.message}`);
  };
  ytdlp.stdout?.on("error", engolirCanoQuebrado("saida do yt-dlp"));
  ffmpeg.stdin?.on("error", engolirCanoQuebrado("entrada do ffmpeg"));
  ffmpeg.stdout?.on("error", engolirCanoQuebrado("saida do ffmpeg"));
  ytdlp.on("error", engolirCanoQuebrado("yt-dlp"));
  ffmpeg.on("error", engolirCanoQuebrado("ffmpeg"));

  const eu = { sala, fonte, ytdlp, ffmpeg, cancelado: false };
  atual = eu;
  estado = {
    tocando: true,
    canal: canalId,
    faixa: { titulo: faixa.titulo, paginaUrl: faixa.paginaUrl },
    desde: new Date().toISOString(),
  };
  console.log(`[tocar] "${faixa.titulo}" no canal ${canalId}`);

  ffmpeg.stderr?.on("data", (b: Buffer) => {
    const texto = b.toString().trim();
    if (texto) console.error(`[ffmpeg] ${texto}`);
  });

  // Alimenta o LiveKit em blocos de tamanho fixo. `captureFrame` aplica
  // contrapressão: aguardá-lo é o que mantém o ritmo colado no relógio do
  // áudio, sem acumular buffer nem precisar de temporizador.
  // `sobra` acumula o que ainda nao completou um quadro. O tipo declarado
  // evita o `SharedArrayBuffer` que o TypeScript admite em `Buffer`: o
  // `Int16Array` mais abaixo precisa de um `ArrayBuffer` de verdade.
  let sobra: Buffer<ArrayBuffer> = Buffer.alloc(0) as Buffer<ArrayBuffer>;
  const saida = ffmpeg.stdout!;

  saida.on("data", (bloco: Buffer) => {
    sobra = (
      sobra.length ? Buffer.concat([sobra, bloco]) : bloco
    ) as Buffer<ArrayBuffer>;

    if (sobra.length < BYTES_POR_QUADRO) return;

    saida.pause();
    void (async () => {
      try {
        // `atual === eu` além do `cancelado`: trocar de faixa substitui o que
        // está no ar, e o laço da faixa velha precisa perceber que perdeu a
        // vez. Sem isso ele segue alimentando uma fonte de áudio já
        // desligada, e o LiveKit responde `InvalidState` a cada quadro.
        while (sobra.length >= BYTES_POR_QUADRO && !eu.cancelado && atual === eu) {
          const quadro = sobra.subarray(0, BYTES_POR_QUADRO);
          sobra = sobra.subarray(BYTES_POR_QUADRO) as Buffer<ArrayBuffer>;
          await fonte.captureFrame(
            new AudioFrame(
              new Int16Array(
                quadro.buffer.slice(
                  quadro.byteOffset,
                  quadro.byteOffset + quadro.byteLength,
                ),
              ),
              TAXA,
              CANAIS,
              AMOSTRAS_POR_QUADRO,
            ),
          );
        }
      } catch (erro) {
        // Depois de parar, falhar é o esperado: a fonte já foi embora.
        if (!eu.cancelado && atual === eu) {
          console.error(`[tocar] falha ao emitir: ${erro}`);
        }
      } finally {
        if (!eu.cancelado && atual === eu) saida.resume();
      }
    })();
  });

  ffmpeg.on("close", () => {
    // Só encerra se ainda for a tocada corrente: uma faixa nova pode ter
    // começado enquanto esta terminava.
    if (atual === eu) void parar();
  });
}
