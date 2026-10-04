# CloudPilot as a container image. Build it from the repository root:
#
#   docker build -t cloudpilot .
#
# The image holds the built command, its production dependencies and kubectl
# (which `cloudpilot kube` needs). It runs as a non-root user and holds no
# credentials: pass them in when you run it. See "Run it in Docker" in
# packages/cli/README.md. In a cluster it reads with the pod's service account:
# see deploy/kube-watch.yaml. It is for scanning, which changes nothing: run
# `cloudpilot apply` from your own machine, with your own aws and kubectl.

ARG NODE_IMAGE=node:22.19.0-alpine3.22

# Build the TypeScript.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY packages/cli/package.json packages/cli/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY packages/cli/tsconfig.json ./
COPY packages/cli/src ./src
RUN npm run build

# Install only what the built command needs at run time.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY packages/cli/package.json packages/cli/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Fetch kubectl and check it against a SHA-256 that is written down here.
# To move to another release, take the checksums from
# https://dl.k8s.io/release/<version>/bin/linux/<arch>/kubectl.sha256
FROM ${NODE_IMAGE} AS kubectl
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.37.1
ARG KUBECTL_SHA256_AMD64=65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8
ARG KUBECTL_SHA256_ARM64=ff749f4b78d9c4f1ec87307df9b50119ed819e2094aa9810cb9acffc3286c8c7
RUN set -eu; \
    case "${TARGETARCH:-}" in \
      amd64) sha="${KUBECTL_SHA256_AMD64}" ;; \
      arm64) sha="${KUBECTL_SHA256_ARM64}" ;; \
      *) echo "Unsupported or unset TARGETARCH '${TARGETARCH:-}': build with BuildKit (docker build or docker buildx build) for linux/amd64 or linux/arm64" >&2; exit 1 ;; \
    esac; \
    wget -q -O /kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl"; \
    echo "${sha}  /kubectl" | sha256sum -c -; \
    chmod 0755 /kubectl

# The image you run.
FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="CloudPilot" \
      org.opencontainers.image.description="Finder of wasted AWS and Kubernetes spend: a scan is read-only" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
WORKDIR /app
# The command reads ../package.json for its version, so keep this layout.
COPY packages/cli/package.json packages/cli/LICENSE ./
# The report embeds two typefaces; their licence texts travel with them.
COPY packages/cli/licenses ./licenses
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=kubectl /kubectl /usr/local/bin/kubectl
RUN chmod 0755 /app/dist/index.js && ln -s /app/dist/index.js /usr/local/bin/cloudpilot
# The command saves its last scan to .cloudpilot/ in the working directory.
RUN mkdir /work && chown node:node /work
USER node
WORKDIR /work
ENTRYPOINT ["cloudpilot"]
CMD ["--help"]
