import { startAuthentication, startRegistration } from '@simplewebauthn/browser'

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let data = {}
  if (text !== '') {
    try {
      data = JSON.parse(text)
    } catch {
      data = { error: text }
    }
  }
  if (!response.ok) throw new Error(data.error ?? `request failed (${response.status})`)
  return data
}

export const api = request

export async function register(username) {
  const options = await request('/api/auth/passkey/register/options', {
    method: 'POST',
    body: { username },
  })
  const response = await startRegistration({ optionsJSON: options })
  return request('/api/auth/passkey/register/verify', {
    method: 'POST',
    body: { username, response },
  })
}

export async function login(username) {
  const options = await request('/api/auth/passkey/login/options', {
    method: 'POST',
    body: { username },
  })
  const response = await startAuthentication({ optionsJSON: options })
  return request('/api/auth/passkey/login/verify', {
    method: 'POST',
    body: { username, response },
  })
}
