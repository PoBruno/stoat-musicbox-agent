import { config } from "./config.ts";
import { atualizarYtdlp, diagnosticar, type Diagnostico } from "./diagnostico.ts";
import { subirHttp } from "./http.ts";
import { manterBatimento } from "./registro.ts";
import { manterTrabalho } from "./trabalho.ts";

/**
 * Agente MusicBox.
 *
 * Existe porque o YouTube recusa requisições do IP da VPS e atende as de uma
 * conexão residencial. Isto roda em casa e faz só a extração; fila,
 * playlists e interface continuam no Stoat.
 */

let ultimoDiagnostico: Diagnostico | null = null;

async function principal() {
  console.log("[agente] iniciando");

  if (config.atualizarYtdlp) {
    console.log(`[agente] atualizando yt-dlp: ${await atualizarYtdlp()}`);
  }

  ultimoDiagnostico = await diagnosticar();

  const { ferramentas, youtube } = ultimoDiagnostico;
  console.log(
    `[agente] yt-dlp ${ferramentas.ytdlp ?? "AUSENTE"} | ffmpeg ${ferramentas.ffmpeg ?? "AUSENTE"}`,
  );

  if (youtube.alcancavel) {
    console.log(`[agente] o YouTube atende este IP (${youtube.ms} ms)`);
  } else {
    // Não é motivo para sair: o agente continua respondendo /saude, e é por
    // ali que se descobre o que houve. Sair deixaria o container reiniciando
    // em laço, sem ninguém para contar o porquê.
    console.error(`[agente] NÃO vou conseguir extrair: ${youtube.motivo}`);
  }

  subirHttp(() => ultimoDiagnostico);
  const pararBatimento = manterBatimento(() => ultimoDiagnostico);

  // Só busca trabalho se conseguir fazê-lo. Pendurar-se no servidor sem
  // conseguir extrair faria os pedidos irem para uma máquina que só sabe
  // devolver erro.
  const pararTrabalho = youtube.alcancavel ? manterTrabalho() : () => {};

  // Revalida de tempos em tempos: um IP pode ser desafiado depois de horas
  // funcionando, e o servidor precisa saber disso sem esperar alguém tentar
  // tocar uma música.
  const revalidacao = setInterval(
    async () => {
      ultimoDiagnostico = await diagnosticar();
    },
    30 * 60_000,
  );

  const encerrar = (sinal: string) => {
    console.log(`[agente] ${sinal}, encerrando`);
    clearInterval(revalidacao);
    pararBatimento();
    pararTrabalho();
    process.exit(0);
  };

  process.on("SIGTERM", () => encerrar("SIGTERM"));
  process.on("SIGINT", () => encerrar("SIGINT"));
}

principal().catch((erro) => {
  console.error("[agente] falhou ao iniciar:", erro);
  process.exit(1);
});
