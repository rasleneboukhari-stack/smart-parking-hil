import time
import requests
import serial

GATEWAY_URL = "http://127.0.0.1:8000/simulator/hil/distances"
HIL_URL = "rfc2217://localhost:4000"

CHANNEL_COUNT = 16
DEFAULT_DISTANCE_CM = 200.0
CHANGE_EPSILON_CM = 0.25
FULL_RESYNC_INTERVAL_S = 3.0


def distances_to_channels(distances):
    channels = [DEFAULT_DISTANCE_CM] * CHANNEL_COUNT

    for spot_id, distance in distances.items():
        digits = "".join(char for char in spot_id if char.isdigit())
        if not digits:
            continue

        channel = int(digits) - 1
        if 0 <= channel < CHANNEL_COUNT:
            channels[channel] = float(distance)

    return channels


def changed_channels(current, previous, force_all=False):
    if force_all or previous is None:
        return list(range(CHANNEL_COUNT))

    return [
        channel
        for channel in range(CHANNEL_COUNT)
        if abs(current[channel] - previous[channel]) >= CHANGE_EPSILON_CM
    ]


def send_channels(serial_port, channels, channel_indexes):
    payload = "".join(
        f"{channel},{channels[channel]:.2f}\n"
        for channel in channel_indexes
    ).encode("ascii")

    if payload:
        serial_port.write(payload)
        serial_port.flush()


def drain_mcu_output(serial_port, rx_buffer):
    try:
        waiting = serial_port.in_waiting
    except (OSError, serial.SerialException):
        return rx_buffer

    if not waiting:
        return rx_buffer

    rx_buffer += serial_port.read(waiting)
    while b"\n" in rx_buffer:
        line, rx_buffer = rx_buffer.split(b"\n", 1)
        text = line.rstrip(b"\r").decode("utf-8", errors="replace")
        if text:
            print(f"[MCU] {text}")
    return rx_buffer


def main():
    # No write_timeout: PySerial RFC2217 does not support it.
    hil = serial.serial_for_url(
        HIL_URL,
        baudrate=115200,
        timeout=0.05,
    )

    last_sequence = None
    last_sent_channels = None
    last_full_resync = 0.0
    mcu_rx_buffer = b""

    try:
        while True:
            try:
                mcu_rx_buffer = drain_mcu_output(hil, mcu_rx_buffer)

                response = requests.get(GATEWAY_URL, timeout=1)
                response.raise_for_status()
                data = response.json()

                if not data.get("ready"):
                    print("No simulator distances yet")
                    time.sleep(0.2)
                    continue

                sequence = data.get("sequence")
                now = time.monotonic()

                if (
                    sequence == last_sequence
                    and now - last_full_resync < FULL_RESYNC_INTERVAL_S
                ):
                    time.sleep(0.03)
                    continue

                channels = distances_to_channels(data["distances_cm"])
                force_all = (
                    last_sent_channels is None
                    or now - last_full_resync >= FULL_RESYNC_INTERVAL_S
                )
                to_send = changed_channels(
                    channels,
                    last_sent_channels,
                    force_all,
                )

                if to_send:
                    send_channels(hil, channels, to_send)

                    if force_all:
                        last_full_resync = now
                        print(f"[HIL TX] full resync sequence={sequence}")
                    else:
                        changed_text = ", ".join(
                            f"ch{channel}={channels[channel]:.1f}cm"
                            for channel in to_send
                        )
                        print(f"[HIL TX] sequence={sequence}: {changed_text}")

                    last_sent_channels = channels.copy()

                last_sequence = sequence
                mcu_rx_buffer = drain_mcu_output(hil, mcu_rx_buffer)

            except requests.RequestException as error:
                print("Gateway error:", error)
            except (serial.SerialException, serial.SerialTimeoutException) as error:
                print("HIL serial error:", error)
                raise

            time.sleep(0.03)
    finally:
        hil.close()


if __name__ == "__main__":
    main()
