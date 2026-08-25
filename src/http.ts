import { createServer } from "node:http";

import { config } from "./config.ts";
import { medirCusto } from "./audio.ts";
import { diagnosticar, type Diagnostico } from "./diagnostico.ts";
import { ErroDeProvedor, fontes, resolver } from "./provedores.ts";
import { estadoDoRegistro } from "./registro.ts";

/**
 * API local do agente.
 *
 * Não é a interface do MusicBox — essa vive no Stoat. Isto aqui existe para
 * responder "esta máquina está fazendo o trabalho?" sem depender de o
 * servidor já ter as rotas prontas.
 *
 * Fica ligada só na rede local: expor um extrator na internet seria dar a
 * qualquer um um proxy de download.
 */
export function subirHttp(ultimoDiagnostico: () => Diagnostico | null) {
  const servidor = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${config.porta}`);

    const responder = (codigo: number, corpo: unknown) => {
      const texto = JSON.stringify(corpo, null, 2);
      res.writeHead(codigo, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(texto),
      });
      res.end(texto);
    };

    try {
      switch (url.pathname) {
        case "/saude": {
          // Reaproveita o diagnóstico da partida quando é recente. Refazer a
          // cada chamada faria uma requisição ao YouTube por batimento, o que
          // é justamente o padrão que chama atenção.
          const cache = ultimoDiagnostico();
          const recente =
            cache &&
            Date.now() - Date.parse(cache.verificadoEm) < 5 * 60_000;

          const diag = recente ? cache : await diagnosticar();
          return responder(diag.ok ? 200 : 503, {
            ...diag,
            stoat: estadoDoRegistro(),
          });
        }

        case "/resolver": {
          const consulta = url.searchParams.get("q");
          if (!consulta) {
            return responder(400, { erro: "faltou o parâmetro q" });
          }
          // O teto é alto porque uma playlist inteira é um pedido legítimo;
          // existe só para um endereço maldoso não virar uma resposta sem fim.
          const limite = Number(url.searchParams.get("limite") ?? 5);
          const faixas = await resolver(consulta, Math.min(limite, 200));
          return responder(200, { total: faixas.length, faixas });
        }

        case "/medir": {
          // Diagnóstico de custo: quanto uma faixa consome nesta máquina.
          const consulta = url.searchParams.get("q");
          if (!consulta) {
            return responder(400, { erro: "faltou o parâmetro q" });
          }
          const [faixa] = await resolver(consulta, 1);
          if (!faixa) return responder(404, { erro: "nada encontrado" });

          const fonte = fontes.get(faixa.provedor);
          if (!fonte) {
            return responder(501, {
              erro: `o provedor ${faixa.provedor} resolve mas não entrega áudio`,
            });
          }

          const endereco = await fonte.enderecoDireto(faixa);
          const medida = await medirCusto(endereco, 5);
          return responder(200, {
            faixa: { titulo: faixa.titulo, duracaoS: faixa.duracaoS },
            amostra: {
              ...medida,
              // Opus a ~106 kbit/s dá cerca de 13 KB por segundo de música.
              segundosDeAudio: +(medida.bytes / 13_000).toFixed(1),
            },
          });
        }

        default:
          return responder(404, {
            erro: "rota desconhecida",
            disponiveis: ["/saude", "/resolver?q=", "/medir?q="],
          });
      }
    } catch (erro) {
      if (erro instanceof ErroDeProvedor) {
        // 502 e não 500: a falha é do serviço lá fora, não deste agente.
        return responder(erro.motivo === "bloqueado" ? 502 : 400, {
          erro: erro.message,
          motivo: erro.motivo,
        });
      }
      return responder(500, { erro: String(erro) });
    }
  });

  servidor.listen(config.porta, config.endereco, () => {
    console.log(`[http] ouvindo em ${config.endereco}:${config.porta}`);
  });

  return servidor;
}
