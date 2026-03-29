import AOCore from '@permaweb/ao-core-libs'
import Arweave from 'arweave'
import { TurboFactory } from '@ardrive/turbo-sdk/node'
import { createHash } from 'crypto'
import { spawnSync, spawn } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
let sessionCwd = process.env.HOME || __dir
const STATE_FILE = join(__dir, 'device-state.json')
const PROCESS_ID = readFileSync(join(__dir, 'process-id.txt'), 'utf-8').trim()
const CONFIG_FILE = '/boot/firmware/config.txt'

const HB_URL = 'http://62.146.173.162:8734'
const CU_URL = 'http://62.146.173.162:6363'

const _fetch = globalThis.fetch
globalThis.fetch = (url: any, opts: any = {}) => {
  const h = new Headers(opts.headers || {})
  h.set('connection', 'close')
  return _fetch(url, { ...opts, headers: h })
}

// ── Device State ──────────────────────────────────────────────────────────────

interface DeviceState {
  device_id: string; claim_code: string; device_wallet: string; jwk: any; registered: boolean
}

function generateDeviceId() { return String(Math.floor(100000 + Math.random() * 900000)) }
function generateClaimCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

async function generateDeviceState(): Promise<DeviceState> {
  const arweave = Arweave.init({})
  const jwk = await arweave.wallets.generate()
  const device_wallet = await arweave.wallets.jwkToAddress(jwk)
  const state: DeviceState = { device_id: generateDeviceId(), claim_code: generateClaimCode(), device_wallet, jwk, registered: false }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  return state
}

async function initDeviceState(): Promise<DeviceState> {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
  return generateDeviceState()
}

let deviceState = await initDeviceState()
console.log(`\n Device ID:   ${deviceState.device_id}`)
console.log(`  Registered:  ${deviceState.registered}\n`)

function computeVerification(claim_code: string, device_id: string) {
  return createHash('sha256').update(claim_code + device_id).digest('hex')
}

// ── AO Helpers ────────────────────────────────────────────────────────────────

function getAoCore() {
  return AOCore.init({ jwk: deviceState.jwk, url: HB_URL })
}

async function hbSend(action: string, data: any) {
  const aoCore = getAoCore()
  const res = await aoCore.request({
    method: 'POST',
    path: `/${PROCESS_ID}/schedule`,
    'signing-format': 'ans104',
    'codec-device': 'ans104@1.0',
    Action: action,
    Target: PROCESS_ID,
    data: typeof data === 'string' ? data : JSON.stringify(data),
    'Data-Protocol': 'ao',
    Type: 'Message',
    Variant: 'ao.N.1'
  })
  return res
}

async function cuDryRun(action: string, data: string = '') {
  const res = await fetch(`${CU_URL}/dry-run?process-id=${PROCESS_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Id: 'dryrun', Owner: 'dryrun', Tags: [{ name: 'Action', value: action }], Data: data, Timestamp: Date.now() })
  })
  const { Messages } = await res.json()
  return JSON.parse(Messages?.[0]?.Data ?? '{}')
}

// ── Sensor Process ────────────────────────────────────────────────────────────

let sensorProc: ReturnType<typeof spawn> | null = null
let sensorLog = ''
let sensorRunning = false
let sensorLastRun: number | null = null
let sensorCodeHash = ''
const runningJobs = new Map<string, ReturnType<typeof spawn>>()

function startSensor() {
  if (sensorRunning) return { ok: false, message: 'Sensor already running' }
  const sensorPath = join(__dir, 'pi-sensor/sensor.py')
  if (!existsSync(sensorPath)) return { ok: false, message: 'sensor.py not found' }
  sensorLog = ''
  sensorRunning = true
  sensorLastRun = Date.now()
  sensorProc = spawn('python3', [sensorPath], { cwd: join(__dir, 'pi-sensor') })
  sensorProc.stdout?.on('data', (d: Buffer) => { sensorLog += d.toString() })
  sensorProc.stderr?.on('data', (d: Buffer) => { sensorLog += d.toString() })
  sensorProc.on('close', (code: number) => {
    sensorRunning = false
    sensorProc = null
    sensorLog += `\n[exit code ${code}]`
  })
  return { ok: true, message: 'Sensor started' }
}

// ── Device Registration ───────────────────────────────────────────────────────

async function registerDevice() {
  if (deviceState.registered) return { ok: true, message: 'Already registered' }
  const verification = computeVerification(deviceState.claim_code, deviceState.device_id)
  const res = await hbSend('RegisterDevice', { device_id: deviceState.device_id, verification })
  if (!res.ok) return { ok: false, message: `HB error: ${res.status}` }
  await new Promise(r => setTimeout(r, 3000))
  const result = await cuDryRun('GetDevice', deviceState.device_id)
  if (result.error) return { ok: false, message: result.error }
  deviceState.registered = true
  writeFileSync(STATE_FILE, JSON.stringify(deviceState, null, 2))
  return { ok: true, message: 'Registered on HyperBEAM' }
}

async function checkClaimed(): Promise<{ claimed: boolean; owner: string | null; error?: string }> {
  try {
    const data = await cuDryRun('GetDevice', deviceState.device_id)
    if (data.error) return { claimed: false, owner: null, error: data.error }
    return { claimed: !!data.owner, owner: data.owner ?? null }
  } catch (e: any) {
    return { claimed: false, owner: null, error: e.message }
  }
}

// ── GPIO Control ──────────────────────────────────────────────────────────────

function rcGet(cmd: string): boolean {
  const r = spawnSync('sudo', ['raspi-config', 'nonint', cmd], { encoding: 'utf-8' })
  return r.stdout?.trim() === '0'
}
function rcSet(cmd: string, enable: boolean): boolean {
  const r = spawnSync('sudo', ['raspi-config', 'nonint', cmd, enable ? '0' : '1'], { encoding: 'utf-8' })
  return r.status === 0
}
function i2sEnabled(): boolean {
  try { return readFileSync(CONFIG_FILE, 'utf-8').split('\n').some(l => l.trim() === 'dtparam=i2s=on') }
  catch { return false }
}
function setI2s(enable: boolean): boolean {
  try {
    let config = readFileSync(CONFIG_FILE, 'utf-8')
    config = config.split('\n').filter(l => !l.match(/^\s*dtparam=i2s=/)).join('\n')
    if (enable) config = config.trimEnd() + '\ndtparam=i2s=on\n'
    return spawnSync('sudo', ['tee', CONFIG_FILE], { input: config, encoding: 'utf-8' }).status === 0
  } catch { return false }
}
function getGpioStatus() {
  return { spi: rcGet('get_spi'), i2c: rcGet('get_i2c'), uart: rcGet('get_serial_hw'), onewire: rcGet('get_onewire'), i2s: i2sEnabled() }
}
function toggleGpio(iface: string, enable: boolean): boolean {
  const map: Record<string, string> = { spi: 'do_spi', i2c: 'do_i2c', uart: 'do_serial_hw', onewire: 'do_onewire' }
  if (iface === 'i2s') return setI2s(enable)
  return map[iface] ? rcSet(map[iface], enable) : false
}

// ── Attestation Flow ──────────────────────────────────────────────────────────

async function getChallengeDirect(device_id: string) {
  // 1. Schedule GetChallenge — HB stores the challenge with nonce
  const res = await hbSend('GetChallenge', device_id)
  if (!res.ok) return { error: `HB error: ${res.status}` }
  // 2. Wait for CU to compute
  await new Promise(r => setTimeout(r, 3000))
  // 3. Dry-run GetLatestChallenge to read the stored nonce back
  const result = await cuDryRun('GetLatestChallenge', device_id)
  return result
}

async function submitAttestation(payload: any) {
  // Schedule the attestation message (signed by device wallet)
  const res = await hbSend('SubmitAttestation', payload)
  if (!res.ok) return { ok: false, message: `HB error: ${res.status}` }
  await new Promise(r => setTimeout(r, 4000))
  // Verify it was stored by checking attestations
  const attestations = await cuDryRun('GetAttestations', payload.device_id)
  const list = Array.isArray(attestations) ? attestations : []
  const found = list.find((a: any) => a.device_id === payload.device_id)
  if (found) {
    return { ok: true, attestation_id: found.id, message: 'Attestation verified on HyperBEAM' }
  }
  // Check if it just succeeded without finding in list yet
  return { ok: true, message: 'Attestation submitted' }
}

async function getAttestations() {
  try {
    const result = await cuDryRun('GetAttestations', deviceState.device_id)
    return Array.isArray(result) ? result : []
  } catch { return [] }
}

// ── HTTP Server ────────────────────────────────────────────────────────────────

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

Bun.serve({ idleTimeout: 120,
  port: 3001,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

    // ── Device identity
    if (url.pathname === '/api/status')
      return Response.json({ device_id: deviceState.device_id, claim_code: deviceState.claim_code, device_wallet: deviceState.device_wallet, registered: deviceState.registered, process_id: PROCESS_ID }, { headers: CORS })

    if (url.pathname === '/api/claimed')
      return Response.json(await checkClaimed(), { headers: CORS })

    if (url.pathname === '/api/register' && req.method === 'POST')
      return Response.json(await registerDevice(), { headers: CORS })

    if (url.pathname === '/api/reset' && req.method === 'POST') {
      deviceState = await generateDeviceState()
      return Response.json({ device_id: deviceState.device_id, claim_code: deviceState.claim_code, device_wallet: deviceState.device_wallet, registered: deviceState.registered, process_id: PROCESS_ID }, { headers: CORS })
    }

    // ── GPIO
    if (url.pathname === '/api/gpio')
      return Response.json(getGpioStatus(), { headers: CORS })

    if (url.pathname === '/api/gpio/toggle' && req.method === 'POST') {
      const { iface, enable } = await req.json()
      const ok = toggleGpio(iface, enable)
      return Response.json({ ok, status: getGpioStatus(), reboot_required: true }, { headers: CORS })
    }

    if (url.pathname === '/api/reboot' && req.method === 'POST') {
      spawnSync('sudo', ['reboot'])
      return Response.json({ ok: true }, { headers: CORS })
    }

    // ── Attestation
    if (url.pathname === '/api/challenge') {
      const device_id = url.searchParams.get('device_id') || deviceState.device_id
      const result = await getChallengeDirect(device_id)
      return Response.json(result, { headers: CORS })
    }

    if (url.pathname === '/api/attest' && req.method === 'POST') {
      const payload = await req.json()
      const result = await submitAttestation(payload)
      return Response.json(result, { headers: CORS })
    }

    if (url.pathname === '/api/attestations')
      return Response.json(await getAttestations(), { headers: CORS })

    // Deploy new sensor code: upload to Arweave via x402 (free <100KB) + register on HB
    if (url.pathname === '/api/deploy-code' && req.method === 'POST') {
      try {
        const { code_content, description } = await req.json()
        if (!code_content) return Response.json({ ok: false, message: 'code_content required' }, { headers: CORS })

        const fileSize = Buffer.byteLength(code_content, 'utf-8')
        const code_hash = createHash('sha256').update(code_content).digest('hex')
        let arweave_tx_id = ''

        if (fileSize <= 100_000) {
          try {
            const turbo = TurboFactory.unauthenticated({ token: 'base-usdc' })
            const result = await (turbo as any).uploadRawX402Data({ data: Buffer.from(code_content, 'utf-8') })
            arweave_tx_id = result.id
            console.log(`[deploy-code] ✓ Arweave TX: ${arweave_tx_id}`)
          } catch (e: any) {
            console.log(`[deploy-code] x402 upload failed: ${e.message.slice(0, 80)} — storing in HB state`)
          }
        }

        const res = await hbSend('RegisterCode', { code_hash, code_content, description: description || 'sensor.py', arweave_tx_id })
        if (!res.ok) return Response.json({ ok: false, message: `HB error: ${res.status}` }, { headers: CORS })

        await new Promise(r => setTimeout(r, 3000))
        const codes = await cuDryRun('GetApprovedCode', '')
        const list: any[] = Array.isArray(codes) ? codes : []
        const found = list.find((c: any) => c.code_hash === code_hash)

        if (found) {
          // Write sensor.py directly (we have the content) and auto-start
          const sensorPath = join(__dir, 'pi-sensor/sensor.py')
          writeFileSync(sensorPath, code_content)
          sensorCodeHash = code_hash
          if (sensorRunning && sensorProc) { sensorProc.kill(); sensorRunning = false; sensorProc = null }
          const runResult = startSensor()
          return Response.json({ ok: true, code_hash, arweave_tx_id, source: arweave_tx_id ? 'arweave' : 'hb_state', description: description || 'sensor.py', sensor: runResult }, { headers: CORS })
        }
        return Response.json({ ok: false, message: 'Registered but not yet confirmed on HB' }, { headers: CORS })
      } catch (e: any) {
        return Response.json({ ok: false, message: e.message }, { headers: CORS })
      }
    }

    // Fetch latest approved code from HB state (or Arweave if tx_id present), verify hash, replace sensor.py
    if (url.pathname === '/api/fetch-code' && req.method === 'POST') {
      try {
        const codes = await cuDryRun('GetApprovedCode', '')
        const list: any[] = Array.isArray(codes) ? codes : []
        if (list.length === 0) return Response.json({ ok: false, message: 'No approved code on HB — run deploy-code.ts first' }, { headers: CORS })

        // Most recently registered entry
        const latest = list.sort((a, b) => (b.registered_at || 0) - (a.registered_at || 0))[0]

        let code: string

        if (latest.arweave_tx_id) {
          // Prefer permanent Arweave copy
          console.log(`[fetch-code] Fetching from Arweave: ${latest.arweave_tx_id}`)
          const gwRes = await fetch(`https://arweave.net/${latest.arweave_tx_id}`)
          if (!gwRes.ok) throw new Error(`Arweave gateway error: ${gwRes.status}`)
          code = await gwRes.text()
        } else if (latest.code_content) {
          // Fall back to content stored in HB state
          console.log(`[fetch-code] Fetching code from HB state`)
          code = latest.code_content
        } else {
          return Response.json({ ok: false, message: 'No code content or Arweave TX on record' }, { headers: CORS })
        }

        // Verify hash
        const actual_hash = createHash('sha256').update(code).digest('hex')
        if (actual_hash !== latest.code_hash) {
          return Response.json({ ok: false, message: `Hash mismatch — expected ${latest.code_hash.slice(0,12)}... got ${actual_hash.slice(0,12)}...` }, { headers: CORS })
        }

        const sensorPath = join(__dir, 'pi-sensor/sensor.py')
        writeFileSync(sensorPath, code)
        console.log(`[fetch-code] ✓ sensor.py updated — hash: ${actual_hash.slice(0, 16)}...`)
        return Response.json({ ok: true, code_hash: actual_hash, source: latest.arweave_tx_id ? 'arweave' : 'hb_state', description: latest.description }, { headers: CORS })
      } catch (e: any) {
        return Response.json({ ok: false, message: e.message }, { headers: CORS })
      }
    }

    if (url.pathname === '/api/sensor-status')
      return Response.json({ running: sensorRunning, log: sensorLog, last_run: sensorLastRun, code_hash: sensorCodeHash }, { headers: CORS })

    if (url.pathname === '/api/run-sensor' && req.method === 'POST')
      return Response.json(startSensor(), { headers: CORS })

    if (url.pathname === '/api/stop-sensor' && req.method === 'POST') {
      if (sensorProc) { sensorProc.kill(); sensorRunning = false; sensorProc = null; sensorLog += '\n[stopped by user]' }
      return Response.json({ ok: true }, { headers: CORS })
    }




    // POST /api/attest-batch — batch sensor attestation (TSEL batching from whitepaper)
    if (url.pathname === '/api/attest-batch' && req.method === 'POST') {
      try {
        const body = await req.json()
        const { batch_hash, batch_size, batch_num, sensor, readings } = body
        if (!batch_hash) return Response.json({ ok: false, message: 'batch_hash required' }, { headers: CORS })

        // 1. Get challenge nonce
        const cr = await getChallengeDirect(deviceState.device_id)
        if (cr.error) return Response.json({ ok: false, message: 'Challenge failed: ' + cr.error }, { headers: CORS })

        // 2. Hash the batch payload as the "command_hash" (represents the full batch)
        const batch_payload = JSON.stringify({ batch_hash, batch_size, sensor, batch_num })
        const payload_hash = createHash('sha256').update(batch_payload).digest('hex')

        // 3. Submit attestation with batch_hash as output_hash (binds all N readings)
        const attestRes = await hbSend('RecordCommand', {
          device_id: deviceState.device_id,
          command: `batch:${sensor}:size=${batch_size}:num=${batch_num}`,
          command_hash: payload_hash,
          output: batch_payload,
          output_hash: batch_hash,
          nonce: cr.nonce,
          exit_code: 0,
          local_timestamp: Date.now()
        })
        if (!attestRes.ok) return Response.json({ ok: false, message: 'HB error: ' + attestRes.status }, { headers: CORS })
        await new Promise(r => setTimeout(r, 4000))

        return Response.json({
          ok: true,
          nonce: cr.nonce,
          batch_hash,
          batch_size,
          batch_num,
          sensor,
          payload_hash,
          message: 'Batch attested on HyperBEAM'
        }, { headers: CORS })
      } catch (e: any) {
        return Response.json({ ok: false, message: e.message }, { headers: CORS })
      }
    }

    // GET /api/batch-history — return all batch attestations from terminal history
    if (url.pathname === '/api/batch-history') {
      try {
        const result = await cuDryRun('GetTerminalHistory', deviceState.device_id)
        const list = Array.isArray(result) ? result : []
        const batches = list.filter((item: any) => String(item.command || '').startsWith('batch:'))
        return Response.json(batches, { headers: CORS })
      } catch {
        return Response.json([], { headers: CORS })
      }
    }

    // POST /api/sensor-batch/stream — SSE: run batch_mpu6050.py with live output
    if (url.pathname === '/api/sensor-batch/stream' && req.method === 'POST') {
      const body = await req.json()
      const batchSize = parseInt(body.batch_size) || 10
      const intervalMs = parseInt(body.interval_ms) || 500
      const scriptPath = '/home/rythmn/batch_mpu6050.py'

      const enc = new TextEncoder()
      const { readable, writable } = new TransformStream()
      const writer = writable.getWriter()
      const send = async (data: object) => writer.write(enc.encode('data: ' + JSON.stringify(data) + '\n\n')).catch(() => {})

      const jobId = `batch-${Date.now()}`
      ;(async () => {
        try {
          await send({ type: 'start', job_id: jobId, batch_size: batchSize, sensor: 'mpu6050' })
          const proc = spawn('python3', [scriptPath, String(batchSize), String(intervalMs)], {
            cwd: sessionCwd, env: process.env
          })
          runningJobs.set(jobId, proc)

          let buf = ''
          const flush = async (chunk: string) => {
            buf += chunk
            const lines = buf.split('\n')
            buf = lines.pop() ?? ''
            for (const line of lines) {
              if (!line.trim()) continue
              // Detect batch completion line
              if (line.includes('batch_hash =')) {
                const m = line.match(/batch_hash = ([0-9a-f]+)/)
                if (m) await send({ type: 'batch_hash', hash: m[1] })
              } else if (line.includes('Attested!')) {
                const m = line.match(/nonce=(.+)/)
                await send({ type: 'attested', nonce: m ? m[1] : '' })
              } else if (line.includes('Batch #')) {
                const m = line.match(/Batch #(\d+)/)
                if (m) await send({ type: 'batch_start', batch_num: parseInt(m[1]) })
              } else if (line.match(/^\s+\[\s*\d+\//)) {
                // Individual reading line: [1/10] ax=...
                await send({ type: 'reading', line: line.trim() })
              } else {
                await send({ type: 'log', line: line.trim() })
              }
            }
          }

          proc.stdout?.on('data', async (chunk: Buffer) => { await flush(chunk.toString()) })
          proc.stderr?.on('data', async (chunk: Buffer) => { await send({ type: 'err', line: chunk.toString().trim() }) })
          proc.on('close', async () => {
            runningJobs.delete(jobId)
            await send({ type: 'stopped' })
            await writer.close().catch(() => {})
          })
        } catch (e: any) {
          await send({ type: 'err', line: e.message })
          await writer.close().catch(() => {})
        }
      })()

      return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' } })
    }

    // POST /api/run-py/stream — verified Python execution with live streaming output
    if (url.pathname === '/api/run-py/stream' && req.method === 'POST') {
      const body = await req.json()
      const file = String(body.file || '').trim()
      if (!file) return Response.json({ ok: false, error: 'file required' }, { headers: CORS })
      const jobId = `vpj-${Date.now()}`
      const enc = new TextEncoder()
      const { readable, writable } = new TransformStream()
      const writer = writable.getWriter()
      const send = async (data: object) => writer.write(enc.encode('data: ' + JSON.stringify(data) + '\n\n')).catch(() => {})
      ;(async () => {
        try {
          const fileContent = readFileSync(file, 'utf-8')
          const file_hash = createHash('sha256').update(fileContent).digest('hex')
          await send({ step: 'hash_file', status: 'done', file_hash })
          await send({ step: 'challenge', status: 'pending' })
          const cr = await getChallengeDirect(deviceState.device_id)
          if (cr.error) { await send({ step: 'error', error: 'Challenge failed: ' + cr.error }); await writer.close().catch(() => {}); return }
          await send({ step: 'challenge', status: 'done', nonce: cr.nonce })
          await send({ step: 'execute', status: 'pending' })
          let fullOutput = ''
          const proc = spawn('python3', [file], { cwd: sessionCwd, env: process.env })
          runningJobs.set(jobId, proc)
          await send({ step: 'job_started', job_id: jobId })
          proc.stdout?.on('data', async (chunk: Buffer) => { const text = chunk.toString(); fullOutput += text; await send({ step: 'output', text }) })
          proc.stderr?.on('data', async (chunk: Buffer) => { const text = chunk.toString(); fullOutput += text; await send({ step: 'output', text, is_err: true }) })
          const exit_code = await new Promise<number>((resolve) => { proc.on('close', (code: number | null) => resolve(code ?? -1)) })
          runningJobs.delete(jobId)
          await send({ step: 'execute', status: 'done', exit_code })
          const output_hash = createHash('sha256').update(fullOutput).digest('hex')
          await send({ step: 'hash_out', status: 'done', output_hash })
          await send({ step: 'attest', status: 'pending' })
          const attestRes = await hbSend('RecordCommand', { device_id: deviceState.device_id, command: 'veri_py ' + file, command_hash: file_hash, output: fullOutput, output_hash, nonce: cr.nonce, exit_code, local_timestamp: Date.now() })
          if (!attestRes.ok) { await send({ step: 'attest', status: 'error', error: 'HB error: ' + attestRes.status }) }
          else { await new Promise(r => setTimeout(r, 4000)); await send({ step: 'attest', status: 'done' }) }
          await send({ step: 'complete', file, output: fullOutput, exit_code, file_hash, output_hash, nonce: cr.nonce, verified: attestRes.ok })
        } catch (e: any) { await send({ step: 'error', error: e.message }).catch(() => {}) }
        finally { await writer.close().catch(() => {}) }
      })()
      return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' } })
    }

    // POST /api/run-py/stop — kill a running veri_py job
    if (url.pathname === '/api/run-py/stop' && req.method === 'POST') {
      const { job_id } = await req.json()
      const proc = runningJobs.get(job_id)
      if (proc) { proc.kill('SIGTERM'); runningJobs.delete(job_id); return Response.json({ ok: true }, { headers: CORS }) }
      return Response.json({ ok: false, error: 'job not found' }, { headers: CORS })
    }

    // POST /api/terminal/stream — SSE: hash → challenge → execute → attest
    if (url.pathname === '/api/terminal/stream' && req.method === 'POST') {
      const { command } = await req.json()
      if (!command?.trim()) return Response.json({ ok: false, error: 'command required' }, { headers: CORS })
      const cmd = String(command).trim()
      const enc = new TextEncoder()
      const { readable, writable } = new TransformStream()
      const writer = writable.getWriter()
      const send = async (data: object) => writer.write(enc.encode('data: ' + JSON.stringify(data) + '\n\n')).catch(() => {})
      ;(async () => {
        try {
          const command_hash = createHash('sha256').update(cmd).digest('hex')
          await send({ step: 'hash_cmd', status: 'done', command_hash })
          await send({ step: 'challenge', status: 'pending' })
          const cr = await getChallengeDirect(deviceState.device_id)
          if (cr.error) { await send({ step: 'error', error: 'Challenge failed: ' + cr.error }); await writer.close().catch(()=>{}); return }
          await send({ step: 'challenge', status: 'done', nonce: cr.nonce })
          await send({ step: 'execute', status: 'pending' })
          const wrappedCmd = cmd + '; echo __NEWPWD__:$(pwd)'
          const execResult = spawnSync('bash', ['-c', wrappedCmd], { encoding: 'utf-8', timeout: 30000, cwd: sessionCwd })
          const rawOut = ((execResult.stdout || '') + (execResult.stderr || '')).slice(0, 8000)
          const pwdMatch = rawOut.match(/__NEWPWD__:(.+)/)
          if (pwdMatch) { try { sessionCwd = pwdMatch[1].trim() } catch {} }
          const output = rawOut.replace(/\n?__NEWPWD__:.+/, '')
          const exit_code = execResult.status ?? -1
          await send({ step: 'execute', status: 'done', output, exit_code })
          const output_hash = createHash('sha256').update(output).digest('hex')
          await send({ step: 'hash_out', status: 'done', output_hash })
          await send({ step: 'attest', status: 'pending' })
          const attestRes = await hbSend('RecordCommand', { device_id: deviceState.device_id, command: cmd, command_hash, output, output_hash, nonce: cr.nonce, exit_code, local_timestamp: Date.now() })
          if (!attestRes.ok) { await send({ step: 'attest', status: 'error', error: 'HB error: ' + attestRes.status }) }
          else { await new Promise(r => setTimeout(r, 4000)); await send({ step: 'attest', status: 'done' }) }
          await send({ step: 'complete', command: cmd, output, exit_code, command_hash, output_hash, nonce: cr.nonce, verified: attestRes.ok })
        } catch (e: any) { await send({ step: 'error', error: e.message }).catch(()=>{}) }
        finally { await writer.close().catch(()=>{}) }
      })()
      return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' } })
    }

    if (url.pathname === '/api/terminal' && req.method === 'POST') {
      try {
        const { command } = await req.json()
        if (!command?.trim()) return Response.json({ ok: false, message: 'command required' }, { headers: CORS })
        const cmd = String(command).trim()
        const command_hash = createHash('sha256').update(cmd).digest('hex')

        // 1. Get challenge
        const challengeResult = await getChallengeDirect(deviceState.device_id)
        if (challengeResult.error) return Response.json({ ok: false, message: 'Challenge failed: ' + challengeResult.error }, { headers: CORS })
        const nonce = challengeResult.nonce
        if (!nonce) return Response.json({ ok: false, message: 'No nonce in challenge response' }, { headers: CORS })

        // 2. Execute command
        const wrappedCmd2 = cmd + '; echo __NEWPWD__:$(pwd)'
        const execResult = spawnSync('bash', ['-c', wrappedCmd2], {
          encoding: 'utf-8', timeout: 30000, cwd: sessionCwd
        })
        const rawOut2 = ((execResult.stdout || '') + (execResult.stderr || '')).slice(0, 8000)
        const pwdMatch2 = rawOut2.match(/__NEWPWD__:(.+)/)
        if (pwdMatch2) { try { sessionCwd = pwdMatch2[1].trim() } catch {} }
        const output = rawOut2.replace(/\n?__NEWPWD__:.+/, '')
        const exit_code = execResult.status ?? -1
        const output_hash = createHash('sha256').update(output).digest('hex')

        // 3. Submit terminal attestation
        const attestRes = await hbSend('RecordCommand', {
          device_id: deviceState.device_id,
          command: cmd, command_hash,
          output, output_hash,
          nonce, exit_code,
          local_timestamp: Date.now()
        })
        if (!attestRes.ok) return Response.json({ ok: false, message: 'HB error: ' + attestRes.status }, { headers: CORS })

        await new Promise(r => setTimeout(r, 4000))
        return Response.json({ ok: true, command: cmd, output, exit_code, command_hash, output_hash, nonce, message: 'Attested on HyperBEAM' }, { headers: CORS })
      } catch (e: any) {
        return Response.json({ ok: false, message: e.message }, { headers: CORS })
      }
    }

    if (url.pathname === '/api/terminal-history') {
      try {
        const result = await cuDryRun('GetTerminalHistory', deviceState.device_id)
        const list = Array.isArray(result) ? result : []
        return Response.json(list, { headers: CORS })
      } catch (e: any) {
        return Response.json([], { headers: CORS })
      }
    }
    return new Response('Not found', { status: 404 })
  }
})

console.log('Pi backend running on http://localhost:3001')
