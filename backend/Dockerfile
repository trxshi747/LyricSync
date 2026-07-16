FROM node:18-bookworm-slim

# Install ffmpeg, python3, and latest yt-dlp from master to fix SABR streaming issues
RUN apt-get update && \
    apt-get install -y ffmpeg python3 python3-pip && \
    pip3 install -U pip setuptools wheel && \
    pip3 install -U https://github.com/yt-dlp/yt-dlp/archive/master.zip && \
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
