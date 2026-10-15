# Deployment

The frontend targets Netlify. The compiler runs as a separate Node service so requests have explicit worker memory, concurrency, and time limits.

## 1. Deploy the processor

Use a container host that supports Node 22 and worker threads. The included Dockerfile installs production dependencies only and runs as a non-root user.

```sh
docker build -t veil-processor .
docker run --rm -p 8787:8787 --memory=768m --cpus=2 \
  -e API_TOKEN=YOUR_RANDOM_SERVER_SECRET \
  veil-processor
```

Generate a strong random API token with your secret manager. Store it in the processing host's environment as `API_TOKEN`; never commit it, include it in a URL, or put it in a frontend `VITE_*` variable. Terminate HTTPS at the host or gateway. The health endpoint is `/health`.

Environment:

| Variable | Purpose |
|---|---|
| `API_TOKEN` | Required for `NODE_ENV=production`; bearer token accepted only by the processing service |
| `HOST` | `0.0.0.0` in the container; default local development binding is `127.0.0.1` |
| `PORT` | Default 8787 |
| `RATE_LIMIT_PER_MINUTE` | Default 20; per-process, per authenticated client digest/socket IP |
| `ALLOWED_ORIGINS` | Optional comma-separated browser origins for direct CORS; unnecessary for the same-origin Netlify proxy |

Use one processor instance initially. Before scaling replicas, enforce a shared quota at the gateway or implement a distributed limiter. Configure host memory/CPU limits, access logs, TLS, abuse monitoring, dependency updates, and uptime checks. Avoid request-body capture in host logs. API authentication identifies the proxy; it is not an end-user account system.

## 2. Deploy the frontend

Import this directory as the repository root for a Netlify project. If the repository has a parent directory, set Netlify's base directory to the path containing this `package.json` and `netlify.toml`.

- Build command: `npm run build`
- Publish directory: `dist`
- Functions directory: `netlify/functions`
- Node version: 22

Set these **server-side** Netlify environment variables for the function runtime:

| Variable | Value |
|---|---|
| `PROCESSOR_URL` | HTTPS origin of the deployed processor, such as `https://processor.example.com` |
| `PROCESSOR_TOKEN` | Same secret as the processor's `API_TOKEN` |

Redeploy after setting environment variables. Do not set `VITE_API_BASE` for this topology; the browser uses same-origin `/api` and never receives the token. The Netlify function authenticates upstream requests, hashes client identity for rate limiting, bounds request bodies, disables redirects, imposes an 18-second upstream deadline, and forwards actual compiler responses.

`netlify.toml` also installs a CSP that allows bundled Monaco workers and local assets without external scripts/fonts. If changing the integration or adding a separate frontend API origin, update the CSP and CORS deliberately.

The proxy passes the upstream `ReadableStream` directly into its `Response`, using Netlify response streaming. Netlify documents a 20 MB streamed-response limit; the engine caps output at 16 MiB and the service caps serialized JSON at 18 MiB to stay below that transport ceiling. Large generated scripts need this streaming proxy rather than a buffered response. Verify the deployed function actually streams as configured. [Netlify Functions API reference](https://docs.netlify.com/build/functions/api/#streaming-responses).

## 3. Verify the deployed system

1. Confirm the processor `/health` returns `{"status":"ok",...}`.
2. Open the Netlify workbench and confirm `Compiler connected`.
3. Compile the example with all three profiles. Check the build manifest changes and Maximum reports `register-vm`, `randomized-opcodes`, and `masked-operands`.
4. Copy/download the result and execute it in the actual target environment.
5. Submit a known syntax error and confirm it produces an error rather than a successful unchanged script.
6. Verify authentication rejects direct unauthenticated processor POSTs, rate limiting returns 429, and source is absent from application/platform logs.
7. Run desktop/mobile browser checks. `node scripts/ui-smoke.js` expects the local preview at port 5173; override `UI_URL` for the deployed site.

No Netlify site, domain, processing host, or credentials have been created by this project. No production deployment has been verified.
