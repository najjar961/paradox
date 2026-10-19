FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv
COPY requirements.txt .
RUN pip install -r requirements.txt && useradd --uid 10001 --no-create-home pdx

COPY app ./app
COPY scripts ./scripts

USER pdx
EXPOSE 8000

# No access log: request paths are not recorded anywhere.
CMD ["uvicorn", "--factory", "app.main:create_app", "--host", "0.0.0.0", "--port", "8000", \
     "--no-access-log", "--proxy-headers", "--forwarded-allow-ips", "*"]
