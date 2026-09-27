#!/usr/bin/env node
// MacroSuite 서버 도메인 동기화 — Vercel API 에서 운영 도메인을 읽어 공개 안내 파일(backend.json)에 적는다.
//
// 앱(런처)은 시작할 때 https://raw.githubusercontent.com/endlessGold/macrosuite-installer/main/backend.json 을 읽어
// 서버 주소를 정한다. 그래서 Vercel 에서 도메인을 바꿔도 앱을 다시 만들 필요가 없다. 이 스크립트가 그 파일을 최신으로 둔다.
//
// 하는 일
//   1. Vercel API  GET /v9/projects/<project>/domains  → 운영 도메인 고르기
//      (넘겨주기 전용·브랜치 전용·미인증 도메인은 뺀다. 사용자 도메인이 있으면 그것, 없으면 가장 짧은 *.vercel.app)
//   2. 그 도메인의 /health 가 MacroSuite 서버인지 확인 — 아니면 파일을 바꾸지 않고 실패한다.
//   3. backend.json 이 다르면 고쳐 쓴다(같으면 그대로 — 커밋할 것이 없다).
//   4. (선택) Auth0 관리 API 자격이 있으면 새 도메인의 로그인 복귀 주소 세 개를 Auth0 에 더하고,
//      *.vercel.app 에 있는 우리 경로의 복귀 주소 중 살아 있는 MacroSuite 서버가 아닌 것은 뺀다.
//      Vercel 에서 풀린 *.vercel.app 이름은 남이 가져갈 수 있다 — 그 주소가 복귀 주소로 남아 있으면
//      남이 우리 앱 이름으로 로그인 코드를 받아 갈 수 있다. 로컬 주소(127.0.0.1)·그 밖의 도메인은 건드리지 않는다.
//
// 환경변수
//   VERCEL_TOKEN (필수)            Vercel 계정 토큰
//   VERCEL_TEAM                    팀 slug (기본 dev-golds-projects)
//   VERCEL_PROJECT                 프로젝트 이름 (기본 macrosuite-backend)
//   AUTH0_DOMAIN, AUTH0_CLIENT_ID  Auth0 테넌트와 로그인 앱(데스크톱·웹이 같이 쓰는 앱)
//   AUTH0_MGMT_CLIENT_ID, AUTH0_MGMT_CLIENT_SECRET   Auth0 관리 API 용 M2M 앱(read:clients, update:clients)
//   BACKEND_FILE                   쓸 파일 (기본 ./backend.json)
//
// 토큰·비밀 값은 어디에도 찍지 않는다.

import { readFile, writeFile, appendFile } from 'node:fs/promises'

const env = name => process.env[name]?.trim() || ''
const TEAM = env('VERCEL_TEAM') || 'dev-golds-projects'
const PROJECT = env('VERCEL_PROJECT') || 'macrosuite-backend'
const FILE = env('BACKEND_FILE') || 'backend.json'
const AUTH0_DOMAIN = env('AUTH0_DOMAIN') || 'dev-c0vhgfkcu1w5zewv.us.auth0.com'
const AUTH0_CLIENT_ID = env('AUTH0_CLIENT_ID') || '98fpvWqifMZicda2tZBRCb6BBRdAw1yj'
/** 서버가 Auth0 에 보내는 복귀 주소 — 웹 가입·웹 관리자·데스크톱 로그인 중계. Auth0 는 글자 그대로 비교한다. */
const CALLBACK_PATHS = ['/signup', '/admin', '/v1/auth/desktop-callback']

const lines = []
function report(text) { console.log(text); lines.push(text) }
async function summary() {
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.map(l => `- ${l}`).join('\n') + '\n')
}
function fail(text) { report(`실패: ${text}`); return summary().then(() => process.exit(1)) }

/** 도메인 목록에서 운영 도메인 하나를 고른다. 순수 함수 — 테스트가 직접 부른다. */
export function pickProductionDomain(domains) {
  const usable = (domains ?? []).filter(d => d && typeof d.name === 'string' && !d.redirect && !d.gitBranch && d.verified !== false)
  if (usable.length === 0) return null
  const custom = usable.filter(d => !d.name.endsWith('.vercel.app'))
  const pool = custom.length ? custom : usable
  return [...pool].sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))[0].name.toLowerCase()
}

/**
 * 뺄 복귀 주소 — *.vercel.app 이고 우리 경로(CALLBACK_PATHS)이며 지금 도메인이 아니고, 그 서버가 MacroSuite 로 응답하지 않는 것.
 * isLive(origin) 는 주입한다(테스트). 확인하지 못한 것(네트워크 오류 등)은 "죽음"으로 본다 — 모름을 살아 있음으로 바꾸지 않는다.
 */
export async function staleCallbacks(callbacks, currentOrigin, isLive) {
  const stale = []
  const checked = new Map()
  for (const value of callbacks) {
    let url
    try { url = new URL(value) } catch { continue }
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.vercel.app') || url.origin === currentOrigin) continue
    if (!CALLBACK_PATHS.includes(url.pathname)) continue
    if (!checked.has(url.origin)) checked.set(url.origin, await isLive(url.origin))
    if (!checked.get(url.origin)) stale.push(value)
  }
  return stale
}

async function vercelDomains(token) {
  const url = `https://api.vercel.com/v9/projects/${encodeURIComponent(PROJECT)}/domains?slug=${encodeURIComponent(TEAM)}&limit=100`
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`Vercel API 가 ${response.status} 를 돌려줬습니다(${body?.error?.code ?? '알 수 없음'}). 토큰이 만료됐거나 팀 권한이 없을 수 있습니다.`)
  return body.domains ?? []
}

async function isMacroSuite(origin) {
  try {
    const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(15000) })
    const body = await response.json()
    return response.ok && body?.service === 'macrosuite-github-storage'
  } catch {
    return false
  }
}

async function syncAuth0(origin) {
  const id = env('AUTH0_MGMT_CLIENT_ID'), secret = env('AUTH0_MGMT_CLIENT_SECRET')
  if (!id || !secret) {
    report('Auth0: 관리 API 자격(AUTH0_MGMT_CLIENT_ID/SECRET)이 없어 로그인 복귀 주소는 확인하지 않았습니다.')
    return true
  }
  const tokenResponse = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: id, client_secret: secret, audience: `https://${AUTH0_DOMAIN}/api/v2/` }),
  })
  const tokenBody = await tokenResponse.json().catch(() => ({}))
  if (!tokenResponse.ok || !tokenBody.access_token) { report(`Auth0: 관리 토큰을 받지 못했습니다(${tokenResponse.status}).`); return false }
  const headers = { authorization: `Bearer ${tokenBody.access_token}`, 'content-type': 'application/json' }
  const clientUrl = `https://${AUTH0_DOMAIN}/api/v2/clients/${AUTH0_CLIENT_ID}`
  const current = await fetch(`${clientUrl}?fields=callbacks&include_fields=true`, { headers }).then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status)))).catch(e => ({ error: e.message }))
  if (!Array.isArray(current.callbacks)) { report(`Auth0: 지금 복귀 주소를 읽지 못했습니다(${current.error ?? '모양이 다름'}).`); return false }
  const wanted = CALLBACK_PATHS.map(path => origin + path)
  const missing = wanted.filter(url => !current.callbacks.includes(url))
  const stale = await staleCallbacks(current.callbacks, origin, isMacroSuite)
  if (missing.length === 0 && stale.length === 0) { report('Auth0: 새 도메인의 로그인 복귀 주소가 이미 모두 등록돼 있고, 죽은 주소도 없습니다.'); return true }
  const next = [...current.callbacks.filter(url => !stale.includes(url)), ...missing]
  const patched = await fetch(clientUrl, { method: 'PATCH', headers, body: JSON.stringify({ callbacks: next }) })
  if (!patched.ok) { report(`Auth0: 복귀 주소를 고치지 못했습니다(${patched.status}).`); return false }
  // 들어갔는지 다시 읽어 확인한다 — 성공 응답만 믿지 않는다.
  const after = await fetch(`${clientUrl}?fields=callbacks&include_fields=true`, { headers }).then(r => r.json()).catch(() => ({}))
  const stillMissing = wanted.filter(url => !(after.callbacks ?? []).includes(url))
  const stillStale = stale.filter(url => (after.callbacks ?? []).includes(url))
  if (stillMissing.length || stillStale.length) { report(`Auth0: 고쳤다고 했지만 다시 읽으니 다릅니다(빠짐 ${stillMissing.length}, 남음 ${stillStale.length}).`); return false }
  if (missing.length) report(`Auth0: 로그인 복귀 주소를 더했습니다: ${missing.join(', ')}`)
  if (stale.length) report(`Auth0: 살아 있지 않은 복귀 주소를 뺐습니다: ${stale.join(', ')}`)
  return true
}

async function main() {
  const token = env('VERCEL_TOKEN')
  if (!token) return fail('VERCEL_TOKEN 이 없습니다. 저장소 Settings → Secrets → Actions 에 넣어 주세요.')
  let domains
  try { domains = await vercelDomains(token) } catch (error) { return fail(error.message) }
  const domain = pickProductionDomain(domains)
  if (!domain) return fail(`프로젝트 ${PROJECT} 에 쓸 수 있는 운영 도메인이 없습니다.`)
  const origin = `https://${domain}`
  report(`Vercel 운영 도메인: ${domain}`)
  if (!(await isMacroSuite(origin))) return fail(`${origin}/health 가 MacroSuite 서버로 응답하지 않아 안내 파일을 바꾸지 않았습니다.`)

  const next = { schemaVersion: 1, backendUrl: `${origin}/` }
  let previous = null
  try { previous = JSON.parse(await readFile(FILE, 'utf8')) } catch { /* 처음 */ }
  if (previous?.backendUrl === next.backendUrl && previous?.schemaVersion === next.schemaVersion) report(`안내 파일은 이미 최신입니다: ${next.backendUrl}`)
  else {
    await writeFile(FILE, JSON.stringify(next, null, 2) + '\n')
    report(`안내 파일을 고쳤습니다: ${previous?.backendUrl ?? '(없음)'} → ${next.backendUrl}`)
  }

  const auth0Ok = await syncAuth0(origin)
  await summary()
  if (!auth0Ok) process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('sync-backend-domain.mjs')) await main()
