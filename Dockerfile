# DOCKER-VERSION 1.2.0

FROM ubuntu

RUN apt-get update
RUN apt-get install -y curl uuid uuid-dev vim
RUN apt-get install -y nodejs-legacy
RUN apt-get install -y npm

COPY . /opt/smartdc/vmapi

CMD ["/bin/bash", "/opt/smartdc/vmapi/server.sh"]