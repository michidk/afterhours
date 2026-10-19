#!/usr/bin/env python3
"""Run all five-client phases while retaining TCP and server transport evidence."""
import argparse
import concurrent.futures
import json
import pathlib
import socket
import subprocess
import threading
import time
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--url', required=True)
parser.add_argument('--node', default='node')
parser.add_argument('--seconds', type=int, default=60)
parser.add_argument('--output', type=pathlib.Path, required=True)
args = parser.parse_args()
target = urllib.parse.urlsplit(args.url)
if target.scheme not in ('http', 'https') or not target.hostname:
    parser.error('--url must name an HTTP or HTTPS debug-enabled test server')
if args.seconds < 10:
    parser.error('--seconds must be at least 10')
args.output.mkdir(parents=True, exist_ok=False)
addresses = sorted({a[4][0] for a in socket.getaddrinfo(target.hostname, target.port or (443 if target.scheme == 'https' else 80), type=socket.SOCK_STREAM)})
stop = threading.Event()
lock = threading.Lock()
health_url = urllib.parse.urlunsplit((target.scheme, target.netloc, '/health', '', ''))
started = time.time_ns() // 1_000_000

def write(handle, record):
    # A complete line must be one locked write: health requests can finish together.
    with lock:
        handle.write(json.dumps(record) + '\n')
        handle.flush()

def sample_health(handle):
    at = time.time_ns() // 1_000_000
    try:
        with urllib.request.urlopen(health_url, timeout=5) as response:
            status = response.status
            health = json.load(response)
        record = {'at': at, 'requestMs': time.time_ns() // 1_000_000 - at, 'status': status, 'health': health}
    except Exception as error:
        record = {'at': at, 'requestMs': time.time_ns() // 1_000_000 - at, 'error': str(error)}
    write(handle, record)

def observe_health():
    with (args.output / 'health.jsonl').open('w') as handle, concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        active = set()
        while not stop.is_set():
            active = {future for future in active if not future.done()}
            if len(active) < 4:
                active.add(pool.submit(sample_health, handle))
            stop.wait(0.25)
        for future in active:
            future.result()

def observe_tcp():
    with (args.output / 'tcp.jsonl').open('w') as handle:
        while not stop.is_set():
            for address in addresses:
                at = time.time_ns() // 1_000_000
                try:
                    result = subprocess.run(['ss', '-tionp', 'dst', address], capture_output=True, text=True, timeout=3)
                    record = {'at': at, 'finishedAt': time.time_ns() // 1_000_000, 'address': address, 'status': result.returncode, 'tcp': result.stdout, 'error': result.stderr}
                except Exception as error:
                    record = {'at': at, 'address': address, 'error': str(error)}
                write(handle, record)
            stop.wait(0.1)

threads = [threading.Thread(target=observe_health), threading.Thread(target=observe_tcp)]
for thread in threads:
    thread.start()
exit_code = 1
try:
    with (args.output / 'movement.log').open('w') as log:
        command = [args.node, '--import', 'tsx', 'scripts/five-client-test.ts', '--url', args.url, '--seconds', str(args.seconds), '--output', str(args.output / 'five-client.json')]
        child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
        try:
            exit_code = child.wait()
        except BaseException:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
            raise
finally:
    stop.set()
    for thread in threads:
        thread.join()
    (args.output / 'capture.json').write_text(json.dumps({'url': args.url, 'addresses': addresses, 'startedAt': started, 'finishedAt': time.time_ns() // 1_000_000, 'exitCode': exit_code}, indent=2) + '\n')
raise SystemExit(exit_code)
