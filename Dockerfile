# Lightweight image. Only needs Python + Pillow + httpx + fastapi + uvicorn
# plus the project source. The brain (SGLang) is a separate container.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Minimal host tooling needed for the docker CLI download + general hygiene.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Docker CLI binary: needed by brain_watchdog to run
# `docker restart qwen-image-sglang` against the host daemon via the
# socket we mount at /var/run/docker.sock.
RUN set -eux; \
    curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.4.0.tgz -o /tmp/docker.tgz; \
    tar -xzf /tmp/docker.tgz -C /tmp; \
    mv /tmp/docker/docker /usr/local/bin/docker; \
    rm -rf /tmp/docker /tmp/docker.tgz; \
    docker --version

WORKDIR /app

# Runtime deps in one layer to keep the image small.
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Project source.
COPY server.py /app/server.py
COPY static /app/static
COPY brain_watchdog.py /app/brain_watchdog.py
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Where history / presets / thumbs / uploads live. The image does NOT
# pre-create these — they are bind-mounted from the host so the existing
# SQLite DB + image files survive container rebuilds.
ENV STUDIO_DATA_DIR=/data
EXPOSE 8000

# Default brain URL — override at runtime via --env-file or -e.
ENV BRAIN_URL=http://qwen-image-sglang:30010 \
    BRAIN_CONTAINER=qwen-image-sglang

CMD ["/usr/local/bin/docker-entrypoint.sh"]
