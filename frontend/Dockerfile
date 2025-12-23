FROM node:18-alpine as build

WORKDIR /app

COPY package.json .
RUN npm install

RUN echo "cache bust 3 - Dec 17 2025"

COPY . .
RUN npm run build

FROM node:18-alpine
WORKDIR /app
COPY --from=build /app/build ./build
RUN npm install -g serve

EXPOSE 3000
CMD ["serve", "-s", "build", "-l", "3000"]
