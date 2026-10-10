const express = require('express');
const fs = require('fs');
const path = require('path');
const { Zalo } = require('zca-js');

const app = express();
const PORT = process.env.PORT || 10000;

let isLoginSuccess = false;
let sessionData = null; // { imei, cookie, uid, ... }

async function startZalo() {
    const qrPath = path.join(__dirname, 'qr.png');
    if (fs.existsSync(qrPath)) {
        try { fs.unlinkSync(qrPath); } catch (e) {}
    }

    const zalo = new Zalo({ selfListen: false, checkUpdate: false });
    try {
        const api = await zalo.loginQR();

        // Trích xuất dữ liệu phiên từ api sau khi login thành công
        // zca-js lưu context trong api; tùy version, các field có thể nằm ở
        // api.getContext(), api.ctx, hoặc api.context
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

        // Nếu cookie là object/array, chuyển thành string cho dễ đọc
        let cookieStr = cookie;
        if (cookie && typeof cookie !== 'string') {
            try {
                if (Array.isArray(cookie)) {
                    cookieStr = cookie.map(c => (typeof c === 'string' ? c : (c.name ? `${c.name}=${c.value}` : JSON.stringify(c)))).join('; ');
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
                // dump toàn bộ context thô để dj có thể đọc thêm field
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
        console.error("Lỗi đăng nhập Zalo:", err.message);
    }
}

// Giới hạn kích thước preview, tránh vòng lặp vô hạn
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

startZalo();

// QR image
app.get('/qr.png', (req, res) => {
    const qrPath = path.join(__dirname, 'qr.png');
    if (fs.existsSync(qrPath)) res.sendFile(qrPath);
    else res.status(404).send('Chưa có mã QR');
});

// Status
app.get('/api/check-status', (req, res) => {
    const qrExists = fs.existsSync(path.join(__dirname, 'qr.png'));
    res.json({
        hasQR: qrExists,
        success: isLoginSuccess
    });
});

// API trả dữ liệu session (imei + cookie + ...)
app.get('/api/session', (req, res) => {
    if (!isLoginSuccess || !sessionData) {
        return res.status(404).json({ error: 'Chưa đăng nhập' });
    }
    res.json(sessionData);
});

// Trang kết quả sau khi login — hiển thị dãy imei + cookie
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
            <title>Session Info</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                       background:#0f1115; color:#e6e6e6; margin:0; padding:24px; }
                h1 { color:#28a745; margin-top:0; }
                .card { background:#181b22; border:1px solid #262a33; border-radius:10px;
                        padding:16px 18px; margin-bottom:16px; }
                .label { font-size:12px; text-transform:uppercase; letter-spacing:1px;
                         color:#8b93a7; margin-bottom:6px; }
                .value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                         font-size:13px; word-break:break-all; white-space:pre-wrap;
                         background:#0b0d12; border:1px solid #232733; border-radius:6px;
                         padding:10px 12px; }
                .row { display:flex; gap:10px; align-items:center; margin-top:8px; }
                button { background:#0068ff; color:white; border:0; padding:8px 14px;
                         border-radius:6px; cursor:pointer; font-size:13px; }
                button:hover { background:#0052cc; }
                .ok { color:#28a745; font-weight:600; }
            </style>
        </head>
        <body>
            <h1>🎉 Đăng nhập Zalo thành công</h1>
            <p class="ok">Dữ liệu phiên đã được trích xuất từ máy tính.</p>

            <div class="card">
                <div class="label">IMEI / Device ID</div>
                <div class="value" id="imei">${escapeHtml(String(imei))}</div>
            </div>

            <div class="card">
                <div class="label">UID</div>
                <div class="value" id="uid">${escapeHtml(String(uid))}</div>
            </div>

            <div class="card">
                <div class="label">Cookie</div>
                <div class="value" id="cookie">${escapeHtml(String(cookie))}</div>
                <div class="row">
                    <button onclick="copyText('cookie')">Copy cookie</button>
                    <button onclick="copyText('imei')">Copy IMEI</button>
                </div>
            </div>

            <div class="card">
                <div class="label">User-Agent</div>
                <div class="value" id="ua">${escapeHtml(String(ua))}</div>
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

function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    })[c]);
}

// Trang chủ QR (giữ nguyên logic cũ, không gây lỗi QR)
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
                       display:flex; justify-content:center; align-items:center;
                       min-height:100vh; margin:0; background:#f0f2f5; }
                .box { background:white; padding:30px; border-radius:12px;
                       box-shadow:0 4px 15px rgba(0,0,0,0.1); text-align:center; width:320px; }
                h2 { margin-top:0; color:#0068ff; }
                .qr-box { width:260px; height:260px; margin:15px auto;
                          display:flex; align-items:center; justify-content:center; }
                img { width:100%; border-radius:8px; border:1px solid #ddd; }
                #status { margin-top:15px; font-weight:bold; color:#555; font-size:14px; }
            </style>
        </head>
        <body>
            <div class="box">
                <h2>Zalo Login</h2>
                <div class="qr-box" id="qrArea"><p>Đang tải mã QR...</p></div>
                <div id="status">Vui lòng chờ...</div>
            </div>

            <script>
                let qrLoaded = false;
                const timer = setInterval(async () => {
                    try {
                        const res = await fetch('/api/check-status');
                        const data = await res.json();

                        if (data.hasQR && !qrLoaded && !data.success) {
                            qrLoaded = true;
                            document.getElementById('qrArea').innerHTML =
                                '<img src="/qr.png?t=' + Date.now() + '" alt="QR Zalo" />';
                            document.getElementById('status').innerText =
                                'Mở Zalo quét mã và bấm Chấp nhận trên điện thoại';
                        }

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
