FROM node:20-bookworm-slim

# ffmpeg supplies both the renderer and ffprobe, which is used to read each voice-over duration.
# Verify them during the image build so Railway never deploys an image missing either binary.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core && command -v ffmpeg && command -v ffprobe && ffmpeg -version && ffprobe -version && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src

ENV PORT=10000
CMD ["npm", "start"]
