import { spawn } from "node:child_process";

/**
 * Execução de processo externo com limite de tempo e saída capturada.
 *
 * O `exec` da biblioteca padrão junta stdout e stderr de um jeito que
 * esconde qual foi qual, e não tem limite de tempo por padrão. Aqui um
 * comando travado morre em vez de pendurar o agente para sempre.
 */
export function executar(
  comando: string,
  argumentos: string[],
  opcoes: { limiteMs?: number } = {},
): Promise<{ codigo: number; saida: string; erro: string }> {
  const limiteMs = opcoes.limiteMs ?? 30_000;

  return new Promise((resolver) => {
    const processo = spawn(comando, argumentos, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let saida = "";
    let erro = "";
    let encerrado = false;

    const relogio = setTimeout(() => {
      encerrado = true;
      processo.kill("SIGKILL");
      resolver({
        codigo: -1,
        saida,
        erro: `${erro}\n[agente] tempo esgotado após ${limiteMs} ms`,
      });
    }, limiteMs);

    processo.stdout.on("data", (pedaco) => (saida += pedaco));
    processo.stderr.on("data", (pedaco) => (erro += pedaco));

    processo.on("error", (falha) => {
      if (encerrado) return;
      clearTimeout(relogio);
      resolver({ codigo: -1, saida, erro: `${erro}\n${falha.message}` });
    });

    processo.on("close", (codigo) => {
      if (encerrado) return;
      clearTimeout(relogio);
      resolver({ codigo: codigo ?? -1, saida, erro });
    });
  });
}
