FROM python:3.11-slim

WORKDIR /app
COPY req.txt .
RUN pip install --no-cache-dir -r req.txt

COPY . .
EXPOSE 5000
CMD ["python", "main.py"]