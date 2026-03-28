#!/usr/bin/env python3
"""
Verifiable Sensor Client — rythmn Pi
Implements Proof of Freshness, Origin, Execution, and Identity
against the HyperBEAM AO registry process.

Sensors supported (in order of preference):
  1. DHT22 (temperature + humidity) on GPIO 4
  2. CPU temperature (always available on Pi)

Usage:
  python3 sensor.py              # single reading
  python3 sensor.py --loop 30   # read every 30 seconds
"""

import argparse
import base64
import hashlib
import json
import os
import sys
import time
import struct
from datetime import datetime, timezone

import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.backends import default_backend

# ── Config ────────────────────────────────────────────────────────────────────

BACKEND_URL = "http://localhost:3001"
SCRIPT_PATH = os.path.abspath(__file__)
STATE_FILE = os.path.join(os.path.dirname(__file__), "../device-state.json")
DHT_GPIO_PIN = 4  # Change if your DHT22 is on a different pin

# ── Code Integrity ────────────────────────────────────────────────────────────

def compute_code_hash() -> str:
    """SHA-256 of this script file itself — Proof of Execution."""
    with open(SCRIPT_PATH, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()

CODE_HASH = compute_code_hash()
print(f"[boot] Code hash: {CODE_HASH}")

# ── Signing ───────────────────────────────────────────────────────────────────

def b64url_to_int(b64: str) -> int:
    padded = b64 + "=" * (-len(b64) % 4)
    return int.from_bytes(base64.urlsafe_b64decode(padded), "big")

def load_private_key(jwk: dict):
    """Load Arweave RSA JWK into a cryptography private key object."""
    from cryptography.hazmat.primitives.asymmetric.rsa import (
        RSAPrivateNumbers, RSAPublicNumbers
    )
    n  = b64url_to_int(jwk["n"])
    e  = b64url_to_int(jwk["e"])
    d  = b64url_to_int(jwk["d"])
    p  = b64url_to_int(jwk["p"])
    q  = b64url_to_int(jwk["q"])
    dp = b64url_to_int(jwk["dp"])
    dq = b64url_to_int(jwk["dq"])
    qi = b64url_to_int(jwk["qi"])
    pub = RSAPublicNumbers(e, n)
    priv = RSAPrivateNumbers(p, q, d, dp, dq, qi, pub)
    return priv.private_key(default_backend())

def sign_payload(private_key, payload: str) -> str:
    """RSA-PSS SHA-256 signature, base64url encoded."""
    sig = private_key.sign(
        payload.encode("utf-8"),
        padding.PSS(
            mgf=padding.MGF1(hashes.SHA256()),
            salt_length=32
        ),
        hashes.SHA256()
    )
    return base64.urlsafe_b64encode(sig).decode("utf-8")

# ── Device State ──────────────────────────────────────────────────────────────

def load_device_state() -> dict:
    with open(STATE_FILE) as f:
        return json.load(f)

# ── Sensor Reading ────────────────────────────────────────────────────────────

def read_cpu_temperature() -> tuple[float, bytes]:
    """
    Reads Pi CPU temperature from /sys/class/thermal.
    Returns (celsius, raw_bytes).
    """
    with open("/sys/class/thermal/thermal_zone0/temp") as f:
        raw_str = f.read().strip()
    raw_bytes = raw_str.encode("utf-8")
    celsius = int(raw_str) / 1000.0
    return celsius, raw_bytes

def read_dht22() -> tuple[dict, bytes] | None:
    """
    Tries to read DHT22 via adafruit-circuitpython-dht.
    Returns ({ temperature, humidity }, raw_bytes) or None if unavailable.
    """
    try:
        import adafruit_dht
        import board
        dht = adafruit_dht.DHT22(board.D4)
        temp = dht.temperature
        humidity = dht.humidity
        dht.exit()
        # Raw bytes: pack both floats as big-endian doubles
        raw_bytes = struct.pack(">dd", temp, humidity)
        return {"temperature": temp, "humidity": humidity}, raw_bytes
    except Exception:
        return None

def take_reading() -> dict:
    """
    Takes a sensor reading. Tries DHT22 first, falls back to CPU temp.
    Returns structured reading with raw_hash, data_hash, value fields.
    """
    dht = read_dht22()
    if dht is not None:
        data, raw_bytes = dht
        raw_hash = hashlib.sha256(raw_bytes).hexdigest()
        processed = {
            "temperature_c": round(data["temperature"], 2),
            "humidity_pct": round(data["humidity"], 2)
        }
        data_hash = hashlib.sha256(json.dumps(processed, sort_keys=True).encode()).hexdigest()
        return {
            "sensor_type": "dht22",
            "value": f"{processed['temperature_c']}°C / {processed['humidity_pct']}%",
            "unit": "°C / %RH",
            "data": processed,
            "raw_hash": raw_hash,
            "data_hash": data_hash,
        }
    else:
        # CPU temperature fallback
        celsius, raw_bytes = read_cpu_temperature()
        raw_hash = hashlib.sha256(raw_bytes).hexdigest()
        processed = {"temperature_c": round(celsius, 2)}
        data_hash = hashlib.sha256(json.dumps(processed, sort_keys=True).encode()).hexdigest()
        return {
            "sensor_type": "cpu_temp",
            "value": f"{celsius:.2f}°C",
            "unit": "°C",
            "data": processed,
            "raw_hash": raw_hash,
            "data_hash": data_hash,
        }

# ── HyperBEAM Flow ────────────────────────────────────────────────────────────

def get_challenge(device_id: str) -> dict:
    """Step 1: Get a fresh nonce from HB via Pi backend."""
    res = requests.get(f"{BACKEND_URL}/api/challenge", params={"device_id": device_id}, timeout=30)
    res.raise_for_status()
    data = res.json()
    if "error" in data:
        raise RuntimeError(f"Challenge error: {data['error']}")
    return data  # { nonce, timestamp, device_id }

def submit_attestation(payload: dict) -> dict:
    """Step 4: Submit signed attestation to HB via Pi backend."""
    res = requests.post(
        f"{BACKEND_URL}/api/attest",
        json=payload,
        timeout=60
    )
    res.raise_for_status()
    return res.json()

# ── Main Flow ─────────────────────────────────────────────────────────────────

def run_once():
    print(f"\n{'─'*50}")
    print(f"[{datetime.now(timezone.utc).isoformat()}] Starting attestation cycle")

    # Load device state and private key
    state = load_device_state()
    device_id = state["device_id"]
    private_key = load_private_key(state["jwk"])
    print(f"[id]      Device ID: {device_id}")

    # Step 1: Get fresh challenge from HB
    print("[challenge] Requesting nonce from HyperBEAM...")
    challenge = get_challenge(device_id)
    nonce = challenge["nonce"]
    hb_timestamp = challenge["timestamp"]
    print(f"[challenge] Nonce: {nonce[:16]}...")

    # Step 2: Take sensor reading (raw bytes hashed immediately)
    print("[sensor]  Reading sensor...")
    reading = take_reading()
    print(f"[sensor]  {reading['sensor_type']}: {reading['value']}")
    print(f"[sensor]  raw_hash:  {reading['raw_hash'][:16]}...")
    print(f"[sensor]  data_hash: {reading['data_hash'][:16]}...")

    # Step 3: Build attestation payload
    local_timestamp = int(time.time() * 1000)
    payload = {
        "device_id":       device_id,
        "code_hash":       CODE_HASH,
        "raw_hash":        reading["raw_hash"],
        "data_hash":       reading["data_hash"],
        "sensor_type":     reading["sensor_type"],
        "value":           reading["value"],
        "unit":            reading["unit"],
        "nonce":           nonce,
        "hb_timestamp":    hb_timestamp,
        "local_timestamp": local_timestamp,
        "data":            reading["data"],
    }

    # Sign the canonical payload string (sorted keys for determinism)
    payload_str = json.dumps(payload, sort_keys=True)
    signature = sign_payload(private_key, payload_str)
    payload["signature"] = signature
    print(f"[sign]    Signature: {signature[:16]}...")

    # Step 4: Submit to HB
    print("[submit]  Sending attestation to HyperBEAM...")
    result = submit_attestation(payload)

    if result.get("ok"):
        att_id = result.get("attestation_id", "")
        print(f"[✓]       VERIFIED — attestation_id: {att_id[:16]}...")
    else:
        print(f"[✗]       FAILED — {result.get('message', result)}")

    return result

def main():
    parser = argparse.ArgumentParser(description="Verifiable sensor client")
    parser.add_argument("--loop", type=int, default=0, metavar="SECONDS",
                        help="Run continuously every N seconds (0 = run once)")
    args = parser.parse_args()

    if args.loop > 0:
        print(f"Running in loop mode every {args.loop}s. Ctrl+C to stop.")
        while True:
            try:
                run_once()
            except Exception as e:
                print(f"[error] {e}")
            print(f"[sleep]   Next reading in {args.loop}s...")
            time.sleep(args.loop)
    else:
        run_once()

if __name__ == "__main__":
    main()
