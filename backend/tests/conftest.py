"""Shared test setup: loaded by pytest before any test module imports the app."""
import os

# FastAPI's TestClient sends "Host: testserver": allow it next to the defaults (the DNS-rebinding guard is tested
# explicitly in test_security.py)
os.environ.setdefault("KWEETO_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1],testserver")
