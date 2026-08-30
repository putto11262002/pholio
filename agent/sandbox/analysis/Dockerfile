FROM docker.io/cloudflare/sandbox:0.13.0-next.751.1-python@sha256:4a2285eeefb26107a7c909e565560a2562ffb3e7d9f75efec8ce444f0d2b0648

WORKDIR /workspace

COPY sdk /opt/pholio-sdk

RUN python3 -m pip install --no-cache-dir \
  /opt/pholio-sdk \
  numpy \
  pandas \
  scipy \
  statsmodels \
  scikit-learn

# Local container development needs explicit port exposure when services are used.
EXPOSE 3000
