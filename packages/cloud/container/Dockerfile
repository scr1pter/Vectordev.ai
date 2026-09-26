FROM alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0
ARG VECTOR_VERSION
ARG VECTOR_SOURCE_REVISION
ARG VECTOR_SOURCE_URL
LABEL org.opencontainers.image.title="Vector" \
      org.opencontainers.image.version=$VECTOR_VERSION \
      org.opencontainers.image.revision=$VECTOR_SOURCE_REVISION \
      org.opencontainers.image.source=$VECTOR_SOURCE_URL \
      org.opencontainers.image.licenses="LicenseRef-Vector-and-third-party-notices"
RUN apk add --no-cache bash ca-certificates git openssh-client ripgrep libgcc libstdc++ \
    && addgroup -g 10001 vector \
    && adduser -D -u 10001 -G vector vector \
    && mkdir -p /workspace /home/vector/.config /home/vector/.local/share /home/vector/.cache \
    && chown -R 10001:10001 /workspace /home/vector
COPY --chmod=755 vector /usr/local/bin/vector
COPY LICENSE THIRD_PARTY_NOTICES.md DEPENDENCY_NOTICES.md CONTAINER-INFO.json /usr/share/vector/
ENV HOME=/home/vector VECTOR_CLI=1
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/vector"]
CMD ["--help"]
