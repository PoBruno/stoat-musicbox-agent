import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

import { config } from "./config.ts";
import type { Faixa } from "./provedores.ts";

/**
 * Abre um fluxo de áudio em Opus a partir de um endereço direto.
 *
 * Duas decisões que valem explicação:
 *
 * O YouTube já entrega Opus a 48 kHz no formato 251, que é exatamente o que o
 * LiveKit consome. Quando é esse o caso, o ffmpeg só **reempacota**
 * (`-c:a copy`) em vez de recodificar. Opus para Opus perderia qualidade e
 * gastaria CPU sem nenhum ganho.
 *
 * O `-reconnect` existe porque os endereços do YouTube caem no meio de faixas
 * longas com alguma frequência. Sem ele, a música simplesmente para na metade
 * e nada no log explica por quê.
 */
export function abrirFluxoOpus(
  enderecoDireto: string,
  opcoes: { recodificar?: boolean } = {},
): { fluxo: Readable; encerrar: () => void } {
  const argumentos = [
    "-hide_banner",
    "-loglevel",
    "error",
    // Reconecta se o endereço cair no meio.
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "5",
    "-i",
    enderecoDireto,
    "-vn",
  ];

  if (opcoes.recodificar) {
    argumentos.push("-ac", "2", "-ar", "48000", "-c:a", "libopus", "-b:a", "96k");
  } else {
    argumentos.push("-c:a", "copy");
  }

  // OGG carrega os limites de quadro que o Opus cru não tem; sem container o
  // consumidor não sabe onde um quadro termina e o outro começa.
  argumentos.push("-f", "ogg", "pipe:1");

  const processo = spawn(config.ffmpeg, argumentos, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let ultimoErro = "";
  processo.stderr.on("data", (pedaco) => {
    ultimoErro = String(pedaco).trim();
  });

  processo.on("close", (codigo) => {
    // Código 255 é o encerramento pedido por nós; não é falha.
    if (codigo !== 0 && codigo !== 255 && ultimoErro) {
      console.error(`[audio] ffmpeg saiu com ${codigo}: ${ultimoErro}`);
    }
  });

  return {
    fluxo: processo.stdout,
    encerrar: () => {
      if (!processo.killed) processo.kill("SIGKILL");
    },
  };
}

/**
 * Mede quanto uma faixa custaria, sem tocar nada até o fim.
 *
 * Serve ao diagnóstico: responde "esta máquina dá conta?" com número em vez
 * de opinião.
 */
export async function medirCusto(
  enderecoDireto: string,
  segundos = 5,
): Promise<{ bytes: number; ms: number }> {
  const inicio = Date.now();
  const { fluxo, encerrar } = abrirFluxoOpus(enderecoDireto);

  let bytes = 0;
  await new Promise<void>((pronto) => {
    const relogio = setTimeout(() => {
      encerrar();
      pronto();
    }, segundos * 1000);

    fluxo.on("data", (pedaco: Buffer) => (bytes += pedaco.length));
    fluxo.on("close", () => {
      clearTimeout(relogio);
      pronto();
    });
    fluxo.on("error", () => {
      clearTimeout(relogio);
      pronto();
    });
  });

  return { bytes, ms: Date.now() - inicio };
}

/** Só para o tipo de `Faixa` não ficar sem uso quando o LiveKit entrar aqui */
export type FaixaParaTocar = Faixa;
