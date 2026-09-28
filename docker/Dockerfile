FROM node:24.15.0-bookworm-slim

#Nodejs installation
RUN apt-get update && apt-get install -y curl git nano wget procps

WORKDIR /home/node
# Runs as the unprivileged `node` user (uid 1000 / gid 1000). The deployment
# quadlet pins this uid to the host repository owner with rootless
# --userns=keep-id:uid=1000,gid=1000, so files this service writes under
# /repositories land owned by that single host identity — shared with
# session-manager, wsrng-server and apache. Build steps below run as root and the
# app tree is chowned to node before dropping privileges.

RUN git clone https://github.com/humlab-speech/emu-webapp-server
RUN mv emu-webapp-server app
WORKDIR /home/node/app
RUN npm install
RUN mkdir logs

# Hand the whole app tree (node_modules, logs, source) to the runtime user so it
# can write logs/ and any working files once the quadlet drops capabilities.
RUN chown -R node:node /home/node/app
USER node
CMD ["npm", "run", "dev"]
