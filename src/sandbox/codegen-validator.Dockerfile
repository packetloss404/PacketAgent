# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim

WORKDIR /opt/packetagent
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

LABEL org.opencontainers.image.title="PacketAgent generated-app validator"
LABEL org.opencontainers.image.description="Trusted TypeScript and Vite toolchain for network-isolated generated-source validation"

# The sandbox driver also forces this numeric identity at runtime. Keeping the
# image default non-root prevents an accidental unhardened launch from gaining
# root solely because the caller omitted --user.
USER 65534:65534
