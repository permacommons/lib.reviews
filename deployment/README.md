# Deployment

The recommended production deployment uses systemd. Copy
`libreviews.service.sample` into your unit directory (typically
`/etc/systemd/system/`), review the paths and environment overrides to match
your host, then enable and start the service with `systemctl`.

For HTTPS, we use `certbot` configured with auto-renewal timers.
The Node process listens for SIGHUP (`systemctl reload`) and will
reload the HTTPS config. We use DNS-based challenges, so there's
no need to serve anything on port 80 or spin down the server.