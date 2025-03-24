FROM node:20

WORKDIR /usr/src/app

COPY package*.json ./
COPY src /usr/src/app/src
RUN npm install

EXPOSE 8000
CMD ["node", "/usr/src/app/src/index.js"]
