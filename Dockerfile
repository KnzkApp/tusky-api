FROM node:boron

ENV NODE_ENV=production

RUN adduser --disabled-login --gecos 'apppush' apppush

RUN mkdir /apppush
WORKDIR /apppush

ADD package.json /apppush/package.json
ADD yarn.lock /apppush/yarn.lock
RUN yarn

ADD . /apppush
RUN chown -hR apppush:apppush /apppush
USER apppush

EXPOSE 3000
VOLUME ["/apppush/db"]
CMD ["npm", "start"]
