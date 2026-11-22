# Serves the single-file Marginalia page for desktop and mobile browsers.
FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY app/src/main/assets/index.html /srv/index.html
