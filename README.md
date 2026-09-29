# QR Studio

A web app for creating and scanning QR codes. It's the web version of `qrscan_create.py`
(the Tkinter app): the same `qrcode` and OpenCV logic now runs behind a small Flask API,
with a browser UI that anyone can open on a phone or computer.

- **Create**: type text or a link and press Enter. Choose the error-correction level,
  size and colors, then download the PNG, copy it, or share it (on phones).
- **Scan with the camera**: live scanning in the browser, with a camera picker when the
  device has more than one.
- **Scan a picture**: upload, drag and drop, or paste (Ctrl+V) an image.
- **Websites open automatically**, like `webbrowser.open()` did in the Tkinter app. If a
  scanned code is a website (`https://example.com` or just `www.example.com`), a 3-second
  countdown shows the real address with a Cancel button, then the site opens. Anything
  else (plain text, Wi-Fi details, contacts, ...) is shown as text with a Copy button.
  Change `AUTO_OPEN_SECONDS` in `public/app.js` to adjust the countdown; 0 opens instantly.

## How it works

| Feature | Where it runs | Code |
| --- | --- | --- |
| Create a QR code | Server: `POST /api/generate` → `qrcode` + Pillow → PNG | `qr_core.make_qr_png` |
| Scan a picture | Server: `POST /api/decode` → OpenCV `QRCodeDetector` | `qr_core.decode_qr` |
| Scan with the camera | Browser: jsQR decodes video frames | `public/app.js` |

The camera part can't run on the server the way `cv2.VideoCapture(0)` did on your
desktop, because a server has no webcam. The visitor's browser has the camera, so it does
the live decoding. For uploaded pictures, OpenCV on the server gets the first try, and jsQR
in the browser takes a second look if OpenCV finds nothing. That covers light-on-dark
codes, which OpenCV misses.

## Run it locally (Windows PowerShell)

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
python app.py
```

Then open http://127.0.0.1:5000. The camera works on `localhost`. Anywhere else, browsers
only allow camera access over HTTPS, which Vercel provides automatically.

Run the tests with `pytest`.

## Deploy to Vercel

**Option A: Vercel CLI**

```powershell
npx vercel login      # one-time, opens your browser
npx vercel --prod     # first run asks a few setup questions; the defaults are fine
```

**Option B: GitHub**

Push this folder to a GitHub repository, then import it at https://vercel.com/new.
Vercel detects Flask from `requirements.txt` and `app.py`, so no settings are needed.

Every later `npx vercel --prod` (or `git push`) redeploys.

## Deploy to Render

Render deploys from GitHub. The repo includes a [`render.yaml`](render.yaml) Blueprint,
so Render configures the service itself:

1. Push your latest code to GitHub.
2. Sign in at https://dashboard.render.com with your GitHub account and choose
   **New > Blueprint**.
3. Pick the `QR-Code-generator` repository and click **Apply**.

Render installs `requirements.txt` on Python 3.12 (from `.python-version`), starts the app
with gunicorn, and gives you an `https://…onrender.com` address. Every push to `main`
redeploys it.

To set it up by hand instead, choose **New > Web Service**, pick the repo, and enter:

| Setting | Value |
| --- | --- |
| Language | Python 3 |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `gunicorn app:app --workers 1 --threads 4 --timeout 120` |
| Instance Type | Free |

On the free plan Render puts the app to sleep after 15 minutes without visitors. The next
visit wakes it up, which takes about a minute.

## Project layout

```
app.py              Flask app: serves the page and the /api routes (Vercel's entrypoint)
qr_core.py          QR generation (qrcode) and decoding (OpenCV)
public/             The web UI: index.html, styles.css, app.js, vendor/jsQR.js
tests/              pytest suite for the API
requirements.txt    Runtime dependencies (installed by Vercel and Render)
vercel.json         Vercel settings: security headers
render.yaml         Render settings: build and start commands
.python-version     Python 3.12 (used by Vercel and Render)
```

## Notes

- `requirements.txt` uses `opencv-python-headless`, not `opencv-python`. The regular
  package needs desktop GUI libraries (libGL) that don't exist on Vercel's servers.
- OpenCV is imported only when a picture is decoded, so creating codes stays fast even
  right after a cold start.
- Vercel rejects request bodies over 4.5 MB. The browser shrinks pictures to at most
  1600 px before uploading them, and the API caps uploads at 4 MB.
- jsQR is vendored in `public/vendor/` (Apache-2.0, license alongside it).
