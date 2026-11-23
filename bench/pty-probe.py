#!/usr/bin/env python3
"""Spawn a command on a real pseudo-terminal and timestamp what it prints.

Used by bench/startup.mjs to measure terminal startup (alt-screen enter,
first paint, typed-key echo, transcript visible) of the interactive TUI.

usage: pty-probe.py [--type TEXT] [--type-delay-ms N] [--mark NAME=TEXT]...
                    [--after-alt] [--send-after-alt TEXT] [--dump FILE] [--stop-on NAME] [--timeout S] [--profile-out FILE] -- cmd args...

Prints one JSON object: {"marks": {name: ms-since-spawn | null}, "firstByteMs": ..., "altScreenMs": ...,
"exit": ..., "bytes": ...}. `--type` writes TEXT to the terminal right after spawn
(+ --type-delay-ms), which is how an impatient user types before the UI is ready.
`--send-after-alt` writes TEXT 50 ms after the alternate screen appears (a user pressing Enter as soon as
the UI shows up).
The probe passes its environment through to the child. Callers matching translated output must
choose the child's locale. Marks and typed text are encoded as UTF-8.
"""
import fcntl, json, os, pty, select, signal, struct, sys, termios, time


# A person cannot react to the UI appearing in the same millisecond; give the app one frame.
SEND_AFTER_ALT_DELAY = 0.05


def value_after(opts, i):
    return opts[i + 1] if i + 1 < len(opts) else ""


def main() -> int:
    dump_path = None
    send_after_alt = None
    send_at = None
    argv = sys.argv[1:]
    if "--" not in argv:
        print("missing --", file=sys.stderr)
        return 2
    split = argv.index("--")
    opts, cmd = argv[:split], argv[split + 1:]
    typed, type_delay, marks, stop_on, timeout, after_alt = None, 0.0, {}, None, 30.0, False
    i = 0
    while i < len(opts):
        flag = opts[i]
        if flag == "--send-after-alt":
            send_after_alt = value_after(opts, i).encode()
            i += 2
            continue
        if flag == "--dump":
            dump_path = value_after(opts, i)
            i += 2
            continue
        if flag == "--after-alt":
            after_alt = True
            i += 1
            continue
        value = opts[i + 1] if i + 1 < len(opts) else ""
        if flag == "--type":
            typed = value.encode()
        elif flag == "--type-delay-ms":
            type_delay = float(value) / 1000
        elif flag == "--mark":
            name, _, text = value.partition("=")
            marks[name] = text.encode()
        elif flag == "--stop-on":
            stop_on = value
        elif flag == "--timeout":
            timeout = float(value)
        i += 2

    start = time.perf_counter()
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

    found = {name: None for name in marks}
    first_byte = None
    alt_screen = None
    buf = b""
    sent = typed is None
    total = 0
    exit_code = None
    while True:
        now = time.perf_counter() - start
        if now > timeout:
            break
        if send_after_alt and send_at is not None and now >= send_at:
            os.write(fd, send_after_alt)
            send_after_alt = None
        if not sent and now >= type_delay:
            os.write(fd, typed)
            sent = True
        ready, _, _ = select.select([fd], [], [], 0.002)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            at = (time.perf_counter() - start) * 1000
            total += len(chunk)
            if first_byte is None:
                first_byte = at
            buf += chunk
            if alt_screen is None and b"\x1b[?1049h" in buf:
                alt_screen = at
                send_at = at / 1000 + SEND_AFTER_ALT_DELAY
            # Terminal line-discipline echo happens before the UI exists; with --after-alt only
            # bytes the app wrote after entering the alternate screen can satisfy a mark.
            scope = buf
            if after_alt:
                scope = buf[buf.index(b"\x1b[?1049h"):] if alt_screen is not None else b""
            for name, text in marks.items():
                if found[name] is None and text in scope:
                    found[name] = at
            if stop_on and found.get(stop_on) is not None:
                break
    # SIGTERM first so the child can flush --cpu-prof output; SIGKILL if it lingers.
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.perf_counter() + 3
    while time.perf_counter() < deadline:
        try:
            done, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            break
        if done:
            exit_code = os.waitstatus_to_exitcode(status)
            break
        time.sleep(0.01)
    else:
        try:
            os.kill(pid, signal.SIGKILL)
            _, status = os.waitpid(pid, 0)
            exit_code = os.waitstatus_to_exitcode(status)
        except (ProcessLookupError, ChildProcessError):
            pass
    if dump_path:
        with open(dump_path, "wb") as handle:
            handle.write(buf)
    print(json.dumps({"marks": found, "firstByteMs": first_byte, "altScreenMs": alt_screen, "bytes": total, "exit": exit_code}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
