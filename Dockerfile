# --- Build stage -----------------------------------------------------
# Has Vite, TypeScript, bootstrap, all devDependencies. Discarded after
# this stage - none of it becomes part of the shipped image.
FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts skips lifecycle scripts, notably "prepare": "husky".
# Husky itself IS present in this stage (unlike a --omit=dev install),
# and modern Husky versions detect there's no .git here (excluded via
# .dockerignore anyway) and no-op gracefully rather than erroring - but
# that's relying on Husky's own internal behavior rather than something
# this build controls directly, and this stage has no actual use for
# git-hook setup regardless, so skipping it outright is more robust than
# depending on Husky continuing to self-detect correctly across future
# versions.
RUN npm ci --ignore-scripts

# Broad COPY, since the build needs config/, src/, styles/, public/ and
# index.html together - .dockerignore keeps node_modules, dist, and test
# out of what actually gets sent to the build context.
COPY . .

# Vite bakes VITE_* values into the bundle at build time (index.html uses
# %VITE_SIGNALING_URL%). .env files are gitignored, so they don't exist
# on the CI runner - the default here is what ships. The URL is public,
# so there's no secret to protect. Override with --build-arg if needed;
# an ARG is visible as an environment variable to RUN steps, so no ENV
# line is required.
ARG VITE_SIGNALING_URL=wss://hdws.stampatron.com

# Matches the real build script: tsc --noEmit -p config/tsconfig.build.json
# && vite build --config config/vite.config.ts
RUN npm run build

# --- Runtime stage -----------------------------------------------------
# No Node, no npm, no node_modules at all - nginx never runs any JS, it
# just serves the files Vite already produced. This is the whole payoff
# of doing this as one multi-stage build instead of a separate dist repo.
FROM nginx:1.31-alpine3.24 AS runtime
COPY --from=builder /app/dist /usr/share/nginx/html

