FROM oven/bun:1.3.9-alpine
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

# Wealthfolio's database is mounted read-only at /data; Spark's own state, which
# it must write, lives on a separate volume at /state.
ENV SPARK_WF_DB_PATH=/data/wealthfolio.db \
    SPARK_STATE_PATH=/state/spark.db \
    SPARK_PORT=3000

EXPOSE 3000
CMD ["bun", "run", "src/index.ts", "watch"]
