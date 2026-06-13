# all-api

Tiny OpenAI-compatible gateway for local coding agents.

It turns local `codex`, `claude`, OpenClaw, and Hermes endpoints into a small
OpenAI-style `base_url + api_key + model` service.

Implemented surface:

- `GET /v1/models`
- `POST /v1/chat/completions`

## Use

From npm:

```sh
npm install -g @waibiwaibig/all-api
all-api setup
```

From source:

```sh
git clone https://github.com/waibiwaibig/all-api.git
cd all-api
npm install
npm link
all-api setup
```

`setup` asks for the workspace directory, creates an API key, starts the server,
in the background, prints the connection details, and exits:

```text
Base URL:
  http://127.0.0.1:4011/v1

API key:
  sk-allapi-admin-...

Models:
  codex-local
  claude-code
```

Call it:

```sh
curl http://127.0.0.1:4011/v1/chat/completions \
  -H "Authorization: Bearer sk-allapi-admin-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex-local",
    "messages": [{"role": "user", "content": "Reply with exactly: ok"}]
  }'
```

Create another key:

```sh
all-api key create --models claude-code
```

Stop the background server:

```sh
all-api stop
```

## Notes

- No runtime dependencies.
- No Docker or database.
- Each request starts a fresh agent process.
- Stores API key hashes, not raw keys.
- Codex runs with `--sandbox read-only`.
- Claude runs with `--permission-mode plan`.
- Binds to `127.0.0.1` by default.
- `/v1` is the OpenAI API version prefix. Use `http://127.0.0.1:4011/v1`
  for OpenAI-compatible clients; root paths like `/chat/completions` also work.
