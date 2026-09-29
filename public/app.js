// QR Studio front end: plain JavaScript, no build step.
//
// Creating codes and decoding uploaded pictures go through the Python API in
// app.py. Live camera scanning runs entirely in the browser (with jsQR),
// because the camera belongs to the visitor's device, not to the server.

const $ = (selector) => document.querySelector(selector);

const SCAN_EVERY_MS = 100; // how often a camera frame is checked for a code
const MAX_FRAME_SIDE = 720; // camera frames are shrunk to this before decoding
const MAX_UPLOAD_SIDE = 1600; // uploads are shrunk too, keeping them far below Vercel's 4.5 MB limit
const DEFAULT_SIZE_PX = 10; // must match the checked "Image size" option
const AUTO_OPEN_SECONDS = 3; // countdown before a scanned website opens (0 opens it instantly)

/* ---------------------------------------------------------------- helpers */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function showNotice(node, message) {
  node.textContent = message;
  node.hidden = false;
}

function hideNotice(node) {
  node.hidden = true;
  node.textContent = '';
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.classList.toggle('is-loading', busy);
  button.setAttribute('aria-busy', String(busy));
}

const toastNode = $('#toast');
let toastTimer = 0;

function toast(message) {
  toastNode.textContent = message;
  toastNode.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastNode.classList.remove('show'), 2200);
}

async function readError(response) {
  try {
    const body = await response.json();
    if (typeof body?.error === 'string') return body.error;
  } catch {
    // not a JSON error from our API
  }
  return `Something went wrong on the server (${response.status}). Please try again.`;
}

function friendlyError(err) {
  // fetch() rejects with a TypeError when the network is unreachable.
  return err instanceof TypeError ? "Couldn't reach the server. Check your connection and try again." : err.message;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    toast("Couldn't copy. Select the text and copy it yourself.");
  }
}

/* ----------------------------------------------------------------- create */

const createForm = $('#create-form');
const textInput = $('#qr-text');
const charCount = $('#char-count');
const generateBtn = $('#generate-btn');
const createError = $('#create-error');
const fgInput = $('#fg');
const bgInput = $('#bg');
const contrastWarning = $('#contrast-warning');
const qrFrame = $('#qr-frame');
const qrImage = $('#qr-image');
const qrEmpty = $('#qr-empty');
const qrMeta = $('#qr-meta');
const downloadBtn = $('#download-btn');
const copyImageBtn = $('#copy-image-btn');
const shareBtn = $('#share-btn');

const DEFAULT_COLORS = { fg: fgInput.value, bg: bgInput.value };
const canCopyImage = Boolean(navigator.clipboard?.write && window.ClipboardItem);

let currentQr = null; // { blob, url, text } of the code on screen
let pendingCreate = null; // AbortController of the request in flight
let optionsTimer = 0;

async function createQr() {
  const text = textInput.value.trim();
  if (!text) {
    showNotice(createError, 'Enter some text or a link first.');
    textInput.focus();
    return;
  }
  hideNotice(createError);

  pendingCreate?.abort();
  const request = new AbortController();
  pendingCreate = request;
  setBusy(generateBtn, true);

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        ec: createForm.elements.ec.value,
        size: Number(createForm.elements.size.value) || DEFAULT_SIZE_PX,
        fg: fgInput.value,
        bg: bgInput.value,
      }),
      signal: request.signal,
    });
    if (!response.ok) throw new Error(await readError(response));
    showQr(await response.blob(), text, response.headers);
  } catch (err) {
    if (err.name !== 'AbortError') showNotice(createError, friendlyError(err));
  } finally {
    if (pendingCreate === request) {
      pendingCreate = null;
      setBusy(generateBtn, false);
    }
  }
}

function showQr(blob, text, headers) {
  if (currentQr) URL.revokeObjectURL(currentQr.url);
  currentQr = { blob, text, url: URL.createObjectURL(blob) };

  qrImage.src = currentQr.url;
  qrImage.alt = `QR code for ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`;
  qrImage.hidden = false;
  qrImage.classList.remove('pop');
  void qrImage.offsetWidth; // restart the pop-in animation
  qrImage.classList.add('pop');
  qrEmpty.hidden = true;
  qrFrame.classList.add('has-qr');

  const px = headers.get('X-QR-Pixels');
  qrMeta.textContent = `${px} × ${px} px · QR version ${headers.get('X-QR-Version')}`;
  qrMeta.hidden = false;

  downloadBtn.disabled = false;
  copyImageBtn.hidden = !canCopyImage;
  shareBtn.hidden = !canShareQr();
}

function fileNameFor(text) {
  const slug = text
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  return `qr-${slug || 'code'}.png`;
}

function qrFile() {
  return new File([currentQr.blob], fileNameFor(currentQr.text), { type: 'image/png' });
}

function canShareQr() {
  try {
    return Boolean(navigator.canShare?.({ files: [qrFile()] }));
  } catch {
    return false;
  }
}

function luminance(hex) {
  const channel = (start) => {
    const c = parseInt(hex.slice(start, start + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function updateContrastWarning() {
  const fg = luminance(fgInput.value);
  const bg = luminance(bgInput.value);
  const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  if (ratio < 3) {
    showNotice(contrastWarning, 'These colors are too similar. Scanners may not be able to read the code.');
  } else if (fg > bg) {
    showNotice(contrastWarning, "Light codes on dark backgrounds don't work with every scanner app.");
  } else {
    hideNotice(contrastWarning);
  }
}

function optionsChanged() {
  updateContrastWarning();
  if (!currentQr) return;
  clearTimeout(optionsTimer);
  optionsTimer = setTimeout(createQr, 150); // refresh the code on screen with the new look
}

/* ------------------------------------------------------------------- scan */

const panelScan = $('#panel-scan');
const scanCard = $('#scan-card');
const viewport = $('#viewport');
const video = $('#video');
const snapshot = $('#snapshot');
const snapshotCtx = snapshot.getContext('2d', { willReadFrequently: true });
const frameCanvas = document.createElement('canvas');
const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
const busyText = $('#busy-text');
const startCameraBtn = $('#start-camera');
const stopCameraBtn = $('#stop-camera');
const cameraSelect = $('#camera-select');
const uploadBtn = $('#upload-btn');
const fileInput = $('#file-input');
const scanError = $('#scan-error');
const resultCard = $('#result-card');
const resultEmpty = $('#result-empty');
const resultBody = $('#result-body');
const resultList = $('#result-list');
const resultSource = $('#result-source');
const scanAgainBtn = $('#scan-again');

let stream = null;
let frameRequest = 0;
let lastFrameAt = 0;
let frameCount = 0;
let mirrored = false;
let cameraId = ''; // camera used last, so "Scan again" reopens the same one
let lastSource = 'camera';
let scanJob = 0; // bumped by every new scan, so stale async work can bail out
let resumeCamera = false; // restart the camera when the page is visible again

let jsQRLoading = null;

function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  jsQRLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/jsQR.js';
    script.onload = () => {
      if (window.jsQR) return resolve(window.jsQR);
      jsQRLoading = null;
      reject(new Error("The scanner couldn't start. Reload the page and try again."));
    };
    script.onerror = () => {
      jsQRLoading = null;
      script.remove();
      reject(new Error("The scanner couldn't be loaded. Check your connection and try again."));
    };
    document.head.append(script);
  });
  return jsQRLoading;
}

function setView(state, busyMessage) {
  viewport.dataset.state = state;
  if (busyMessage) busyText.textContent = busyMessage;
}

function cameraErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was blocked. Allow it in your browser’s site settings, or upload a picture instead.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device. You can upload a picture instead.';
    case 'NotReadableError':
    case 'AbortError':
      return 'Your camera is being used by another app. Close that app and try again.';
    default:
      return err?.message || "The camera couldn't be started.";
  }
}

function stopTracks(mediaStream) {
  mediaStream?.getTracks().forEach((track) => track.stop());
}

function stopStream() {
  cancelAnimationFrame(frameRequest);
  frameRequest = 0;
  stopTracks(stream);
  stream = null;
  video.srcObject = null;
}

function stopCamera() {
  const state = viewport.dataset.state;
  if (state !== 'live' && state !== 'starting') return;
  scanJob++;
  stopStream();
  setView('idle');
}

async function startCamera(deviceId = cameraId) {
  hideNotice(scanError);
  if (!navigator.mediaDevices?.getUserMedia) {
    showNotice(
      scanError,
      window.isSecureContext
        ? "This browser can't use the camera. Upload a picture instead."
        : 'The camera only works on a secure (https://) page. Upload a picture instead.',
    );
    return;
  }

  const job = ++scanJob;
  stopStream();
  clearResults();
  lastSource = 'camera';
  setView('starting', 'Starting camera…');

  const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
  const constraints = deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: { ideal: 'environment' }, ...size };
  const streamPromise = navigator.mediaDevices.getUserMedia({ audio: false, video: constraints });

  let newStream;
  try {
    [, newStream] = await Promise.all([loadJsQR(), streamPromise]);
  } catch (err) {
    streamPromise.then(stopTracks, () => {});
    if (job !== scanJob) return;
    if (deviceId && err?.name === 'OverconstrainedError') {
      cameraId = ''; // that camera is gone; fall back to the default one
      startCamera('');
      return;
    }
    setView('idle');
    showNotice(scanError, cameraErrorMessage(err));
    return;
  }
  if (job !== scanJob) {
    stopTracks(newStream); // the user stopped or moved on while we waited for permission
    return;
  }

  stream = newStream;
  const settings = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
  cameraId = settings.deviceId || deviceId || '';
  // Mirror front cameras (and laptop webcams, which rarely report a facing
  // mode) so aiming feels natural. Decoding always uses the unmirrored frame.
  mirrored = settings.facingMode ? settings.facingMode === 'user' : true;
  video.classList.toggle('mirror', mirrored);
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    // play() can reject if interrupted; the stream still renders
  }
  if (job !== scanJob) return;

  setView('live');
  listCameras();
  lastFrameAt = 0;
  frameRequest = requestAnimationFrame(scanFrame);
}

async function listCameras() {
  try {
    const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    cameraSelect.replaceChildren(
      ...cameras.map((camera, i) => new Option(camera.label || `Camera ${i + 1}`, camera.deviceId, false, camera.deviceId === cameraId)),
    );
    cameraSelect.hidden = cameras.length < 2;
  } catch {
    cameraSelect.hidden = true;
  }
}

function scanFrame(now) {
  if (!stream) return;
  frameRequest = requestAnimationFrame(scanFrame);
  if (now - lastFrameAt < SCAN_EVERY_MS || video.readyState < video.HAVE_CURRENT_DATA || !video.videoWidth) return;
  lastFrameAt = now;

  const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.round(video.videoWidth * scale);
  const height = Math.round(video.videoHeight * scale);
  if (frameCanvas.width !== width || frameCanvas.height !== height) {
    frameCanvas.width = width;
    frameCanvas.height = height;
  }
  frameCtx.drawImage(video, 0, 0, width, height);
  const { data } = frameCtx.getImageData(0, 0, width, height);
  // Alternate between dark-on-light and light-on-dark codes: checking both on
  // every frame would double the work.
  const inversionAttempts = frameCount++ % 2 ? 'onlyInvert' : 'dontInvert';
  let code = null;
  try {
    code = window.jsQR(data, width, height, { inversionAttempts });
  } catch {
    // jsQR sometimes throws on frames that only half-look like a code; try the next frame
  }
  if (code) onCameraCode(code, scale);
}

function cornersOf(location, scale = 1) {
  const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = location;
  return [topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner].map((p) => [p.x / scale, p.y / scale]);
}

function onCameraCode(code, scale) {
  // Freeze the frame the code was found in and outline the code on it.
  snapshot.width = video.videoWidth;
  snapshot.height = video.videoHeight;
  snapshotCtx.drawImage(video, 0, 0);
  snapshot.classList.toggle('mirror', mirrored);
  drawOutline(cornersOf(code.location, scale));
  stopStream();
  setView('frozen');
  navigator.vibrate?.(40);
  showResults([{ data: code.data }], 'camera');
}

function drawOutline(points) {
  const ctx = snapshotCtx;
  ctx.save();
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = 'rgba(34, 197, 94, 0.2)';
  ctx.fill();
  ctx.lineWidth = Math.max(3, Math.round(Math.max(snapshot.width, snapshot.height) / 150));
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#22c55e';
  ctx.stroke();
  ctx.restore();
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('unreadable picture'));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the picture.'))), 'image/jpeg', 0.92);
  });
}

async function decodeOnServer(blob) {
  const body = new FormData();
  body.append('image', blob, 'picture.jpg');
  const response = await fetch('/api/decode', { method: 'POST', body });
  if (!response.ok) throw new Error(await readError(response));
  const { codes } = await response.json();
  return Array.isArray(codes) ? codes : [];
}

async function scanPicture(file) {
  hideNotice(scanError);
  if (!file?.type.startsWith('image/')) {
    showNotice(scanError, "That file isn't a picture. Choose a PNG, JPG or similar image.");
    return;
  }

  const job = ++scanJob;
  stopStream();
  clearResults();
  lastSource = 'picture';
  snapshot.width = 0; // don't flash the previous picture while this one loads
  setView('reading', 'Reading the picture…');

  let image;
  try {
    image = await loadImage(file);
  } catch {
    if (job === scanJob) {
      setView('idle');
      showNotice(scanError, "That picture couldn't be opened. Try a PNG or JPG.");
    }
    return;
  }
  if (job !== scanJob) return;

  const scale = Math.min(1, MAX_UPLOAD_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  snapshot.width = width;
  snapshot.height = height;
  snapshot.classList.remove('mirror');
  snapshotCtx.fillStyle = '#ffffff'; // flatten transparent PNGs onto white, like a printed code
  snapshotCtx.fillRect(0, 0, width, height);
  snapshotCtx.drawImage(image, 0, 0, width, height);
  const pixels = snapshotCtx.getImageData(0, 0, width, height);

  // Your OpenCV detector on the server gets the first try. If it finds nothing
  // (or the server can't be reached), jsQR takes a second look in the browser.
  let codes = [];
  let source = 'server';
  try {
    codes = await decodeOnServer(await canvasToBlob(snapshot));
  } catch (err) {
    console.warn('Server-side decoding failed; trying in the browser instead.', err);
  }
  if (!codes.length && job === scanJob) {
    try {
      const jsQR = await loadJsQR();
      const code = jsQR(pixels.data, width, height, { inversionAttempts: 'attemptBoth' });
      if (code) {
        codes = [{ data: code.data, points: cornersOf(code.location) }];
        source = 'browser';
      }
    } catch (err) {
      console.warn(err);
    }
  }
  if (job !== scanJob) return;

  setView('picture');
  if (!codes.length) {
    showNotice(scanError, 'No QR code found in that picture. Try a sharper photo, or get closer to the code.');
    return;
  }
  for (const code of codes) {
    if (code.points?.length === 4) drawOutline(code.points);
  }
  showResults(codes, source);
}

// Without "http(s)://", text only counts as a website when it starts with
// "www." or ends in one of these, so things like "report.pdf" stay plain text.
const WEBSITE_ENDINGS = new Set(
  'com net org in io co ai app dev edu gov info me biz xyz site online store shop tech blog news live tv us uk ca au de fr jp cn br nl es it eu sg ae pk bd lk np nz za'.split(' '),
);

const KINDS = [
  [/^mailto:/i, 'Email'],
  [/^(tel|sms|smsto):/i, 'Phone'],
  [/^WIFI:/i, 'Wi-Fi'],
  [/^BEGIN:VCARD/i, 'Contact'],
  [/^BEGIN:(VEVENT|VCALENDAR)/i, 'Event'],
  [/^geo:/i, 'Location'],
];

// The website a scanned code points to, or null when it isn't one. Accepts
// full links ("https://example.com/page") and bare ones ("www.example.com").
function websiteUrl(text) {
  const value = text.trim();
  if (!value || /\s/.test(value)) return null; // web addresses never contain spaces
  let address = value;
  if (!/^https?:\/\//i.test(value)) {
    const host = value.split(/[/?#:]/, 1)[0];
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) return null;
    const ending = host.slice(host.lastIndexOf('.') + 1).toLowerCase();
    if (!/^www\./i.test(host) && !WEBSITE_ENDINGS.has(ending)) return null;
    address = `https://${value}`;
  }
  try {
    const url = new URL(address);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null; // looked like a link but isn't a valid address
  }
}

function describe(text) {
  const url = websiteUrl(text);
  if (url) return { kind: 'Website', url };
  return { kind: KINDS.find(([pattern]) => pattern.test(text))?.[1] ?? 'Text', url: null };
}

function renderResult({ data }) {
  const { kind, url } = describe(data);
  const item = el('article', 'result-item');

  const head = el('div', 'result-head');
  head.append(el('span', 'badge', kind));
  if (url) head.append(el('span', 'result-host', url.host)); // show where the link really goes

  const actions = el('div', 'actions');
  if (url) {
    const open = el('a', 'btn btn-primary');
    open.href = url.href;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.append(icon('external'), 'Open website');
    open.addEventListener('click', () => cancelAutoOpen()); // it opens in a new tab instead
    actions.append(open);
  }
  const copy = el('button', 'btn btn-secondary');
  copy.type = 'button';
  copy.append(icon('copy'), url ? 'Copy link' : 'Copy text');
  copy.addEventListener('click', () => {
    cancelAutoOpen(); // they want the address, not the website
    copyText(data);
  });
  actions.append(copy);

  item.append(head, el('p', 'result-text', data || '(this code is empty)'), actions);
  return item;
}

let autoOpen = null; // { timer, ticker, notice } while a scanned website is about to open

// Opens a scanned website like the Tkinter app's webbrowser.open(), after a
// short countdown: a QR code can point anywhere, so people get to see the
// address and cancel first. It opens in this tab because browsers block
// pop-ups that don't come straight from a click; Back returns to the scanner.
function startAutoOpen(url, item) {
  cancelAutoOpen();
  const seconds = el('strong', null, String(AUTO_OPEN_SECONDS));
  const message = el('p', 'auto-open-text');
  message.append('Opening ', el('strong', null, url.host), ' in ', seconds, ' s…');
  const cancel = el('button', 'link-btn', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => cancelAutoOpen());
  const bar = el('span', 'auto-open-bar');
  bar.style.animationDuration = `${AUTO_OPEN_SECONDS}s`;
  const notice = el('div', 'auto-open');
  notice.append(message, cancel, bar);
  item.querySelector('.actions').before(notice);

  let left = AUTO_OPEN_SECONDS;
  const ticker = setInterval(() => {
    left -= 1;
    seconds.textContent = String(Math.max(left, 1));
  }, 1000);
  const timer = setTimeout(() => {
    clearInterval(ticker);
    autoOpen = null;
    message.replaceChildren('Opening ', el('strong', null, url.host), '…');
    cancel.remove();
    location.assign(url.href);
  }, AUTO_OPEN_SECONDS * 1000);
  autoOpen = { timer, ticker, notice };
}

function cancelAutoOpen() {
  if (!autoOpen) return;
  clearTimeout(autoOpen.timer);
  clearInterval(autoOpen.ticker);
  autoOpen.notice.remove();
  autoOpen = null;
}

function showResults(codes, source) {
  cancelAutoOpen();
  const items = codes.map(renderResult);
  resultList.replaceChildren(...items);
  const via = { camera: 'Scanned with your camera', server: 'Read by OpenCV', browser: 'Read in your browser' }[source];
  resultSource.textContent = codes.length > 1 ? `${codes.length} codes found · ${via}` : via;
  scanAgainBtn.lastElementChild.textContent = lastSource === 'camera' ? 'Scan again' : 'Scan another';
  resultEmpty.hidden = true;
  resultBody.hidden = false;
  if (window.matchMedia('(max-width: 879px)').matches) {
    resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  // A code that is just a website opens it; anything else is simply shown.
  const website = codes.length === 1 ? websiteUrl(codes[0].data) : null;
  if (website) startAutoOpen(website, items[0]);
}

function clearResults() {
  cancelAutoOpen();
  resultList.replaceChildren();
  resultBody.hidden = true;
  resultEmpty.hidden = false;
}

/* ------------------------------------------------------------------- tabs */

const tabs = [...document.querySelectorAll('[role="tab"]')];

function selectTab(name, { focus = false } = {}) {
  for (const tab of tabs) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
    if (selected && focus) tab.focus();
  }
  if (name !== 'scan') {
    stopCamera();
    cancelAutoOpen();
  }
  const hash = name === 'scan' ? '#scan' : '';
  if (location.hash !== hash) history.replaceState(null, '', hash || location.pathname + location.search);
}

/* ----------------------------------------------------------------- events */

createForm.addEventListener('submit', (event) => {
  event.preventDefault();
  createQr();
});

textInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    createQr();
  }
});

textInput.addEventListener('input', () => {
  const count = [...textInput.value].length; // characters, not UTF-16 code units
  charCount.textContent = count === 1 ? '1 character' : `${count} characters`;
  if (!createError.hidden) hideNotice(createError);
});

createForm.addEventListener('change', (event) => {
  if (event.target !== textInput) optionsChanged();
});
fgInput.addEventListener('input', updateContrastWarning);
bgInput.addEventListener('input', updateContrastWarning);

$('#reset-colors').addEventListener('click', () => {
  fgInput.value = DEFAULT_COLORS.fg;
  bgInput.value = DEFAULT_COLORS.bg;
  optionsChanged();
});

qrImage.addEventListener('load', () => {
  // Crisp pixel edges when the browser has to enlarge the code; smooth when shrinking it.
  const shownPx = qrImage.clientWidth * (window.devicePixelRatio || 1);
  qrImage.classList.toggle('pixelated', qrImage.naturalWidth < shownPx);
});

downloadBtn.addEventListener('click', () => {
  if (!currentQr) return;
  const link = el('a');
  link.href = currentQr.url;
  link.download = fileNameFor(currentQr.text);
  document.body.append(link);
  link.click();
  link.remove();
});

copyImageBtn.addEventListener('click', async () => {
  if (!currentQr) return;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': currentQr.blob })]);
    toast('QR code copied as an image');
  } catch {
    toast("Your browser wouldn't copy the image. Use Download instead.");
  }
});

shareBtn.addEventListener('click', async () => {
  if (!currentQr) return;
  try {
    await navigator.share({ files: [qrFile()], title: 'QR code' });
  } catch (err) {
    if (err.name !== 'AbortError') toast("Couldn't open the share menu.");
  }
});

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  tab.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    selectTab(tabs[(index + step + tabs.length) % tabs.length].dataset.tab, { focus: true });
  });
});
window.addEventListener('hashchange', () => selectTab(location.hash === '#scan' ? 'scan' : 'create'));

startCameraBtn.addEventListener('click', () => startCamera());
stopCameraBtn.addEventListener('click', stopCamera);
cameraSelect.addEventListener('change', () => startCamera(cameraSelect.value));

scanAgainBtn.addEventListener('click', () => {
  if (lastSource === 'camera') {
    startCamera();
  } else {
    clearResults();
    hideNotice(scanError);
    setView('idle');
  }
});

uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const [file] = fileInput.files;
  fileInput.value = ''; // so picking the same file again still triggers "change"
  if (file) scanPicture(file);
});

const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');

scanCard.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  scanCard.classList.add('dragging');
});
scanCard.addEventListener('dragleave', (event) => {
  if (!scanCard.contains(event.relatedTarget)) scanCard.classList.remove('dragging');
});
scanCard.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  scanCard.classList.remove('dragging');
  const files = [...event.dataTransfer.files];
  scanPicture(files.find((f) => f.type.startsWith('image/')) ?? files[0]);
});
// A file dropped anywhere else would make the browser navigate away to it.
window.addEventListener('dragover', (event) => hasFiles(event) && event.preventDefault());
window.addEventListener('drop', (event) => hasFiles(event) && event.preventDefault());

document.addEventListener('paste', (event) => {
  if (panelScan.hidden) return;
  const item = [...(event.clipboardData?.items ?? [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  if (!item) return;
  event.preventDefault();
  scanPicture(item.getAsFile());
});

document.addEventListener('visibilitychange', () => {
  // Release the camera while the page is in the background, and don't open a
  // website behind the visitor's back.
  if (document.hidden) {
    resumeCamera = viewport.dataset.state === 'live';
    stopCamera();
    cancelAutoOpen();
  } else if (resumeCamera) {
    resumeCamera = false;
    if (!panelScan.hidden) startCamera();
  }
});
window.addEventListener('pagehide', stopStream);
window.addEventListener('pageshow', (event) => {
  // Coming Back from a website that was opened: drop its stale "Opening…" notice.
  if (event.persisted) document.querySelectorAll('.auto-open').forEach((node) => node.remove());
});

/* ------------------------------------------------------------------- init */

if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
  document.querySelectorAll('[data-mod-key]').forEach((key) => (key.textContent = '⌘'));
}
updateContrastWarning();
selectTab(location.hash === '#scan' ? 'scan' : 'create');
