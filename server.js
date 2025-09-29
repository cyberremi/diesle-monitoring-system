// server.js
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

// in-memory store (simple)
const devices = {}; // deviceId -> lastTelemetry
const history = {}; // deviceId -> array of recent telemetry points (bounded)

// helper
function pushHistory(deviceId, point) {
  history[deviceId] = history[deviceId] || [];
  history[deviceId].push(point);
  if (history[deviceId].length > 300) history[deviceId].shift(); // keep last N
}

// socket.io: accept telemetry from devices and broadcast to dashboards
io.on('connection', socket => {
  console.log('socket connected', socket.id);

  // device sends telemetry
  socket.on('telemetry', data => {
    // expected shape: { deviceId, timestamp, fuel_level_pct, temperature_c, flow_lph, lat, lon, status }
    if (!data || !data.deviceId) return;
    data.timestamp = data.timestamp || Date.now();
    devices[data.deviceId] = data;
    pushHistory(data.deviceId, { t: data.timestamp, fuel: data.fuel_level_pct, flow: data.flow_lph });

    // broadcast to all dashboard clients
    io.emit('telemetry:update', data);
    console.log(`telemetry from ${data.deviceId}: ${Math.round(data.fuel_level_pct)}%`);
  });

  // dashboard requests initial state
  socket.on('request:init', () => {
    socket.emit('init', { devices, history });
  });

  socket.on('disconnect', () => {
    // nothing special
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Diesel monitor server running on http://localhost:${PORT}`);
});
