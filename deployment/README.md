# Deployment

The recommended production deployment uses systemd. Copy
`libreviews.service.sample` into your unit directory (typically
`/etc/systemd/system/`), review the paths and environment overrides to match
your host, then enable and start the service with `systemctl`.
