import { config } from "./config.ts";
import { ErroDeProvedor, resolver, type Faixa } from "./provedores.ts";
import { parar, tocar } from "./tocar.ts";

/** Trabalho entregue pelo servidor. */
type Comando = {
  id: string;
  kind: "resolve" | "play" | "stop";
  query: string;
  limit: number;
  channel_id?: string | null;
  track?: FaixaDoServidor | null;
};

/** Faixa no formato do servidor (inglês), como ela volta num comando. */
type FaixaDoServidor = {
  id: string;
  provider: string;
  title: string;
  author: string | null;
  duration_s: number | null;
  cover_url: string | null;
  page_url: string;
};

/** Converte de volta ao formato do agente. */
function doServidor(t: FaixaDoServidor): Faixa {
  return {
    id: t.id,
    provedor: t.provider,
    titulo: t.title,
    autor: t.author,
    duracaoS: t.duration_s,
    capaUrl: t.cover_url,
    paginaUrl: t.page_url,
  };
}

/**
 * Converte uma faixa do agente para o formato que o servidor espera.
 *
 * Os dois lados usam nomes diferentes de propósito: o agente fala português
 * porque é código nosso, e o servidor segue o inglês do resto da API. A
 * tradução fica num lugar só, aqui.
 */
function paraOServidor(f: Faixa) {
  return {
    id: f.id,
    provider: f.provedor,
    title: f.titulo,
    author: f.autor,
    duration_s: f.duracaoS,
    cover_url: f.capaUrl,
    page_url: f.paginaUrl,
  };
}

/**
 * Devolve o resultado de um comando.
 *
 * Erro de provedor também é resultado: o servidor precisa saber que o pedido
 * terminou, senão quem pediu fica esperando até estourar o tempo — o que
 * transforma "vídeo indisponível" numa espera de um minuto.
 */
async function devolver(
  base: string,
  segredo: string,
  corpo: Record<string, unknown>,
): Promise<void> {
  const resposta = await fetch(`${base}/musicbox/agent/result`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-musicbox-secret": segredo,
    },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resposta.ok) {
    console.error(
      `[trabalho] o servidor recusou o resultado: ${resposta.status}`,
    );
  }
}

/** Executa um comando e devolve o que achou. */
async function atender(
  base: string,
  segredo: string,
  comando: Comando,
): Promise<void> {
  const comeco = Date.now();

  try {
    switch (comando.kind) {
      case "play": {
        if (!comando.channel_id || !comando.track) {
          throw new ErroDeProvedor("comando de tocar veio incompleto", "desconhecido");
        }
        await tocar(comando.channel_id, doServidor(comando.track));
        console.log(
          `[trabalho] tocando "${comando.track.title.slice(0, 50)}" em ${Date.now() - comeco} ms`,
        );
        await devolver(base, segredo, { id: comando.id, tracks: [] });
        return;
      }

      case "stop": {
        await parar();
        await devolver(base, segredo, { id: comando.id, tracks: [] });
        return;
      }

      default: {
        const faixas = await resolver(comando.query, comando.limit);
        console.log(
          `[trabalho] "${comando.query.slice(0, 60)}" -> ${faixas.length} faixa(s) em ${Date.now() - comeco} ms`,
        );
        await devolver(base, segredo, {
          id: comando.id,
          tracks: faixas.map(paraOServidor),
        });
        return;
      }
    }
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    const motivo = erro instanceof ErroDeProvedor ? erro.motivo : "desconhecido";
    console.error(`[trabalho] ${comando.kind} falhou (${motivo}): ${mensagem}`);
    await devolver(base, segredo, {
      id: comando.id,
      tracks: [],
      error: mensagem,
      reason: motivo,
    });
  }
}

/**
 * Fica pendurado no servidor esperando trabalho.
 *
 * O servidor não pode ligar para cá: este agente está atrás do NAT de uma casa.
 * Então é ele quem liga e espera. A requisição fica aberta até o servidor ter
 * o que mandar, e aí a resposta chega na hora, em vez de esperar o próximo
 * ciclo de uma sondagem periódica.
 *
 * Devolve uma função para parar o laço.
 */
export function manterTrabalho(): () => void {
  let vivo = true;

  const base = config.stoatUrl;
  const segredo = config.segredo;
  if (!base || !segredo) {
    console.log("[trabalho] sem STOAT_URL/AGENTE_SEGREDO: não busco trabalho");
    return () => {};
  }

  /** Espera crescente depois de falhar, para não martelar um servidor fora do ar. */
  let recuo = 1_000;

  (async () => {
    while (vivo) {
      try {
        const resposta = await fetch(`${base}/musicbox/agent/commands`, {
          headers: { "x-musicbox-secret": segredo },
          // Mais folgado que o tempo de espera do servidor: quem decide a
          // hora de desistir é ele. Cortar antes faria toda espera normal
          // parecer uma falha de rede.
          signal: AbortSignal.timeout(90_000),
        });

        if (resposta.status === 401 || resposta.status === 404) {
          console.error(
            `[trabalho] o servidor recusou (${resposta.status}); tento de novo em 30 s`,
          );
          await new Promise((r) => setTimeout(r, 30_000));
          continue;
        }

        recuo = 1_000;

        if (!resposta.ok) {
          console.error(`[trabalho] resposta inesperada: ${resposta.status}`);
          continue;
        }

        // Corpo `null` é o normal: a espera acabou sem trabalho aparecer.
        const comando = (await resposta.json()) as Comando | null;
        if (!comando) continue;

        // Atende sem travar o laço: enquanto uma playlist longa é resolvida,
        // o agente já volta a se pendurar para pegar o próximo pedido.
        void atender(base, segredo, comando);
      } catch (erro) {
        if (!vivo) return;
        const mensagem = erro instanceof Error ? erro.message : String(erro);
        console.error(`[trabalho] ${mensagem}; tento de novo em ${recuo} ms`);
        await new Promise((r) => setTimeout(r, recuo));
        recuo = Math.min(recuo * 2, 30_000);
      }
    }
  })();

  return () => {
    vivo = false;
  };
}
