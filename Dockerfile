FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
EXPOSE 8080
ENV PORT=8080
RUN chmod +x start.sh
CMD ["./start.sh"]
