FROM node:18

WORKDIR /app

# Install ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy source
COPY . .

EXPOSE 3301

CMD ["npm", "start"]