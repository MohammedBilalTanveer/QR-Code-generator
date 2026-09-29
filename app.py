"""QR Studio: a web UI for creating and scanning QR codes.

Run it locally with ``python app.py`` and open http://127.0.0.1:5000.
Vercel picks up the ``app`` object below automatically when you deploy.
"""

from dataclasses import asdict
from pathlib import Path

from flask import Flask, jsonify, redirect, request

from qr_core import QRInputError, decode_qr, make_qr_png

PUBLIC_DIR = Path(__file__).resolve().parent / "public"
MAX_UPLOAD_BYTES = 4 * 1024 * 1024  # Vercel rejects request bodies over 4.5 MB

# On Vercel the files in public/ are served by the CDN before a request reaches
# Flask, so static_folder only matters when running locally.
app = Flask(__name__, static_folder=PUBLIC_DIR, static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES


@app.get("/")
def index():
    return app.send_static_file("index.html")


@app.get("/favicon.ico")
def favicon():
    return redirect("/favicon.svg", code=301)  # some browsers ask for this path regardless


@app.post("/api/generate")
def generate():
    options = request.get_json(silent=True)
    if not isinstance(options, dict):
        options = {}
    try:
        qr = make_qr_png(
            options.get("text"),
            error=options.get("ec", "M"),
            box_size=options.get("size", 10),
            fill=options.get("fg", "#000000"),
            back=options.get("bg", "#ffffff"),
        )
    except QRInputError as exc:
        return jsonify(error=str(exc)), 400

    response = app.response_class(qr.png, mimetype="image/png")
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-QR-Version"] = str(qr.version)
    response.headers["X-QR-Pixels"] = str(qr.pixels)
    return response


@app.post("/api/decode")
def decode():
    upload = request.files.get("image")
    if upload is None:
        return jsonify(error="Send the picture as a file field named 'image'."), 400
    try:
        codes = decode_qr(upload.read())
    except QRInputError as exc:
        return jsonify(error=str(exc)), 400
    return jsonify(found=bool(codes), codes=[asdict(code) for code in codes])


@app.get("/api/health")
def health():
    return jsonify(status="ok")


@app.errorhandler(413)
def too_large(_error):
    return jsonify(error="That picture is too big. The limit is 4 MB."), 413


if __name__ == "__main__":
    app.run(debug=True)
