# Docker

## 1. Configure environment variables

Copy `.env.example` to `.env` and fill in the required values.

```sh
cp .env.example .env
```

Required values:

- `AUTH_BOOTSTRAP_INVITE_CODE` for the first admin registration
- `JWT_ACCESS_SECRET`
- `AUTH_ENCRYPTION_KEY` as a base64-encoded 32 byte key
- `WEBAUTHN_RP_ID`
- `WEBAUTHN_RP_NAME`
- `WEBAUTHN_ORIGIN`
- `PUSH_VAPID_PUBLIC_KEY`
- `PUSH_VAPID_PRIVATE_KEY`
- `PUSH_VAPID_SUBJECT`

User-specific CIST credentials are stored during `/api/auth/register`; `CIST_USERNAME` and `CIST_PASSWORD` are no longer server-wide settings.

You can generate `AUTH_ENCRYPTION_KEY` with:

```sh
openssl rand -base64 32
```

## 2. Build and start

```sh
docker compose up --build
```

The API listens on `http://localhost:3000`.

## Persistent data

The Compose setup mounts these directories from the host:

- `.auth` for the Playwright login storage state
- `.data` for auth and push notification SQLite databases

They are intentionally excluded from the Docker image.
