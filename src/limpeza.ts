import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Remove restos de extração do yt-dlp.
 *
 * O binário autônomo desempacota as próprias bibliotecas numa pasta `_MEI…`
 * dentro do diretório temporário e a apaga ao encerrar. Encerramento anormal
 * — o processo morto ao trocar de faixa, o container reiniciado no meio de um
 * download — deixa a pasta para trás.
 *
 * Cada resto custa dezenas de megabytes. Num /tmp em memória de 256 MB, meia
 * dúzia deles enche tudo, e a partir daí toda extração falha com
 * "Failed to extract entry: ..." — mensagem que culpa uma biblioteca e não
 * diz que o disco acabou.
 *
 * Isto varre o que já ficou. A causa em si é tratada matando o processo com
 * SIGTERM antes de SIGKILL, para que ele consiga limpar sozinho.
 */
export async function limparRestosDeExtracao(): Promise<number> {
  const base = process.env.HOME || tmpdir();
  let removidas = 0;

  let entradas: string[];
  try {
    entradas = await readdir(base);
  } catch {
    return 0;
  }

  // Só toca no que tem a cara de uma extração do PyInstaller: prefixo `_MEI`
  // seguido de dígitos. Varrer o diretório inteiro apagaria coisa de outros.
  const molde = /^_MEI\d+$/;

  for (const nome of entradas) {
    if (!molde.test(nome)) continue;

    const caminho = join(base, nome);
    try {
      const info = await stat(caminho);
      if (!info.isDirectory()) continue;

      // Deixa em paz o que foi criado agora: pode ser uma extração em uso.
      if (Date.now() - info.mtimeMs < 60_000) continue;

      await rm(caminho, { recursive: true, force: true });
      removidas++;
    } catch {
      // Em uso ou já removida por outro caminho; não é motivo para parar.
    }
  }

  return removidas;
}
