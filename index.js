import WebSocket from 'ws'
import express from 'express'
import axios from 'axios'
import bodyParser from 'body-parser'
import npmlog from 'npmlog'
import morgan from 'morgan'
import Sequelize from 'sequelize'
import dotenv from 'dotenv'

dotenv.config();

const app          = express()
const serverKey    = process.env.SERVER_KEY || ''
const port         = process.env.PORT || 3000
const Key          = process.env.ACCESS_KEY
//const allowDomains = JSON.parse(process.env.ALLOW_DOMAINS)
const version      = "v1";
const wsStorage = {}
const sequelize = new Sequelize('sqlite://apppush.sqlite', {
  logging: npmlog.verbose,
  storage: 'db/apppush.sqlite'
})

const connectForUser = (config, created_at, acct) => {
  const baseUrl = config.instance_url || config.instanceUrl
    , accessToken = config.access_token || config.accessToken
    , deviceToken = config.device_token || config.deviceToken
    , option = config.option
    , language = config.language

  let nowDate = new Date();
  nowDate.setDate(nowDate.getDate() + 7);
  if (created_at > nowDate.getTime()) { //有効期限過ぎた
    disconnectForUser(baseUrl, accessToken)
    return
  }

  const log = (level, message) => npmlog.log(level, `${baseUrl}:${acct}`, message)
  const send_option = JSON.parse(option);

  if (typeof wsStorage[`${baseUrl}:${accessToken}`] !== 'undefined') {
    log('info', 'Already registered')
    return
  }

  let heartbeat

  log('info', 'New registration')

  const close = () => {
    clearInterval(heartbeat)
    disconnectForUser(baseUrl, accessToken)
  }

  const onMessage = data => {
    const json = JSON.parse(data)
    const payload = JSON.parse(json.payload)

    if (json.event === 'delete') {
      return
    }

    let text = "", acct_s = (payload['account']['acct'].indexOf("@") === -1 ? payload['account']['acct'] + "@" + config.instance_url : payload['account']['acct']).toLowerCase();
    if (!payload.account.display_name) payload.account.display_name = payload.account.username
    text = payload["account"]["display_name"]+" さん";
    if (payload["account"]["display_name"] !== payload["account"]["acct"]) {
      text += " (@"+payload["account"]["acct"]+")";
    }

    if (!send_option["notification"]["user"][acct_s]) {
      send_option["notification"]["user"][acct_s] = {}
    }

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
        text += " があなた";
        if (payload["type"] === "follow") { //フォロー
          text += "をフォローしました";
        } else if (payload["type"] === "mention") { //メンション
          text += "にメンションしました";
        } else if (payload["type"] === "reblog") { //ブースト
          text += "の投稿をブーストしました";
        } else if (payload["type"] === "favourite") { //お気に入り
          text += "の投稿をお気に入りしました";
        }
      } else {
        log('info', 'Not found language:'+language)
        return
      }
    } else if (json.event === 'update') {
      if (payload["account"]["acct"]+"@"+config.instance_url === acct ||
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
        text += " が「"+match+"」を発言しました";
      } else {
        log('info', 'Not found language:'+language)
        return
      }
    }

    if (!text) {
      return
    }

    const firebaseMessage = {
      to: deviceToken,
      priority: 'high',
      notification : {
        "title" : acct,
        "body": text,
        "icon": "fcm_push_icon",
        "color": "#ffffff",
      }
    }

    axios.post('https://fcm.googleapis.com/fcm/send', JSON.stringify(firebaseMessage), {
      headers: {
        'Authorization': `key=${serverKey}`,
        'Content-Type': 'application/json'
      }
    }).then(response => {
      log('info', `Sent to FCM, status ${response.status}: ${JSON.stringify(response.data)}`)

      if (response.data.failure === 0 && response.data.canonical_ids === 0) {
        return
      }

      response.data.results.forEach(result => {
        if (result.message_id && result.registration_id) {
          Registration.findOne({ where: { instanceUrl: baseUrl, accessToken: accessToken }}).then(registration => registration.update({ deviceToken: result.registration_id }))
        } else if (result.error === 'NotRegistered') {
          close()
        }
      })
    }).catch(error => {
      log('error', `Error sending to FCM, status: ${error.response.status}: ${JSON.stringify(error.response.data)}`)
    })
  }

  const onError = error => {
    log('error', error)
    setTimeout(() => reconnect(), 5000)
  }

  const onClose = code => {
    if (code === 1000) {
      log('info', 'Remote server closed connection')
      clearInterval(heartbeat)
      close()
      return
    }

    log('error', `Unexpected close: ${code}`)
    setTimeout(() => reconnect(), 5000)
  }

  const reconnect = () => {
    clearInterval(heartbeat)

    const ws = new WebSocket(`https://${baseUrl}/api/v1/streaming/?access_token=${accessToken}&stream=user`)

    ws.on('open', () => {
      if (ws.readyState != 1) {
        log('error', `Client state is: ${ws.readyState}`)
      } else {
        log('info', 'Connected')
        heartbeat = setInterval(() => ws.ping(), 1000)
      }
    })

    ws.on('message', onMessage)
    ws.on('error', onError)
    ws.on('close', onClose)

    wsStorage[`${baseUrl}:${accessToken}`] = ws;
  }

  reconnect()
}

const disconnectForUser = (baseUrl, accessToken) => {
  Registration.findOne({ where: { instanceUrl: baseUrl, accessToken: accessToken }}).then((registration) => {
    if (registration != null) {
      registration.destroy()
    }
  })

  const ws = wsStorage[`${baseUrl}:${accessToken}`]

  if (typeof ws !== 'undefined') {
    ws.close()
    delete wsStorage[`${baseUrl}:${accessToken}`]
  }
}

async function deleteData(baseUrl, accessToken) {
  Registration.findOne({ where: { instanceUrl: baseUrl, accessToken: accessToken }}).then((registration) => {
    if (registration != null) {
      registration.destroy()
      const ws = wsStorage[`${baseUrl}:${accessToken}`]
      if (typeof ws !== 'undefined') {
        ws.close()
        delete wsStorage[`${baseUrl}:${accessToken}`]
      }
      return true;
    } else {
      return false;
    }
  })
}

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

  created_at: {
    type: Sequelize.DATE
  },

  acct: {
    type: Sequelize.STRING
  }
})

Registration.sync()
  .then(() => Registration.findAll())
  .then(registrations => registrations.forEach(registration => {
    connectForUser(registration, registration.created_at, registration.acct)
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

  const date = new Date();

  if (Key === req.body.server_key && req.body.device_token && req.body.option && req.body.username) {
    let getdate = date.getTime(), acct = encodeURIComponent(req.body.username)+"@"+req.body.instance_url;

    deleteData(req.body.instance_url, req.body.access_token).then(re => {
      if (re) {
        npmlog.log('info', `Update data: ${req.body.instance_url} / ${req.body.app_name}`)
      }
      setTimeout(function () {
        Registration.findOrCreate({ where: { instanceUrl: req.body.instance_url, accessToken: req.body.access_token, deviceToken: req.body.device_token, option: req.body.option, language: req.body.language, created_at: getdate, acct: acct }})
        connectForUser(req.body, getdate, acct)
        res.send({ok:true})
        npmlog.log('info', `New user: ${req.body.instance_url} / ${req.body.app_name}`)
      }, 50)
    });
  } else {
    res.sendStatus(403)
  }
})


app.post('/info', (req, res) => {
  let is_auth = Key === req.body.server_key;

  res.header('Content-Type', 'application/json; charset=utf-8')
  Registration.count().then(c => {
    res.send({users:c,version:version,is_auth:is_auth})
  })
})

app.post('/unregister', (req, res) => {
  disconnectForUser(req.body.instance_url, req.body.access_token)
  res.send({ok:true})
})

app.listen(port, () => {
  npmlog.log('info', `Listening on port ${port}`)
})
