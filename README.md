# Agente MusicBox

Extrai áudio para o [STOAT](https://github.com/PoBruno) tocar dentro de uma
chamada de voz.

## Por que isto existe

O YouTube recusa requisições vindas do IP da VPS que hospeda o servidor:

```
Sign in to confirm you're not a bot
```

Foram testados onze clientes internos diferentes do YouTube, e todos falham.
Da mesma máquina, no mesmo minuto, uma conexão residencial resolve o mesmo
vídeo sem reclamar. Não é o programa que está errado — é o endereço.

Então a extração sai do servidor e vai para uma máquina em casa. Este agente
é essa máquina.

## Como se encaixa

```
navegador  ──►  servidor STOAT  ──►  agente (em casa)  ──►  YouTube
                      │                    │
                      └────────────────────┴──►  LiveKit  ──►  quem ouve
```

Dois detalhes do desenho valem explicação:

**O agente é sempre quem inicia a conversa.** Ele vive atrás do NAT de uma
casa e não aceita conexões de fora — nada de abrir porta no roteador. Ele fica
pendurado numa requisição ao servidor esperando trabalho, e a resposta chega
no instante em que houver.

**O áudio nunca passa pelo servidor.** Ele vai desta máquina direto para o
LiveKit. A VPS não vê um byte de música, o que é o que torna isso viável numa
máquina de 1 GB.

## Requisitos

- Docker e Docker Compose
- Uma conexão residencial (o ponto todo)
- Alcance à instância do STOAT e ao servidor de voz dela

## Instalação

```bash
git clone https://github.com/PoBruno/stoat-musicbox-agent.git musicbox-agent
cd musicbox-agent
cp .env.example .env
```

Preencha o `.env`:

| Variável | O que é |
|---|---|
| `STOAT_URL` | endereço da API, ex. `https://sua.instancia/api` |
| `AGENTE_SEGREDO` | o mesmo valor de `REVOLT__MUSICBOX__AGENT_SECRET` no servidor |

Depois:

```bash
docker compose up -d --build
curl http://127.0.0.1:7700/saude
```

A resposta diz se este endereço consegue falar com o YouTube:

```json
{
  "ok": true,
  "youtube": { "alcancavel": true, "ms": 2096 },
  "stoat": { "registrado": true }
}
```

`alcancavel: false` significa que este IP também está sendo recusado, e o
agente não vai servir aqui.

## No lado do servidor

```
REVOLT__MUSICBOX__AGENT_SECRET=<mesmo segredo>
REVOLT__MUSICBOX__BOT_USER_ID=<id de uma conta de bot>
```

O bot dá nome e rosto ao MusicBox dentro da chamada, editáveis pelas telas que
o STOAT já tem. Sem ele o agente entra com uma identidade sintética, toca
igual, mas aparece sem avatar.

## Diagnóstico

A API local só escuta em `127.0.0.1` de propósito: um extrator aberto na rede
é um proxy de download para quem quiser.

| Rota | Para quê |
|---|---|
| `GET /saude` | este IP funciona? as ferramentas estão aí? |
| `GET /resolver?q=` | resolve um nome, um vídeo ou uma playlist |
| `GET /medir?q=` | quanto uma faixa custa de CPU e banda nesta máquina |

## Notas de operação

**Rede de anfitrião não é descuido.** Mídia RTC não passa por mapeamento de
porta: o servidor de voz anuncia nos candidatos ICE o endereço onde acha que
está, e em rede em ponte a sinalização conecta enquanto a mídia morre — o que
parece erro de credencial e não é.

**O `yt-dlp` se atualiza na partida.** O YouTube muda de propósito, e versão
velha é a causa mais comum de "parou de funcionar do nada". Para desligar,
`ATUALIZAR_YTDLP=0`.

**Uma faixa por vez, por instância.** A fila e a ordem vivem no servidor; aqui
só se extrai e publica.

## Licença

Mesma do projeto STOAT.
