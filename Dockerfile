# Agente MusicBox
#
# node:22-slim e nao alpine: o yt-dlp autonomo e compilado contra glibc, e no
# alpine (musl) ele nao roda.
FROM node:22-slim

# ffmpeg vem do apt. O yt-dlp vem do binario oficial, que traz o proprio
# Python -- o pacote do apt costuma estar meses atrasado, e com o YouTube
# mudando de proposito, uma versao velha e a causa mais comum de "parou de
# funcionar do nada".
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
       -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json tsconfig.json ./
COPY src ./src

# Sem dependencias de producao: o agente usa so a biblioteca padrao do Node.
# Menos coisa para atualizar, menos superficie, imagem menor.
RUN npm install --omit=dev --no-audit --no-fund 2>/dev/null || true

# O yt-dlp guarda cache em $HOME; sem isso ele reclama rodando como nao-root.
ENV HOME=/tmp
USER node

EXPOSE 7700

# Le a saude pela propria API: responde 503 quando o YouTube desafia o IP,
# entao o container aparece como nao-saudavel exatamente no caso que importa.
HEALTHCHECK --interval=60s --timeout=15s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7700/saude').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "src/main.ts"]
