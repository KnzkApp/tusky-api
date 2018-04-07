import WebSocket from 'ws'
import express from 'express'
import axios from 'axios'
import bodyParser from 'body-parser'
import npmlog from 'npmlog'
import morgan from 'morgan'
import Sequelize from 'sequelize'
import dotenv from 'dotenv'

dotenv.config();

const app         = express()
const serverKey   = process.env.SERVER_KEY || ''
const port        = process.env.PORT || 3000
const Key         = process.env.ACCESS_KEY
const allowDomains = process.env.ALLOW_DOMAINS
const wsStorage = {}
const sequelize = new Sequelize('sqlite://apppush.sqlite', {
  logging: npmlog.verbose,
  storage: 'db/apppush.sqlite'
})

const connectForUser = (config, created_at, acct) => {
  const baseUrl = config.instance_url || config.instanceUrl
    , accessToken = config.access_token || config.accessToken
    , deviceToken = config.device_token || config.deviceToken
    , filter = config.filter_json || config.filter
    , mode = config.mode
    , language = config.language

  let nowDate = new Date();
  nowDate.setDate(nowDate.getDate() + 7);
  if (created_at > nowDate.getTime()) { //有効期限過ぎた
    disconnectForUser(baseUrl, accessToken)
    return
  }


  const send_filter = JSON.parse(filter);
  const log = (level, message) => npmlog.log(level, `${baseUrl}:${deviceToken}`, message)

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

    if (mode === "Notification") {
      log('info', `New notification: ${json.event}`)
      if (json.event !== 'notification') {
        return
      }

      if ((payload.type === "follow" && (send_filter["all"]["follow"] || send_filter["user"][payload.acct]["follow"])) ||
        (payload.type === "mention" && (send_filter["all"]["mention"] || send_filter["user"][payload.acct]["mention"])) ||
        (payload.type === "reblog" && (send_filter["all"]["reblog"] || send_filter["user"][payload.acct]["reblog"])) ||
        (payload.type === "favourite" && (send_filter["all"]["favourite"] || send_filter["user"][payload.acct]["favourite"]))) {
        return
      }

      let text = "";
      if (!payload.account.display_name) payload.account.display_name = payload.account.username

      if (language === "ja") {
        text = "["+acct+"] "+payload["account"]["display_name"]+" さん ("+payload["account"]["acct"]+") があなた";
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
    } else if (mode === "Keyword") {
      log('info', `New keyword match: ${json.event}`)
      if (json.event !== 'update') {
        return
      }

    }

    if (!text) {
      return
    }

    const firebaseMessage = {
      to: deviceToken,
      priority: 'high',
      notification : {"title" : text}
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

    const ws = new WebSocket(`${baseUrl}/api/v1/streaming/?access_token=${accessToken}&stream=user`)

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

  filter: {
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

  if (req.body.mode !== "Notification" && req.body.mode !== "Keyword") {
    res.sendStatus(406)
    return
  }

  const date = new Date();

  if (Key === req.body.server_key && allowDomains[req.body.instance_url] && req.body.device_token && req.body.mode) {
    axios.post('https://'+req.body.instance_url+'/api/v1/accounts/verify_credentials', {}, {
      headers: {
        'Authorization': `Bearer `+req.body.access_token,
        'Content-Type': 'application/json'
      }
    }).then(response => {
      let getdate = date.getTime(), acct = response.acct + "@" + req.body.instance_url;

      Registration.findOne({ where: { instanceUrl: req.body.instance_url, accessToken: req.body.access_token }}).then((registration) => {
        if (registration != null) {
          registration.destroy()
        }
        Registration.findOrCreate({ where: { instanceUrl: req.body.instance_url, accessToken: req.body.access_token, deviceToken: req.body.device_token, filter: req.body.filter_json, language: req.body.language, created_at: getdate, acct: acct, mode: req.body.mode }})
      })

      connectForUser(req.body, getdate, acct)
      res.sendStatus(201)
    }).catch(error => {
      log('error', `Error verify_credentials, status: ${error.response.status}: ${JSON.stringify(error.response.data)}`)
      res.sendStatus(500)
    })
  } else {
    res.sendStatus(403)
  }
})


app.post('/info', (req, res) => {
  if (Key === req.body.server_key) {
    res.header('Content-Type', 'application/json; charset=utf-8')
    res.send({users:0,allow_domains:allowDomains})
  } else {
    res.sendStatus(403)
  }
})

app.post('/unregister', (req, res) => {
  disconnectForUser(req.body.instance_url, req.body.access_token)
  res.sendStatus(201)
})

app.listen(port, () => {
  npmlog.log('info', `Listening on port ${port}`)
})
