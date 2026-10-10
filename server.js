const express = require('express');
const fs = require('fs');
const path = require('path');
const { Zalo } = require('zca-js');

const app = express();
const PORT = process.env.PORT || 10000;

let isLoginSuccess = false;
let sessionData = null; // { imei, cookie, uid, userAgent, raw }

// ============================================================
// SAFE PREVIEW — tránh vòng lặp vô hạn khi dump context
// ============================================================
function safePreview(obj, depth = 2) {
    const seen = new WeakSet();
    function walk(o, d) {
        if (o === null || typeof o !== 'object') return o;
        if (d <= 0) return '[Object]';
        if (seen.has(o)) return '[Circular]';
        seen.add(o);
        if (Array.isArray(o)) return o.slice(0, 5).map(x => walk(x, d - 1));
        const out = {};
        for (const k of Object.keys(o).slice(0, 30)) {
            try { out[k] = walk(o[k], d - 1); } catch (e) { out[k] = '[err]'; }
        }
        return out;
    }
    try { return walk(obj, depth); } catch (e) { return '[unserializable]'; }
}

// ============================================================
// START ZALO — bắt QR bằng mọi đường, trích xuất session
// ============================================================
async function startZalo() {
    const qrPath = path.join(__dirname, 'qr.png');
    if (fs.existsSync(qrPath)) {
        try { fs.unlinkSync(qrPath); } catch (e) {}
    }

    const zalo = new Zalo({ selfListen: false, checkUpdate: false });

    // Hàm ghi QR ra file — nhận mọi định dạng: Buffer, base64, dataURL, path, object
    const saveQR = (data, source = 'unknown') => {
        try {
            if (!data) return;
            let buf = null;

            if (Buffer.isBuffer(data)) {
                buf = data;
            } else if (typeof data === 'string') {
                if (data.startsWith('data:image')) {
                    buf = Buffer.from(data.split(',')[1], 'base64');
                } else if (data.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(data)) {
                    buf = Buffer.from(data.replace(/\s/g, ''), 'base64');
                } else if (fs.existsSync(data)) {
                    fs.copyFileSync(data, qrPath);
                    console.log(`[QR] copied from ${source}: ${data}`);
                    return;
                } else {
                    console.log(`[QR] string from ${source}, len=${data.length}, preview=${data.slice(0, 60)}`);
                    return;
                }
            } else if (data.path && fs.existsSync(data.path)) {
                fs.copyFileSync(data.path, qrPath);
                console.log(`[QR] copied from ${source}: ${data.path}`);
                return;
            } else if (data.qrCodeURL) {
                return saveQR(data.qrCodeURL, source + '.qrCodeURL');
            } else if (data.qr) {
                return saveQR(data.qr, source + '.qr');
            } else {
                console.log(`[QR] unknown shape from ${source}:`, Object.keys(data));
                return;
            }

            if (buf) {
                fs.writeFileSync(qrPath, buf);
                console.log(`[QR] saved (${buf.length} bytes) from ${source}`);
            }
        } catch (e) {
            console.error(`[QR] saveQR error from ${source}:`, e.message);
        }
    };

    // Bắt event nếu Zalo là EventEmitter
    if (typeof zalo.on === 'function') {
        ['qr', 'qrCode', 'qr-code', 'qrcode', 'QRCode'].forEach(ev => {
            try { zalo.on(ev, (d) => saveQR(d, 'event:' + ev)); } catch (e) {}
        });
    }

    let api = null;
    try {
        // Variant A: loginQR(options, callback) — zca-js docs ghi rõ signature này
        // và qrPath là tùy chọn để lưu file, mặc định ./qr.png
        try {
            const maybe = zalo.loginQR({ qrPath }, (qr) => saveQR(qr, 'callback'));
            if (maybe && typeof maybe.then === 'function') {
                api = await maybe;
            } else {
                api = maybe;
            }
        } catch (eA) {
            console.log('loginQR callback variant failed:', eA.message);
            // Variant B: loginQR(options) không callback
            try {
                api = await zalo.loginQR({ qrPath });
            } catch (eB) {
                console.log('loginQR promise variant failed:', eB.message);
                // Variant C: loginQR() trơn
                api = await zalo.loginQR();
            }
        }

        // Nếu api không phải object thật (một số bản trả void), thử lấy từ zalo
        if (!api || typeof api !== 'object') {
            api = zalo.api || zalo.instance || zalo;
        }

        // Trích xuất session context — thử mọi đường có thể
        let ctx = null;
        try {
            if (typeof api.getContext === 'function') ctx = api.getContext();
            else if (api.ctx) ctx = api.ctx;
            else if (api.context) ctx = api.context;
            else ctx = api;
        } catch (e) { ctx = api; }

        const imei = ctx?.imei || ctx?.deviceId || ctx?.device?.imei || null;
        const cookie = ctx?.cookie || ctx?.cookies || ctx?.cookieJar || null;
        const uid = ctx?.uid || ctx?.userId || ctx?.ownId || null;
        const userAgent = ctx?.userAgent || ctx?.ua || null;

        // Normalize cookie thành string
        let cookieStr = cookie;
        if (cookie && typeof cookie !== 'string') {
            try {
                if (Array.isArray(cookie)) {
                    cookieStr = cookie.map(c =>
                        typeof c === 'string' ? c : (c.name ? `${c.name}=${c.value}` : JSON.stringify(c))
                    ).join('; ');
                } else {
                    cookieStr = JSON.stringify(cookie);
                }
            } catch (e) { cookieStr = String(cookie); }
        }

        sessionData = {
            imei,
            cookie: cookieStr,
            uid,
            userAgent,
            raw: {
                ctxKeys: ctx ? Object.keys(ctx) : [],
                ctxPreview: ctx ? safePreview(ctx) : null
            }
        };

        isLoginSuccess = true;
        console.log("=== LOGIN SUCCESS ===");
        console.log("IMEI:", imei);
        console.log("UID :", uid);
        console.log("COOKIE:", cookieStr);
    } catch (err) {
        console.error("Lỗi đăng nhập Zalo:", err.message, err.stack);
    }
}

startZalo();

// ============================================================
// QR IMAGE — trả file QR nếu tồn tại
// ============================================================
app.get('/qr.png', (req, res) => {
    const qrPath = path.join(__dirname, 'qr.png');
    if (fs.existsSync(qrPath)) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.sendFile(qrPath);
    } else {
        res.status(404).send('Chưa có mã QR');
    }
});

// ============================================================
// API CHECK STATUS — trả trạng thái QR + login
// ============================================================
app.get('/api/check-status', (req, res) => {
    const qrPath = path.join(__dirname, 'qr.png');
    const exists = fs.existsSync(qrPath);
    let size = 0, mtime = 0;
    if (exists) {
        try {
            const st = fs.statSync(qrPath);
            size = st.size;
            mtime = st.mtimeMs;
        } catch (e) {}
    }
    res.json({
        hasQR: exists,
        qrSize: size,
        qrMtime: mtime,
        success: isLoginSuccess,
        qrUrl: exists ? '/qr.png?t=' + mtime : null
    });
});

// ============================================================
// API SESSION — trả imei + cookie + uid + userAgent
// ============================================================
app.get('/api/session', (req, res) => {
    if (!isLoginSuccess || !sessionData) {
        return res.status(404).json({ error: 'Chưa đăng nhập' });
    }
    res.json(sessionData);
});

// ============================================================
// DASHBOARD — hiển thị IMEI + COOKIE + UID + UA + nút copy
// ============================================================
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

app.get('/dashboard', (req, res) => {
    const d = sessionData || {};
    const imei = d.imei || '(không lấy được)';
    const cookie = d.cookie || '(không lấy được)';
    const uid = d.uid || '(không lấy được)';
    const ua = d.userAgent || '(không lấy được)';

    res.send(`
        <!DOCTYPE html>
        <html lang="vi">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Session Info — Zalo</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                       background: #0f1115; color: #e6e6e6; margin: 0; padding: 24px; }
                h1 { color: #28a745; margin-top: 0; }
                .sub { color: #8b93a7; margin-bottom: 24px; }
                .card { background: #181b22; border: 1px solid #262a33; border-radius: 10px;
                        padding: 16px 18px; margin-bottom: 16px; }
                .label { font-size: 12px; text-transform: uppercase; letter-spacing: 1px;
                         color: #8b93a7; margin-bottom: 6px; }
                .value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                         font-size: 13px; word-break: break-all; white-space: pre-wrap;
                         background: #0b0d12; border: 1px solid #232733; border-radius: 6px;
                         padding: 10px 12px; }
                .row { display: flex; gap: 10px; align-items: center; margin-top: 8px; }
                button { background: #0068ff; color: white; border: 0; padding: 8px 14px;
                         border-radius: 6px; cursor: pointer; font-size: 13px; }
                button:hover { background: #0052cc; }
                .ok { color: #28a745; font-weight: 600; }
            </style>
        </head>
        <body>
            <h1>🎉 Đăng nhập Zalo thành công</h1>
            <p class="sub">Dữ liệu phiên đã được trích xuất từ máy tính.</p>

            <div class="card">
                <div class="label">IMEI / Device ID</div>
                <div class="value" id="imei">${escapeHtml(imei)}</div>
            </div>

            <div class="card">
                <div class="label">UID</div>
                <div class="value" id="uid">${escapeHtml(uid)}</div>
            </div>

            <div class="card">
                <div class="label">Cookie</div>
                <div class="value" id="cookie">${escapeHtml(cookie)}</div>
                <div class="row">
                    <button onclick="copyText('cookie')">Copy cookie</button>
                    <button onclick="copyText('imei')">Copy IMEI</button>
                </div>
            </div>

            <div class="card">
                <div class="label">User-Agent</div>
                <div class="value" id="ua">${escapeHtml(ua)}</div>
            </div>

            <script>
                function copyText(id) {
                    const t = document.getElementById(id).innerText;
                    navigator.clipboard.writeText(t).then(() => {
                        const b = event.target;
                        const old = b.innerText;
                        b.innerText = 'Đã copy!';
                        setTimeout(() => b.innerText = old, 1200);
                    });
                }
            </script>
        </body>
        </html>
    `);
});

// ============================================================
// TRANG CHỦ — QR + poll trạng thái
// ============================================================
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="vi">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Đăng nhập Zalo</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                       display: flex; justify-content: center; align-items: center;
                       min-height: 100vh; margin: 0; background: #f0f2f5; }
                .box { background: white; padding: 30px; border-radius: 12px;
                       box-shadow: 0 4px 15px rgba(0,0,0,0.1); text-align: center; width: 320px; }
                h2 { margin-top: 0; color: #0068ff; }
                .qr-box { width: 260px; height: 260px; margin: 15px auto;
                          display: flex; align-items: center; justify-content: center; }
                .qr-box img { width: 100%; border-radius: 8px; border: 1px solid #ddd; }
                #status { margin-top: 15px; font-weight: bold; color: #555; font-size: 14px; }
            </style>
        </head>
        <body>
            <div class="box">
                <h2>Zalo Login</h2>
                <div class="qr-box" id="qrArea"><p>Đang tải mã QR...</p></div>
                <div id="status">Vui lòng chờ...</div>
            </div>

            <script>
                let lastMtime = 0;
                const timer = setInterval(async () => {
                    try {
                        const res = await fetch('/api/check-status');
                        const data = await res.json();

                        // Hiển thị QR khi có file và mtime thay đổi (QR hết hạn ~1 phút)
                        if (data.hasQR && data.qrUrl && !data.success) {
                            const img = document.getElementById('qrImg');
                            if (!img) {
                                document.getElementById('qrArea').innerHTML =
                                    '<img id="qrImg" src="' + data.qrUrl + '" alt="QR Zalo" />';
                                document.getElementById('status').innerText =
                                    'Mở Zalo quét mã và bấm Chấp nhận trên điện thoại';
                            } else if (data.qrMtime !== lastMtime) {
                                img.src = data.qrUrl;
                                document.getElementById('status').innerText =
                                    'Mã QR mới — quét lại';
                            }
                            lastMtime = data.qrMtime;
                        }

                        // Khi login thành công
                        if (data.success) {
                            clearInterval(timer);
                            document.getElementById('status').innerText =
                                'Đăng nhập thành công! Đang chuyển trang...';
                            document.getElementById('status').style.color = 'green';
                            setTimeout(() => { window.location.href = '/dashboard'; }, 1000);
                        }
                    } catch (e) {}
                }, 1500);
            </script>
        </body>
        </html>
    `);
});

app.listen(PORT, () => {
    console.log("Server đang chạy ở port " + PORT);
});
