import { google } from 'googleapis'
import { shell } from 'electron'
import http from 'http'
import url from 'url'
import store from './store.js'

// Reused from OAKANIZER — loopback OAuth flow. drive.file scope means the app
// only ever sees files it created itself.
const SCOPES = ['https://www.googleapis.com/auth/drive.file']
const REDIRECT = 'http://localhost:42814/callback'

function createOAuthClient() {
  const clientId = store.get('oauthClientId')
  const clientSecret = store.get('oauthClientSecret')
  if (!clientId || !clientSecret) throw new Error('OAuth credentials not configured')
  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT)
}

export function getAuthClient() {
  const client = createOAuthClient()
  const token = store.get('oauthToken')
  if (token) client.setCredentials(token)
  return client
}

export function isAuthenticated() {
  return !!store.get('oauthToken')
}

// A token on disk is not a working connection: a revoked grant, or one Google
// expired (refresh tokens last seven days while the OAuth consent screen is in
// Testing), still reads as connected until a sync quietly fails with
// invalid_grant. This proves the grant end to end: the access token is dropped
// so Google has to mint a new one, then one cheap Drive call has to succeed.
//
// Resolves to one of:
//   { state: 'off' }                  nothing to check (never connected)
//   { state: 'ok', email }
//   { state: 'reauth', error }        Google refused the sign-in; reconnecting fixes it
//   { state: 'unreachable', error }   no answer (offline, DNS, timeout, Google 5xx)
const CHECK_TIMEOUT_MS = 15000

export async function checkConnection() {
  const token = store.get('oauthToken')
  if (!token) return { state: 'off' }
  if (!token.refresh_token) return { state: 'reauth', error: 'no refresh token was saved' }

  let client
  try { client = createOAuthClient() } catch (e) { return { state: 'reauth', error: e.message } }
  client.setCredentials({ refresh_token: token.refresh_token })
  const drive = google.drive({ version: 'v3', auth: client })

  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Google did not answer in time')), CHECK_TIMEOUT_MS)
  })
  try {
    const res = await Promise.race([drive.about.get({ fields: 'user(emailAddress)' }), timeout])
    return { state: 'ok', email: res.data.user?.emailAddress || '' }
  } catch (err) {
    return classifyAuthError(err)
  } finally {
    clearTimeout(timer)
  }
}

// Google answering 4xx (invalid_grant, invalid_client, a 401/403 from Drive) is a
// sign-in problem that reconnecting fixes. No answer at all, or a 5xx, is not.
function classifyAuthError(err) {
  const status = err.response?.status
  const data = err.response?.data
  // The token endpoint answers { error, error_description }; Drive answers { error: { message } }.
  const reason = typeof data?.error === 'string'
    ? [data.error, data.error_description].filter(Boolean).join(': ')
    : data?.error?.message || err.code || err.message
  return { state: status >= 400 && status < 500 ? 'reauth' : 'unreachable', error: reason }
}

export async function startAuthFlow() {
  const client = createOAuthClient()
  const authUrl = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' })

  return new Promise((resolve, reject) => {
    let settled = false
    const done = (fn, val) => { if (!settled) { settled = true; server.close(); fn(val) } }

    const server = http.createServer(async (req, res) => {
      const parsed = url.parse(req.url, true)
      if (parsed.pathname !== '/callback') return

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body style="font-family:sans-serif;background:#1a120b;color:#e9dccb;display:grid;place-items:center;height:100vh;margin:0"><h2>LatteWrite is connected. You can close this tab.</h2></body></html>')

      const code = parsed.query.code
      if (!code) return done(reject, new Error('No auth code received'))

      try {
        const { tokens } = await client.getToken(code)
        client.setCredentials(tokens)
        store.set('oauthToken', tokens)
        done(resolve, tokens)
      } catch (err) {
        done(reject, err)
      }
    })

    const timeout = setTimeout(() => done(reject, new Error('Auth timed out')), 5 * 60 * 1000)
    server.on('close', () => clearTimeout(timeout))
    server.listen(42814, () => shell.openExternal(authUrl))
    server.on('error', (err) => done(reject, err))
  })
}

export function signOut() {
  store.delete('oauthToken')
}
