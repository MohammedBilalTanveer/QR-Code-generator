import io

import pytest
from PIL import Image

from app import app


@pytest.fixture
def client():
    app.config.update(TESTING=True)
    return app.test_client()


def create(client, **options):
    return client.post("/api/generate", json={"text": "https://example.com", **options})


def upload(client, data, filename="picture.png"):
    return client.post("/api/decode", data={"image": (io.BytesIO(data), filename)})


def png_of(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_home_page_serves_the_ui(client):
    res = client.get("/")
    assert res.status_code == 200
    assert b"<title>QR Studio" in res.data


def test_create_returns_a_png(client):
    res = create(client)
    assert res.status_code == 200
    assert res.mimetype == "image/png"
    image = Image.open(io.BytesIO(res.data))
    assert image.size == (int(res.headers["X-QR-Pixels"]),) * 2


@pytest.mark.parametrize("text", ["https://example.com/path?q=1", "Hello, world!", "héllo wörld – ünïcode ✓"])
def test_created_codes_decode_back(client, text):
    res = upload(client, create(client, text=text).data)
    assert res.status_code == 200
    body = res.get_json()
    assert body["found"] is True
    assert body["codes"][0]["data"] == text
    assert len(body["codes"][0]["points"]) == 4


def test_colors_and_size_are_applied(client):
    res = create(client, fg="#1e3a8a", bg="#fef3c7", size=6, ec="H")
    assert res.status_code == 200
    image = Image.open(io.BytesIO(res.data)).convert("RGB")
    assert image.getpixel((0, 0)) == (0xFE, 0xF3, 0xC7)  # the quiet zone uses the background color
    assert int(res.headers["X-QR-Pixels"]) % 6 == 0


@pytest.mark.parametrize(
    ("options", "message"),
    [
        ({"text": "   "}, "Enter some text"),
        ({"fg": "red"}, "Colors must be"),
        ({"ec": "X"}, "Error correction"),
        ({"size": 99}, "Size must be"),
        ({"text": "x" * 3000}, "too long"),
        ({"text": "a" * 2000, "ec": "H"}, "too much text"),
    ],
)
def test_create_rejects_bad_input(client, options, message):
    res = create(client, **options)
    assert res.status_code == 400
    assert message in res.get_json()["error"]


def test_create_without_a_json_body(client):
    assert client.post("/api/generate", data="nope").status_code == 400


def test_decode_picture_without_a_code(client):
    res = upload(client, png_of(Image.new("RGB", (240, 240), "white")))
    assert res.status_code == 200
    assert res.get_json() == {"found": False, "codes": []}


def test_decode_big_photo_reports_corners_in_original_pixels(client):
    code = Image.open(io.BytesIO(create(client, size=20).data)).convert("RGB")
    photo = Image.new("RGB", (4000, 3000), "white")
    photo.paste(code.resize((1200, 1200), Image.NEAREST), (1500, 900))

    body = upload(client, png_of(photo)).get_json()

    assert body["found"] is True
    xs = [x for x, _ in body["codes"][0]["points"]]
    assert 1500 <= min(xs) and max(xs) <= 2700


def test_decode_rejects_files_that_are_not_pictures(client):
    assert upload(client, b"definitely not a picture", "notes.txt").status_code == 400


def test_decode_requires_a_file(client):
    assert client.post("/api/decode").status_code == 400


def test_decode_rejects_huge_uploads(client):
    res = upload(client, b"0" * (5 * 1024 * 1024))
    assert res.status_code == 413
    assert "too big" in res.get_json()["error"]
