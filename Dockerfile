FROM node:18-slim

WORKDIR /app
COPY package*.json ./

RUN npm install --production

COPY . .
EXPOSE 5000

CMD ["node", "app.js"]

