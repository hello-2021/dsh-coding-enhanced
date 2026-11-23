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
  return request('/api/auth/register', {
    method: 'POST',
    body: { username },
  })
}

export async function login(username, key) {
  return request('/api/auth/login', {
    method: 'POST',
    body: { username, key },
  })
}
