# Deployment

The recommended production deployment uses systemd. Copy
`libreviews.service.sample` into your unit directory (typically
`/etc/systemd/system/`), review the paths and environment overrides to match
your host, then enable and start the service with `systemctl`.

For HTTPS, we use `certbot` configured with auto-renewal timers.
The Node process listens for SIGHUP (`systemctl reload`) and will
reload the HTTPS config. We use DNS-based challenges, so there's
no need to serve anything on port 80 or spin down the server.

## Production build (compiled server)

In production, run the compiled JavaScript instead of using `tsx`.

Build everything for deployment:

- `npm run build:deploy`

This will:
- Remove any previous `build/` directory
- Compile backend/CLI TypeScript to `build/server` using NodeNext resolution
- Build frontend assets to `build/frontend`
- Copy `locales/` and `views/` into `build/server/bin/`
- Serve frontend assets directly from `build/frontend` (no copy). The server reads the manifest from `build/frontend/.vite`.
- Serve static assets from the repository root `static/` and deleted files from `deleted/` (no copying during build). Ensure the service WorkingDirectory points to the project root.

The systemd unit is configured to execute the compiled entry point:

- ExecStart should point to `node build/server/bin/www.js` (see the sample unit)

Local development remains unchanged and continues to use `tsx` via the existing `start-dev` script.