## KnzkApp-Notification
KnzkAppで使用しているプッシュ配信サーバーです。  
[Gargron/tusky-api](https://github.com/Gargron/tusky-api) を元に作成しています。

### tusky-apiからの変更点

- .envファイルで変数を設定
- プッシュ配信に有効期限を設定
- プッシュ配信のフィルタ機能を追加
- `POST /info`により配信サーバーの情報を提供
- 簡易的な認証を追加

### Contact
KnzkApp-Notificationに関するお問い合わせは必ず[y@knzk.me](https://knzk.me/@y)までお願いします。

---

# Tusky API server

This server proxies notification from the Mastodon API to Firebase push notifications for users of the apppush app. The apppush app registers a device with some metadata, and the server connects to the Mastodon streaming API on behalf of the device user.

- `SERVER_KEY`: Firebase server API key
- `PORT`: Port to run the HTTP server on (defaults to 3000)

This server **should run behind HTTPS**.

Docker configuration included for convenience.
