# Pro Engine Companion Protocol

This extension is configured for pro-only stem generation via a local companion app.

## Local Service

- Base URL: `http://127.0.0.1:48231`
- Health endpoint: `GET /v1/health`
- Split endpoint: `POST /v1/stems/split`

## Health Response

`GET /v1/health` should return `200` and JSON like:

```json
{
  "ok": true,
  "engine": "demucs",
  "version": "4.0.0"
}
```

The extension treats any `200` as available.

## Split Request

`POST /v1/stems/split`

Headers:
- `Content-Type: audio/wav`
- `X-Requested-Stems: vocals,drums,bass,other`

Requested stems can also include `instrumental`.
- `instrumental` is a synthetic stem returned by the engine as `drums + bass + other`.
- This is useful for low-latency mode when you only need one non-vocal output track.

Body:
- Raw WAV file bytes (full track)

## Split Response

Return `200` JSON object with `stems` map.

Supported payload formats per stem value:
1. Data URL string, e.g. `"data:audio/wav;base64,..."`
2. Raw base64 string (assumed WAV)
3. Object with explicit fields:

Supported stem keys in response:
- `vocals`, `drums`, `bass`, `other`
- `instrumental` (synthetic mix of drums+bass+other, when requested)

```json
{
  "stems": {
    "vocals": {
      "mimeType": "audio/wav",
      "dataBase64": "..."
    },
    "drums": "data:audio/wav;base64,...",
    "bass": "...",
    "other": "..."
  }
}
```

Each stem should be full-length audio aligned to the input timeline.

## Error Handling

On failure, return non-2xx with plain text or JSON error.
The extension surfaces this directly in the popup stem status.
