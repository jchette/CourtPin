FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY index.js ./

# Create data directory for state file persistence
RUN mkdir -p /data

# Run as non-root user for security
RUN addgroup -S courtpass && adduser -S courtpass -G courtpass
RUN chown -R courtpass:courtpass /app /data
USER courtpass

# Expose admin portal port
EXPOSE 3000

ENV NODE_ENV=production
ENV STATE_FILE=/data/state.json

CMD ["node", "index.js"]
