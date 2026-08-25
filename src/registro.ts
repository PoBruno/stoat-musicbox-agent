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

  // O batimento não leva diagnóstico: se este agente não consegue falar com o
  // YouTube, ele não deve se anunciar como disponível. Bater ponto dizendo
  // "estou aqui mas não funciono" faria o servidor mandar trabalho que só
  // pode falhar.
  if (!diagnostico.ok) {
    estado = {
      registrado: false,
      ultimaTentativa: estado.ultimaTentativa,
      motivo: `não me anuncio sem conseguir extrair: ${diagnostico.youtube.motivo ?? "sem detalhe"}`,
    };
    return;
  }

  try {
    const resposta = await fetch(`${config.stoatUrl}/musicbox/agent/heartbeat`, {
      method: "POST",
      headers: { "x-musicbox-secret": config.segredo },
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
          : resposta.status === 401
            ? "o servidor recusou o segredo"
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
