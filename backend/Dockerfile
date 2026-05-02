FROM python:3.10-slim

# Installation des dépendances système pour SUMO
RUN apt-get update && apt-get install -y \
    sumo \
    sumo-tools \
    libxerces-c-dev \
    && rm -rf /var/lib/apt/lists/*

ENV SUMO_HOME=/usr/share/sumo

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# On copie tout le contenu du dossier backend dans /app
COPY . .

EXPOSE 8000

# On lance l'API depuis le dossier src
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]