import WebSocket from 'ws'
import express from 'express'
import axios from 'axios'
import bodyParser from 'body-parser'
import npmlog from 'npmlog'
import morgan from 'morgan'
import Sequelize from 'sequelize'
import dotenv from 'dotenv'

dotenv.config();

const app = express()
const serverKey = process.env.SERVER_KEY || ''
const port = process.env.PORT || 3000
const Key = process.env.ACCESS_KEY
//const allowDomains = JSON.parse(process.env.ALLOW_DOMAINS)
const KnzkLiveNotification = process.env.KNZKLIVE_NOTIFICATION;
const version = "v1";
const wsStorage = {};
const sequelize = new Sequelize('sqlite://apppush.sqlite', {
  logging: npmlog.verbose,
  storage: 'db/apppush.sqlite'
})
let ErrorCount = {};
let SessionState = {};

const connectForUser = (config) => {
  const baseUrl = config.instance_url || config.instanceUrl
    , accessToken = config.access_token || config.accessToken
    , deviceToken = config.device_token || config.deviceToken
    , option = config.option
    , language = config.language
    , acct = config.acct
    , created_at = config.updatedAt ? config.updatedAt.getTime : config.created_at;

  const log = (level, message) => npmlog.log(level, `${acct}`, message)
  const send_option = JSON.parse(option);

  if (typeof wsStorage[`${acct}`] !== 'undefined') {
    log('info', 'Already registered')
    return;
  }

  let heartbeat;
  SessionState[`${acct}`] = null;
  ErrorCount[`${acct}`] = 0;
  log('info', 'New registration')

  const close = () => {
    clearInterval(heartbeat)
    if (SessionState[`${acct}`] !== "reload") disconnectForUser(baseUrl, acct)
  }

  const onMessage = data => {
    /*
    let nowDate = new Date();
    nowDate.setDate(nowDate.getDate() + 7);
    if (created_at > nowDate.getTime()) { //有効期限過ぎた
      disconnectForUser(baseUrl, acct)
      return
    }
    */

    const json = JSON.parse(data)
    const payload = JSON.parse(json.payload)

    if (json.event === 'delete') {
      return
    }

    let text = "", acct_s = (payload['account']['acct'].indexOf("@") === -1 ? payload['account']['acct'] + "@" + baseUrl : payload['account']['acct']).toLowerCase();
    if (!payload.account.display_name) payload.account.display_name = payload.account.username
    if (acct_s === KnzkLiveNotification && json.event === 'update') {
      text = "";
    } else {
      text = payload["account"]["display_name"];
      if (payload["account"]["display_name"] !== payload["account"]["acct"]) {
        text += " (@" + payload["account"]["acct"] + ") ";
      }
    }

    if (!send_option["notification"]["user"][acct_s]) {
      send_option["notification"]["user"][acct_s] = {}
    }

    var notification_mode = "";
    if (json.event === 'notification') {
      log('info', `New notification: ${json.event}`)

      if ((payload.type === "follow" && (send_option["notification"]["all"]["follow"] || send_option["notification"]["user"][acct_s]["follow"])) ||
        (payload.type === "mention" && (send_option["notification"]["all"]["mention"] || send_option["notification"]["user"][acct_s]["mention"])) ||
        (payload.type === "reblog" && (send_option["notification"]["all"]["reblog"] || send_option["notification"]["user"][acct_s]["reblog"])) ||
        (payload.type === "favourite" && (send_option["notification"]["all"]["favourite"] || send_option["notification"]["user"][acct_s]["favourite"])) ||
        send_option["notification"]["user"][acct_s]["all"]) {
        return
      }

      if (language === "ja") {
        text += "が";

        text += payload["type"] === "follow" ? "フォロー" :
          payload["type"] === "mention" ? "メンション" :
            payload["type"] === "reblog" ? "ブースト" :
              payload["type"] === "favourite" ? "お気に入り" : "";
      } else if (language === "en") {
        text += payload["type"] === "follow" ? "followed you" :
          payload["type"] === "mention" ? "mentioned you" :
            payload["type"] === "reblog" ? "boosted your status" :
              payload["type"] === "favourite" ? "favorited your status" : "";
      } else {
        log('info', 'Not found language:' + language)
        return
      }
      notification_mode = payload["type"];
    } else if (json.event === 'update') {
      if (acct_s === KnzkLiveNotification) { //KnzkLive
        if (!payload["reblog"] && payload.content.match(/!kl_start/g)) {
          const live_title = payload.content.split('<br />')[1];
          if (language === "ja") {
            text += "【配信開始】" + live_title;
          } else if (language === "en") {
            text += "[KnzkLive]" + live_title;
          } else {
            log('info', 'Not found language:' + language)
            return
          }
        } else {
          return;
        }
      } else { //キーワード
        if (acct_s === acct ||
          payload["visibility"] === "direct" ||
          send_option["notification"]["user"][acct_s]["all"] ||
          send_option["notification"]["user"][acct_s]["keyword"] ||
          payload["reblog"]) {
          return
        }

        let i = 0, match = "";
        while (send_option["keyword"][i]) {
          if (payload.content.match(new RegExp(send_option["keyword"][i], "g"))) {
            log('info', `New keyword match`)
            match = send_option["keyword"][i]
            break
          }
          i++;
        }

        if (!match) {
          return
        }

        if (language === "ja") {
          text += " が「" + match + "」を発言";
        } else if (language === "en") {
          text += " said \"" + match + "\"";
        } else {
          log('info', 'Not found language:' + language)
          return
        }
      }
      notification_mode = "keyword";
    }

    if (!text) {
      return
    }

    const firebaseMessage = {
      to: deviceToken,
      priority: 'high',
      notification: {
        "title": acct,
        "body": text,
        "icon": "fcm_" + notification_mode,
        "color": "#ffffff"
      }
    };
    log('info', `text: ${text}`);
    axios.post('https://fcm.googleapis.com/fcm/send', JSON.stringify(firebaseMessage), {
      headers: {
        'Authorization': `key=${serverKey}`,
        'Content-Type': 'application/json'
      }
    }).then(response => {
      log('info', `Sent to FCM, status ${response.status}: ${JSON.stringify(response.data)}`);

      if (response.data.failure === 0 && response.data.canonical_ids === 0) {
        return
      }

      response.data.results.forEach(result => {
        if (result.message_id && result.registration_id) {
          Registration.findOne({ where: { instanceUrl: baseUrl, acct: acct } }).then(registration => registration.update({ deviceToken: result.registration_id }))
        } else if (result.error === 'NotRegistered') {
          close()
        }
      })
    }).catch(error => {
      log('error', `Error sending to FCM, status: ${error.response.status}: ${JSON.stringify(error.response.data)}`)
    })
  }

  const onError = error => {
    updateErrorCount(baseUrl, acct);
    log('error', error);
    setTimeout(() => reconnect(), 100000)
  }

  const onClose = code => {
    if (code === 1000) {
      if (SessionState[`${acct}`] === "reload") log('info', 'Restart connection')
      else log('info', 'Remote server closed connection')
      clearInterval(heartbeat)
      close()
      return
    }

    updateErrorCount(baseUrl, acct);
    log('error', `Unexpected close: ${code}`)
    setTimeout(() => reconnect(), 60000)
  }

  const reconnect = () => {
    clearInterval(heartbeat)

    const ws = new WebSocket(`https://${baseUrl}/api/v1/streaming/?access_token=${accessToken}&stream=user`)

    ws.on('open', () => {
      if (ws.readyState != 1) {
        log('error', `Client state is: ${ws.readyState}`)
      } else {
        log('info', 'Connected')
        try {
          heartbeat = setInterval(() => ws.ping(), 1000)
        } catch (e) {
          log('error', `Failed to create heartbeat`)
        }
      }
    })

    ws.on('message', onMessage)
    ws.on('error', onError)
    ws.on('close', onClose)

    wsStorage[`${acct}`] = ws;
  }

  reconnect()
}

const disconnectForUser = (baseUrl, acct) => {
  Registration.findOne({ where: { instanceUrl: baseUrl, acct: acct } }).then((registration) => {
    if (registration != null) {
      registration.destroy()
    }
  })

  const ws = wsStorage[`${acct}`]
  updateErrorCount(null, acct, true);

  if (typeof ws !== 'undefined') {
    ws.close()
    delete wsStorage[`${acct}`]
  }
}

async function disconnect(acct) {
  const ws = wsStorage[`${acct}`]
  updateErrorCount(null, acct, true);

  if (typeof ws !== 'undefined') {
    SessionState[`${acct}`] = "reload";
    ws.close()
    delete wsStorage[`${acct}`]
  }
  return;
}

function updateErrorCount(baseUrl, acct, mode) {
  if (!ErrorCount[`${acct}`]) ErrorCount[`${acct}`] = 0;
  ErrorCount[`${acct}`] = mode ? 0 : ErrorCount[`${acct}`] + 1;
  npmlog.log(`info`, `${acct}`, "Update ErrorCount: " + ErrorCount[`${acct}`]);
  if (ErrorCount[`${acct}`] >= 3 && !mode) {
    npmlog.log('error', `${acct}`, `Forcibly delete!!`)
    disconnectForUser(baseUrl, acct)
  }
}

const getUserAcct = (baseUrl, accessToken) => new Promise((resolve, reject) => {
  axios.get(`https://${baseUrl}/api/v1/accounts/verify_credentials`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  }).then(response => {
    if (response.data) {
      if (response.data.acct) {
        resolve((response.data.acct.toLowerCase()) + "@" + baseUrl);
      } else {
        throw response;
      }
    } else {
      throw response;
    }
  }).catch(error => {
    const err = error.response ? error.response : error;
    log('error', `Failed to account information ${baseUrl}:${error.response.status}: ${JSON.stringify(error.response.data)}`)
    resolve(undefined);
  })
});

const Registration = sequelize.define('registration', {
  instanceUrl: {
    type: Sequelize.STRING
  },

  accessToken: {
    type: Sequelize.STRING
  },

  deviceToken: {
    type: Sequelize.STRING
  },

  option: {
    type: Sequelize.STRING
  },

  language: {
    type: Sequelize.STRING
  },

  acct: {
    type: Sequelize.STRING
  },

  updatedAt: {
    type: Sequelize.DATE
  }
}, {
    updatedAt: false
  })

Registration.sync()
  .then(() => Registration.findAll())
  .then(registrations => registrations.forEach(registration => {
    connectForUser(registration)
  }))

app.use(morgan('combined'));
app.use(bodyParser.urlencoded({ extended: true }))

app.get('/', (req, res) => {
  res.sendStatus(204)
})

app.post('/register', (req, res) => {
  if (req.body.language !== "ja" && req.body.language !== "en") {
    res.sendStatus(406)
    return
  }

  if (Key === req.body.server_key && req.body.device_token && req.body.option) {
    getUserAcct(req.body.instance_url, req.body.access_token).then(acct => {
      if (acct) {
        acct = acct.toLowerCase();
        Registration.findOne({ where: { instanceUrl: req.body.instance_url, acct: acct } }).then(bef_data => {
          req.body.acct = acct;
          req.body.created_at = (new Date()).getTime();

          if (bef_data) { //アプデ
            npmlog.log('info', `Update data: ${acct} / ${req.body.app_name}`);
            bef_data.update({ accessToken: req.body.access_token, deviceToken: req.body.device_token, option: req.body.option, language: req.body.language, updatedAt: req.body.created_at });
            disconnect(acct).then(re => {
              setTimeout(function () {
                connectForUser(req.body)
              }, 50);
            });
          } else { //新規
            npmlog.log('info', `New user: ${acct} / ${req.body.app_name}`);
            Registration.findOrCreate({ where: { instanceUrl: req.body.instance_url, accessToken: req.body.access_token, deviceToken: req.body.device_token, option: req.body.option, language: req.body.language, acct: acct, updatedAt: req.body.created_at } })
            connectForUser(req.body);
          }
          res.send({ ok: true });
        });
      } else {
        res.sendStatus(403)
      }
    });
  } else {
    res.sendStatus(403)
  }
})


app.post('/info', (req, res) => {
  let is_auth = Key === req.body.server_key;

  res.header('Content-Type', 'application/json; charset=utf-8')
  Registration.count().then(c => {
    res.send({ users: c, version: version, is_auth: is_auth })
  })
})

app.post('/unregister', (req, res) => {
  getUserAcct(req.body.instance_url, req.body.access_token).then(acct => {
    if (acct) {
      disconnectForUser(req.body.instance_url, acct);
      res.send({ ok: true })
    } else {
      res.sendStatus(404);
    }
  });
})

app.listen(port, () => {
  npmlog.log('info', `Listening on port ${port}`)
})
