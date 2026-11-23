FROM ghcr.io/home-assistant/base-python:3.13-alpine3.24

RUN apk add --no-cache android-tools-adb

WORKDIR /app
COPY server.py index.html ./

CMD ["python3", "/app/server.py"]
