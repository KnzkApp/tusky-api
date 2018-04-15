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
const version      = "1.0.0";
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


  const send_option = JSON.parse(option);
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

    let text = "";
    if (!payload.account.display_name) payload.account.display_name = payload.account.username

    if (json.event === 'notification') {
      log('info', `New notification: ${json.event}`)

      if (!send_option["notification"]["user"][payload.acct]) {
        send_option["notification"]["user"][payload.acct] = {}
      }

      if ((payload.type === "follow" && (send_option["notification"]["all"]["follow"] || send_option["notification"]["user"][payload.acct]["follow"])) ||
        (payload.type === "mention" && (send_option["notification"]["all"]["mention"] || send_option["notification"]["user"][payload.acct]["mention"])) ||
        (payload.type === "reblog" && (send_option["notification"]["all"]["reblog"] || send_option["notification"]["user"][payload.acct]["reblog"])) ||
        (payload.type === "favourite" && (send_option["notification"]["all"]["favourite"] || send_option["notification"]["user"][payload.acct]["favourite"])) ||
        send_option["notification"]["user"][payload.acct]["all"]) {
        return
      }

      if (language === "ja") {
        text = payload["account"]["display_name"]+" さん ("+payload["account"]["acct"]+") があなた";
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
        text = payload["account"]["display_name"]+" さん ("+payload["account"]["acct"]+") が["+match+"]を発言しました";
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
      notification : {"title" : acct, "body": text}
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

  option: {
    type: Sequelize.JSON
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

  if (Key === req.body.server_key && req.body.device_token && req.body.option) {
    axios.get('https://'+req.body.instance_url+'/api/v1/accounts/verify_credentials', {
      headers: {
        'Authorization': `Bearer `+req.body.access_token,
        'Content-Type': 'application/json'
      }
    }).then(response => {
      let getdate = date.getTime(), acct = response.data.acct + "@" + req.body.instance_url;
      req.body.option = JSON.parse(req.body.option)

      Registration.findOne({ where: { instanceUrl: req.body.instance_url, accessToken: req.body.access_token }}).then((registration) => {
        if (registration != null) {
          registration.destroy()
        }
        Registration.findOrCreate({ where: { instanceUrl: req.body.instance_url, accessToken: req.body.access_token, deviceToken: req.body.device_token, option: req.body.option, language: req.body.language, created_at: getdate, acct: acct }})
      })

      connectForUser(req.body, getdate, acct)
      res.sendStatus(201)
      npmlog.log('info', `New user: ${req.body.instance_url} / ${req.body.app_name}`)
    }).catch(error => {
      npmlog.log('error', `Error verify_credentials, status: ${error.response.status}: ${JSON.stringify(error.response.data)}`)
      res.sendStatus(500)
    })
  } else {
    res.sendStatus(403)
  }
})


app.post('/info', (req, res) => {
  let is_auth = Key === req.body.server_key;

  res.header('Content-Type', 'application/json; charset=utf-8')
  res.send({users:0,version:version,is_auth:is_auth})
})

app.post('/unregister', (req, res) => {
  disconnectForUser(req.body.instance_url, req.body.access_token)
  res.send({ok:true})
})

app.listen(port, () => {
  npmlog.log('info', `Listening on port ${port}`)
})
