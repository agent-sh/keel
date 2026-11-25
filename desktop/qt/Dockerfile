# The image desktop/qt/check.sh builds the Qt WebEngine engine in: a compiler and the
# development files of Qt WebEngine 6.8 or newer, which the machines that edit
# desktop/qt/main.cpp often lack. Debian 13 ships Qt 6.8.
FROM debian:trixie-slim
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      g++ pkg-config qt6-base-dev qt6-webengine-dev qt6-webchannel-dev \
 && rm -rf /var/lib/apt/lists/*
