FROM alpine:3.23
COPY ios-continue-proxy /usr/local/bin/ios-continue-proxy
ENV LISTEN_ADDR=:8091 BACKEND_WS_BASE=ws://monkeycode-ai-backend:8888 BACKEND_ORIGIN=https://code.69574517.xyz
EXPOSE 8091
ENTRYPOINT ["/usr/local/bin/ios-continue-proxy"]
