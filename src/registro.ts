import { config } from "./config.ts";
import type { Diagnostico } from "./diagnostico.ts";

type Estado = {
  registrado: boolean;
  ultimaTentativa: string | null;
  motivo?: string;
};

let estado: Estado = { registrado: false, ultimaTentativa: null };

export function estadoDoRegistro(): Estado {
  return estado;
}

/**
 * Avisa o Stoat que este agente está vivo.
 *
 * Quem inicia a conversa é sempre o agente, nunca o servidor. O agente vive
 * atrás do NAT da casa: o servidor não tem como alcançá-lo, e nada de abrir
 * porta no roteador para resolver isso.
 *
 * A rota ainda não existe no backend. Enquanto não existir, o agente registra
 * o motivo e segue funcionando — dá para validar a extração nesta máquina sem
 * depender de o servidor estar pronto.
 */
async function bater(diagnostico: Diagnostico): Promise<void> {
  estado.ultimaTentativa = new Date().toISOString();

  if (!config.stoatUrl || !config.segredo) {
    estado = {
      registrado: false,
      ultimaTentativa: estado.ultimaTentativa,
      motivo: "STOAT_URL ou AGENTE_SEGREDO não configurados",
    };
    return;
  }

  try {
    const resposta = await fetch(`${config.stoatUrl}/api/musicbox/agente/batimento`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.segredo}`,
      },
      body: JSON.stringify({
        pronto: diagnostico.ok,
        provedores: diagnostico.ok ? ["youtube"] : [],
        // O servidor precisa saber a diferença entre "está fora do ar" e
        // "está de pé mas o YouTube recusou o IP" — as duas pedem mensagens
        // diferentes para quem estiver tentando ouvir música.
        motivo: diagnostico.ok ? undefined : diagnostico.youtube.motivo,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (resposta.ok) {
      estado = { registrado: true, ultimaTentativa: estado.ultimaTentativa };
      return;
    }

    estado = {
      registrado: false,
      ultimaTentativa: estado.ultimaTentativa,
      motivo:
        resposta.status === 404
          ? "rota ainda não existe no servidor"
          : `servidor respondeu ${resposta.status}`,
    };
  } catch (erro) {
    estado = {
      registrado: false,
      ultimaTentativa: estado.ultimaTentativa,
      motivo: erro instanceof Error ? erro.message : String(erro),
    };
  }
}

/**
 * Mantém o batimento enquanto o agente viver.
 *
 * Devolve uma função para parar, porque um `setInterval` órfão segura o
 * processo e faz o encerramento demorar sem motivo aparente.
 */
export function manterBatimento(
  diagnostico: () => Diagnostico | null,
): () => void {
  const enviar = () => {
    const atual = diagnostico();
    if (atual) void bater(atual);
  };

  enviar();
  const relogio = setInterval(enviar, config.batimentoMs);
  return () => clearInterval(relogio);
}
