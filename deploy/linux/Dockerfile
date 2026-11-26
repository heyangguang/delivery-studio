FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    PORT=8080 \
    DELIVERY_STUDIO_DATA_DIR=/var/lib/delivery-studio

COPY bin/delivery-studio /usr/local/bin/delivery-studio
COPY deploy/linux/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod 0755 /usr/local/bin/delivery-studio /usr/local/bin/docker-entrypoint.sh && \
    mkdir -p /var/lib/delivery-studio /opt/delivery-studio/seed

WORKDIR /var/lib/delivery-studio
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
