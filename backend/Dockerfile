FROM node:18-bullseye-slim

# Install ffmpeg, python3, and yt-dlp via pip
RUN apt-get update && \
    apt-get install -y ffmpeg python3 python3-pip && \
    pip3 install -U yt-dlp && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application code
COPY . .

# Expose port
EXPOSE 3001

# Start the server
CMD ["node", "server.js"]
