import os

__version__ = "1.0.0"

# On Windows torch and faiss-cpu may both load libiomp5md.dll (OMP Error #15)
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

# Behind a TLS-intercepting proxy/antivirus, model downloads (Hugging Face) fail certificate checks:
# KWEETO_TRUSTSTORE=1 makes Python trust the operating system's certificate store instead.
if os.getenv("KWEETO_TRUSTSTORE") == "1":
    try:
        import truststore

        truststore.inject_into_ssl()
    except ImportError:  # pragma: no cover
        pass
