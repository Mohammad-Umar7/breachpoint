# The server imports the CLIENT's own weapon definitions and arena data
# (../src/net, ../src/weapons), so the build context has to be the repository
# root, not this folder:
#
#   docker build -f server/Dockerfile -t breachpoint-server .
#
# Fly.io is configured for this already — see fly.toml at the repo root.
FROM node:22-alpine

WORKDIR /app

# Install server dependencies first so this layer caches across code changes.
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev

# Only the two source trees the server actually reads.
COPY server/ ./server/
COPY src/net/ ./src/net/
COPY src/weapons/WeaponDefinitions.js ./src/weapons/WeaponDefinitions.js

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Run as the built-in non-root user rather than root.
USER node

CMD ["node", "server/index.js"]
