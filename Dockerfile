ARG NODE_IMAGE=node:26.10.0-bookworm@sha256:2aaae6d91f99fee84cfc92da9b52c22a185752d247746052bbc3f961e44478c6
FROM ${NODE_IMAGE} AS base

ENV NEXT_TELEMETRY_DISABLED=1
ENV CHECKPOINT_DISABLE=1

WORKDIR /usr/app
COPY ./package.json \
     ./package-lock.json \
     ./next.config.mjs \
     ./prisma.config.ts \
     ./tsconfig.json \
     ./reset.d.ts \
     ./tailwind.config.js \
     ./postcss.config.js ./
COPY ./scripts ./scripts
COPY ./prisma ./prisma

# The registry occasionally resets a connection mid-install, which fails the
# whole image build for a reason that has nothing to do with the code. Retry a
# few times before giving up.
RUN for i in 1 2 3 4 5; do \
      npm ci --ignore-scripts --fetch-retries=5 --fetch-timeout=600000 && exit 0; \
      echo "npm ci failed (attempt $i of 5), retrying in 10s..."; \
      sleep 10; \
    done; \
    exit 1

COPY ./src ./src
COPY ./messages ./messages

# Prisma 7 generates the client into ./src/generated/prisma instead of
# node_modules, so this has to run after the source tree is in place.
RUN node node_modules/prisma/build/index.js generate

# This public endpoint is needed to bake the image/CSP allowlist into Next.js.
# Bucket credentials are supplied only at runtime.
ARG S3_UPLOAD_ENDPOINT
COPY scripts/build.env .env
RUN npm run build

# Next.js copies .env into the standalone output, which would ship the mocked
# build values (a database URL pointing at `db`, placeholder S3 and OpenAI
# credentials) inside the image. Real configuration comes from the container
# environment and would win, but a variable the operator *forgot* to set would
# silently resolve to a build placeholder instead of failing. Drop it.
RUN rm -f .next/standalone/.env && \
    npm prune --offline --omit=dev --ignore-scripts --no-audit --no-fund

# Keep the migration CLI and its generated engine from the same reviewed lockfile.
# The pinned Debian image includes OpenSSL, so no live OS-package install is needed.
FROM ${NODE_IMAGE} AS runner

EXPOSE 3000/tcp
WORKDIR /usr/app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV CHECKPOINT_DISABLE=1
# The standalone server binds to localhost by default, which is unreachable
# from outside the container.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# The traced server, plus the two things tracing cannot know about: the static
# assets it serves and the public/ directory.
COPY --from=base /usr/app/.next/standalone ./
COPY --from=base /usr/app/.next/static ./.next/static
COPY ./public ./public

# prisma.config.ts carries the connection URLs that used to live in
# schema.prisma; `prisma migrate deploy` reads it at container start.
COPY --from=base /usr/app/prisma ./prisma
COPY --from=base /usr/app/prisma.config.ts ./
COPY --from=base /usr/app/node_modules ./node_modules
COPY ./scripts ./scripts

ENTRYPOINT ["/bin/bash", "/usr/app/scripts/container-entrypoint.sh"]
