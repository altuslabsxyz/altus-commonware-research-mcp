# Use a lightweight Node.js image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy the rest of the application code
COPY . .

# Build the TypeScript code
RUN npm run build

# Expose the port (Cloud Run sets PORT env var, but this is good documentation)
EXPOSE 3100

# Start the application
CMD ["npm", "start"]
