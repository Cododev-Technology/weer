FROM node:22-alpine

RUN npm install -g pm2

WORKDIR /app

COPY package.json yarn.lock ./
COPY packages/server/package.json ./packages/server/
COPY packages/server-shared/package.json ./packages/server-shared/
COPY packages/web/package.json ./packages/web/
COPY packages/styles/package.json ./packages/styles/
COPY packages/common/package.json ./packages/common/
COPY packages/reusable/package.json ./packages/reusable/

RUN yarn install

# Each COPY+RUN pair is its own cache layer
COPY packages/common/ ./packages/common/
RUN cd packages/common && yarn build

COPY packages/reusable/ ./packages/reusable/
RUN cd packages/reusable && yarn build

COPY packages/web/ ./packages/web/
RUN cd packages/web && npm run build

COPY packages/styles/ ./packages/styles/
RUN cd packages/styles && npm run build

COPY packages/server-shared/ ./packages/server-shared/
COPY packages/server/ ./packages/server/
RUN cd packages/server && yarn build

COPY docker-entrypoint.sh ./


ENTRYPOINT ["./docker-entrypoint.sh"]