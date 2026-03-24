import { useEffect, useMemo, useRef, useState } from 'react'
import { onValue } from 'firebase/database'
import './App.css'
import { getBodyRef, logEvent, setSosButtonValue } from './firebase'

const TELEGRAM_BOT_TOKEN = '8720013737:AAGTpg0-HVY1gIN7g9ESHpzPMn6JVOvIawg'
const TELEGRAM_CHAT_ID = '1142156560'

const LIMITS = {
  hr: { low: 60, high: 100 },
  spo2: { low: 95, medium: 97 },
  temp: { low: 36.0, high: 37.5 },
  systolic: { low: 90, high: 140 },
  diastolic: { low: 60, high: 90 },
}

function parseNumber(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const text = String(value).trim()
  const numeric = Number.parseFloat(text)
  return Number.isFinite(numeric) ? numeric : null
}

function parseBP(value) {
  if (typeof value !== 'string') return { systolic: null, diastolic: null }
  const match = value.match(/(\d+)\s*\/\s*(\d+)/)
  if (!match) return { systolic: null, diastolic: null }
  return {
    systolic: Number.parseInt(match[1], 10),
    diastolic: Number.parseInt(match[2], 10),
  }
}

function formatTime(dateValue) {
  return new Date(dateValue).toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  })
}

function getRangeLabel(value, low, high) {
  if (value === null) return 'Unknown'
  if (value < low) return 'Low'
  if (value > high) return 'High'
  return 'Normal'
}

function getSpO2Label(value) {
  if (value === null) return 'Unknown'
  if (value < LIMITS.spo2.low) return 'Low'
  if (value < LIMITS.spo2.medium) return 'Medium'
  return 'Normal'
}

function stabilizeNumeric(prev, next, threshold) {
  if (next === null) return prev
  if (prev === null) return next
  if (Math.abs(next - prev) < threshold) return prev
  return next
}

function distanceMeters(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY
  const toRad = (deg) => (deg * Math.PI) / 180
  const earthRadius = 6371000
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const sinLat = Math.sin(dLat / 2)
  const sinLng = Math.sin(dLng / 2)
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng
  return 2 * earthRadius * Math.asin(Math.sqrt(h))
}

function getAiSuggestions(metrics) {
  const suggestions = []
  if (metrics.spo2 !== null && metrics.spo2 < LIMITS.spo2.low) {
    suggestions.push('Low SpO2 warning: improve ventilation and seek medical advice immediately.')
  }
  if (metrics.hr !== null && metrics.hr > LIMITS.hr.high) {
    suggestions.push('Abnormal heart rate warning: heart rate is high, reduce physical load and hydrate.')
  }
  if (metrics.hr !== null && metrics.hr < LIMITS.hr.low) {
    suggestions.push('Abnormal heart rate warning: heart rate is low, check symptoms such as dizziness.')
  }
  if (metrics.temp !== null && metrics.temp > LIMITS.temp.high) {
    suggestions.push('Possible fever indication: monitor temperature frequently and consider medical consultation.')
  }
  if (metrics.systolic !== null && metrics.systolic > LIMITS.systolic.high) {
    suggestions.push('High BP alert: avoid stress and salt-heavy food, recheck blood pressure soon.')
  }
  if (metrics.systolic !== null && metrics.systolic < LIMITS.systolic.low) {
    suggestions.push('Low BP alert: increase fluids, rest, and observe weakness or fainting symptoms.')
  }
  if (suggestions.length === 0) {
    suggestions.push('Health status appears stable. Continue hydration, sleep, and regular monitoring.')
  }
  return suggestions
}

function createChartPath(values, width, height) {
  if (values.length < 2) return ''
  const validValues = values.filter((v) => v !== null)
  if (validValues.length < 2) return ''
  const min = Math.min(...validValues)
  const max = Math.max(...validValues)
  const range = max - min || 1

  return values
    .map((point, index) => {
      const x = (index / (values.length - 1)) * width
      const value = point ?? min
      const y = height - ((value - min) / range) * height
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
}

function TinyChart({ data, color, title }) {
  const path = useMemo(() => createChartPath(data, 320, 120), [data])

  return (
    <div className="chart-card" role="img" aria-label={title}>
      <h4>{title}</h4>
      <svg viewBox="0 0 320 120" preserveAspectRatio="none">
        <rect x="0" y="0" width="320" height="120" className="chart-grid" />
        {path ? <path d={path} style={{ stroke: color }} /> : null}
      </svg>
    </div>
  )
}

function statusClass(label) {
  if (label === 'High') return 'status-high'
  if (label === 'Low') return 'status-low'
  if (label === 'Medium') return 'status-medium'
  if (label === 'Normal') return 'status-normal'
  return 'status-unknown'
}

function App() {
  const [metrics, setMetrics] = useState({
    hr: null,
    spo2: null,
    temp: null,
    hum: null,
    fall: 0,
    bpRaw: 'Not available',
    systolic: null,
    diastolic: null,
    button: 0,
    updatedAt: null,
  })
  const [history, setHistory] = useState([])
  const [events, setEvents] = useState([])
  const [alerts, setAlerts] = useState([])
  const [location, setLocation] = useState({ lat: 13.0827, lng: 80.2707, source: 'Default' })
  const [mapError, setMapError] = useState('')
  const [isLocating, setIsLocating] = useState(false)
  const [modalAlert, setModalAlert] = useState(null)

  const previousFallRef = useRef(0)
  const previousButtonRef = useRef(0)
  const cooldownRef = useRef({})
  const stableMetricsRef = useRef({
    hr: null,
    spo2: null,
    temp: null,
    hum: null,
    systolic: null,
    diastolic: null,
  })

  const pushUiAlert = (message, type = 'warning') => {
    const item = {
      id: crypto.randomUUID(),
      message,
      type,
      time: Date.now(),
    }
    setAlerts((prev) => [item, ...prev].slice(0, 8))
  }

  const openAlertModal = (title, message, eventTime) => {
    setModalAlert({ title, message, eventTime })
  }

  const closeAlertModal = () => {
    setModalAlert(null)
  }

  const sendTelegramMessage = async (message) => {
    const endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`
    const params = new URLSearchParams({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
    })

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
        }),
      })

      if (!response.ok) {
        throw new Error('Telegram POST rejected')
      }
      return
    } catch {
      // Fallback to GET (avoids some browser preflight/CORS issues with JSON POST).
      try {
        const response = await fetch(`${endpoint}?${params.toString()}`)
        if (!response.ok) {
          throw new Error('Telegram GET rejected')
        }
        return
      } catch {
        // Last fallback: send request without reading response.
        await fetch(`${endpoint}?${params.toString()}`, { mode: 'no-cors' })
      }
    }
  }

  const sendTelegramLocation = async (lat, lng) => {
    const endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendLocation`
    const params = new URLSearchParams({
      chat_id: TELEGRAM_CHAT_ID,
      latitude: String(lat),
      longitude: String(lng),
    })

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          latitude: lat,
          longitude: lng,
        }),
      })

      if (!response.ok) {
        throw new Error('Telegram location POST rejected')
      }
      return
    } catch {
      try {
        const response = await fetch(`${endpoint}?${params.toString()}`)
        if (!response.ok) {
          throw new Error('Telegram location GET rejected')
        }
        return
      } catch {
        await fetch(`${endpoint}?${params.toString()}`, { mode: 'no-cors' })
      }
    }
  }

  const getLocationText = (loc = location) => {
    if (!loc?.lat || !loc?.lng) return 'Location unavailable'
    return `https://maps.google.com/?q=${loc.lat},${loc.lng}`
  }

  const resolveAlertLocation = () => new Promise((resolve) => {
    if (!navigator.geolocation || !window.isSecureContext) {
      resolve(location)
      return
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const latestLocation = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          source: 'Live GPS',
        }
        setLocation((prev) => (distanceMeters(prev, latestLocation) >= 25 ? latestLocation : prev))
        setMapError('')
        resolve(latestLocation)
      },
      () => {
        resolve(location)
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
    )
  })

  const writeEvent = async (eventType, details, eventLocation = location) => {
    const event = {
      type: eventType,
      details,
      time: Date.now(),
      location: eventLocation,
    }
    await logEvent(event)
    setEvents((prev) => [event, ...prev].slice(0, 25))
  }

  const triggerAlert = async (eventType, message, shouldPopup = false) => {
    const alertLocation = await resolveAlertLocation()
    const eventTime = formatTime(Date.now())
    const telegramMessage = [
      `Body-Strapping Alert: ${eventType}`,
      `Message: ${message}`,
      `Time: ${eventTime}`,
      `Location: ${getLocationText(alertLocation)}`,
    ].join('\n')

    pushUiAlert(`${eventType}: ${message}`, eventType === 'Emergency' ? 'danger' : 'warning')

    if (shouldPopup) {
      openAlertModal(eventType, message, eventTime)
    }

    const [eventResult, messageResult, locationResult] = await Promise.allSettled([
      writeEvent(eventType, message, alertLocation),
      sendTelegramMessage(telegramMessage),
      sendTelegramLocation(alertLocation.lat, alertLocation.lng),
    ])

    if (eventResult.status === 'rejected') {
      pushUiAlert('Failed to write alert event to Firebase.', 'danger')
    }

    if (messageResult.status === 'rejected') {
      try {
        await sendTelegramMessage(telegramMessage)
      } catch {
        pushUiAlert('Failed to send Telegram SOS message.', 'danger')
      }
    }

    if (locationResult.status === 'rejected') {
      pushUiAlert('Telegram location pin failed, but message was attempted.', 'warning')
    }
  }

  const triggerWithCooldown = (key, eventType, message, cooldownMs = 120000, popup = false) => {
    const now = Date.now()
    const previous = cooldownRef.current[key] || 0
    if (now - previous < cooldownMs) return
    cooldownRef.current[key] = now
    triggerAlert(eventType, message, popup)
  }

  const requestCurrentLocation = () => {
    if (!navigator.geolocation) {
      setMapError('Geolocation is not supported in this browser.')
      return
    }

    if (!window.isSecureContext) {
      setMapError('Location needs a secure context. Open this app on https or localhost.')
      return
    }

    setIsLocating(true)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nextLocation = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          source: 'Live GPS',
        }
        setLocation((prev) => (distanceMeters(prev, nextLocation) >= 25 ? nextLocation : prev))
        setMapError('')
        setIsLocating(false)
      },
      (error) => {
        const message =
          error.code === 1
            ? 'Location permission denied. Please allow location in browser site settings.'
            : 'Unable to get current location. Try again in open sky or better network.'
        setMapError(message)
        setIsLocating(false)
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    )
  }

  useEffect(() => {
    requestCurrentLocation()
  }, [])

  useEffect(() => {
    const unsubscribe = onValue(getBodyRef(), (snapshot) => {
      const payload = snapshot.val() || {}
      const bpRaw = payload.BP ?? 'Not available'
      const { systolic, diastolic } = parseBP(bpRaw)
      const stablePrevious = stableMetricsRef.current
      const stableHr = stabilizeNumeric(stablePrevious.hr, parseNumber(payload.HR), 1)
      const stableSpo2 = stabilizeNumeric(stablePrevious.spo2, parseNumber(payload.Spo2), 1)
      const stableTemp = stabilizeNumeric(stablePrevious.temp, parseNumber(payload.Temp), 0.2)
      const stableHum = stabilizeNumeric(stablePrevious.hum, parseNumber(payload.Hum), 1)
      const stableSystolic = stabilizeNumeric(stablePrevious.systolic, systolic, 2)
      const stableDiastolic = stabilizeNumeric(stablePrevious.diastolic, diastolic, 2)

      stableMetricsRef.current = {
        hr: stableHr,
        spo2: stableSpo2,
        temp: stableTemp,
        hum: stableHum,
        systolic: stableSystolic,
        diastolic: stableDiastolic,
      }

      const next = {
        hr: stableHr,
        spo2: stableSpo2,
        temp: stableTemp,
        hum: stableHum,
        fall: parseNumber(payload.Fall) || 0,
        bpRaw: String(bpRaw),
        systolic: stableSystolic,
        diastolic: stableDiastolic,
        button: parseNumber(payload.Button) || 0,
        updatedAt: Date.now(),
      }

      setMetrics(next)

      setHistory((prev) => {
        const point = {
          time: Date.now(),
          hr: next.hr,
          spo2: next.spo2,
          temp: next.temp,
          hum: next.hum,
          systolic: next.systolic,
          diastolic: next.diastolic,
        }
        return [...prev.slice(-59), point]
      })

      if (next.fall === 1 && previousFallRef.current !== 1) {
        triggerAlert('Emergency', 'Human fall detected.', true)
      }
      previousFallRef.current = next.fall

      if (next.button === 1 && previousButtonRef.current !== 1) {
        triggerAlert('Emergency', 'Emergency SOS alert.', true).finally(async () => {
          try {
            await setSosButtonValue(0)
            previousButtonRef.current = 0
          } catch {
            pushUiAlert('Unable to reset Firebase Button to 0 after SOS.', 'danger')
          }
        })
      }
      previousButtonRef.current = next.button

      const hrLabel = getRangeLabel(next.hr, LIMITS.hr.low, LIMITS.hr.high)
      const spo2Label = getSpO2Label(next.spo2)
      const tempLabel = getRangeLabel(next.temp, LIMITS.temp.low, LIMITS.temp.high)
      const bpSys = getRangeLabel(next.systolic, LIMITS.systolic.low, LIMITS.systolic.high)

      if (hrLabel === 'High' || hrLabel === 'Low') {
        triggerWithCooldown('hr', 'Health Warning', `Heart rate is ${hrLabel} (${next.hr ?? 'N/A'} bpm).`)
      }
      if (spo2Label === 'Low') {
        triggerWithCooldown('spo2', 'Health Warning', `SpO2 is low (${next.spo2 ?? 'N/A'}%).`)
      }
      if (tempLabel === 'High' || tempLabel === 'Low') {
        triggerWithCooldown('temp', 'Health Warning', `Temperature is ${tempLabel} (${next.temp ?? 'N/A'} C).`)
      }
      if (bpSys === 'High' || bpSys === 'Low') {
        triggerWithCooldown('bp', 'Health Warning', `Blood pressure trend is ${bpSys} (${next.bpRaw}).`)
      }
    })

    return () => unsubscribe()
  }, [])

  const hrLabel = getRangeLabel(metrics.hr, LIMITS.hr.low, LIMITS.hr.high)
  const spo2Label = getSpO2Label(metrics.spo2)
  const tempLabel = getRangeLabel(metrics.temp, LIMITS.temp.low, LIMITS.temp.high)
  const bpLabel = getRangeLabel(metrics.systolic, LIMITS.systolic.low, LIMITS.systolic.high)

  const suggestions = getAiSuggestions(metrics)

  const chartData = {
    hr: history.map((item) => item.hr),
    spo2: history.map((item) => item.spo2),
    temp: history.map((item) => item.temp),
    hum: history.map((item) => item.hum),
    systolic: history.map((item) => item.systolic),
  }

  const combinedSeries = history.map((item) => {
    if (item.hr === null || item.spo2 === null || item.temp === null) return null
    return (item.hr / 2 + item.spo2 + item.temp * 2) / 3
  })

  const mapLat = Number(location.lat).toFixed(5)
  const mapLng = Number(location.lng).toFixed(5)
  const mapEmbedSrc = `https://www.google.com/maps?q=${mapLat},${mapLng}&hl=en&z=17&output=embed`

  return (
    <div className="dashboard">
      {modalAlert ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Emergency alert">
          <div className="alert-modal">
            <h3>{modalAlert.title}</h3>
            <p>{modalAlert.message}</p>
            <p className="modal-time">Time: {modalAlert.eventTime}</p>
            <button className="modal-close" onClick={closeAlertModal}>Close</button>
          </div>
        </div>
      ) : null}

      <header className="hero-panel">
        <div>
          <h1>Body-Strapping Health Monitoring System</h1>
          {/* <p>Real-time vitals, emergency response, AI suggestions, and event timeline.</p> */}
          <p className="timestamp">
            Last update: {metrics.updatedAt ? formatTime(metrics.updatedAt) : 'Waiting for Firebase data...'}
          </p>
        </div>
      </header>

      <section className="metric-grid">
        <article className="metric-card">
          <h3>Heart Rate</h3>
          <strong>{metrics.hr ?? '--'} bpm</strong>
          <span className={statusClass(hrLabel)}>{hrLabel}</span>
        </article>
        <article className="metric-card">
          <h3>SpO2</h3>
          <strong>{metrics.spo2 ?? '--'} %</strong>
          <span className={statusClass(spo2Label)}>{spo2Label}</span>
        </article>
        <article className="metric-card">
          <h3>Body Temperature</h3>
          <strong>{metrics.temp ?? '--'} C</strong>
          <span className={statusClass(tempLabel)}>{tempLabel}</span>
        </article>
        <article className="metric-card">
          <h3>Humidity</h3>
          <strong>{metrics.hum ?? '--'} %</strong>
          <span className="status-normal">Ambient</span>
        </article>
        <article className="metric-card">
          <h3>Blood Pressure</h3>
          <strong>{metrics.bpRaw}</strong>
          <span className={statusClass(bpLabel)}>{bpLabel}</span>
        </article>
        <article className="metric-card">
          <h3>Fall Sensor</h3>
          <strong>{metrics.fall === 1 ? 'Detected' : 'Safe'}</strong>
          <span className={statusClass(metrics.fall === 1 ? 'High' : 'Normal')}>
            {metrics.fall === 1 ? 'Emergency' : 'Normal'}
          </span>
        </article>
      </section>

      <section className="content-grid">
        <article className="panel">
          <h2>Graphical Representation of Sensor History</h2>
          <div className="charts-wrap">
            <TinyChart data={combinedSeries} color="#1f7a8c" title="Combined Health Trend" />
            <TinyChart data={chartData.hr} color="#f94144" title="Heart Rate" />
            <TinyChart data={chartData.spo2} color="#277da1" title="SpO2" />
            <TinyChart data={chartData.temp} color="#f3722c" title="Body Temperature" />
            <TinyChart data={chartData.hum} color="#577590" title="Humidity" />
            <TinyChart data={chartData.systolic} color="#f8961e" title="Blood Pressure Systolic" />
          </div>
        </article>

        <article className="panel">
          <h2>Patient Health Summary</h2>
          <ul className="summary-list">
            <li>Real-time heart rate monitoring: {metrics.hr ?? '--'} bpm</li>
            <li>Real-time SpO2 monitoring: {metrics.spo2 ?? '--'} %</li>
            <li>Real-time blood pressure monitoring: {metrics.bpRaw}</li>
            <li>Real-time body temperature monitoring: {metrics.temp ?? '--'} C</li>
            <li>Real-time ambient humidity monitoring: {metrics.hum ?? '--'} %</li>
            <li>Emergency risk indication: {metrics.fall === 1 ? 'High (fall detected)' : 'Low'}</li>
            <li>Current location source: {location.source}</li>
            <li>Most recent event time: {events[0] ? formatTime(events[0].time) : 'No event yet'}</li>
          </ul>
<br />
          <h3>Suggestions and Warnings</h3>
          <ul className="ai-list">
            {suggestions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
      </section>

      <section className="content-grid">
        <article className="panel map-panel">
          <h2>Live Patient Location (Google Map)</h2>
          <p>
            Latitude: {location.lat.toFixed(5)} | Longitude: {location.lng.toFixed(5)}
          </p>
          <button className="locate-button" onClick={requestCurrentLocation} disabled={isLocating}>
            {isLocating ? 'Detecting Location...' : 'Use My Current Location'}
          </button>
          {mapError ? <p className="map-error">{mapError}</p> : null}
          <iframe
            title="Live map"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            src={mapEmbedSrc}
          />
        </article>

        <article className="panel">
          <h2>Alerts and Event Timeline</h2>
          <div className="alert-stack">
            {alerts.length === 0 ? <p>No active alerts right now.</p> : null}
            {alerts.map((alert) => (
              <div className={`alert-item ${alert.type}`} key={alert.id}>
                <p>{alert.message}</p>
                <time>{formatTime(alert.time)}</time>
              </div>
            ))}
          </div>

          <h3>Stored Events (Current Session)</h3>
          <div className="event-table">
            {events.length === 0 ? <p>No events recorded yet.</p> : null}
            {events.map((event, index) => (
              <div className="event-row" key={`${event.time}-${index}`}>
                <span>{event.type}</span>
                <span>{event.details}</span>
                <span>{formatTime(event.time)}</span>
              </div>
            ))}
          </div>
        </article>
      </section>
    </div>
  )
}

export default App
