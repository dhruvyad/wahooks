FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml .
COPY wahooks_mcp/ wahooks_mcp/

RUN pip install --no-cache-dir .

EXPOSE 8000

CMD ["wahooks-mcp", "--http", "--port", "8000"]
