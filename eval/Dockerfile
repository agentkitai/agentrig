FROM node@sha256:e0d149b4727ac0c20d9774e801e423d7a946a0bffced886f42cfe9cd3c67820a AS worker
RUN npm install --global pnpm@11.25.0
WORKDIR /workspace

FROM worker AS checker
RUN mkdir -p /evaluator/packages/cli && npm install --prefix /evaluator/packages/cli zod@3.25.76 typescript@5.9.3
COPY check.mjs tasks.mjs /evaluator/eval/
COPY fixtures /evaluator/eval/fixtures/
