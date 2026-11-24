FROM ghcr.io/home-assistant/base-python:3.13-alpine3.24

RUN apk add --no-cache android-tools-adb

WORKDIR /app
COPY server.py index.html style.css app.js mom.webmanifest icon-192.png icon-512.png ./

CMD ["python3", "/app/server.py"]
