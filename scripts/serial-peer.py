"""OS PTY peer for desktop smoke tests; not a physical device or firmware."""
import errno
import os
from pathlib import Path
import pty
import select
import time
import tty

root = Path('smoke-results')
master, slave = pty.openpty()
tty.setraw(slave)
(root / 'serial-port.txt').write_text(os.ttyname(slave))
os.close(slave)
received = b''
while True:
    if not select.select([master], [], [], 0.1)[0]:
        continue
    try:
        chunk = os.read(master, 4096)
    except OSError as error:
        if error.errno != errno.EIO:
            raise
        if received:
            (root / 'serial-disconnected.txt').write_text('PTY slave closed after UI disconnect')
            break
        time.sleep(0.1)
        continue
    received += chunk
    (root / 'serial-transmitted.bin').write_bytes(received)
    if received.endswith(b'\n'):
        os.write(master, b'PTY fixture RX: acknowledgement\n')
        (root / 'serial-replied.txt').write_text('OS PTY reply sent')
# Keep master open so assertions can distinguish explicit disconnect from peer exit.
time.sleep(30)
