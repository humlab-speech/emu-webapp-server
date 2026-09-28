FROM node:24.15.0-bookworm-slim

WORKDIR /home/node/app
# Runs as the unprivileged `node` user (uid 1000 / gid 1000). The deployment
# quadlet pins this uid to the host repository owner with rootless
# --userns=keep-id:uid=1000,gid=1000, so files this service writes under
# /repositories land owned by that single host identity — shared with
# session-manager, wsrng-server and apache.

# Built from the checked-out source (the build context), not a fresh clone, so
# the image matches the version locked by the deployment. npm ci installs
# exactly what package-lock.json pins. devDependencies (nodemon) are kept for
# dev mode, which runs the image's default CMD with src/ bind-mounted.
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY src ./src

# The app tree stays owned by root: the service can write logs/ but not its own
# code or dependencies.
RUN mkdir logs && chown node:node logs
USER node
CMD ["npm", "run", "dev"]
