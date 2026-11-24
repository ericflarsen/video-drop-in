FROM ghcr.io/home-assistant/base-python:3.13-alpine3.24

RUN apk add --no-cache android-tools-adb
# Web Push for Mom's call alerts. Prebuilt wheels only for the crypto pieces.
RUN pip install --no-cache-dir --only-binary=cryptography,cffi pywebpush==2.1.2

WORKDIR /app
COPY server.py index.html style.css app.js sw.js mom.webmanifest icon-192.png icon-512.png ./

CMD ["python3", "/app/server.py"]
