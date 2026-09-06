/* ============================================
   MOTOR BEARING FAULT DETECTION DASHBOARD
   JavaScript Controller
   ============================================ */

// Global State
const state = {
    isConnected: false,
    statusBadgeElement: document.getElementById('statusBadge'),
    statusText: document.getElementById('statusText'),
    statusDescription: document.getElementById('statusDescription'),
    peakFrequency: 0,
    noiseFloor: 0,
    anomalyScore: 0,
    eventLog: [],
    startTime: Date.now(),
    frequencyData: new Array(256).fill(0),
    sampleRate: 16000,
    fftSize: 512,
    chart: null,
    ws: null,
    reconnectAttempts: 0,
    maxReconnectAttempts: 5
};

/* ============================================
   INITIALIZATION
   ============================================ */

document.addEventListener('DOMContentLoaded', function () {
    initializeChart();
    initializeWebSocket();
    updateUptime();
    setInterval(updateUptime, 1000);
    
    // Add keyboard shortcuts
    document.addEventListener('keydown', handleKeyboardShortcuts);
});

/* ============================================
   CHART.JS INITIALIZATION
   ============================================ */

function initializeChart() {
    const ctx = document.getElementById('frequencyChart').getContext('2d');
    
    // Create frequency bins (0 Hz to 16 kHz)
    const frequencyLabels = generateFrequencyLabels(256);
    
    state.chart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: frequencyLabels,
            datasets: [{
                label: 'Frequency Spectrum (dB)',
                data: state.frequencyData,
                backgroundColor: function(context) {
                    const value = context.parsed.y;
                    const index = context.dataIndex;
                    const freq = (index / 256) * 8000; // Nyquist frequency
                    
                    // Color coding by frequency band
                    if (freq < 3000) {
                        return 'rgba(39, 174, 96, 0.6)'; // Healthy (Green)
                    } else if (freq < 8000) {
                        return 'rgba(243, 156, 18, 0.6)'; // Warning (Orange)
                    } else {
                        return 'rgba(231, 76, 60, 0.6)'; // Critical (Red)
                    }
                },
                borderColor: function(context) {
                    const index = context.dataIndex;
                    const freq = (index / 256) * 8000;
                    
                    if (freq < 3000) {
                        return 'rgba(39, 174, 96, 1)';
                    } else if (freq < 8000) {
                        return 'rgba(243, 156, 18, 1)';
                    } else {
                        return 'rgba(231, 76, 60, 1)';
                    }
                },
                borderWidth: 1,
                borderRadius: 2,
                tension: 0.1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        font: { size: 12 },
                        padding: 15
                    }
                },
                tooltip: {
                    enabled: true,
                    callbacks: {
                        label: function(context) {
                            const freq = (context.dataIndex / 256) * 8000;
                            return `${freq.toFixed(0)} Hz: ${context.parsed.y.toFixed(2)} dB`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: 120,
                    title: {
                        display: true,
                        text: 'Amplitude (dB)'
                    }
                },
                x: {
                    title: {
                        display: true,
                        text: 'Frequency (Hz)'
                    },
                    ticks: {
                        maxTicksLimit: 10,
                        callback: function(value) {
                            const freq = (value / 256) * 8000;
                            return freq.toFixed(0) + ' Hz';
                        }
                    }
                }
            }
        }
    });
}

function generateFrequencyLabels(bins) {
    const labels = [];
    for (let i = 0; i < bins; i++) {
        labels.push((i / bins * 8000).toFixed(0));
    }
    return labels;
}

/* ============================================
   WEBSOCKET COMMUNICATION
   ============================================ */

function initializeWebSocket() {
    // Use ?esp32=192.168.1.100 when the dashboard is served locally.
    const configuredHost = new URLSearchParams(window.location.search).get('esp32');
    const localHosts = ['', 'localhost', '127.0.0.1', '::1'];
    const esp32Host = configuredHost || (!localHosts.includes(window.location.hostname)
        ? window.location.hostname
        : '');

    if (!esp32Host) {
        document.getElementById('wsUrl').textContent = 'ESP32 address not configured';
        updateConnectionStatus(false);
        console.log('ESP32 address not configured. Use ?esp32=ESP32_IP_ADDRESS.');
        return;
    }

    const wsUrl = `ws://${esp32Host}:8080`;
    document.getElementById('wsUrl').textContent = wsUrl;
    
    try {
        state.ws = new WebSocket(wsUrl);
        
        state.ws.onopen = function() {
            console.log('WebSocket connected');
            state.isConnected = true;
            state.reconnectAttempts = 0;
            updateConnectionStatus(true);
            showToast('Connected to ESP32', 'success');
        };
        
        state.ws.onmessage = function(event) {
            try {
                const data = JSON.parse(event.data);
                handleTelemetryData(data);
            } catch (e) {
                console.error('Failed to parse WebSocket message:', e);
            }
        };
        
        state.ws.onerror = function(error) {
            console.error('WebSocket error:', error);
            showToast('WebSocket connection error', 'error');
        };
        
        state.ws.onclose = function() {
            console.log('WebSocket disconnected');
            state.isConnected = false;
            updateConnectionStatus(false);
            attemptReconnect();
        };
    } catch (e) {
        console.error('Failed to create WebSocket:', e);
        updateConnectionStatus(false);
        showToast('Unable to connect to ESP32. Check the WebSocket URL.', 'error');
    }
}

function attemptReconnect() {
    if (state.reconnectAttempts < state.maxReconnectAttempts) {
        state.reconnectAttempts++;
        const delay = Math.pow(2, state.reconnectAttempts) * 1000; // Exponential backoff
        console.log(`Attempting to reconnect in ${delay}ms...`);
        setTimeout(initializeWebSocket, delay);
    } else {
        showToast('Failed to connect. Check if ESP32 is running.', 'error');
    }
}

/* ============================================
   DATA HANDLING
   ============================================ */

function handleTelemetryData(data) {
    // Expected data format from ESP32:
    // {
    //   "peakFreq": 4500,
    //   "frequencySpectrum": [...],
    //   "anomalyScore": 45,
    //   "status": "HEALTHY" | "WARNING" | "CRITICAL",
    //   "noiseFloor": 35
    // }
    
    // Update peak frequency
    if (data.peakFreq !== undefined) {
        state.peakFrequency = data.peakFreq;
        document.getElementById('peakFrequency').textContent = data.peakFreq.toFixed(0);
    }
    
    // Update noise floor
    if (data.noiseFloor !== undefined) {
        state.noiseFloor = data.noiseFloor;
        document.getElementById('noiseFloor').textContent = data.noiseFloor.toFixed(1);
    }
    
    // Update anomaly score
    if (data.anomalyScore !== undefined) {
        state.anomalyScore = data.anomalyScore;
        document.getElementById('anomalyScore').textContent = data.anomalyScore.toFixed(1);
    }
    
    // Update frequency spectrum if provided
    if (data.frequencySpectrum && Array.isArray(data.frequencySpectrum)) {
        state.frequencyData = data.frequencySpectrum;
        if (state.chart) {
            state.chart.data.datasets[0].data = state.frequencyData;
            state.chart.update('none'); // Update without animation for real-time
        }
    }
    
    // Update status
    if (data.status) {
        updateStatus(data.status);
    }
    
    // Log event
    addEvent({
        timestamp: new Date(),
        status: data.status || 'UNKNOWN',
        peakFreq: data.peakFreq || 0,
        anomalyScore: data.anomalyScore || 0
    });
    
    // Update last update time
    document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();
}

/* ============================================
   STATUS MANAGEMENT
   ============================================ */

function updateStatus(status) {
    status = status.toUpperCase();
    
    // Remove previous status classes
    state.statusBadgeElement.classList.remove('healthy', 'warning', 'critical');
    
    let displayText = status;
    let description = '';
    
    switch (status) {
        case 'HEALTHY':
            state.statusBadgeElement.classList.add('healthy');
            displayText = '✓ HEALTHY';
            description = 'Motor bearing condition is normal. No anomalies detected.';
            break;
        case 'WARNING':
            state.statusBadgeElement.classList.add('warning');
            displayText = '⚠ WARNING';
            description = 'Elevated friction frequency detected. Monitor closely.';
            break;
        case 'CRITICAL':
            state.statusBadgeElement.classList.add('critical');
            displayText = '🚨 CRITICAL ANOMALY';
            description = 'Critical bearing fault detected! Immediate attention required.';
            if (state.isConnected) {
                triggerTelegramAlert();
            }
            break;
        default:
            state.statusBadgeElement.classList.add('healthy');
    }
    
    state.statusText.textContent = displayText;
    state.statusDescription.textContent = description;
}

function updateConnectionStatus(connected) {
    const dot = document.getElementById('connectionDot');
    const text = document.getElementById('connectionText');
    
    if (connected) {
        dot.classList.remove('disconnected');
        dot.classList.add('connected');
        text.textContent = 'Connected';
    } else {
        dot.classList.remove('connected');
        dot.classList.add('disconnected');
        text.textContent = 'Disconnected';
    }
}

/* ============================================
   EVENT LOGGING
   ============================================ */

function addEvent(event) {
    state.eventLog.unshift(event); // Add to beginning
    
    // Keep only last 100 events
    if (state.eventLog.length > 100) {
        state.eventLog.pop();
    }
    
    renderEventLog();
    updateLogStats();
}

function renderEventLog() {
    const tbody = document.getElementById('eventLogBody');
    const filterValue = document.getElementById('filterInput').value.toLowerCase();
    const filterLevel = document.getElementById('filterLevel').value;
    
    // Filter events
    let filteredEvents = state.eventLog;
    
    if (filterLevel) {
        filteredEvents = filteredEvents.filter(e => 
            e.status.toLowerCase() === filterLevel
        );
    }
    
    if (filterValue) {
        filteredEvents = filteredEvents.filter(e =>
            e.status.toLowerCase().includes(filterValue) ||
            e.peakFreq.toString().includes(filterValue)
        );
    }
    
    // Clear table
    tbody.innerHTML = '';
    
    if (filteredEvents.length === 0) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No events to display</td></tr>';
        return;
    }
    
    // Render events
    filteredEvents.forEach(event => {
        const row = document.createElement('tr');
        
        const timestamp = event.timestamp.toLocaleTimeString();
        const statusClass = event.status.toLowerCase();
        const statusBadge = `<span class="status-badge-small ${statusClass}">${event.status}</span>`;
        const peakFreq = event.peakFreq.toFixed(1);
        const anomalyScore = event.anomalyScore.toFixed(1);
        
        row.innerHTML = `
            <td>${timestamp}</td>
            <td>${statusBadge}</td>
            <td>${peakFreq}</td>
            <td>${anomalyScore}</td>
            <td><button class="delete-btn" onclick="deleteEvent(this)">Delete</button></td>
        `;
        
        tbody.appendChild(row);
    });
}

function deleteEvent(button) {
    button.closest('tr').remove();
}

function resetEventLog() {
    if (confirm('Are you sure you want to clear all events?')) {
        state.eventLog = [];
        renderEventLog();
        updateLogStats();
        showToast('Event log cleared', 'success');
    }
}

function updateLogStats() {
    const total = state.eventLog.length;
    const critical = state.eventLog.filter(e => e.status === 'CRITICAL').length;
    
    document.getElementById('totalEvents').textContent = total;
    document.getElementById('criticalCount').textContent = critical;
}

/* ============================================
   USER INTERACTIONS
   ============================================ */

function triggerCalibration() {
    const btn = document.getElementById('calibrateBtn');
    btn.disabled = true;
    
    showToast('Starting 3-second ambient noise calibration...', 'success');
    
    // Send calibration command to ESP32
    if (state.ws && state.isConnected) {
        state.ws.send(JSON.stringify({
            command: 'calibrate',
            duration: 3000
        }));
    }
    
    // Simulate calibration
    let countdown = 3;
    const interval = setInterval(() => {
        if (countdown > 0) {
            showToast(`Calibrating... ${countdown}s remaining`, 'success');
            countdown--;
        } else {
            clearInterval(interval);
            showToast('Calibration complete! Noise floor updated.', 'success');
            btn.disabled = false;
        }
    }, 1000);
}

function exportData() {
    const csvContent = generateCSV();
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bearing-fault-log-${new Date().getTime()}.csv`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
    
    showToast('Data exported successfully', 'success');
}

function generateCSV() {
    let csv = 'Timestamp,Status,Peak Frequency (Hz),Anomaly Score (%)\n';
    
    state.eventLog.forEach(event => {
        const timestamp = event.timestamp.toLocaleString();
        const status = event.status;
        const peakFreq = event.peakFreq.toFixed(1);
        const anomalyScore = event.anomalyScore.toFixed(1);
        
        csv += `"${timestamp}","${status}",${peakFreq},${anomalyScore}\n`;
    });
    
    return csv;
}

function triggerTelegramAlert() {
    // Send alert command to ESP32
    if (state.ws && state.isConnected) {
        state.ws.send(JSON.stringify({
            command: 'alert',
            message: 'CRITICAL: Motor bearing anomaly detected!',
            severity: 'critical'
        }));
    }
}

/* ============================================
   UTILITIES
   ============================================ */

function updateUptime() {
    const elapsed = Date.now() - state.startTime;
    const seconds = Math.floor(elapsed / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    const uptime = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    document.getElementById('uptime').textContent = uptime;
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

function handleKeyboardShortcuts(event) {
    // Alt+C: Calibrate
    if (event.altKey && event.key === 'c') {
        event.preventDefault();
        triggerCalibration();
    }
    
    // Alt+E: Export
    if (event.altKey && event.key === 'e') {
        event.preventDefault();
        exportData();
    }
    
    // Alt+R: Reset Log
    if (event.altKey && event.key === 'r') {
        event.preventDefault();
        resetEventLog();
    }
}

/* ============================================
   EVENT LISTENERS
   ============================================ */

// Filter functionality
document.getElementById('filterInput').addEventListener('input', renderEventLog);
document.getElementById('filterLevel').addEventListener('change', renderEventLog);

// Sample Rate and FFT Size debug info
document.getElementById('sampleRate').textContent = `${state.sampleRate}`;
document.getElementById('fftSize').textContent = `${state.fftSize}`;

console.log('Dashboard initialized. Waiting for ESP32 connection...');
console.log('Keyboard shortcuts: Alt+C (Calibrate), Alt+E (Export), Alt+R (Reset Log)');
