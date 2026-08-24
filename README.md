# Agente MusicBox

Extrator de áudio para o MusicBox do Stoat, feito para rodar **na sua rede
doméstica** — tipicamente um container no Proxmox.

## Por que ele existe

O YouTube recusa requisições vindas do IP da VPS:

```
Sign in to confirm you're not a bot.
```

Isso foi medido, não suposto. Onze clientes InnerTube diferentes foram testados
a partir da VPS e todos receberam o mesmo desafio. O **mesmo binário, no mesmo
vídeo, no mesmo minuto**, a partir de uma conexão residencial, resolveu sem
reclamar.

O que separa os dois casos é o IP. Este agente existe para que a extração
aconteça de um endereço residencial.

## O que ele NÃO faz

Ele não é um servidor de música. A fila, as playlists, as permissões e a
interface vivem no Stoat. O agente só resolve endereços e entrega áudio.

Também **não repassa áudio pela VPS**: ele fala direto com o LiveKit, que já é
público. A máquina do servidor nunca vê um byte de música — o que importa
quando ela tem 1 GB de RAM.

```
   [ este agente, em casa ]
     │
     ├── controle ──────────▶ Stoat  (fila, comandos, quem pode o quê)
     │                        VPS, sem áudio
     │
     └── áudio ─────────────▶ LiveKit
                              direto, sem passar pela VPS
```

## Estado atual

Honestamente, o que está pronto e o que não está:

| Parte | Estado |
|---|---|
| Verificação das ferramentas na partida | **pronto** |
| Resolver busca ou URL em faixas | **pronto** |
| Produzir fluxo Opus | **pronto** |
| API local de saúde e diagnóstico | **pronto** |
| Batimento para o Stoat | **pronto**, tolera o servidor não ter a rota ainda |
| Publicar no LiveKit | **falta** — depende das rotas no backend |
| Fila e comandos | **falta** — vive no Stoat, não aqui |

O agente é útil desde já: dá para subir, apontar o navegador para a porta dele
e confirmar que a extração funciona na sua rede antes de existir qualquer código
no servidor.

## Subindo no Proxmox

Num container LXC com Docker, ou em qualquer máquina com Docker:

```bash
git clone <este repositorio> musicbox-agent
cd musicbox-agent
cp .env.example .env
# edite o .env: no mínimo AGENTE_SEGREDO e STOAT_URL
docker compose up -d
```

Conferir se subiu:

```bash
curl http://localhost:7700/saude
```

Deve responder algo como:

```json
{
  "ok": true,
  "ferramentas": { "ytdlp": "2026.08.19", "ffmpeg": "4.4.2" },
  "youtube": { "alcancavel": true },
  "stoat": { "registrado": false, "motivo": "rota ainda não existe no servidor" }
}
```

O campo que importa é **`youtube.alcancavel`**. Se vier `false`, o IP desta
máquina também está sendo desafiado, e o agente não resolve nada — melhor
descobrir agora que depois.

### Requisitos do container

- Docker, e nada mais.
- Saída para a internet **sem** proxy corporativo ou VPN de datacenter. Uma VPN
  comercial provavelmente reproduz o mesmo bloqueio da VPS.
- ~200 MB de RAM. Medido: `yt-dlp` e `ffmpeg` juntos deram pico de 56 MB por
  faixa; o resto é folga para o Node e picos.

### Sobre LXC no Proxmox

Se o container for **não-privilegiado**, Docker dentro dele exige
`nesting=1` nas opções do CT. Se preferir evitar isso, uma VM pequena resolve.

## Ajustes

Tudo pelo `.env`. Os que importam:

| Variável | Para quê |
|---|---|
| `AGENTE_SEGREDO` | O mesmo valor configurado no Stoat. É o que prova que o agente é seu |
| `STOAT_URL` | Endereço da sua instância, ex. `https://discord.monga.dev.br` |
| `PORTA` | Porta da API local. Padrão `7700` |
| `ATUALIZAR_YTDLP` | `1` para atualizar o `yt-dlp` a cada partida |

## Manutenção

**O `yt-dlp` quebra periodicamente**, porque o YouTube muda de propósito. A
correção costuma sair em dias. Com `ATUALIZAR_YTDLP=1` o agente busca a versão
nova sempre que reinicia, o que transforma a correção num `docker compose
restart`.

Se o agente parar de resolver, o `/saude` diz se o problema é ferramenta velha
ou bloqueio de rede — são coisas diferentes e o remédio é diferente.

## Uma escolha consciente

Extrair áudio do YouTube por fora do player oficial contraria os termos de uso
deles. Para um grupo fechado o risco prático é baixo, mas é uma escolha, e vale
tê-la feito de olhos abertos em vez de por acidente.
