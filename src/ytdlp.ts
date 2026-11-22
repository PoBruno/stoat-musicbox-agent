import { randomUUID } from "node:crypto";
import {
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config } from "./config.ts";

/**
 * Argumentos que toda execução do yt-dlp leva, e a sessão do YouTube.
 *
 * Desde novembro de 2026 o YouTube não entrega áudio a acesso anônimo a
 * partir do IP de casa: todo cliente do yt-dlp levava 403 ou "só imagens",
 * inclusive com PO token e com o downloader SABR. Com os cookies de uma conta
 * logada o mesmo pedido passa. Ver .claude/plans/musicbox.md, seção 19.
 *
 * O que derruba a sessão é o YouTube girar os cookies: a cada tanto ele troca
 * alguns valores, e quem continuar com os velhos perde o login. Por isso:
 *
 * - a sessão tem que ser SÓ do agente (exportada de janela anônima, que é
 *   fechada em seguida); se um navegador continuar usando, um derruba o outro;
 * - o agente guarda o que o YouTube girou, em `cookiesVivos`, e é dali que
 *   parte no próximo reinício. Sem isso a sessão morria em minutos.
 *
 * `--js-runtimes node`: o yt-dlp precisa de um runtime JS para o desafio de
 * assinatura do player, e o node já está no container.
 */

/** A sessão atual, em memória. */
let cookies: string | null = null;

/** Data da semente quando foi lida: semente mais nova = exportação nova. */
let sementeLida = -1;

/** Último aviso do yt-dlp de que a sessão caiu; nulo se está valendo. */
let sessaoCaiu: string | null = null;

/** O que o /saude mostra sobre a sessão. */
export function estadoDaSessao(): {
  configurada: boolean;
  valida: boolean;
  aviso: string | null;
} {
  return { configurada: !!cookies, valida: !!cookies && !sessaoCaiu, aviso: sessaoCaiu };
}

function idade(caminho: string): number {
  try {
    return statSync(caminho).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * Carrega a sessão: a viva, se for mais nova que a semente, senão a semente.
 *
 * A semente (`YTDLP_COOKIES`) é o arquivo exportado, somente leitura. Trocar
 * a semente por uma exportação nova faz o agente recomeçar dela, porque ela
 * fica mais nova que a viva.
 */
export function carregarCookies(): boolean {
  const semente = config.cookies;
  const viva = config.cookiesVivos;
  const fonte =
    viva && idade(viva) > (semente ? idade(semente) : -1) ? viva : semente;
  if (!fonte) return false;
  try {
    const texto = readFileSync(fonte, "utf8");
    if (!texto.includes("youtube.com")) return false;
    cookies = texto;
    sessaoCaiu = null;
    sementeLida = semente ? idade(semente) : -1;
    console.log(`[ytdlp] sessao do YouTube lida de ${fonte === viva ? "cookies vivos" : "semente"}`);
    return true;
  } catch (erro) {
    console.error(`[ytdlp] nao consegui ler os cookies: ${erro}`);
    return false;
  }
}

/** Guarda a sessão girada, de forma atômica (nunca deixa arquivo pela metade). */
function guardar(texto: string) {
  cookies = texto;
  if (!config.cookiesVivos) return;
  try {
    const temporario = `${config.cookiesVivos}.${process.pid}.tmp`;
    writeFileSync(temporario, texto, { mode: 0o600 });
    renameSync(temporario, config.cookiesVivos);
  } catch (erro) {
    console.error(`[ytdlp] nao consegui guardar os cookies: ${erro}`);
  }
}

/** O pote tem uma conta logada (os dois cookies que o YouTube exige). */
function logado(texto: string): boolean {
  return /\tLOGIN_INFO\t/.test(texto) && /\t__Secure-3PSID\t/.test(texto);
}

/** Linhas de cookie (sem comentários), para comparar sessões. */
function linhas(texto: string): string {
  return texto
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("# "))
    .sort()
    .join("\n");
}

/**
 * Argumentos extras para uma execução, e o que fazer quando ela terminar.
 *
 * Uma cópia por execução porque várias rodam ao mesmo tempo (resolver,
 * espelhar do Spotify, tocar), e o yt-dlp regrava o arquivo ao sair. A cópia
 * fica em /tmp, que é tmpfs. Ao terminar, se o yt-dlp gravou cookies
 * diferentes (o YouTube girou), eles viram a sessão atual.
 *
 * `terminar` recebe o stderr para notar a sessão caída.
 */
export function argumentosDoYtdlp(): {
  args: string[];
  limpar: (erro?: string) => void;
} {
  const args = ["--js-runtimes", "node"];
  // Exportação nova no lugar da semente: recarrega sem reiniciar o agente.
  if (config.cookies && idade(config.cookies) > sementeLida) carregarCookies();
  if (!cookies) return { args, limpar: () => {} };

  const base = cookies;
  const copia = join(tmpdir(), `ck-${randomUUID()}.txt`);
  writeFileSync(copia, base, { mode: 0o600 });

  let feito = false;
  return {
    args: [...args, "--cookies", copia],
    limpar: (erro?: string) => {
      if (feito) return;
      feito = true;
      try {
        if (erro?.includes("cookies are no longer valid")) {
          if (!sessaoCaiu) {
            console.error(
              "[ytdlp] a sessao do YouTube caiu (cookies girados). Exporte de novo, de janela anonima.",
            );
          }
          sessaoCaiu = new Date().toISOString();
          return;
        }
        const depois = readFileSync(copia, "utf8");
        // O YouTube desloga apagando LOGIN_INFO: isso e a sessao caindo, e
        // guardar esse pote deslogado esconderia a queda para sempre.
        if (logado(base) && !logado(depois)) {
          if (!sessaoCaiu) {
            console.error(
              "[ytdlp] o YouTube deslogou a sessao. Exporte de novo, de janela anonima.",
            );
          }
          sessaoCaiu = new Date().toISOString();
          return;
        }
        if (cookies === base && linhas(depois) !== linhas(base)) {
          guardar(depois);
        }
      } catch {
        // A cópia pode já não existir; nada a guardar.
      } finally {
        rmSync(copia, { force: true });
      }
    },
  };
}
