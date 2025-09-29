# pi_simulator.py
# pip install "python-socketio[client]" requests
import socketio, time, random, uuid
sio = socketio.Client()

DEVICE_ID = "tank-" + uuid.uuid4().hex[:6]

@sio.event
def connect():
    print("connected to server")

@sio.event
def disconnect():
    print("disconnected")

def send_loop():
    fuel = 73.0  # start %
    while True:
        # simulate usage
        usage = random.uniform(0.05, 0.5)  # percent per interval
        fuel -= usage
        if fuel < 0:
            fuel = 100.0  # refill for demo
        payload = {
            "deviceId": DEVICE_ID,
            "timestamp": int(time.time() * 1000),
            "fuel_level_pct": round(fuel, 2),
            "temperature_c": round(20 + random.uniform(-2, 8), 1),
            "flow_lph": round(random.uniform(0, 6), 2),
            "lat": 5.0 + random.uniform(-0.01, 0.01),
            "lon": 7.0 + random.uniform(-0.01, 0.01),
            "status": "ok"
        }
        sio.emit('telemetry', payload)
        print("sent", payload)
        time.sleep(5)  # send every 5s

if __name__ == "__main__":
    server = "http://localhost:3000"  # change to ngrok URL if remote: "https://abcd.ngrok-free.app"
    sio.connect(server)
    try:
        send_loop()
    except KeyboardInterrupt:
        sio.disconnect()
