FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore \
    MODELS_DIR=/models

# insightface ships a Cython extension that is compiled at install time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

# Models go before dependencies: they are large and rarely change, so editing
# requirements.txt doesn't re-download them. From InsightFace's buffalo_l pack we keep
# only the SCRFD-10GF detector and the ArcFace R50 recognizer.
RUN python -c "import urllib.request, zipfile; \
urllib.request.urlretrieve('https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip', '/tmp/buffalo_l.zip'); \
zipfile.ZipFile('/tmp/buffalo_l.zip').extractall('$MODELS_DIR/models/buffalo_l', members=['det_10g.onnx', 'w600k_r50.onnx'])" \
    && rm /tmp/buffalo_l.zip

WORKDIR /app

# insightface's setup.py imports numpy and Cython, so they must exist before it builds.
# The cache mount keeps downloaded wheels between builds.
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install numpy==1.26.4 Cython==3.3.0 \
    && pip install --no-build-isolation -r requirements.txt

COPY . .

CMD ["python", "scripts/check_env.py"]
