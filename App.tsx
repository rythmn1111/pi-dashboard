import { useState, useEffect } from 'react'

const C = {
  bg: '#f5f0e8', card: '#fffaf3', border: '#e8d8c0',
  orange: '#c84b00', text: '#2d2013', muted: '#8c6a3f',
  green: '#4caf50', red: '#e57373', amber: '#f59e0b',
}

const s = {
  page: { minHeight: '100vh', backgroundColor: C.bg, fontFamily: "'Segoe UI', sans-serif", padding: '24px 32px', color: C.text } as React.CSSProperties,
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' } as React.CSSProperties,
  title: { fontSize: '26px', fontWeight: '700', color: C.orange, margin: 0 } as React.CSSProperties,
  headerRight: { display: 'flex', alignItems: 'center', gap: '10px' } as React.CSSProperties,
  badge: (color: string) => ({ backgroundColor: color, color: '#fff', borderRadius: '20px', padding: '5px 14px', fontSize: '12px', fontWeight: '700', letterSpacing: '0.05em' } as React.CSSProperties),
  outlineBtn: (color = C.orange) => ({ backgroundColor: 'transparent', color, border: `1.5px solid ${color}`, borderRadius: '10px', padding: '8px 16px', fontSize: '13px', fontWeight: '700', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px' } as React.CSSProperties),
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', alignItems: 'start' } as React.CSSProperties,
  card: { backgroundColor: C.card, border: `1.5px solid ${C.border}`, borderRadius: '16px', padding: '24px', boxShadow: '0 2px 8px rgba(200,75,0,0.06)' } as React.CSSProperties,
  fullCard: { backgroundColor: C.card, border: `1.5px solid ${C.border}`, borderRadius: '16px', padding: '24px', boxShadow: '0 2px 8px rgba(200,75,0,0.06)', gridColumn: '1 / -1' } as React.CSSProperties,
  claimCard: (claimed: boolean) => ({ backgroundColor: C.card, border: `2px solid ${claimed ? C.green : C.amber}`, borderRadius: '16px', padding: '16px 24px', boxShadow: `0 2px 16px ${claimed ? 'rgba(76,175,80,0.15)' : 'rgba(245,158,11,0.15)'}`, gridColumn: '1 / -1' } as React.CSSProperties),
  cardTitle: { fontSize: '11px', fontWeight: '700', textTransform: 'uppercase' as const, letterSpacing: '0.1em', color: C.orange, marginBottom: '16px' },
  bigMono: { fontSize: '32px', fontWeight: '700', fontFamily: 'monospace', letterSpacing: '0.1em', color: C.text } as React.CSSProperties,
  codeBox: { backgroundColor: '#2d2013', color: '#f5c97a', borderRadius: '10px', padding: '12px 18px', fontFamily: 'monospace', fontSize: '22px', fontWeight: '700', letterSpacing: '0.15em', textAlign: 'center' as const, marginBottom: '4px' },
  label: { fontSize: '12px', color: C.muted, marginBottom: '6px' } as React.CSSProperties,
  btn: { backgroundColor: C.orange, color: '#fff', border: 'none', borderRadius: '10px', padding: '10px 20px', fontSize: '14px', fontWeight: '600', cursor: 'pointer', marginRight: '8px', marginTop: '8px' } as React.CSSProperties,
  btnOutline: { backgroundColor: 'transparent', color: C.orange, border: `1.5px solid ${C.orange}`, borderRadius: '10px', padding: '10px 20px', fontSize: '14px', fontWeight: '600', cursor: 'pointer', marginRight: '8px', marginTop: '8px' } as React.CSSProperties,
  btnDanger: { backgroundColor: 'transparent', color: '#c62828', border: '1.5px solid #c62828', borderRadius: '10px', padding: '8px 16px', fontSize: '13px', fontWeight: '700', cursor: 'pointer' } as React.CSSProperties,
  dot: (on: boolean, color?: string) => ({ display: 'inline-block', width: '9px', height: '9px', borderRadius: '50%', backgroundColor: on ? (color || C.green) : C.red, marginRight: '8px', flexShrink: 0 } as React.CSSProperties),
  row: { display: 'flex', alignItems: 'center', marginBottom: '10px', fontSize: '14px' } as React.CSSProperties,
  log: { backgroundColor: '#2d2013', color: '#f5c97a', borderRadius: '10px', padding: '14px', fontFamily: 'monospace', fontSize: '12px', minHeight: '90px', whiteSpace: 'pre-wrap' as const, marginTop: '10px' },
  walletAddr: { fontSize: '11px', fontFamily: 'monospace', color: C.muted, wordBreak: 'break-all' as const, marginTop: '4px' },
}

function Toggle({ enabled, onChange, disabled }: { enabled: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div onClick={() => !disabled && onChange(!enabled)} style={{ width: '44px', height: '24px', borderRadius: '12px', cursor: disabled ? 'not-allowed' : 'pointer', backgroundColor: enabled ? C.green : '#ccc', position: 'relative', transition: 'background 0.2s', flexShrink: 0, opacity: disabled ? 0.5 : 1 }}>
      <div style={{ position: 'absolute', top: '3px', left: enabled ? '23px' : '3px', width: '18px', height: '18px', borderRadius: '50%', backgroundColor: '#fff', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }} />
    </div>
  )
}

interface DeviceStatus { device_id: string; claim_code: string; device_wallet: string; registered: boolean; process_id: string }
interface ClaimStatus { claimed: boolean; owner: string | null; error?: string }
interface GpioStatus { spi: boolean; i2c: boolean; uart: boolean; onewire: boolean; i2s: boolean }
interface Attestation {
  id: string; device_id: string; sensor_type: string; value: string; unit: string;
  code_hash: string; raw_hash: string; data_hash: string; nonce: string;
  hb_timestamp: number; local_timestamp: number; submitted_at: number; verified: boolean;
}

const GPIO_INTERFACES = [
  { key: 'spi',     label: 'SPI',    desc: 'Sensors, displays, SD cards' },
  { key: 'i2c',     label: 'I2C',    desc: 'OLED displays, ATECC608A, sensors' },
  { key: 'uart',    label: 'UART',   desc: 'Serial console, GPS modules' },
  { key: 'onewire', label: '1-Wire', desc: 'DS18B20 temperature sensors' },
  { key: 'i2s',     label: 'I2S',    desc: 'Audio HATs, microphones' },
]

function short(s: string, n = 12) { return s ? `${s.slice(0, n)}...` : '' }

function AttestationRow({ att }: { att: Attestation }) {
  const [open, setOpen] = useState(false)
  const ts = att.submitted_at ? new Date(att.submitted_at).toLocaleTimeString() : '—'
  return (
    <div style={{ borderRadius: '10px', border: `1px solid ${C.border}`, overflow: 'hidden', marginBottom: '8px' }}>
      <div onClick={() => setOpen(!open)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', cursor: 'pointer', backgroundColor: C.bg }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '18px' }}>{att.sensor_type === 'dht22' ? '🌡' : att.sensor_type === 'cpu_temp' ? '🖥' : '📡'}</span>
          <div>
            <div style={{ fontSize: '14px', fontWeight: '700' }}>{att.value}</div>
            <div style={{ fontSize: '11px', color: C.muted }}>{att.sensor_type} · {ts}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ ...s.badge(att.verified ? C.green : C.red), fontSize: '10px' }}>
            {att.verified ? '✓ VERIFIED' : '✗ FAILED'}
          </span>
          <span style={{ color: C.muted, fontSize: '12px' }}>{open ? '▲' : '▼'}</span>
        </div>
      </div>
      {open && (
        <div style={{ padding: '14px 16px', backgroundColor: C.card, borderTop: `1px solid ${C.border}`, fontSize: '11px', fontFamily: 'monospace', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          {[
            ['Attestation ID', short(att.id, 20)],
            ['Nonce', short(att.nonce, 20)],
            ['Code Hash', short(att.code_hash, 20)],
            ['Raw Hash', short(att.raw_hash, 20)],
            ['Data Hash', short(att.data_hash, 20)],
            ['HB Timestamp', att.hb_timestamp ? new Date(att.hb_timestamp).toISOString() : '—'],
            ['Local Time', att.local_timestamp ? new Date(att.local_timestamp).toISOString() : '—'],
            ['Submitted At', att.submitted_at ? new Date(att.submitted_at).toISOString() : '—'],
          ].map(([k, v]) => (
            <div key={k}>
              <div style={{ color: C.muted, marginBottom: '2px' }}>{k}</div>
              <div style={{ color: C.text, wordBreak: 'break-all' }}>{v}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [device, setDevice] = useState<DeviceStatus | null>(null)
  const [claim, setClaim] = useState<ClaimStatus | null>(null)
  const [gpio, setGpio] = useState<GpioStatus | null>(null)
  const [attestations, setAttestations] = useState<Attestation[]>([])
  const [rebootNeeded, setRebootNeeded] = useState(false)
  const [togglingIface, setTogglingIface] = useState<string | null>(null)
  const [log, setLog] = useState('Dashboard ready.')
  const [loading, setLoading] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [deployCode, setDeployCode] = useState('')
  const [deployDesc, setDeployDesc] = useState('')
  const [deploying, setDeploying] = useState(false)
  const [deployResult, setDeployResult] = useState<{ ok: boolean; code_hash?: string; arweave_tx_id?: string; source?: string; message?: string } | null>(null)
  const [sensor, setSensor] = useState<{ running: boolean; log: string; last_run: number | null; code_hash: string } | null>(null)

  const emit = (msg: string) => setLog(prev => `${prev}\n> ${msg}`)

  async function fetchStatus() { try { setDevice(await (await fetch('/api/status')).json()) } catch { emit('Could not reach backend') } }
  async function fetchClaimed() { try { const d = await (await fetch('/api/claimed')).json(); setClaim(d); return d } catch { return null } }
  async function fetchGpio() { try { setGpio(await (await fetch('/api/gpio')).json()) } catch {} }
  async function fetchAttestations() {
    try {
      const data = await (await fetch('/api/attestations')).json()
      if (Array.isArray(data)) setAttestations(data)
    } catch {}
  }

  async function fetchSensorStatus() {
    try { setSensor(await (await fetch('/api/sensor-status')).json()) } catch {}
  }

  async function refresh() {
    setRefreshing(true)
    emit('Refreshing...')
    await Promise.all([fetchStatus(), fetchClaimed(), fetchGpio(), fetchAttestations()])
    emit('✓ Refreshed')
    setRefreshing(false)
  }

  useEffect(() => {
    fetchStatus(); fetchClaimed(); fetchGpio(); fetchAttestations(); fetchSensorStatus()
    const attId = setInterval(fetchAttestations, 15000)
    const sensorId = setInterval(() => {
      fetchSensorStatus().then(() => {
        // Refresh attestations when sensor just finished
        setSensor(prev => {
          if (prev?.running === false) fetchAttestations()
          return prev
        })
      })
    }, 2000)
    return () => { clearInterval(attId); clearInterval(sensorId) }
  }, [])

  async function toggleIface(iface: string, enable: boolean) {
    setTogglingIface(iface)
    emit(`${enable ? 'Enabling' : 'Disabling'} ${iface.toUpperCase()}...`)
    try {
      const data = await (await fetch('/api/gpio/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ iface, enable }) })).json()
      if (data.ok) { setGpio(data.status); setRebootNeeded(true); emit(`✓ ${iface.toUpperCase()} ${enable ? 'enabled' : 'disabled'} — reboot required`) }
      else emit(`✗ Failed to toggle ${iface.toUpperCase()}`)
    } catch { emit('✗ Network error') }
    setTogglingIface(null)
  }

  async function reboot() {
    if (!confirm('Reboot the Pi now?')) return
    emit('Rebooting...')
    await fetch('/api/reboot', { method: 'POST' })
  }

  async function register() {
    if (!device || device.registered) return
    setLoading(true)
    emit('Registering device on HyperBEAM...')
    try {
      const data = await (await fetch('/api/register', { method: 'POST' })).json()
      emit(data.ok ? `✓ ${data.message}` : `✗ ${data.message}`)
      if (data.ok) { await fetchStatus(); await fetchClaimed() }
    } catch { emit('✗ Network error') }
    setLoading(false)
  }

  async function deployCodeToHB() {
    if (!deployCode.trim()) { emit('✗ Paste sensor code first'); return }
    setDeploying(true)
    setDeployResult(null)
    emit('Uploading code to HyperBEAM...')
    try {
      const data = await (await fetch('/api/deploy-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code_content: deployCode, description: deployDesc || 'sensor.py' })
      })).json()
      setDeployResult(data)
      if (data.ok) {
        emit(`✓ Code deployed — hash: ${data.code_hash?.slice(0, 16)}... source: ${data.source}`)
        if (data.arweave_tx_id) emit(`  Arweave TX: ${data.arweave_tx_id}`)
        emit('Sensor started automatically...')
        fetchSensorStatus()
      } else {
        emit(`✗ Deploy failed: ${data.message}`)
      }
    } catch { emit('✗ Network error') }
    setDeploying(false)
  }

  async function stopSensor() {
    await fetch('/api/stop-sensor', { method: 'POST' })
    fetchSensorStatus()
    emit('Sensor stopped.')
  }

  async function reset() {
    if (!confirm('Generate a new device identity? This cannot be undone.')) return
    setResetting(true)
    emit('Generating new device identity...')
    try {
      const data = await (await fetch('/api/reset', { method: 'POST' })).json()
      setDevice(data); setClaim(null); setAttestations([])
      emit(`✓ New device: ID=${data.device_id}`)
    } catch { emit('✗ Network error') }
    setResetting(false)
  }

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={s.title}>rythmn // pi dashboard</h1>
        <div style={s.headerRight}>
          <button style={s.outlineBtn()} onClick={refresh} disabled={refreshing}>↻ {refreshing ? 'Checking...' : 'Refresh'}</button>
          <button style={s.outlineBtn('#c62828')} onClick={reboot}>⏻ Reboot</button>
          <span style={s.badge(C.orange)}>LIVE</span>
        </div>
      </div>

      <div style={s.grid}>

        {/* Claim Status */}
        {device && (
          <div style={s.claimCard(!!claim?.claimed)}>
            <div style={s.cardTitle}>Claim Status</div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '14px' }}>
              <div style={{ width: '48px', height: '48px', borderRadius: '50%', backgroundColor: claim?.claimed ? C.green : (claim === null ? C.border : C.amber), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px', flexShrink: 0, color: '#fff', fontWeight: '700' }}>
                {claim?.claimed ? '✓' : claim === null ? '?' : '○'}
              </div>
              <div>
                <div style={{ fontSize: '20px', fontWeight: '700', color: claim?.claimed ? C.green : C.text }}>
                  {claim === null ? 'Checking...' : claim.claimed ? 'Device Claimed' : 'Unclaimed — waiting for owner'}
                </div>
                {claim?.claimed && claim.owner && <div style={{ fontSize: '12px', fontFamily: 'monospace', color: C.muted, marginTop: '4px' }}>Owner: {claim.owner}</div>}
                {!claim?.claimed && !claim?.error && claim !== null && (
                  <div style={{ fontSize: '13px', color: C.muted, marginTop: '4px' }}>
                    Use ID <strong>{device.device_id}</strong> + Code <strong>{device.claim_code}</strong> in the web app
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Device Identity */}
        <div style={s.card}>
          <div style={s.cardTitle}>Device Identity</div>
          {device ? <>
            <div style={s.label}>Device ID</div>
            <div style={s.bigMono}>{device.device_id}</div>
            <div style={{ ...s.label, marginTop: '16px' }}>Claim Code</div>
            <div style={s.codeBox}>{device.claim_code}</div>
            <div style={{ fontSize: '11px', color: C.muted, textAlign: 'center', marginBottom: '16px' }}>Enter this in the web app to claim device</div>
            <div style={s.label}>Wallet</div>
            <div style={s.walletAddr}>{device.device_wallet}</div>
            <div style={{ marginTop: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={s.dot(device.registered)} />
              <span style={{ fontSize: '13px', fontWeight: '600' }}>{device.registered ? 'Registered on HyperBEAM' : 'Not registered yet'}</span>
            </div>
            <div style={{ marginTop: '16px' }}>
              {!device.registered && <button style={s.btn} onClick={register} disabled={loading}>{loading ? 'Registering...' : 'Register on HB'}</button>}
              <button style={s.btnOutline} onClick={reset} disabled={resetting}>{resetting ? 'Resetting...' : '↺ New Device'}</button>
            </div>
          </> : <div style={{ color: C.muted, fontSize: '14px' }}>Connecting...</div>}
        </div>

        {/* System Status */}
        <div style={s.card}>
          <div style={s.cardTitle}>System Status</div>
          <div style={s.row}><span style={s.dot(true)} />Dashboard running</div>
          <div style={s.row}><span style={s.dot(!!device)} />Backend {device ? 'connected' : 'unreachable'}</div>
          <div style={s.row}><span style={s.dot(true)} />WiFi connected</div>
          <div style={s.row}><span style={s.dot(!!device?.registered)} />HyperBEAM registered</div>
          <div style={s.row}><span style={s.dot(!!claim?.claimed)} />Device claimed</div>
          <div style={s.row}><span style={s.dot(attestations.length > 0)} />{attestations.length > 0 ? `${attestations.length} verified attestation${attestations.length > 1 ? 's' : ''}` : 'No attestations yet'}</div>
          {device && <>
            <div style={{ ...s.label, marginTop: '16px' }}>Process ID</div>
            <div style={{ fontSize: '11px', fontFamily: 'monospace', color: C.muted, wordBreak: 'break-all' }}>{device.process_id}</div>
          </>}
        </div>

        {/* Attestation Feed */}
        <div style={s.fullCard}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div style={s.cardTitle}>Attestation Feed</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {attestations.length > 0 && <span style={{ fontSize: '12px', color: C.muted }}>{attestations.length} verified readings</span>}
              <button style={s.outlineBtn()} onClick={fetchAttestations}>↻</button>
            </div>
          </div>
          {attestations.length === 0 ? (
            <div style={{ color: C.muted, fontSize: '14px', textAlign: 'center', padding: '32px' }}>
              <div style={{ fontSize: '32px', marginBottom: '8px' }}>📡</div>
              <div>No verified readings yet.</div>
              <div style={{ fontSize: '12px', marginTop: '8px' }}>
                Run <code style={{ backgroundColor: C.bg, padding: '2px 6px', borderRadius: '4px' }}>python3 ~/dashboard/pi-sensor/sensor.py</code> on the Pi to start attesting.
              </div>
            </div>
          ) : (
            attestations.map(att => <AttestationRow key={att.id} att={att} />)
          )}
        </div>

        {/* GPIO & Interfaces */}
        <div style={s.fullCard}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div style={s.cardTitle}>GPIO & Interfaces</div>
            {rebootNeeded && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '12px', color: C.amber, fontWeight: '600' }}>⚠ Reboot required</span>
                <button style={s.btnDanger} onClick={reboot}>Reboot Now</button>
              </div>
            )}
          </div>
          {gpio ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
              {GPIO_INTERFACES.map(({ key, label, desc }) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.bg, borderRadius: '10px', padding: '12px 16px', border: `1px solid ${C.border}` }}>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: '700', color: C.text }}>{label}</div>
                    <div style={{ fontSize: '11px', color: C.muted, marginTop: '2px' }}>{desc}</div>
                  </div>
                  <Toggle enabled={gpio[key as keyof GpioStatus]} onChange={(v) => toggleIface(key, v)} disabled={togglingIface !== null} />
                </div>
              ))}
            </div>
          ) : <div style={{ color: C.muted, fontSize: '14px' }}>Loading...</div>}
          <div style={{ fontSize: '11px', color: C.muted, marginTop: '14px' }}>Changes take effect after reboot. Enable I2C for ATECC608A and most sensors.</div>
        </div>

        {/* Deploy Sensor Code */}
        <div style={s.fullCard}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div style={s.cardTitle}>Deploy Sensor Code</div>
            {sensor && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={s.badge(sensor.running ? C.green : C.muted)}>
                  {sensor.running ? '● RUNNING' : sensor.last_run ? '◼ DONE' : '◌ IDLE'}
                </span>
                {sensor.running && <button style={s.btnDanger} onClick={stopSensor}>Stop</button>}
              </div>
            )}
          </div>

          {/* Live log — shown when sensor has run */}
          {sensor && sensor.last_run && (
            <div style={{ marginBottom: '20px' }}>
              <div style={{ ...s.label, display: 'flex', alignItems: 'center', gap: '8px' }}>
                Sensor Output
                {sensor.running && <span style={{ fontSize: '10px', color: C.green, fontWeight: '700', animation: 'none' }}>● live</span>}
                {sensor.last_run && <span style={{ fontSize: '11px', color: C.muted }}>last run: {new Date(sensor.last_run).toLocaleTimeString()}</span>}
                {sensor.code_hash && <span style={{ fontSize: '10px', fontFamily: 'monospace', color: C.muted }}>hash: {sensor.code_hash.slice(0, 12)}...</span>}
              </div>
              <div style={{ ...s.log, maxHeight: '220px', overflowY: 'auto' as const }}>{sensor.log || '(waiting for output...)'}</div>
            </div>
          )}

          <div style={{ fontSize: '13px', color: C.muted, marginBottom: '14px' }}>
            Paste sensor.py below. It will be registered on HyperBEAM{' '}
            <span style={{ color: C.text, fontWeight: '600' }}>and start running automatically</span>. Results will appear in the Attestation Feed above.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
            <div>
              <div style={s.label}>Description</div>
              <input
                value={deployDesc}
                onChange={e => setDeployDesc(e.target.value)}
                placeholder="e.g. sensor.py v2"
                style={{ width: '100%', padding: '8px 12px', borderRadius: '8px', border: `1.5px solid ${C.border}`, backgroundColor: C.bg, color: C.text, fontSize: '13px', boxSizing: 'border-box' as const }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              {deployCode && <span style={{ fontSize: '12px', color: C.muted, paddingBottom: '10px' }}>{(new TextEncoder().encode(deployCode).length / 1024).toFixed(1)} KB</span>}
            </div>
          </div>
          <div style={{ marginBottom: '12px' }}>
            <div style={s.label}>Code Content</div>
            <textarea
              value={deployCode}
              onChange={e => setDeployCode(e.target.value)}
              placeholder="Paste sensor.py source code here..."
              rows={10}
              style={{ width: '100%', padding: '12px', borderRadius: '8px', border: `1.5px solid ${C.border}`, backgroundColor: '#2d2013', color: '#f5c97a', fontFamily: 'monospace', fontSize: '12px', resize: 'vertical', boxSizing: 'border-box' as const }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button style={s.btn} onClick={deployCodeToHB} disabled={deploying || !deployCode.trim()}>
              {deploying ? '⏳ Deploying...' : '⬆ Deploy & Run'}
            </button>
            {deploying && <span style={{ fontSize: '13px', color: C.muted }}>Registering on HyperBEAM, then starting sensor...</span>}
          </div>
          {deployResult && !deploying && (
            <div style={{ marginTop: '14px', padding: '12px 16px', borderRadius: '10px', backgroundColor: deployResult.ok ? 'rgba(76,175,80,0.1)' : 'rgba(229,115,115,0.1)', border: `1px solid ${deployResult.ok ? C.green : C.red}` }}>
              {deployResult.ok ? <>
                <div style={{ fontWeight: '700', color: C.green, marginBottom: '6px' }}>✓ Deployed & sensor started</div>
                <div style={{ fontSize: '12px', fontFamily: 'monospace', color: C.text }}>Hash: {deployResult.code_hash?.slice(0, 40)}...</div>
                <div style={{ fontSize: '12px', color: C.muted, marginTop: '4px' }}>
                  {deployResult.source === 'arweave' ? `On Arweave: ${deployResult.arweave_tx_id}` : 'Stored in HB state'}
                </div>
              </> : <div style={{ color: C.red, fontSize: '13px' }}>✗ {deployResult.message}</div>}
            </div>
          )}
        </div>

        {/* Activity Log */}
        <div style={s.fullCard}>
          <div style={s.cardTitle}>Activity Log</div>
          <div style={s.log}>{log}</div>
          <button style={{ ...s.btnOutline, marginTop: '12px' }} onClick={() => setLog('Log cleared.')}>Clear</button>
        </div>

      </div>
    </div>
  )
}
