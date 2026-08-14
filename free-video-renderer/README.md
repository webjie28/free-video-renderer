# Free Video Renderer

An FFmpeg-based HTTP service for combining four video clips with four audio files.

## Endpoints

- `GET /health`
- `POST /render`

`POST /render` accepts a JSON object with a `scenes` array. Each scene needs `video_url`, `audio_url`, and optionally `caption`.

Set `API_KEY` in Render. Requests must include `Authorization: Bearer <API_KEY>`.

The response is an MP4 file. This service uses temporary storage only; upload the response to Google Drive immediately from n8n.
