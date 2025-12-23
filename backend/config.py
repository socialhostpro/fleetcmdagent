import os
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    ENV: str = "production"
    REDIS_URL: str = os.getenv("REDIS_URL", "redis://localhost:6379")
    POSTGRES_URL: str = os.getenv("POSTGRES_URL", "postgresql://user:pass@localhost:5432/db")
    MINIO_URL: str = os.getenv("MINIO_URL", "http://localhost:9000")
    OLLAMA_URL: str = os.getenv("OLLAMA_URL", "http://localhost:11434")
    
    class Config:
        env_file = ".env"

settings = Settings()
