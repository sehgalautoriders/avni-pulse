"""Checks our QR maker (docs/js/qr.js) with two independent readers (zxing-cpp and OpenCV). Run with Python 3.12."""
import json, subprocess, sys, os
import numpy as np, cv2, zxingcpp
here = os.path.dirname(os.path.abspath(__file__))
texts = ["https://sehgalautoriders.github.io/avni-pulse/?c=ABC234",
         "https://sehgalautoriders.github.io/avni-pulse/?c=K7M9QX", "PULSE", "x" * 120, "AVNI Pulse - live polls, Q&A " * 6]
out = json.loads(subprocess.run(["node", os.path.join(here, "qr_dump.mjs"), *texts], capture_output=True, text=True, check=True).stdout)
bad = 0
for o in out:
    m = np.array([[c == "1" for c in r] for r in o["rows"]], dtype=np.uint8)
    img = np.pad(np.where(m, 0, 255).astype(np.uint8), 4, constant_values=255)
    img = cv2.resize(img, None, fx=8, fy=8, interpolation=cv2.INTER_NEAREST)
    z = [r.text for r in zxingcpp.read_barcodes(img)]
    c, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
    ok = z == [o["text"]] and c == o["text"]
    bad += not ok
    print(("OK  " if ok else "BAD ") + f"v{o['version']} mask {o['mask']} zxing={z[:1]!r:.40} opencv={c!r:.40}")
print("ALL OK" if not bad else f"{bad} FAILED"); sys.exit(1 if bad else 0)
